import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─── LLM Configuration (OpenAI) ─────────────────────────────────────────────

const LLM_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LLM_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;

// ─── JSON repair utilities ──────────────────────────────────────────────────

function repairJSON(raw: string): string {
  let r = raw.replace(/,\s*([}\]])/g, '$1');
  const chars: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i];
    if (esc) { chars.push(ch); esc = false; continue; }
    if (ch === '\\' && inStr) { chars.push(ch); esc = true; continue; }
    if (ch === '"') { inStr = !inStr; chars.push(ch); continue; }
    if (inStr && ch.charCodeAt(0) < 0x20) {
      const map: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
      chars.push(map[ch] || '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
      continue;
    }
    chars.push(ch);
  }
  return chars.join('');
}

function extractOutermostJSON(text: string): string | null {
  const objIdx = text.indexOf('{');
  const arrIdx = text.indexOf('[');
  const tries: Array<[string, string]> = [];
  if (objIdx !== -1 && arrIdx !== -1) {
    tries.push(arrIdx < objIdx ? ['[', ']'] : ['{', '}']);
    tries.push(arrIdx < objIdx ? ['{', '}'] : ['[', ']']);
  } else if (objIdx !== -1) tries.push(['{', '}']);
  else if (arrIdx !== -1) tries.push(['[', ']']);

  for (const [open, close] of tries) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
      }
    }
  }
  return null;
}

function parseJSON(raw: string): unknown {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) cleaned = fence[1].trim();
  try { return JSON.parse(cleaned); } catch {}
  const json = extractOutermostJSON(cleaned);
  if (!json) throw new Error('No JSON found in LLM response');
  try { return JSON.parse(json); } catch {}
  try { return JSON.parse(repairJSON(json)); } catch (e) {
    throw new Error(`JSON parse failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ─── LLM call (OpenAI) ─────────────────────────────────────────────────────

interface LLMResult { rawText: string; parsed: unknown; tokens?: { prompt: number; completion: number } }

async function callLLM(system: string, user: string, temp = 0, maxTokens = 4096): Promise<LLMResult> {
  const baseUrl = LLM_BASE_URL
    ? (LLM_BASE_URL.endsWith('/chat/completions') ? LLM_BASE_URL : `${LLM_BASE_URL}/chat/completions`)
    : 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens, temperature: temp,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const d = await res.json() as any;
  const raw = d.choices?.[0]?.message?.content || '';
  return { rawText: raw, parsed: parseJSON(raw), tokens: { prompt: d.usage?.prompt_tokens, completion: d.usage?.completion_tokens } };
}

// ─── Transcript parsing (same as sandbox v2) ────────────────────────────────

interface TranscriptLine {
  lineNum: number;
  speaker: string;
  text: string;
  wordCount: number;
  cumulativeWords: number;
}

function parseTranscriptHtml(html: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const pBlocks = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];

  let cumulative = 0;
  let lineNum = 0;

  for (const block of pBlocks) {
    const text = block
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text.length < 3) continue;

    let speaker = '';
    let content = text;
    const speakerMatch = text.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
    if (speakerMatch) {
      speaker = speakerMatch[1].trim();
      content = text.slice(speakerMatch[0].length).trim();
    }

    if (!content) continue;

    lineNum++;
    const wc = content.split(/\s+/).filter(Boolean).length;
    cumulative += wc;

    lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
  }

  return lines;
}

function buildNumberedTranscriptText(lines: TranscriptLine[]): string {
  return lines.map(l => {
    const spk = l.speaker ? `${l.speaker}: ` : '';
    return `[${l.lineNum}] ${spk}${l.text}`;
  }).join('\n');
}

function parseDuration(dur: string): number {
  if (!dur) return 0;
  const p = dur.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

// ─── Podcast feed data ──────────────────────────────────────────────────────

const PODCASTS: Record<string, { name: string; feedUrl: string }> = {
  '510325': {
    name: 'The Indicator from Planet Money',
    feedUrl: 'https://feeds.npr.org/510325/podcast.xml',
  },
  '510289': {
    name: 'Planet Money',
    feedUrl: 'https://feeds.npr.org/510289/podcast.xml',
  },
  '510318': {
    name: 'Short Wave',
    feedUrl: 'https://feeds.npr.org/510318/podcast.xml',
  },
  '510308': {
    name: 'Hidden Brain',
    feedUrl: 'https://feeds.npr.org/510308/podcast.xml',
  },
  '344098539': {
    name: 'Up First',
    feedUrl: 'https://feeds.npr.org/344098539/podcast.xml',
  },
};

interface Episode {
  id: string;
  title: string;
  description: string;
  pubDate: string;
  duration: string;
  audioUrl: string;
  link: string;
  transcriptUrl: string | null;
}

// ─── Sample fallback episodes ───────────────────────────────────────────────

function getSampleEpisodes(podcastId: string): Episode[] {
  const samples: Record<string, Episode[]> = {
    '510325': [
      { id: 'sample-1', title: 'Why Egg Prices Are So High', description: 'Bird flu has devastated chicken flocks, driving egg prices to record highs.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '9:32', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-2', title: 'The Rise of Buy Now, Pay Later', description: 'How installment payments are changing the way consumers shop.', pubDate: 'Fri, 07 Feb 2025 20:00:00 GMT', duration: '10:15', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-3', title: 'What Tariffs Actually Do', description: 'A look at how tariffs affect prices, businesses, and trade.', pubDate: 'Thu, 06 Feb 2025 20:00:00 GMT', duration: '8:47', audioUrl: '', link: '', transcriptUrl: null },
    ],
    '510289': [
      { id: 'sample-6', title: 'The Invention of Money', description: 'The story of how money was invented — twice.', pubDate: 'Fri, 07 Feb 2025 20:00:00 GMT', duration: '22:14', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-7', title: 'The Great Inflation', description: 'How Paul Volcker broke the back of inflation in the early 1980s.', pubDate: 'Wed, 05 Feb 2025 20:00:00 GMT', duration: '24:30', audioUrl: '', link: '', transcriptUrl: null },
    ],
  };
  return samples[podcastId] || [
    { id: 'sample-default', title: 'Sample Episode', description: 'A sample episode for demonstration.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '10:00', audioUrl: '', link: '', transcriptUrl: null },
  ];
}

// ─── RSS Feed Proxy ─────────────────────────────────────────────────────────

app.get('/api/podcasts', (_req, res) => {
  const list = Object.entries(PODCASTS).map(([id, p]) => ({ id, name: p.name }));
  res.json(list);
});

app.get('/api/podcast/:id/episodes', async (req, res) => {
  const podcast = PODCASTS[req.params.id];
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  try {
    const response = await fetch(podcast.feedUrl, {
      headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
    });
    if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const feed = parser.parse(xml);
    const items = feed?.rss?.channel?.item || [];
    const itemList = Array.isArray(items) ? items : [items];

    const episodes: Episode[] = itemList.slice(0, 50).map((item: any, i: number) => {
      const enclosure = item.enclosure || {};
      const audioUrl = enclosure['@_url'] || '';
      const link = item.link || '';
      const idMatch = link.match(/\/(\d{4}\/\d{2}\/\d{2}\/[\w-]+|nx-[\w-]+)/);
      const storyId = idMatch ? idMatch[1] : null;
      const transcriptUrl = storyId
        ? `https://www.npr.org/transcripts/${storyId}`
        : null;

      return {
        id: `ep-${i}-${Date.now()}`,
        title: item.title || 'Untitled',
        description: (item.description || item['itunes:summary'] || '').replace(
          /<[^>]*>/g,
          ''
        ),
        pubDate: item.pubDate || '',
        duration: item['itunes:duration'] || '',
        audioUrl,
        link,
        transcriptUrl,
      };
    });

    res.json({
      podcastName: podcast.name,
      episodes,
    });
  } catch (err: any) {
    console.error('RSS fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch RSS feed', detail: err.message });
  }
});

