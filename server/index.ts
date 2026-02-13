import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import { speechToText, ensureCompatibleFormat, openai as sttOpenai } from './replit_integrations/audio/client';

// ─── LLM types & helpers (inlined to avoid bilko-flow ESM/CJS mismatch) ─────

type LLMProvider = 'openai' | 'claude' | 'gemini' | 'ollama' | 'vllm' | 'tgi' | 'local-ai' | 'custom';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMCallOptions {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

interface LLMRawResponse {
  content: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

type LLMAdapter = (options: LLMCallOptions) => Promise<LLMRawResponse>;

const llmAdapters = new Map<LLMProvider, LLMAdapter>();

function registerLLMAdapter(provider: LLMProvider, adapter: LLMAdapter): void {
  llmAdapters.set(provider, adapter);
}

const JSON_MODE_PROVIDERS = new Set<LLMProvider>(['openai', 'gemini', 'ollama', 'vllm', 'tgi', 'local-ai']);

async function chatJSON<T>(options: {
  provider: LLMProvider;
  model: string;
  messages: ChatMessage[];
  systemPrompt?: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  maxRetries?: number;
}): Promise<T> {
  if (!options.apiKey) {
    throw new Error(`API key is required for provider "${options.provider}".`);
  }

  const adapter = llmAdapters.get(options.provider);
  if (!adapter) {
    throw new Error(`No adapter registered for LLM provider: ${options.provider}.`);
  }

  const useJsonMode = JSON_MODE_PROVIDERS.has(options.provider);
  const response = await adapter({
    provider: options.provider,
    model: options.model,
    messages: options.messages,
    systemPrompt: options.systemPrompt,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    responseFormat: useJsonMode ? { type: 'json_object' } : undefined,
  });

  const trimmed = response.content.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new Error(`LLM response is not valid JSON: ${err instanceof Error ? err.message : 'unknown'}\nRaw: ${trimmed.slice(0, 500)}`);
  }
}

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

interface PodcastTranscript {
  url: string;
  type: string; // e.g. "application/x-subrip", "text/vtt", "text/html", "application/json"
}

interface Episode {
  id: string;
  title: string;
  description: string;
  pubDate: string;
  duration: string;
  audioUrl: string;
  link: string;
  transcriptUrl: string | null;
  podcastTranscripts: PodcastTranscript[];
}

// ─── Sample fallback episodes (used when RSS feed is unreachable) ────────────

function getSampleEpisodes(podcastId: string): Episode[] {
  const samples: Record<string, Episode[]> = {
    '510325': [
      { id: 'sample-1', title: 'Why Egg Prices Are So High', description: 'Bird flu has devastated chicken flocks, driving egg prices to record highs.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '9:32', audioUrl: 'https://play.podtrac.com/npr-510325/traffic.megaphone.fm/NPR7910006498.mp3', link: 'https://www.npr.org/2025/02/10/1298765432/why-egg-prices-are-so-high', transcriptUrl: 'https://www.npr.org/transcripts/1298765432', podcastTranscripts: [] },
      { id: 'sample-2', title: 'The Rise of Buy Now, Pay Later', description: 'How installment payments are changing the way consumers shop.', pubDate: 'Fri, 07 Feb 2025 20:00:00 GMT', duration: '10:15', audioUrl: '', link: '', transcriptUrl: null, podcastTranscripts: [] },
      { id: 'sample-3', title: 'What Tariffs Actually Do', description: 'A look at how tariffs affect prices, businesses, and trade.', pubDate: 'Thu, 06 Feb 2025 20:00:00 GMT', duration: '8:47', audioUrl: '', link: '', transcriptUrl: null, podcastTranscripts: [] },
    ],
    '510289': [
      { id: 'sample-6', title: 'The Invention of Money', description: 'The story of how money was invented — twice.', pubDate: 'Fri, 07 Feb 2025 20:00:00 GMT', duration: '22:14', audioUrl: '', link: '', transcriptUrl: null, podcastTranscripts: [] },
      { id: 'sample-7', title: 'The Great Inflation', description: 'How Paul Volcker broke the back of inflation in the early 1980s.', pubDate: 'Wed, 05 Feb 2025 20:00:00 GMT', duration: '24:30', audioUrl: '', link: '', transcriptUrl: null, podcastTranscripts: [] },
    ],
  };
  return samples[podcastId] || [
    { id: 'sample-default', title: 'Sample Episode', description: 'A sample episode for demonstration.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '10:00', audioUrl: '', link: '', transcriptUrl: null, podcastTranscripts: [] },
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

      // Extract <podcast:transcript> tags (Podcast 2.0 namespace)
      const podcastTranscripts: PodcastTranscript[] = [];
      const transcriptTags = item['podcast:transcript'];
      if (transcriptTags) {
        const tagList = Array.isArray(transcriptTags) ? transcriptTags : [transcriptTags];
        for (const tag of tagList) {
          const url = tag?.['@_url'] || tag?.url || (typeof tag === 'string' ? tag : '');
          const type = tag?.['@_type'] || tag?.type || '';
          if (url) {
            podcastTranscripts.push({ url, type });
          }
        }
      }

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
        podcastTranscripts,
      };
    });

    res.json({
      podcastName: podcast.name,
      episodes,
    });
  } catch (err: any) {
    console.error('RSS fetch error:', err.message, '— returning sample episodes');
    const fallback = getSampleEpisodes(req.params.id);
    res.json({
      podcastName: podcast.name,
      episodes: fallback,
    });
  }
});

