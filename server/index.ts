import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import {
  chatJSON,
  registerLLMAdapter,
  type LLMCallOptions,
  type LLMRawResponse,
  type LLMProvider,
  type ChatMessage,
} from '../node_modules/bilko-flow/src/llm/index';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─── LLM Configuration ──────────────────────────────────────────────────────

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai') as LLMProvider;
const LLM_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LLM_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;

// Register a Claude adapter (handles Anthropic API format)
function createClaudeAdapter() {
  return async (options: LLMCallOptions): Promise<LLMRawResponse> => {
    const messages = options.messages.map((m) => ({
      role: m.role === 'system' ? 'user' as const : m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens || 4096,
      messages,
    };
    if (options.systemPrompt) {
      body.system = options.systemPrompt;
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const res = await fetch(options.baseUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Claude API error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const content = data.content?.[0]?.text || '';
    return {
      content,
      finishReason: data.stop_reason,
      usage: {
        promptTokens: data.usage?.input_tokens,
        completionTokens: data.usage?.output_tokens,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  };
}

// Register an OpenAI-compatible adapter
function createOpenAIAdapter() {
  return async (options: LLMCallOptions): Promise<LLMRawResponse> => {
    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const m of options.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      max_tokens: options.maxTokens || 4096,
    };
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.responseFormat) {
      body.response_format = options.responseFormat;
    }

    const baseUrl = options.baseUrl
      ? (options.baseUrl.endsWith('/chat/completions') ? options.baseUrl : `${options.baseUrl}/chat/completions`)
      : 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      finishReason: choice?.finish_reason,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
      },
    };
  };
}

// Register adapters
registerLLMAdapter('claude', createClaudeAdapter());
registerLLMAdapter('openai', createOpenAIAdapter());

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

// ─── Transcript Fetch (raw HTML only — no regex parsing) ────────────────────

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
    // Return raw HTML — LLM will parse it
    res.json({ html });
  } catch (err: any) {
    console.error('Transcript fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch transcript', detail: err.message });
  }
});

// ─── LLM Step: Parse Transcript (ai.generate-text) ─────────────────────────

interface LLMTranscriptSegment {
  speaker: string;
  text: string;
  isAd: boolean;
  adType: string | null;
}

interface LLMTranscriptResult {
  segments: LLMTranscriptSegment[];
  fullText: string;
  adMentions: Array<{
    segmentIndex: number;
    reason: string;
  }>;
  estimatedContentWords: number;
}

app.post('/api/llm/parse-transcript', async (req, res) => {
  const { html } = req.body as { html: string };
  if (!html) {
    res.status(400).json({ error: 'Missing html body' });
    return;
  }

  if (!LLM_API_KEY) {
    // Fallback: extract text minimally so the pipeline still runs without a key
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    res.json({
      segments: [{ speaker: '', text, isAd: false, adType: null }],
      fullText: text,
      adMentions: [],
      estimatedContentWords: text.split(/\s+/).length,
    } as LLMTranscriptResult);
    return;
  }

  // Truncate HTML to fit context window
  const truncatedHtml = html.slice(0, 60000);

  try {
    const result = await chatJSON<LLMTranscriptResult>({
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
      baseUrl: LLM_BASE_URL,
      temperature: 0,
      maxTokens: 4096,
      maxRetries: 2,
      systemPrompt: `You are a podcast transcript parser. You receive raw HTML from an NPR transcript page and extract structured data. Return ONLY valid JSON.`,
      messages: [
        {
          role: 'user',
          content: `Parse this NPR podcast transcript HTML into structured segments.

For each paragraph of spoken content, extract:
- speaker: the speaker name (uppercase, e.g. "DARIAN WOODS") or empty string if unknown
- text: the spoken text content
- isAd: true if this segment is an ad read, sponsor mention, funding credit, or NPR promotional content
- adType: if isAd is true, one of "sponsor_read", "funding_credit", "npr_promo", "show_promo", or null

Also identify all ad mentions with:
- segmentIndex: index into the segments array
- reason: why this was flagged as ad content (e.g. "contains sponsor mention for Squarespace", "NPR funding credit")

Count the number of words in editorial (non-ad) content as estimatedContentWords.

Return JSON matching this schema:
{
  "segments": [{ "speaker": string, "text": string, "isAd": boolean, "adType": string|null }],
  "fullText": string,
  "adMentions": [{ "segmentIndex": number, "reason": string }],
  "estimatedContentWords": number
}

HTML:
${truncatedHtml}`,
        },
      ],
    });

    res.json(result);
  } catch (err: any) {
    console.error('LLM parse-transcript error:', err.message);
    res.status(500).json({ error: 'LLM parse failed', detail: err.message });
  }
});