// ─── Transcript Fetch ────────────────────────────────────────────────────────

app.get('/api/transcript', async (req, res) => {
  const url = req.query.url as string;
  if (!url || !url.includes('npr.org')) {
    res.status(400).json({ error: 'Invalid transcript URL' });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
    if (!response.ok) throw new Error(`Transcript fetch failed: ${response.status}`);

    const html = await response.text();
    res.json({ html });
  } catch (err: any) {
    console.error('Transcript fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch transcript', detail: err.message });
  }
});

// ─── LLM Step 1: Parse Transcript (v2 — server-side HTML parsing) ──────────
//
// The v2 approach parses HTML into numbered lines server-side. No LLM needed
// for this step — it's deterministic HTML parsing, same as the sandbox.

interface LLMTranscriptSegment {
  speaker: string;
  text: string;
  isAd: boolean;
  adType: string | null;
}

interface LLMTranscriptResult {
  segments: LLMTranscriptSegment[];
  fullText: string;
  adMentions: Array<{ segmentIndex: number; reason: string }>;
  estimatedContentWords: number;
  // v2 extras — the numbered lines for the detect-ads step
  _lines?: TranscriptLine[];
}

app.post('/api/llm/parse-transcript', async (req, res) => {
  const { html } = req.body as { html: string };
  if (!html) {
    res.status(400).json({ error: 'Missing html body' });
    return;
  }

  // v2: Parse HTML into structured lines server-side (no LLM call needed)
  const lines = parseTranscriptHtml(html);
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

  // Map to the frontend's expected format
  const segments: LLMTranscriptSegment[] = lines.map(l => ({
    speaker: l.speaker,
    text: l.text,
    isAd: false,   // ad detection happens in the next step
    adType: null,
  }));

  const fullText = lines.map(l => {
    const spk = l.speaker ? `${l.speaker}: ` : '';
    return `${spk}${l.text}`;
  }).join('\n');

  const result: LLMTranscriptResult = {
    segments,
    fullText,
    adMentions: [],          // populated by detect-ads step
    estimatedContentWords: totalWords,
    _lines: lines,           // pass through for detect-ads
  };

  res.json(result);
});