// ─── Transcript Fetch (supports HTML, SRT, VTT) ─────────────────────────────

app.get('/api/transcript', async (req, res) => {
  const url = req.query.url as string;
  const format = (req.query.format as string) || 'html'; // 'html', 'srt', 'vtt', 'json'
  if (!url) {
    res.status(400).json({ error: 'Missing transcript URL' });
    return;
  }

  try {
    const acceptHeader = format === 'html' ? 'text/html' : '*/*';
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: acceptHeader,
      },
    });
    if (!response.ok) throw new Error(`Transcript fetch failed: ${response.status}`);

    const content = await response.text();

    if (format === 'srt' || format === 'vtt' || format === 'json') {
      // Return pre-parsed lines for non-HTML formats
      let lines: SandboxLine[];
      if (format === 'srt') {
        lines = parseSrtToLines(content);
      } else if (format === 'vtt') {
        lines = parseVttToLines(content);
      } else {
        lines = parseJsonTranscriptToLines(content);
      }
      res.json({ format, lines, raw: content.slice(0, 2000) });
    } else {
      // HTML — return raw HTML for LLM parsing, but also provide pre-parsed lines
      const lines = parseTranscriptToLines(content);
      res.json({ html: content, lines, format: 'html' });
    }
  } catch (err: any) {
    console.error('Transcript fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch transcript', detail: err.message });
  }
});

// ─── LLM Step: Parse Transcript (ai.generate-text) ─────────────────────────

// ─── Audio Transcription (speech-to-text via OpenAI) ─────────────────────────

/**
 * Fetch audio from URL and transcribe it using OpenAI's gpt-4o-mini-transcribe.
 * Returns structured transcript with timestamps when available.
 */