// ─── LLM Step: Detect Ad Segments (ai.generate-text) ───────────────────────

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

  if (!LLM_API_KEY) {
    // No-key fallback: basic heuristic
    const segments: LLMAdSegment[] = [];
    if (audioDurationSeconds > 120) {
      segments.push({ startTime: 0, endTime: 30, type: 'pre-roll', confidence: 0.5, reason: 'heuristic fallback' });
    }
    if (audioDurationSeconds > 300) {
      const mid = audioDurationSeconds * 0.48;
      segments.push({ startTime: mid, endTime: mid + 60, type: 'mid-roll', confidence: 0.4, reason: 'heuristic fallback' });
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

  try {
    const result = await chatJSON<LLMAdDetectionResult>({
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
      baseUrl: LLM_BASE_URL,
      temperature: 0,
      maxTokens: 4096,
      maxRetries: 2,
      systemPrompt: `You are an ad detection engine for NPR podcasts. You analyze transcript structure and audio metadata to identify dynamically inserted ad segments. Return ONLY valid JSON.`,
      messages: [
        {
          role: 'user',
          content: `Analyze this podcast episode and identify all ad segments with precise time estimates.

Episode: "${episodeTitle}"
Total audio duration: ${audioDurationSeconds} seconds
Transcript editorial word count: ${transcript.estimatedContentWords}
Number of transcript segments: ${transcript.segments.length}
Number of ad mentions found in transcript: ${transcript.adMentions.length}
Ad mentions: ${JSON.stringify(transcript.adMentions.slice(0, 20))}

Key context:
- NPR podcasts use Megaphone for dynamic ad insertion
- The transcript contains ONLY editorial content (no ad copy)
- The difference between audio duration and expected speech duration (at ~155 words/minute) indicates total ad time
- NPR typically places ads as: pre-roll (beginning), mid-roll (middle), post-roll (end credits/funding)
- Sponsor reads within editorial content are different from inserted ads
- Ad mentions in the transcript (funding credits, sponsor reads) indicate editorial ad content that IS in the transcript

For each detected ad segment, provide:
- startTime/endTime in seconds
- type: "pre-roll", "mid-roll", "post-roll", or "sponsor-mention"
- confidence: 0.0-1.0
- reason: explanation of why this was identified as an ad

Return JSON:
{
  "segments": [{ "startTime": number, "endTime": number, "type": string, "confidence": number, "reason": string }],
  "totalAdTime": number,
  "contentDuration": number,
  "strategy": "llm-transcript-analysis"
}`,
        },
      ],
    });

    res.json(result);
  } catch (err: any) {
    console.error('LLM detect-ads error:', err.message);
    res.status(500).json({ error: 'LLM ad detection failed', detail: err.message });
  }
});

// ─── LLM Step: Prepare Player (ai.summarize) ───────────────────────────────

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

  try {
    const result = await chatJSON<LLMPlaybackConfig>({
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
      baseUrl: LLM_BASE_URL,
      temperature: 0.3,
      maxTokens: 2048,
      maxRetries: 2,
      systemPrompt: `You are a podcast playback assistant. You create concise episode summaries and finalize skip configurations. Return ONLY valid JSON.`,
      messages: [
        {
          role: 'user',
          content: `Prepare a playback configuration for this podcast episode.

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
}`,
        },
      ],
    });

    res.json(result);
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
  console.log(`LLM provider: ${LLM_PROVIDER}, model: ${LLM_MODEL}, key: ${LLM_API_KEY ? '***set***' : 'NOT SET (fallback mode)'}`);
});