// ─── LLM Step 2: Detect Ads (v2 — numbered-line approach, single LLM call) ─
//
// Same approach as sandbox: send the full numbered transcript to the LLM and
// ask "which line ranges are ad blocks?", then map to timestamps.

interface LLMAdSegment {
  startTime: number;
  endTime: number;
  type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention';
  confidence: number;
  reason: string;
}

interface LLMAdDetectionResult {
  segments: LLMAdSegment[];
  totalAdTime: number;
  contentDuration: number;
  strategy: string;
}

app.post('/api/llm/detect-ads', async (req, res) => {
  const { transcript, audioDurationSeconds, episodeTitle } = req.body as {
    transcript: LLMTranscriptResult;
    audioDurationSeconds: number;
    episodeTitle: string;
  };

  if (!transcript || !audioDurationSeconds) {
    res.status(400).json({ error: 'Missing transcript or audioDurationSeconds' });
    return;
  }

  // Reconstruct lines from the transcript segments (or use _lines if passed through)
  let lines: TranscriptLine[] = (transcript as any)._lines || [];
  if (lines.length === 0 && transcript.segments.length > 0) {
    // Rebuild lines from segments if _lines wasn't passed
    let cumulative = 0;
    lines = transcript.segments.map((seg, i) => {
      const wc = seg.text.split(/\s+/).filter(Boolean).length;
      cumulative += wc;
      return {
        lineNum: i + 1,
        speaker: seg.speaker,
        text: seg.text,
        wordCount: wc,
        cumulativeWords: cumulative,
      };
    });
  }

  if (!LLM_API_KEY) {
    // No-key fallback: basic heuristic
    const segments: LLMAdSegment[] = [];
    if (audioDurationSeconds > 120) {
      segments.push({ startTime: 0, endTime: 30, type: 'pre-roll', confidence: 0.5, reason: 'heuristic fallback — no API key' });
    }
    if (audioDurationSeconds > 300) {
      const mid = audioDurationSeconds * 0.48;
      segments.push({ startTime: mid, endTime: mid + 60, type: 'mid-roll', confidence: 0.4, reason: 'heuristic fallback — no API key' });
    }
    const totalAdTime = segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    res.json({
      segments,
      totalAdTime,
      contentDuration: audioDurationSeconds - totalAdTime,
      strategy: 'heuristic-fallback-no-key',
    } as LLMAdDetectionResult);
    return;
  }

  // v2 approach: numbered transcript → single LLM call → line ranges → timestamps
  const numberedText = buildNumberedTranscriptText(lines);
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

  const systemPrompt = `You are an ad-block detector for podcast transcripts. You read the full transcript and identify contiguous blocks of lines that are advertisements, sponsor reads, funding credits, or promotional content — NOT editorial content.

IMPORTANT: You are looking for OBVIOUS ad blocks. These are contiguous runs of lines where the content is clearly commercial/promotional. Typical patterns:
- "Support for this podcast comes from..."
- "This message comes from..."
- Sponsor descriptions with calls-to-action ("visit example.com", "use promo code...")
- NPR funding credits ("Support for NPR comes from...")
- Show promos ("Coming up on..." for a different show)

These ad blocks are typically 1-5 lines long and there are at most a few per episode (one every 10-15 minutes of content). They are VERY obvious — a human would spot them instantly.

Do NOT flag: regular editorial discussion about economics/business/companies, interview content, the host's own commentary, or transitions between topics.

Return ONLY valid JSON.`;

  const userPrompt = `Here is the full transcript of "${episodeTitle}" with numbered lines.
Find all ad blocks — contiguous ranges of lines that are ads/sponsors/funding credits.

For each block, return the start and end line numbers (inclusive) and a short reason.

TRANSCRIPT:
${numberedText}

Return JSON:
{
  "adBlocks": [
    { "startLine": number, "endLine": number, "reason": "short explanation" }
  ]
}`;

  try {
    const { parsed } = await callLLM(systemPrompt, userPrompt, 0, 2048);
    const result = parsed as { adBlocks: Array<{ startLine: number; endLine: number; reason: string }> };
    const adBlocks = result.adBlocks || [];

    // Map line ranges → timestamps (proportional word position)
    const lineMap = new Map<number, TranscriptLine>();
    for (const l of lines) lineMap.set(l.lineNum, l);

    const segments: LLMAdSegment[] = adBlocks.map(b => {
      const startLine = lineMap.get(b.startLine);
      const endLine = lineMap.get(b.endLine);
      let startTimeSec = 0, endTimeSec = 0;
      if (startLine && endLine && totalWords > 0) {
        const startWord = startLine.cumulativeWords - startLine.wordCount;
        const endWord = endLine.cumulativeWords;
        startTimeSec = (startWord / totalWords) * audioDurationSeconds;
        endTimeSec = (endWord / totalWords) * audioDurationSeconds;
      }

      // Classify ad position
      const midpoint = (startTimeSec + endTimeSec) / 2;
      let type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention' = 'mid-roll';
      if (midpoint < audioDurationSeconds * 0.1) type = 'pre-roll';
      else if (midpoint > audioDurationSeconds * 0.9) type = 'post-roll';

      return {
        startTime: Math.round(startTimeSec),
        endTime: Math.round(endTimeSec),
        type,
        confidence: 0.9,
        reason: b.reason,
      };
    });

    const totalAdTime = segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    res.json({
      segments,
      totalAdTime,
      contentDuration: audioDurationSeconds - totalAdTime,
      strategy: 'v2-numbered-line-ranges',
    } as LLMAdDetectionResult);
  } catch (err: any) {
    console.error('LLM detect-ads error:', err.message);
    res.status(500).json({ error: 'LLM ad detection failed', detail: err.message });
  }
});