async function transcribeAudioFromUrl(audioUrl: string): Promise<{
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  lines: SandboxLine[];
  durationSec: number;
}> {
  // Step 1: Download the audio file
  console.log(`[transcribe] Fetching audio: ${audioUrl.slice(0, 80)}...`);
  const audioRes = await fetch(audioUrl, {
    headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
    redirect: 'follow',
  });
  if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);

  const arrayBuf = await audioRes.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuf);
  console.log(`[transcribe] Audio downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // Step 2: Ensure compatible format (MP3 passes through, others get converted)
  const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

  // Step 3: Transcribe with verbose_json for timestamps
  // Try verbose_json first for segment timestamps, fall back to plain text
  let fullText = '';
  let segments: Array<{ start: number; end: number; text: string }> = [];
  let audioDuration = 0;

  try {
    // Use the OpenAI client directly for verbose_json response format
    const { toFile } = await import('openai');
    const file = await toFile(buffer, `audio.${format}`);
    const verboseResult = await sttOpenai.audio.transcriptions.create({
      file,
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
    }) as any;

    fullText = verboseResult.text || '';
    audioDuration = verboseResult.duration || 0;
    segments = (verboseResult.segments || []).map((s: any) => ({
      start: s.start || 0,
      end: s.end || 0,
      text: (s.text || '').trim(),
    }));
    console.log(`[transcribe] Got ${segments.length} segments, duration=${audioDuration}s`);
  } catch (verboseErr: any) {
    // Fall back to plain text transcription
    console.warn(`[transcribe] verbose_json failed (${verboseErr.message}), falling back to plain text`);
    fullText = await speechToText(buffer, format);
    console.log(`[transcribe] Got plain text: ${fullText.length} chars`);
  }

  // Step 4: Convert to SandboxLine format
  const lines: SandboxLine[] = [];
  let cumulative = 0;
  let lineNum = 0;

  if (segments.length > 0) {
    // We have timestamped segments — use them directly
    for (const seg of segments) {
      if (!seg.text) continue;

      let speaker = '';
      let content = seg.text;

      // Detect speaker pattern: "SPEAKER NAME:" at start
      const speakerMatch = content.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        content = content.slice(speakerMatch[0].length).trim();
      }

      if (!content) continue;

      lineNum++;
      const wc = content.split(/\s+/).filter(Boolean).length;
      cumulative += wc;

      lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
    }
  } else {
    // Plain text — split into sentences/paragraphs
    const sentences = fullText.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    for (const sentence of sentences) {
      let speaker = '';
      let content = sentence.trim();

      const speakerMatch = content.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        content = content.slice(speakerMatch[0].length).trim();
      }

      if (!content) continue;

      lineNum++;
      const wc = content.split(/\s+/).filter(Boolean).length;
      cumulative += wc;

      lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
    }
  }

  return { text: fullText, segments, lines, durationSec: audioDuration };
}

app.post('/api/transcribe', async (req, res) => {
  const { audioUrl } = req.body as { audioUrl: string };
  if (!audioUrl) {
    res.status(400).json({ error: 'Missing audioUrl' });
    return;
  }

  try {
    const result = await transcribeAudioFromUrl(audioUrl);
    res.json({
      text: result.text,
      segments: result.segments,
      lines: result.lines,
      totalWords: result.lines.length > 0 ? result.lines[result.lines.length - 1].cumulativeWords : 0,
      durationSec: result.durationSec,
      source: 'audio-transcription',
    });
  } catch (err: any) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Transcription failed', detail: err.message });
  }
});

// ─── LLM Pipeline ────────────────────────────────────────────────────────────

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

  // Pre-parse HTML using our improved extraction before sending to LLM
  const preParsedLines = parseTranscriptToLines(html);
  const preParseValid = preParsedLines.length >= 5;

  if (!LLM_API_KEY) {
    // Fallback: use our pre-parsed lines instead of raw HTML stripping
    let segments: LLMTranscriptSegment[];
    let fullText: string;
    let estimatedContentWords: number;

    if (preParseValid) {
      segments = preParsedLines.map(l => ({
        speaker: l.speaker,
        text: l.text,
        isAd: false,
        adType: null,
      }));
      fullText = preParsedLines.map(l => {
        const spk = l.speaker ? `${l.speaker}: ` : '';
        return `${spk}${l.text}`;
      }).join('\n');
      estimatedContentWords = preParsedLines[preParsedLines.length - 1].cumulativeWords;
    } else {
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      segments = [{ speaker: '', text, isAd: false, adType: null }];
      fullText = text;
      estimatedContentWords = text.split(/\s+/).length;
    }

    res.json({
      segments,
      fullText,
      adMentions: [],
      estimatedContentWords,
    } as LLMTranscriptResult);
    return;
  }

  // ── Pre-parsed path: build segments server-side, ask LLM only for ad flags ──
  // This dramatically reduces output token requirements and avoids truncation
  // on long transcripts (the main cause of 500 errors).
  if (preParseValid) {
    // Build segments and fullText server-side from pre-parsed lines
    const segments: LLMTranscriptSegment[] = preParsedLines.map(l => ({
      speaker: l.speaker,
      text: l.text,
      isAd: false,
      adType: null,
    }));
    const fullText = preParsedLines.map(l => {
      const spk = l.speaker ? `${l.speaker}: ` : '';
      return `${spk}${l.text}`;
    }).join('\n');
    const totalWords = preParsedLines[preParsedLines.length - 1].cumulativeWords;

    // Build a compact numbered version of the transcript for the LLM.
    // Cap at ~50,000 chars to stay well within context window limits.
    let compactInput = '';
    for (let i = 0; i < preParsedLines.length; i++) {
      const l = preParsedLines[i];
      const spk = l.speaker ? `${l.speaker}: ` : '';
      const line = `[${i}] ${spk}${l.text}\n`;
      if (compactInput.length + line.length > 50000) break;
      compactInput += line;
    }

    try {
      // Lightweight LLM call: only ask for ad classification by segment index
      const adResult = await chatJSON<{
        adSegments: Array<{ index: number; adType: string; reason: string }>;
        estimatedContentWords: number;
      }>({
        provider: LLM_PROVIDER,
        model: LLM_MODEL,
        apiKey: LLM_API_KEY,
        baseUrl: LLM_BASE_URL,
        temperature: 0,
        maxTokens: 4096,
        maxRetries: 2,
        systemPrompt: `You are a podcast ad detector. You receive a numbered transcript and identify which segments are ads, sponsor reads, funding credits, or promotional content. Return ONLY valid JSON.`,
        messages: [
          {
            role: 'user',
            content: `Analyze this NPR podcast transcript. Each line is numbered [index].

Identify which segments are ad reads, sponsor mentions, funding credits, or NPR promotional content.

Return JSON matching this schema:
{
  "adSegments": [{ "index": number, "adType": "sponsor_read"|"funding_credit"|"npr_promo"|"show_promo", "reason": string }],
  "estimatedContentWords": number
}

- "index" is the segment number from the transcript
- "adType" classifies the ad
- "reason" explains why (e.g. "contains sponsor mention for Squarespace")
- "estimatedContentWords" is the total word count of non-ad segments (total is ~${totalWords} words)

TRANSCRIPT:
${compactInput}`,
          },
        ],
      });

      // Merge ad flags into pre-built segments
      const adMentions: LLMTranscriptResult['adMentions'] = [];
      for (const ad of adResult.adSegments || []) {
        if (ad.index >= 0 && ad.index < segments.length) {
          segments[ad.index].isAd = true;
          segments[ad.index].adType = ad.adType || null;
          adMentions.push({ segmentIndex: ad.index, reason: ad.reason });
        }
      }

      res.json({
        segments,
        fullText,
        adMentions,
        estimatedContentWords: adResult.estimatedContentWords || totalWords,
      } as LLMTranscriptResult);
    } catch (err: any) {
      // Graceful fallback: return pre-parsed data without ad flags rather than 500
      console.error('LLM ad-classification failed, using fallback:', err.message);
      res.json({
        segments,
        fullText,
        adMentions: [],
        estimatedContentWords: totalWords,
      } as LLMTranscriptResult);
    }
    return;
  }

  // ── Fallback path: raw HTML when pre-parse fails (< 5 lines) ──────────────
  const transcriptSection = extractTranscriptSection(html);
  const llmInput = transcriptSection.slice(0, 60000);

  try {
    const result = await chatJSON<LLMTranscriptResult>({
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      apiKey: LLM_API_KEY,
      baseUrl: LLM_BASE_URL,
      temperature: 0,
      maxTokens: 16384,
      maxRetries: 2,
      systemPrompt: `You are a podcast transcript parser. You receive raw HTML from an NPR transcript page and extract structured data. Return ONLY valid JSON.`,
      messages: [
        {
          role: 'user',
          content: `Parse this NPR podcast transcript into structured segments.

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
${llmInput}`,
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

// ─── Sandbox: full transcript + ad-block analysis ───────────────────────────

interface SandboxLine {
  lineNum: number;
  speaker: string;
  text: string;
  wordCount: number;
  cumulativeWords: number;
}

interface SandboxAdBlock {
  startLine: number;
  endLine: number;
  reason: string;
  textPreview: string;
  startWord: number;
  endWord: number;
  startTimeSec: number;
  endTimeSec: number;
}

// ─── Transcript Extraction Utilities ─────────────────────────────────────────

/**
 * Extract the transcript-specific section from NPR HTML pages.
 * NPR transcript pages embed the actual transcript inside specific containers.
 * This function tries multiple strategies to isolate the transcript from page chrome.
 */
function extractTranscriptSection(html: string): string {
  // Strategy 1: Look for known transcript container patterns
  // NPR uses various containers depending on the page version
  const containerPatterns = [
    // Modern NPR transcript pages
    /<div[^>]*\bclass="[^"]*\btranscript\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*\bclass="[^"]*\b(?:footer|related|sidebar)\b)/i,
    // Older NPR transcript pages with storytext class
    /<div[^>]*\bclass="[^"]*\bstorytext\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    // Article body container
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    // Look for a section with id="transcript" or id="storytext"
    /<(?:div|section)[^>]*\bid=["'](?:transcript|storytext)["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
  ];

  for (const pattern of containerPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      // Verify this section actually has transcript-like content
      const section = match[1];
      const pCount = (section.match(/<p[^>]*>/gi) || []).length;
      if (pCount >= 5) {
        return section;
      }
    }
  }

  // Strategy 2: Find the largest cluster of <p> tags that contain speaker patterns.
  // NPR transcripts have patterns like "<b>SPEAKER NAME:</b> text"
  // or "<p><strong>SPEAKER:</strong> text</p>"
  const speakerPattern = /<p[^>]*>[\s\S]*?(?:<b>|<strong>)[A-Z][A-Z\s'.,-]+:[\s\S]*?<\/p>/gi;
  const speakerParagraphs = html.match(speakerPattern) || [];

  if (speakerParagraphs.length >= 3) {
    // Find the region of HTML that contains these speaker paragraphs
    const firstIdx = html.indexOf(speakerParagraphs[0]);
    const lastParagraph = speakerParagraphs[speakerParagraphs.length - 1];
    const lastIdx = html.lastIndexOf(lastParagraph) + lastParagraph.length;
    if (firstIdx !== -1 && lastIdx > firstIdx) {
      return html.slice(firstIdx, lastIdx);
    }
  }

  // Strategy 3: No container found — return the full HTML
  // (the p-tag extraction will still filter, but results may be noisy)
  return html;
}

/**
 * Clean HTML entity references and tags from a text block.
 */
function cleanHtmlText(block: string): string {
  return block
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect if a text line is page chrome (navigation, metadata, JS) rather than transcript content.
 */
function isPageChrome(text: string): boolean {
  // Skip very short lines that are likely nav items
  if (text.length < 10) return true;

  // Skip lines that look like JavaScript
  if (/^(?:var |function |window\.|document\.|if\s*\(|for\s*\()/.test(text)) return true;
  if (text.includes('createElement') || text.includes('getElementsBy') || text.includes('addEventListener')) return true;

  // Skip lines that contain JSON-LD or structured data
  if (text.includes('"@type"') || text.includes('"@context"') || text.includes('ImageObject')) return true;

  // Skip navigation-like content
  if (/^(?:Skip to|Keyboard shortcuts|Open Navigation|Close Navigation|Expand\/collapse)/i.test(text)) return true;
  if (/^(?:Home|News|Music|Culture|Podcasts & Shows|Search|Newsletters|NPR Shop)\s*$/i.test(text)) return true;

  // Skip NPR page footer/header elements
  if (/^(?:About NPR|Diversity|Support|Careers|Press|Ethics)\s*$/i.test(text)) return true;
  if (/^(?:LISTEN & FOLLOW|NPR App|Apple Podcasts|Spotify|Amazon Music|iHeart Radio|YouTube Music)\s*$/i.test(text)) return true;

  // Skip "Sponsor Message" / "Become an NPR sponsor" page elements (not transcript content)
  if (/^(?:Sponsor Message|Become an NPR sponsor)\s*$/i.test(text)) return true;

  // Skip lines with excessive URLs or technical content
  const urlCount = (text.match(/https?:\/\//g) || []).length;
  if (urlCount > 2) return true;

  // Skip very long lines (>2000 chars) — real transcript paragraphs are rarely this long
  if (text.length > 2000) return true;

  // Skip lines that are just image captions (contain "hide caption" or photo credit patterns)
  if (/\bhide caption\b/i.test(text)) return true;
  if (/\(Photo by [^)]+\)/i.test(text) && text.length < 300) return true;

  return false;
}

function parseTranscriptToLines(html: string): SandboxLine[] {
  // First, try to extract just the transcript section from the full page
  const transcriptSection = extractTranscriptSection(html);

  const lines: SandboxLine[] = [];
  const pBlocks = transcriptSection.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];

  let cumulative = 0;
  let lineNum = 0;

  for (const block of pBlocks) {
    const text = cleanHtmlText(block);

    if (!text || text.length < 3) continue;

    // Filter out page chrome
    if (isPageChrome(text)) continue;

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

/**
 * Parse SRT (SubRip) transcript format into lines.
 * SRT format:
 *   1
 *   00:00:01,000 --> 00:00:04,000
 *   Speaker: Text here
 */
function parseSrtToLines(srt: string): SandboxLine[] {
  const lines: SandboxLine[] = [];
  // Split into subtitle blocks (separated by blank lines)
  const blocks = srt.trim().split(/\n\s*\n/);
  let cumulative = 0;
  let lineNum = 0;

  for (const block of blocks) {
    const blockLines = block.trim().split('\n');
    // SRT blocks have: index, timestamp, text (1+ lines)
    if (blockLines.length < 3) continue;

    // Skip the index line and timestamp line, get text
    const textLines = blockLines.slice(2);
    const fullText = textLines.join(' ').trim();
    if (!fullText) continue;

    let speaker = '';
    let content = fullText;

    // Check for speaker pattern: "<v Speaker Name>text" (WebVTT voice tag in SRT)
    const voiceMatch = fullText.match(/^<v\s+([^>]+)>\s*/);
    if (voiceMatch) {
      speaker = voiceMatch[1].trim();
      content = fullText.slice(voiceMatch[0].length).replace(/<\/v>/g, '').trim();
    } else {
      // Check for "SPEAKER:" pattern
      const speakerMatch = fullText.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        content = fullText.slice(speakerMatch[0].length).trim();
      }
    }

    if (!content) continue;

    lineNum++;
    const wc = content.split(/\s+/).filter(Boolean).length;
    cumulative += wc;

    lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
  }

  return lines;
}

/**
 * Parse WebVTT transcript format into lines.
 * VTT format:
 *   WEBVTT
 *
 *   00:00:01.000 --> 00:00:04.000
 *   <v Speaker>Text here</v>
 */
function parseVttToLines(vtt: string): SandboxLine[] {
  const lines: SandboxLine[] = [];
  // Remove WEBVTT header and metadata
  const content = vtt.replace(/^WEBVTT[^\n]*\n(?:[\w-]+:[^\n]*\n)*/i, '').trim();
  // Split into cue blocks
  const blocks = content.split(/\n\s*\n/);
  let cumulative = 0;
  let lineNum = 0;

  for (const block of blocks) {
    const blockLines = block.trim().split('\n');
    // Find the timestamp line
    let textStart = 0;
    for (let i = 0; i < blockLines.length; i++) {
      if (blockLines[i].includes('-->')) {
        textStart = i + 1;
        break;
      }
    }
    if (textStart === 0 || textStart >= blockLines.length) continue;

    const textLines = blockLines.slice(textStart);
    const fullText = textLines.join(' ').trim();
    if (!fullText) continue;

    let speaker = '';
    let cueText = fullText;

    // WebVTT voice tags: <v Speaker Name>text</v>
    const voiceMatch = fullText.match(/^<v\s+([^>]+)>\s*/);
    if (voiceMatch) {
      speaker = voiceMatch[1].trim();
      cueText = fullText.slice(voiceMatch[0].length).replace(/<\/v>/g, '').trim();
    } else {
      const speakerMatch = fullText.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        cueText = fullText.slice(speakerMatch[0].length).trim();
      }
    }

    // Strip any remaining VTT tags
    cueText = cueText.replace(/<[^>]*>/g, '').trim();
    if (!cueText) continue;

    lineNum++;
    const wc = cueText.split(/\s+/).filter(Boolean).length;
    cumulative += wc;

    lines.push({ lineNum, speaker, text: cueText, wordCount: wc, cumulativeWords: cumulative });
  }

  return lines;
}

/**
 * Parse JSON transcript format (Podcast 2.0 JSON format) into lines.
 */
function parseJsonTranscriptToLines(json: string): SandboxLine[] {
  const lines: SandboxLine[] = [];
  let cumulative = 0;
  let lineNum = 0;

  try {
    const data = JSON.parse(json);
    // Podcast 2.0 JSON transcript format has a "segments" array
    const segments = data.segments || data.cues || data.transcript || (Array.isArray(data) ? data : []);

    for (const seg of segments) {
      const text = (seg.body || seg.text || seg.content || '').trim();
      if (!text) continue;

      const speaker = seg.speaker || seg.voice || '';

      lineNum++;
      const wc = text.split(/\s+/).filter(Boolean).length;
      cumulative += wc;

      lines.push({ lineNum, speaker, text, wordCount: wc, cumulativeWords: cumulative });
    }
  } catch {
    // Invalid JSON — return empty
  }

  return lines;
}

/**
 * Validate that parsed transcript lines look like an actual podcast transcript.
 * Returns a diagnostic object.
 */
function validateTranscript(lines: SandboxLine[], durationSec: number): {
  isValid: boolean;
  reason: string;
  details: {
    lineCount: number;
    totalWords: number;
    linesWithSpeaker: number;
    expectedMinWords: number;
    avgWordsPerLine: number;
  };
} {
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const linesWithSpeaker = lines.filter(l => l.speaker).length;
  // At ~155 words/minute, a 10-min episode should have ~1550 words
  // Use a generous minimum: 30% of expected as threshold
  const expectedMinWords = durationSec > 0 ? Math.floor((durationSec / 60) * 155 * 0.3) : 100;
  const avgWordsPerLine = lines.length > 0 ? totalWords / lines.length : 0;

  const details = { lineCount: lines.length, totalWords, linesWithSpeaker, expectedMinWords, avgWordsPerLine };

  if (lines.length < 5) {
    return { isValid: false, reason: `Only ${lines.length} lines parsed — too few for a real transcript`, details };
  }

  if (totalWords < expectedMinWords) {
    return { isValid: false, reason: `Only ${totalWords} words parsed (expected at least ${expectedMinWords} for ${Math.round(durationSec / 60)}min episode)`, details };
  }

  if (lines.length > 5 && avgWordsPerLine > 500) {
    return { isValid: false, reason: `Average ${Math.round(avgWordsPerLine)} words/line — likely extracted page content, not transcript`, details };
  }

  return { isValid: true, reason: 'Transcript looks valid', details };
}

function mapAdBlocksToTimestamps(
  blocks: SandboxAdBlock[],
  lines: SandboxLine[],
  durationSec: number,
): SandboxAdBlock[] {
  if (lines.length === 0 || durationSec === 0) return blocks;

  const totalWords = lines[lines.length - 1].cumulativeWords;
  const lineMap = new Map<number, SandboxLine>();
  for (const l of lines) lineMap.set(l.lineNum, l);

  for (const b of blocks) {
    const startLine = lineMap.get(b.startLine);
    const endLine = lineMap.get(b.endLine);
    if (!startLine || !endLine) continue;

    b.startWord = startLine.cumulativeWords - startLine.wordCount;
    b.endWord = endLine.cumulativeWords;
    b.startTimeSec = (b.startWord / totalWords) * durationSec;
    b.endTimeSec = (b.endWord / totalWords) * durationSec;
  }

  return blocks;
}

app.post('/api/sandbox/analyze', async (req, res) => {
  const { transcriptUrl, episodeTitle, durationSec, podcastTranscripts, audioUrl } = req.body as {
    transcriptUrl: string;
    episodeTitle: string;
    durationSec: number;
    podcastTranscripts?: PodcastTranscript[];
    audioUrl?: string;
  };

  if (!transcriptUrl && !audioUrl && (!podcastTranscripts || podcastTranscripts.length === 0)) {
    res.status(400).json({ error: 'Missing transcriptUrl, audioUrl, or podcastTranscripts' });
    return;
  }

  try {
    let html = '';
    let rawHtmlLength = 0;
    let pTagCount = 0;
    let lines: SandboxLine[] = [];
    let transcriptSource = 'html';

    // Step 1: PREFERRED — Transcribe the actual audio file (captures dynamic ads)
    if (audioUrl && lines.length === 0) {
      try {
        console.log(`[sandbox] Transcribing audio for "${episodeTitle}"...`);
        const transcription = await transcribeAudioFromUrl(audioUrl);
        lines = transcription.lines;
        transcriptSource = 'audio-transcription';
        html = transcription.text; // Store raw text for reference
        rawHtmlLength = transcription.text.length;
        console.log(`[sandbox] Audio transcription: ${lines.length} lines, ${transcription.lines.length > 0 ? transcription.lines[transcription.lines.length - 1].cumulativeWords : 0} words`);
      } catch (sttErr: any) {
        console.warn(`[sandbox] Audio transcription failed: ${sttErr.message} — falling back to text transcript`);
      }
    }

    // Step 2: Try direct podcast transcript files (SRT, VTT, JSON from RSS)
    if (lines.length === 0 && podcastTranscripts && podcastTranscripts.length > 0) {
      const preferred = [...podcastTranscripts].sort((a, b) => {
        const priority: Record<string, number> = {
          'application/x-subrip': 1, 'application/srt': 1,
          'text/vtt': 2,
          'application/json': 3,
          'text/html': 4, 'text/plain': 5,
        };
        return (priority[a.type] || 6) - (priority[b.type] || 6);
      });

      for (const transcript of preferred) {
        try {
          const tRes = await fetch(transcript.url, {
            headers: { 'User-Agent': 'NPR-Podcast-Player/1.0', Accept: '*/*' },
          });
          if (!tRes.ok) continue;
          const content = await tRes.text();

          if (transcript.type.includes('subrip') || transcript.type.includes('srt')) {
            lines = parseSrtToLines(content);
            transcriptSource = 'srt';
          } else if (transcript.type.includes('vtt')) {
            lines = parseVttToLines(content);
            transcriptSource = 'vtt';
          } else if (transcript.type.includes('json')) {
            lines = parseJsonTranscriptToLines(content);
            transcriptSource = 'json';
          }

          if (lines.length >= 5) {
            html = content;
            rawHtmlLength = content.length;
            break;
          }
          lines = [];
        } catch {
          continue;
        }
      }
    }

    // Step 3: Fall back to NPR transcript HTML page
    if (lines.length === 0 && transcriptUrl) {
      try {
        const htmlRes = await fetch(transcriptUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html',
          },
        });
        if (!htmlRes.ok) throw new Error(`Transcript fetch failed: ${htmlRes.status}`);
        html = await htmlRes.text();
        rawHtmlLength = html.length;
        pTagCount = (html.match(/<p[^>]*>/gi) || []).length;
        transcriptSource = 'html';
        lines = parseTranscriptToLines(html);
      } catch (htmlErr: any) {
        console.warn(`[sandbox] HTML transcript fetch failed: ${htmlErr.message}`);
      }
    }

    // Step 4: Last resort — use episode description as minimal content
    if (lines.length === 0 && episodeTitle) {
      const desc = `This is the episode "${episodeTitle}". Transcript could not be fetched — audio transcription, podcast transcript files, and HTML scraping all failed or were unavailable.`;
      lines = [{ lineNum: 1, speaker: '', text: desc, wordCount: desc.split(/\s+/).length, cumulativeWords: desc.split(/\s+/).length }];
      transcriptSource = 'fallback';
      html = desc;
      rawHtmlLength = desc.length;
    }

    const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

    // Validate transcript quality
    const validation = validateTranscript(lines, durationSec || 0);
    if (!validation.isValid) {
      console.warn(`Transcript validation failed for "${episodeTitle}": ${validation.reason}`);
    }

    // Step 3: Build numbered transcript for LLM
    const numberedText = lines.map(l => {
      const spk = l.speaker ? `${l.speaker}: ` : '';
      return `[${l.lineNum}] ${spk}${l.text}`;
    }).join('\n');

    const systemPrompt = `You are an ad-block detector for podcast transcripts. You read the full transcript and identify contiguous blocks of lines that are advertisements, sponsor reads, funding credits, or promotional content — NOT editorial content.

IMPORTANT: You are looking for OBVIOUS ad blocks. These are contiguous runs of lines where the content is clearly commercial/promotional. Typical patterns:
- "Support for this podcast comes from..."
- "This message comes from..."
- Sponsor descriptions with calls-to-action ("visit example.com", "use promo code...")
- NPR funding credits ("Support for NPR comes from...")
- Show promos ("Coming up on..." for a different show)

These ad blocks are typically 1-5 lines long and there are at most a few per episode. They are VERY obvious — a human would spot them instantly.

Do NOT flag: regular editorial discussion about economics/business/companies, interview content, the host's own commentary, or transitions between topics.

Return ONLY valid JSON.`;

    const userPrompt = `Here is the full transcript of "${episodeTitle || 'Unknown Episode'}" with numbered lines.
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

    // Step 4: Call LLM (or fallback)
    let adBlocks: SandboxAdBlock[] = [];
    let llmRaw = '';

    if (LLM_API_KEY) {
      const result = await chatJSON<{ adBlocks: Array<{ startLine: number; endLine: number; reason: string }> }>({
        provider: LLM_PROVIDER,
        model: LLM_MODEL,
        apiKey: LLM_API_KEY,
        baseUrl: LLM_BASE_URL,
        temperature: 0,
        maxTokens: 2048,
        maxRetries: 2,
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      llmRaw = JSON.stringify(result, null, 2);
      adBlocks = (result.adBlocks || []).map(b => ({
        startLine: b.startLine,
        endLine: b.endLine,
        reason: b.reason,
        textPreview: lines
          .filter(l => l.lineNum >= b.startLine && l.lineNum <= b.endLine)
          .map(l => l.text)
          .join(' ')
          .slice(0, 300),
        startWord: 0,
        endWord: 0,
        startTimeSec: 0,
        endTimeSec: 0,
      }));
    } else {
      // No-key heuristic: scan for obvious patterns
      llmRaw = '(no LLM key — using keyword heuristic)';
      for (const l of lines) {
        const lower = l.text.toLowerCase();
        if (
          lower.includes('support for this podcast') ||
          lower.includes('this message comes from') ||
          lower.includes('support for npr') ||
          lower.match(/sponsor(?:ed by|s?\b)/)
        ) {
          adBlocks.push({
            startLine: l.lineNum,
            endLine: l.lineNum,
            reason: 'Keyword match (no LLM): ' + l.text.slice(0, 60),
            textPreview: l.text.slice(0, 300),
            startWord: 0,
            endWord: 0,
            startTimeSec: 0,
            endTimeSec: 0,
          });
        }
      }
    }

    // Step 5: Map to timestamps
    const dur = durationSec || 0;
    adBlocks = mapAdBlocksToTimestamps(adBlocks, lines, dur);

    // Build skip map
    const skipMap = adBlocks.map(b => ({
      startTime: Math.round(b.startTimeSec),
      endTime: Math.round(b.endTimeSec),
      type: 'mid-roll' as const,
      confidence: LLM_API_KEY ? 0.9 : 0.5,
      reason: b.reason,
    }));

    const totalAdWords = adBlocks.reduce((s, b) => s + (b.endWord - b.startWord), 0);
    const totalAdTimeSec = adBlocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);

    // Compute QA diagnostics
    const speechRateWpm = 155;
    const expectedSpeechSec = totalWords > 0 ? (totalWords / speechRateWpm) * 60 : 0;
    const impliedAdTimeSec = Math.max(0, dur - expectedSpeechSec);

    res.json({
      episode: { title: episodeTitle, durationSec: dur, transcriptUrl },
      rawHtml: {
        length: rawHtmlLength,
        pTagCount,
        snippet: html.slice(0, 2000),
      },
      transcript: { lineCount: lines.length, totalWords, lines },
      transcriptSource,
      validation: {
        isValid: validation.isValid,
        reason: validation.reason,
        details: validation.details,
      },
      adBlocks,
      summary: {
        totalAdBlocks: adBlocks.length,
        totalAdWords,
        totalAdTimeSec: Math.round(totalAdTimeSec),
        contentTimeSec: Math.round(dur - totalAdTimeSec),
        adWordPercent: totalWords > 0 ? +((totalAdWords / totalWords) * 100).toFixed(1) : 0,
        strategy: LLM_API_KEY ? `llm-${LLM_MODEL}` : 'keyword-heuristic',
      },
      qa: {
        expectedSpeechSec: Math.round(expectedSpeechSec),
        impliedAdTimeSec: Math.round(impliedAdTimeSec),
        speechRateWpm,
        audioDurationSec: dur,
        transcriptWords: totalWords,
        linesWithSpeaker: lines.filter(l => l.speaker).length,
        linesWithoutSpeaker: lines.filter(l => !l.speaker).length,
      },
      prompts: { system: systemPrompt, user: userPrompt },
      llmResponse: llmRaw,
      skipMap,
    });
  } catch (err: any) {
    console.error('Sandbox analyze error:', err.message);
    res.status(500).json({ error: 'Sandbox analysis failed', detail: err.message });
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