// ─── LLM Step 3: Prepare Player ─────────────────────────────────────────────

interface LLMPlaybackConfig {
  summary: string;
  topics: string[];
  skipMap: LLMAdSegment[];
  contentDuration: number;
  totalAdTime: number;
  recommendation: string;
}

app.post('/api/llm/prepare-playback', async (req, res) => {
  const { transcript, adDetection, episodeTitle, episodeDescription } = req.body as {
    transcript: LLMTranscriptResult;
    adDetection: LLMAdDetectionResult;
    episodeTitle: string;
    episodeDescription: string;
  };

  if (!transcript || !adDetection) {
    res.status(400).json({ error: 'Missing transcript or adDetection' });
    return;
  }

  if (!LLM_API_KEY) {
    res.json({
      summary: episodeDescription || 'No summary available.',
      topics: [],
      skipMap: adDetection.segments,
      contentDuration: adDetection.contentDuration,
      totalAdTime: adDetection.totalAdTime,
      recommendation: 'Auto-skip enabled for detected ad segments.',
    } as LLMPlaybackConfig);
    return;
  }

  const systemPrompt = `You are a podcast playback assistant. You create concise episode summaries and finalize skip configurations. Return ONLY valid JSON.`;

  const userPrompt = `Prepare a playback configuration for this podcast episode.

Episode: "${episodeTitle}"
Description: "${episodeDescription}"
Content duration: ${adDetection.contentDuration}s
Total ad time: ${adDetection.totalAdTime}s
Detected ad segments: ${JSON.stringify(adDetection.segments)}

Transcript content (first 3000 chars):
${transcript.fullText.slice(0, 3000)}

Produce:
1. A 1-2 sentence summary of what this episode is about
2. 3-5 topic tags
3. The final skipMap (confirmed ad segments to auto-skip) — you may adjust confidence or remove false positives
4. A one-line recommendation for the listener

Return JSON:
{
  "summary": string,
  "topics": [string],
  "skipMap": [{ "startTime": number, "endTime": number, "type": string, "confidence": number, "reason": string }],
  "contentDuration": number,
  "totalAdTime": number,
  "recommendation": string
}`;

  try {
    const { parsed } = await callLLM(systemPrompt, userPrompt, 0.3, 2048);
    res.json(parsed);
  } catch (err: any) {
    console.error('LLM prepare-playback error:', err.message);
    res.status(500).json({ error: 'LLM prepare-playback failed', detail: err.message });
  }
});

// ─── Audio Proxy (to bypass CORS and tracking redirects) ────────────────────

app.get('/api/audio', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'Missing audio URL' });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);

    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');

    const body = response.body;
    if (body) {
      const reader = body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err: any) {
    console.error('Audio proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch audio', detail: err.message });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(path.join(distPath, 'index.html'))) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
const PORT = parseInt(String(process.env.PORT || '5000'), 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NPR Podcast server running on http://0.0.0.0:${PORT}`);
  console.log(`OpenAI model: ${LLM_MODEL}, key: ${LLM_API_KEY ? '***set***' : 'NOT SET (fallback mode)'}`);
});
