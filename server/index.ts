import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import { ensureCompatibleFormat, openai as sttOpenai, speechToText } from './replit_integrations/audio/client.js';

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

/** Format seconds as 00h:00m:00s */
function fmtTs(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h.toString().padStart(2, '0')}h:${m.toString().padStart(2, '0')}m:${s.toString().padStart(2, '0')}s`;
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

// ─── Transcript Fetch ────────────────────────────────────────────────────────

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

// ─── Audio Chunked Processing ────────────────────────────────────────────────
//
// Chunked strategy: 1 MB byte-range chunks fetched via HTTP Range requests.
// Each chunk is ~65s of audio at 128kbps — well under Whisper's 25 MB limit.

const CHUNK_SIZE_BYTES = 1_048_576;  // 1 MB per chunk (~65s at 128kbps)
const DEFAULT_BITRATE = 128000;      // 128kbps

/**
 * Align a buffer to the first valid MP3 frame sync.
 *
 * When fetching audio via HTTP Range requests, the chunk starts at an arbitrary
 * byte offset — often in the middle of an MP3 frame. The leading garbage bytes
 * confuse Whisper's decoder. This function scans forward to the first valid
 * MPEG frame sync (0xFF followed by 0xE0+ mask) and returns the buffer from
 * that point onward.
 *
 * MP3 frame sync: 11 set bits = 0xFF then (byte & 0xE0) === 0xE0
 * Additional validation: check bitrate index is not 0xF (invalid) and
 * sample rate index is not 0x3 (reserved).
 */
function alignToMp3Frame(buf: Buffer): Buffer {
  for (let i = 0; i < Math.min(buf.length - 4, 8192); i++) {
    // Check for frame sync: 11 set bits across first 2 bytes
    if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) {
      // Validate it's a real frame header, not just coincidental bytes
      const byte2 = buf[i + 2];
      const bitrateIndex = (byte2 >> 4) & 0x0F;
      const sampleRateIndex = (byte2 >> 2) & 0x03;
      // bitrateIndex 0xF is "bad" and sampleRate 0x3 is "reserved"
      if (bitrateIndex !== 0x0F && sampleRateIndex !== 0x03 && bitrateIndex !== 0x00) {
        if (i > 0) {
          console.log(`[mp3-align] Skipped ${i} bytes to reach first valid frame sync`);
        }
        return buf.subarray(i);
      }
    }
  }
  // No frame sync found in first 8KB — return as-is and hope for the best
  console.warn(`[mp3-align] No valid MP3 frame sync found in first 8KB of chunk`);
  return buf;
}

// MPEG audio frame parameters for duration calculation
const MPEG_SAMPLES_PER_FRAME: Record<string, number> = {
  '1-1': 384, '1-2': 1152, '1-3': 1152,  // MPEG1 Layer I/II/III
  '2-1': 384, '2-2': 1152, '2-3': 576,   // MPEG2 Layer I/II/III
  '2.5-1': 384, '2.5-2': 1152, '2.5-3': 576,
};
const MPEG_SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

/**
 * Split a full MP3 buffer into chunks of approximately `targetDurationSec` seconds,
 * cutting precisely at frame boundaries. Returns array of { buffer, durationSec }.
 */
function splitMp3IntoChunks(
  fullBuf: Buffer,
  targetDurationSec: number,
): Array<{ buffer: Buffer; durationSec: number; offsetSec: number }> {
  const chunks: Array<{ buffer: Buffer; durationSec: number; offsetSec: number }> = [];

  // Skip ID3v2 header if present
  let pos = 0;
  if (fullBuf.length > 10 && fullBuf[0] === 0x49 && fullBuf[1] === 0x44 && fullBuf[2] === 0x33) {
    // ID3v2 tag: size is stored in 4 syncsafe bytes at offset 6
    const size = (fullBuf[6]! << 21) | (fullBuf[7]! << 14) | (fullBuf[8]! << 7) | fullBuf[9]!;
    pos = 10 + size;
    console.log(`[mp3-split] Skipped ID3v2 header: ${pos} bytes`);
  }

  let chunkStart = pos;
  let chunkDuration = 0;
  let totalDuration = 0;

  while (pos < fullBuf.length - 4) {
    // Look for frame sync
    if (fullBuf[pos] !== 0xFF || (fullBuf[pos + 1]! & 0xE0) !== 0xE0) {
      pos++;
      continue;
    }

    const byte1 = fullBuf[pos + 1]!;
    const byte2 = fullBuf[pos + 2]!;

    // Parse MPEG version
    const versionBits = (byte1 >> 3) & 0x03;
    const mpegVersion = versionBits === 3 ? '1' : versionBits === 2 ? '2' : versionBits === 0 ? '2.5' : null;
    if (!mpegVersion) { pos++; continue; }

    // Parse layer
    const layerBits = (byte1 >> 1) & 0x03;
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : layerBits === 1 ? 3 : 0;
    if (layer === 0) { pos++; continue; }

    // Parse sample rate
    const sampleRateIndex = (byte2 >> 2) & 0x03;
    if (sampleRateIndex === 3) { pos++; continue; }
    const sampleRate = MPEG_SAMPLE_RATES[mpegVersion]?.[sampleRateIndex];
    if (!sampleRate) { pos++; continue; }

    // Parse bitrate
    const bitrateIndex = (byte2 >> 4) & 0x0F;
    if (bitrateIndex === 0 || bitrateIndex === 0x0F) { pos++; continue; }

    // Bitrate tables (kbps)
    const bitrateTables: Record<string, number[]> = {
      '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
      '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
      '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
      '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
      '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    };
    const btKey = mpegVersion === '2.5' ? `2-${layer}` : `${mpegVersion}-${layer}`;
    const bitrate = (bitrateTables[btKey]?.[bitrateIndex] || 0) * 1000;
    if (bitrate === 0) { pos++; continue; }

    // Parse padding
    const padding = (byte2 >> 1) & 0x01;

    // Calculate frame size
    const samplesPerFrame = MPEG_SAMPLES_PER_FRAME[`${mpegVersion}-${layer}`] || 1152;
    let frameSize: number;
    if (layer === 1) {
      frameSize = Math.floor((12 * bitrate / sampleRate + padding) * 4);
    } else {
      frameSize = Math.floor(samplesPerFrame * bitrate / (8 * sampleRate) + padding);
    }

    if (frameSize < 8 || frameSize > 4096) { pos++; continue; }

    const frameDuration = samplesPerFrame / sampleRate;
    chunkDuration += frameDuration;
    pos += frameSize;

    // If we've accumulated enough duration, cut a chunk
    if (chunkDuration >= targetDurationSec) {
      chunks.push({
        buffer: fullBuf.subarray(chunkStart, pos),
        durationSec: chunkDuration,
        offsetSec: totalDuration,
      });
      totalDuration += chunkDuration;
      chunkStart = pos;
      chunkDuration = 0;
    }
  }

  // Push remaining frames as final chunk
  if (chunkStart < fullBuf.length && chunkDuration > 0.5) {
    chunks.push({
      buffer: fullBuf.subarray(chunkStart, fullBuf.length),
      durationSec: chunkDuration,
      offsetSec: totalDuration,
    });
  }

  console.log(`[mp3-split] Split ${(fullBuf.length / 1024 / 1024).toFixed(1)} MB into ${chunks.length} chunks: ${chunks.map(c => `${c.durationSec.toFixed(0)}s/${(c.buffer.length / 1024 / 1024).toFixed(1)}MB`).join(', ')}`);
  return chunks;
}

/**
 * Step 3: Resolve Audio Stream — HEAD request to follow redirects, get metadata for chunking.
 */
app.post('/api/audio/resolve', async (req, res) => {
  const { audioUrl } = req.body as { audioUrl: string };
  if (!audioUrl) {
    res.status(400).json({ error: 'Missing audioUrl' });
    return;
  }

  try {
    console.log(`[resolve] HEAD request: ${audioUrl.slice(0, 80)}...`);
    const headRes = await fetch(audioUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
      redirect: 'follow',
    });

    const resolvedUrl = headRes.url || audioUrl;
    const contentType = headRes.headers.get('content-type') || 'audio/mpeg';
    const cl = headRes.headers.get('content-length');
    const contentLength = cl ? parseInt(cl, 10) : 0;
    const acceptRanges = (headRes.headers.get('accept-ranges') || '').toLowerCase() !== 'none';

    // Estimate duration from file size + assumed bitrate
    const bitrate = DEFAULT_BITRATE;
    const durationSec = contentLength > 0 ? Math.round((contentLength * 8) / bitrate) : 0;
    const totalChunks = contentLength > 0 ? Math.ceil(contentLength / CHUNK_SIZE_BYTES) : 1;

    console.log(`[resolve] Resolved: ${(contentLength / 1024 / 1024).toFixed(1)} MB, ~${durationSec}s, ${totalChunks} chunks (1 MB each), ranges=${acceptRanges}`);

    res.json({
      resolvedUrl,
      contentLength,
      acceptRanges,
      contentType,
      durationSec,
      bitrate,
      totalChunks,
      chunkSizeBytes: CHUNK_SIZE_BYTES,
    });
  } catch (err: any) {
    console.error('[resolve] Error:', err.message);
    res.status(500).json({ error: 'Failed to resolve audio URL', detail: err.message });
  }
});

/**
 * Step 4+5: Process a single audio chunk — fetch bytes via Range request,
 * transcribe with Whisper. Ad detection happens separately via /api/audio/detect-ads.
 */
app.post('/api/audio/chunk', async (req, res) => {
  const {
    resolvedUrl,
    chunkIndex,
    totalChunks,
    contentLength,
    durationSec,
    bitrate,
    chunkDurationSec,
    overlapSec,
    episodeTitle,
    prevChunkTrailingText,
  } = req.body as {
    resolvedUrl: string;
    chunkIndex: number;
    totalChunks: number;
    contentLength: number;
    durationSec: number;
    bitrate: number;
    chunkDurationSec: number;
    overlapSec: number;
    episodeTitle: string;
    prevChunkTrailingText: string;
  };

  if (!resolvedUrl || chunkIndex === undefined) {
    res.status(400).json({ error: 'Missing resolvedUrl or chunkIndex' });
    return;
  }

  try {
    const bytesPerSec = bitrate / 8;
    const chunkStartSec = chunkIndex * chunkDurationSec;
    // Add overlap: fetch a bit past the chunk boundary to catch boundary ads
    const chunkEndSec = Math.min((chunkIndex + 1) * chunkDurationSec + overlapSec, durationSec);

    // For chunks > 0, start fetching slightly before to overlap with previous
    const fetchStartSec = chunkIndex > 0 ? Math.max(0, chunkStartSec - overlapSec) : 0;

    const startByte = Math.floor(fetchStartSec * bytesPerSec);
    const endByte = Math.min(Math.floor(chunkEndSec * bytesPerSec) - 1, contentLength - 1);

    const chunkSizeMB = ((endByte - startByte + 1) / 1024 / 1024).toFixed(1);
    console.log(`[chunk ${chunkIndex}/${totalChunks - 1}] Fetching bytes ${startByte}-${endByte} (${chunkSizeMB} MB), time ${fetchStartSec.toFixed(0)}s-${chunkEndSec.toFixed(0)}s`);

    // Step 4: Fetch chunk via Range request
    const audioRes = await fetch(resolvedUrl, {
      headers: {
        'User-Agent': 'NPR-Podcast-Player/1.0',
        'Range': `bytes=${startByte}-${endByte}`,
      },
    });

    let audioBuffer: Buffer;
    if (!audioRes.ok && audioRes.status !== 206) {
      // If Range requests fail, try fetching the full file and slicing
      console.warn(`[chunk ${chunkIndex}] Range request returned ${audioRes.status}, trying full download + slice`);
      const fullRes = await fetch(resolvedUrl, {
        headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
        redirect: 'follow',
      });
      if (!fullRes.ok) throw new Error(`Audio fetch failed: ${fullRes.status}`);
      const fullBuf = Buffer.from(await fullRes.arrayBuffer());
      audioBuffer = fullBuf.subarray(startByte, endByte + 1);
    } else {
      audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    }

    console.log(`[chunk ${chunkIndex}] Downloaded ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

    // Transcribe chunk with Whisper
    // Align to first valid MP3 frame sync — Range requests start at arbitrary
    // byte offsets which produce leading garbage that confuses Whisper.
    const compatBuffer = alignToMp3Frame(audioBuffer);
    const format = 'mp3';
    console.log(`[chunk ${chunkIndex}] Aligned buffer: ${audioBuffer.length} -> ${compatBuffer.length} bytes (trimmed ${audioBuffer.length - compatBuffer.length})`);

    let chunkText = '';
    let chunkSegments: Array<{ start: number; end: number; text: string }> = [];

    try {
      const { toFile } = await import('openai');
      const file = await toFile(compatBuffer, `chunk_${chunkIndex}.${format}`);
      const verboseResult = await sttOpenai.audio.transcriptions.create({
        file,
        model: 'gpt-4o-mini-transcribe',
        response_format: 'verbose_json',
      }) as any;

      chunkText = verboseResult.text || '';
      // Offset timestamps by the chunk's start time in the full audio
      chunkSegments = (verboseResult.segments || []).map((s: any) => ({
        start: (s.start || 0) + fetchStartSec,
        end: (s.end || 0) + fetchStartSec,
        text: (s.text || '').trim(),
      }));
      console.log(`[chunk ${chunkIndex}] Transcribed: ${chunkSegments.length} segments, ${chunkText.length} chars`);
    } catch (sttErr: any) {
      // Fallback to plain text
      console.warn(`[chunk ${chunkIndex}] verbose_json failed (${sttErr.message}), trying plain text`);
      chunkText = await speechToText(compatBuffer, format);
      console.log(`[chunk ${chunkIndex}] Plain text: ${chunkText.length} chars`);
    }

    // Build trailing text for next chunk's context
    const trailingText = chunkText.slice(-200);

    res.json({
      chunkIndex,
      startTimeSec: fetchStartSec,
      endTimeSec: chunkEndSec,
      transcript: {
        text: chunkText,
        segments: chunkSegments,
      },
      adSegments: [],
      trailingText,
    });
  } catch (err: any) {
    console.error(`[chunk ${chunkIndex}] Error:`, err.message);
    res.status(500).json({ error: `Chunk ${chunkIndex} processing failed`, detail: err.message });
  }
});

// ─── Dedicated Ad Detection (separate from transcription) ────────────────────

/**
 * Detect ads from the full assembled transcript. Called AFTER all chunks have been
 * transcribed. Takes all transcript segments with timestamps and uses a focused
 * LLM call to find complete ad sentences.
 */
app.post('/api/audio/detect-ads', async (req, res) => {
  const {
    segments,
    episodeTitle,
    durationSec,
  } = req.body as {
    segments: Array<{ start: number; end: number; text: string }>;
    episodeTitle: string;
    durationSec: number;
  };

  if (!segments || segments.length === 0) {
    res.status(400).json({ error: 'Missing segments' });
    return;
  }

  if (!LLM_API_KEY) {
    // Heuristic fallback when no API key
    const adSegments: Array<{
      startTime: number; endTime: number;
      type: string; confidence: number; reason: string;
    }> = [];
    for (const seg of segments) {
      const lower = seg.text.toLowerCase();
      if (lower.includes('support for this podcast') || lower.includes('this message comes from') || lower.includes('support for npr')) {
        adSegments.push({
          startTime: Math.round(seg.start),
          endTime: Math.round(seg.end),
          type: 'mid-roll',
          confidence: 0.5,
          reason: 'Keyword heuristic (no API key)',
        });
      }
    }
    res.json({ adSegments });
    return;
  }

  try {
    // Split large segments into sentences so the LLM can identify individual
    // ad sentences — Whisper often returns huge segments (800+ words each)
    interface SplitLine { idx: number; start: number; end: number; text: string }
    const splitLines: SplitLine[] = [];
    let lineIdx = 0;

    for (const seg of segments) {
      if (!seg.text) continue;
      const wordCount = seg.text.split(/\s+/).filter(Boolean).length;

      if (wordCount <= 80) {
        // Short segment — keep as-is
        lineIdx++;
        splitLines.push({ idx: lineIdx, start: seg.start, end: seg.end, text: seg.text });
      } else {
        // Long segment — split into sentences, interpolate timestamps
        const sentences = seg.text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
        const totalWords = seg.text.split(/\s+/).filter(Boolean).length;
        const segDuration = seg.end - seg.start;
        let wordsProcessed = 0;

        for (const sent of sentences) {
          const sentWords = sent.trim().split(/\s+/).filter(Boolean).length;
          const sentStart = seg.start + (wordsProcessed / totalWords) * segDuration;
          wordsProcessed += sentWords;
          const sentEnd = seg.start + (wordsProcessed / totalWords) * segDuration;

          lineIdx++;
          splitLines.push({ idx: lineIdx, start: sentStart, end: sentEnd, text: sent.trim() });
        }
      }
    }

    // Build numbered transcript for the LLM — each line is one sentence with hh:mm:ss timestamps
    const numberedTranscript = splitLines.map(l =>
      `[${l.idx}] (${fmtTs(l.start)}) ${l.text}`
    ).join('\n');

    const systemPrompt = `You are a sentence-level classifier for podcast transcripts. Your task is to read each sentence and decide: is this sentence part of an ADVERTISEMENT or part of the EDITORIAL CONTENT?

## How to classify each sentence

Read every sentence in the transcript. For each sentence, ask yourself:
- Is this sentence part of the podcast's actual topic/discussion/interview? → CONTENT (skip it)
- Is this sentence selling a product, promoting a service, or reading a sponsor credit? → AD

## What ad blocks look like in a podcast

Ads are COMPLETE BLOCKS of consecutive sentences — typically 3 to 10 sentences long — that form a coherent promotional message. They are NOT single words or phrases. A single sentence alone is rarely an ad; ads are paragraphs.

Common ad block patterns:
- SPONSOR READ: A block that opens with "Support for this podcast comes from..." or "This message comes from...", describes a company/product across several sentences, and ends with a call to action ("visit example.com", "use promo code X"). Then the editorial content resumes.
- FUNDING CREDIT: 1-3 sentences like "Support for NPR comes from [Company], providing [service]. Learn more at [website]."
- INSERTED AD: A block of sentences about a product/service that has nothing to do with the episode's editorial topic — it's clearly a commercial break.

## What is NOT an ad (critical — do not classify these as ads)

- ALL editorial discussion, even about companies, money, economics, products, or business deals
- Interviews, even with CEOs or business leaders
- Host commentary, analysis, opinions, jokes
- Topic transitions ("Now let's turn to...", "Coming up after the break...")
- Episode intros and sign-offs
- Any content that relates to the episode's topic

## Output format

Return the sentence numbers that are ads, grouped into contiguous blocks. A typical 10-30 minute NPR episode has 1-4 ad blocks. If no ads are found, return an empty array.

Return ONLY valid JSON.`;

    const userPrompt = `Classify each sentence in this transcript of "${episodeTitle}" (${Math.round(durationSec / 60)} min, ${splitLines.length} sentences).

For each ad block, return the first and last sentence numbers (inclusive) that form the ad.

TRANSCRIPT:
${numberedTranscript}

Return JSON:
{
  "adBlocks": [
    {
      "firstSegment": <number>,
      "lastSegment": <number>,
      "reason": "<what is being advertised>"
    }
  ]
}`;

    console.log(`[detect-ads] Analyzing ${splitLines.length} sentences (from ${segments.length} segments) for "${episodeTitle}"`);
    const { parsed } = await callLLM(systemPrompt, userPrompt, 0, 2048);
    const result = parsed as { adBlocks: Array<{ firstSegment: number; lastSegment: number; reason: string }> };

    const adBlocks = result.adBlocks || [];
    console.log(`[detect-ads] Found ${adBlocks.length} ad blocks`);

    // Map sentence ranges back to timestamps
    const adSegments = adBlocks.map(block => {
      // Sentence numbers are 1-indexed in the prompt
      const firstLine = splitLines.find(l => l.idx === block.firstSegment);
      const lastLine = splitLines.find(l => l.idx === block.lastSegment);

      if (!firstLine || !lastLine) return null;

      const startTime = Math.round(firstLine.start);
      const endTime = Math.round(lastLine.end);
      const midpoint = (startTime + endTime) / 2;

      let type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention' = 'mid-roll';
      if (durationSec > 0) {
        if (midpoint < durationSec * 0.1) type = 'pre-roll';
        else if (midpoint > durationSec * 0.9) type = 'post-roll';
      }

      // Collect the actual ad text for logging
      const adText = splitLines
        .filter(l => l.idx >= block.firstSegment && l.idx <= block.lastSegment)
        .map(l => l.text).join(' ');
      console.log(`[detect-ads]   ${type} [${startTime}s-${endTime}s]: "${adText.slice(0, 120)}..."`);

      return {
        startTime,
        endTime,
        type,
        confidence: 0.9,
        reason: block.reason,
      };
    }).filter(Boolean) as Array<{ startTime: number; endTime: number; type: string; confidence: number; reason: string }>;

    res.json({ adSegments });
  } catch (err: any) {
    console.error('[detect-ads] Error:', err.message);
    res.status(500).json({ error: 'Ad detection failed', detail: err.message });
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
    // Look for a section with id="transcript" or id="storytext"
    /<(?:div|section)[^>]*\bid=["'](?:transcript|storytext)["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
    // Modern NPR transcript pages — class contains "transcript"
    /<div[^>]*\bclass="[^"]*\btranscript\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // Older NPR transcript pages with storytext class
    /<div[^>]*\bclass="[^"]*\bstorytext\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    // Article body container
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    // Main content area
    /<main[^>]*>([\s\S]*?)<\/main>/i,
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
    const firstIdx = html.indexOf(speakerParagraphs[0]!);
    const lastParagraph = speakerParagraphs[speakerParagraphs.length - 1]!;
    const lastIdx = html.lastIndexOf(lastParagraph) + lastParagraph.length;
    if (firstIdx !== -1 && lastIdx > firstIdx) {
      return html.slice(firstIdx, lastIdx);
    }
  }

  // Strategy 3: Strip <header>, <footer>, <nav>, <aside>, <script>, <style> to reduce noise
  const stripped = html
    .replace(/<(?:header|footer|nav|aside)[^>]*>[\s\S]*?<\/(?:header|footer|nav|aside)>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Check if stripping reduced noise meaningfully (still has <p> content)
  const strippedPCount = (stripped.match(/<p[^>]*>/gi) || []).length;
  if (strippedPCount >= 3) {
    return stripped;
  }

  // Strategy 4: No container found — return the full HTML
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

  // Skip navigation-like content (exact line match)
  if (/^(?:Skip to|Keyboard shortcuts|Open Navigation|Close Navigation|Expand\/collapse)/i.test(text)) return true;
  if (/^(?:Home|News|Music|Culture|Podcasts & Shows|Search|Newsletters|NPR Shop)\s*$/i.test(text)) return true;

  // Skip NPR page footer/header elements (exact line match)
  if (/^(?:About NPR|Diversity|Support|Careers|Press|Ethics)\s*$/i.test(text)) return true;
  if (/^(?:LISTEN & FOLLOW|NPR App|Apple Podcasts|Spotify|Amazon Music|iHeart Radio|YouTube Music)\s*$/i.test(text)) return true;

  // Skip lines CONTAINING platform/navigation keywords (catches concatenated nav bars)
  // e.g. "NPR Planet Money LISTEN & FOLLOW NPR App Apple Podcasts Spotify Amazon Music..."
  if (/LISTEN\s*&\s*FOLLOW/i.test(text)) return true;
  const platformCount = [
    /Apple Podcasts/i, /Spotify/i, /Amazon Music/i, /iHeart Radio/i,
    /YouTube Music/i, /Google Podcasts/i, /NPR App/i, /NPR One/i,
    /Pocket Casts/i, /Overcast/i, /Stitcher/i, /TuneIn/i,
  ].filter(rx => rx.test(text)).length;
  if (platformCount >= 2) return true;

  // Skip "Sponsor Message" / "Become an NPR sponsor" page elements (not transcript content)
  if (/(?:Sponsor Message|Become an NPR sponsor)/i.test(text)) return true;

  // Skip NPR section headings and boilerplate
  if (/^(?:Terms of Use|Privacy Policy|Cookie Policy|Your Privacy Choices|Accessibility)\s*$/i.test(text)) return true;
  if (/^(?:Get in touch|Contact Us|Connect with us|Follow us|Share this page)\s*$/i.test(text)) return true;
  if (/^\s*(?:Facebook|Twitter|Instagram|Flipboard|Email|LinkedIn|Threads|Mastodon)\s*$/i.test(text)) return true;
  if (/^(?:Related Stories|More Stories|More News|You May Also Like|Recommended)\s*$/i.test(text)) return true;
  if (/(?:© \d{4}|©\d{4}|All Rights Reserved|Terms of Service)/i.test(text)) return true;
  if (/^(?:Newsletter|Sign Up|Subscribe)\s*$/i.test(text)) return true;

  // Skip show promo / network page elements
  if (/^(?:NPR thanks our sponsors|Support NPR|Learn more at npr\.org)/i.test(text)) return true;
  if (/^(?:Transcript provided by NPR|Copyright NPR)/i.test(text)) return true;

  // Skip lines containing toggle/caption UI elements
  if (/\b(?:hide caption|toggle caption|enlarge this image)\b/i.test(text)) return true;

  // Skip lines with excessive URLs or technical content
  const urlCount = (text.match(/https?:\/\//g) || []).length;
  if (urlCount > 2) return true;

  // Skip very long lines (>2000 chars) — real transcript paragraphs are rarely this long
  if (text.length > 2000) return true;

  // Skip lines that are just image captions
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

// ─── Reusable helpers for ad classification ──────────────────────────────────

/** Build SandboxLine[] from Whisper segments, splitting large segments into sentences */
function buildLinesFromSegments(
  segments: Array<{ start: number; end: number; text: string }>,
): SandboxLine[] {
  const lines: SandboxLine[] = [];
  let cumW = 0;
  let lineN = 0;
  for (const seg of segments) {
    if (!seg.text) continue;
    const segWords = seg.text.split(/\s+/).filter(Boolean).length;
    if (segWords <= 80) {
      let speaker = '';
      let content = seg.text;
      const speakerMatch = content.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) { speaker = speakerMatch[1].trim(); content = content.slice(speakerMatch[0].length).trim(); }
      if (!content) continue;
      lineN++;
      const wc = content.split(/\s+/).filter(Boolean).length;
      cumW += wc;
      lines.push({ lineNum: lineN, speaker, text: content, wordCount: wc, cumulativeWords: cumW });
    } else {
      const sentences = seg.text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
      for (const sent of sentences) {
        let speaker = '';
        let content = sent.trim();
        const speakerMatch = content.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
        if (speakerMatch) { speaker = speakerMatch[1].trim(); content = content.slice(speakerMatch[0].length).trim(); }
        if (!content) continue;
        lineN++;
        const wc = content.split(/\s+/).filter(Boolean).length;
        cumW += wc;
        lines.push({ lineNum: lineN, speaker, text: content, wordCount: wc, cumulativeWords: cumW });
      }
    }
  }
  return lines;
}

/** Build the ad classification system prompt with optional topic context */
function buildAdClassificationPrompt(episodeTitle: string, topicContext?: string): string {
  let prompt = `You are a sentence-level classifier for podcast transcripts. Your task is to read each sentence and decide: is this sentence part of an ADVERTISEMENT or part of the EDITORIAL CONTENT?`;

  if (topicContext) {
    prompt += `

## Episode context

This episode is titled "${episodeTitle}".
Based on the transcript, the main topic is: ${topicContext}

Any discussion of this topic — including companies, products, people, or events related to it — is EDITORIAL CONTENT, not advertising. Only classify sentences as AD when they are clearly promoting an UNRELATED product/service in a commercial break.`;
  }

  prompt += `

## How to classify each sentence

Read every sentence in the transcript. For each sentence, ask yourself:
- Is this sentence part of the podcast's actual topic/discussion/interview? → CONTENT (skip it)
- Is this sentence selling a product, promoting a service, or reading a sponsor credit? → AD

## What ad blocks look like in a podcast

Ads are COMPLETE BLOCKS of consecutive sentences — typically 3 to 10 sentences long — that form a coherent promotional message. They are NOT single words or phrases. A single sentence alone is rarely an ad; ads are paragraphs.

Common ad block patterns:
- SPONSOR READ: A block that opens with "Support for this podcast comes from..." or "This message comes from...", describes a company/product across several sentences, and ends with a call to action ("visit example.com", "use promo code X"). Then the editorial content resumes.
- FUNDING CREDIT: 1-3 sentences like "Support for NPR comes from [Company], providing [service]. Learn more at [website]."
- INSERTED AD: A block of sentences about a product/service that has nothing to do with the episode's editorial topic — it's clearly a commercial break.

## What is NOT an ad (critical — do not classify these as ads)

- ALL editorial discussion, even about companies, money, economics, products, or business deals
- Interviews, even with CEOs or business leaders
- Host commentary, analysis, opinions, jokes
- Topic transitions ("Now let's turn to...", "Coming up after the break...")
- Episode intros and sign-offs
- Any content that relates to the episode's topic

## Output format

Return the sentence numbers that are ads, grouped into contiguous blocks. A typical 10-30 minute NPR episode has 1-4 ad blocks. If no ads are found, return an empty array.

Return ONLY valid JSON.`;
  return prompt;
}

/** Run ad classification on lines and return ad blocks with timestamps */
async function classifyAdsFromLines(
  lines: SandboxLine[],
  episodeTitle: string,
  durationSec: number,
  topicContext?: string,
): Promise<{ adBlocks: SandboxAdBlock[]; llmRaw: string; systemPrompt: string; userPrompt: string }> {
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = durationSec || 0;

  const numberedText = lines.map(l => {
    const spk = l.speaker ? `${l.speaker}: ` : '';
    const approxTime = dur > 0 && totalWords > 0 ? (l.cumulativeWords / totalWords) * dur : 0;
    return `[${l.lineNum}] (${fmtTs(approxTime)}) ${spk}${l.text}`;
  }).join('\n');

  const systemPrompt = buildAdClassificationPrompt(episodeTitle, topicContext);

  const userPrompt = `Classify each sentence in this transcript of "${episodeTitle || 'Unknown Episode'}" (${Math.round(dur / 60)} min, ${lines.length} sentences).

For each ad block, return the first and last sentence numbers (inclusive) that form the ad.

TRANSCRIPT:
${numberedText}

Return JSON:
{
  "adBlocks": [
    { "startLine": <first sentence number>, "endLine": <last sentence number>, "reason": "<what is being advertised>" }
  ]
}`;

  let adBlocks: SandboxAdBlock[] = [];
  let llmRaw = '';

  if (LLM_API_KEY) {
    const { parsed, rawText } = await callLLM(systemPrompt, userPrompt, 0, 2048);
    const result = parsed as { adBlocks: Array<{ startLine: number; endLine: number; reason: string }> };
    llmRaw = rawText;
    adBlocks = (result.adBlocks || []).map(b => ({
      startLine: b.startLine,
      endLine: b.endLine,
      reason: b.reason,
      textPreview: lines
        .filter(l => l.lineNum >= b.startLine && l.lineNum <= b.endLine)
        .map(l => l.text)
        .join(' ')
        .slice(0, 300),
      startWord: 0, endWord: 0, startTimeSec: 0, endTimeSec: 0,
    }));
  } else {
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
          startLine: l.lineNum, endLine: l.lineNum,
          reason: 'Keyword match (no LLM): ' + l.text.slice(0, 60),
          textPreview: l.text.slice(0, 300),
          startWord: 0, endWord: 0, startTimeSec: 0, endTimeSec: 0,
        });
      }
    }
  }

  adBlocks = mapAdBlocksToTimestamps(adBlocks, lines, dur);
  return { adBlocks, llmRaw, systemPrompt, userPrompt };
}

/**
 * Refine ad block boundaries using LLM.
 * Takes anchor boundaries from per-chunk classification and examines surrounding
 * transcript context to find precise ad start/end times (0.1s precision).
 */
async function refineBoundariesWithLLM(
  anchors: SandboxAdBlock[],
  lines: SandboxLine[],
  durationSec: number,
  episodeTitle: string,
  topicContext?: string,
): Promise<{ adBlocks: SandboxAdBlock[]; llmRaw: string; systemPrompt: string; userPrompt: string }> {
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = durationSec || 0;

  // Build context windows around each anchor: ±5 sentences
  const CONTEXT_WINDOW = 5;
  const anchorContexts = anchors.map((anchor, i) => {
    const startIdx = lines.findIndex(l => l.lineNum >= anchor.startLine);
    const endIdx = lines.findIndex(l => l.lineNum >= anchor.endLine);
    const contextStart = Math.max(0, (startIdx >= 0 ? startIdx : 0) - CONTEXT_WINDOW);
    const contextEnd = Math.min(lines.length, (endIdx >= 0 ? endIdx : lines.length - 1) + CONTEXT_WINDOW + 1);
    const contextLines = lines.slice(contextStart, contextEnd);

    return {
      anchorIndex: i,
      anchorStartLine: anchor.startLine,
      anchorEndLine: anchor.endLine,
      reason: anchor.reason,
      context: contextLines.map(l => {
        const approxTime = dur > 0 && totalWords > 0 ? (l.cumulativeWords / totalWords) * dur : 0;
        const isAnchor = l.lineNum >= anchor.startLine && l.lineNum <= anchor.endLine;
        return `[${l.lineNum}] (${fmtTs(approxTime)}) ${isAnchor ? '>>AD>> ' : ''}${l.text}`;
      }).join('\n'),
    };
  });

  const systemPrompt = `You are refining ad segment boundaries in a podcast transcript.

Each anchor below was identified by a per-chunk classifier. Your job is to find the PRECISE start and end of each ad segment by examining the surrounding transcript context.

${topicContext ? `This episode is titled "${episodeTitle}". The main topic is: ${topicContext}\nAny discussion of this topic is EDITORIAL CONTENT, not advertising.\n` : ''}
Rules:
- Anchors are approximate. Examine sentences before and after each anchor boundary.
- If sentences immediately before the anchor start are also ad content (sponsor reads, promos, funding credits), expand the boundary earlier.
- If sentences immediately after the anchor end are also ad content, expand the boundary later.
- If edge sentences are editorial content, contract the boundary inward.
- An ad block is typically 3-10 consecutive sentences.
- MERGE near-adjacent ad blocks: if two ad anchors are separated by only 1-2 sentences of apparent content, those gap sentences are almost certainly part of the same ad break (transitions, host banter between sponsor reads, etc.). Merge them into one larger block spanning the full range. Only keep ad blocks separate when there are 3+ sentences of genuine editorial content between them.
- For each refined boundary, output adStart and adEnd as seconds from episode start, rounded to 0.1s.
- The goal is smooth, accurate skip boundaries — the player will jump from adStart to adEnd, so false gaps in the middle of an ad break cause jarring interruptions.

Return ONLY valid JSON.`;

  const userPrompt = `Refine these ${anchors.length} ad anchor(s) in "${episodeTitle}" (${Math.round(dur / 60)} min).

Lines marked with ">>AD>>" are the current anchor boundaries. Examine the surrounding context and adjust.

${anchorContexts.map(ac => `--- Anchor ${ac.anchorIndex + 1} (lines ${ac.anchorStartLine}-${ac.anchorEndLine}): ${ac.reason} ---
${ac.context}`).join('\n\n')}

For each anchor, return the refined boundary in seconds from episode start (0.1s precision).
Return JSON:
{
  "refinedBoundaries": [
    { "adStart": <seconds>, "adEnd": <seconds>, "reason": "<what is being advertised>" }
  ]
}`;

  let refinedBlocks: SandboxAdBlock[] = [...anchors];
  let llmRaw = '';

  if (LLM_API_KEY) {
    const { parsed, rawText } = await callLLM(systemPrompt, userPrompt, 0, 2048);
    llmRaw = rawText;
    const result = parsed as { refinedBoundaries?: Array<{ adStart: number; adEnd: number; reason: string }> };

    if (result.refinedBoundaries && result.refinedBoundaries.length > 0) {
      refinedBlocks = result.refinedBoundaries
        .filter(b => typeof b.adStart === 'number' && typeof b.adEnd === 'number' && b.adStart < b.adEnd && b.adStart >= 0 && b.adEnd <= dur + 1)
        .map(b => ({
          startLine: 0,
          endLine: 0,
          reason: b.reason || 'Refined ad boundary',
          textPreview: '',
          startWord: 0,
          endWord: 0,
          startTimeSec: Math.round(b.adStart * 10) / 10,
          endTimeSec: Math.round(b.adEnd * 10) / 10,
        }));

      // Reconstruct word/line info from timestamps
      for (const block of refinedBlocks) {
        if (dur > 0 && totalWords > 0) {
          block.startWord = Math.round((block.startTimeSec / dur) * totalWords);
          block.endWord = Math.round((block.endTimeSec / dur) * totalWords);
        }
        // Find closest lines for preview
        const matchingLines = lines.filter(l => {
          const approxTime = dur > 0 && totalWords > 0 ? (l.cumulativeWords / totalWords) * dur : 0;
          return approxTime >= block.startTimeSec && approxTime <= block.endTimeSec;
        });
        if (matchingLines.length > 0) {
          block.startLine = matchingLines[0].lineNum;
          block.endLine = matchingLines[matchingLines.length - 1].lineNum;
          block.textPreview = matchingLines.map(l => l.text).join(' ').slice(0, 300);
        }
      }

      console.log(`[sandbox] Refined ${anchors.length} anchors → ${refinedBlocks.length} boundaries`);
    }
  } else {
    llmRaw = '(no LLM key — using anchor boundaries as-is)';
  }

  return { adBlocks: refinedBlocks, llmRaw, systemPrompt, userPrompt };
}

/** Derive a topic summary from the episode title and first ~200 words of transcript (no LLM call) */
function deriveTopicContext(episodeTitle: string, lines: SandboxLine[]): string {
  // Take the first ~200 words of actual content
  const opening = lines.slice(0, 20).map(l => l.text).join(' ');
  const openingWords = opening.split(/\s+/).slice(0, 200).join(' ');
  return `${openingWords}`;
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
  const { transcriptUrl, episodeTitle, durationSec, podcastTranscripts, audioUrl, testMode } = req.body as {
    transcriptUrl: string;
    episodeTitle: string;
    durationSec: number;
    podcastTranscripts?: PodcastTranscript[];
    audioUrl?: string;
    testMode?: boolean;
  };
  const TEST_MODE_MAX_CHUNKS = 5;

  if (!transcriptUrl && !audioUrl && (!podcastTranscripts || podcastTranscripts.length === 0)) {
    res.status(400).json({ error: 'Missing transcriptUrl, audioUrl, or podcastTranscripts' });
    return;
  }

  // SSE streaming: send progress events as each pipeline stage completes
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  function sendEvent(event: string, data: any) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    let html = '';
    let rawHtmlLength = 0;
    let pTagCount = 0;
    let lines: SandboxLine[] = [];
    let transcriptSource = 'html';

    // Track audio pipeline details for sandbox step-by-step display
    let audioDetails: {
      available: boolean;
      originalUrl: string;
      resolvedUrl: string;
      contentType: string;
      contentLengthBytes: number;
      downloadSizeMb: string;
      segmentCount: number;
      transcriptionModel: string;
      audioDurationSec: number;
      error: string | null;
    } = {
      available: !!audioUrl,
      originalUrl: audioUrl || '',
      resolvedUrl: '',
      contentType: '',
      contentLengthBytes: 0,
      downloadSizeMb: '0',
      segmentCount: 0,
      transcriptionModel: 'gpt-4o-mini-transcribe',
      audioDurationSec: 0,
      error: null,
    };

    // Audio pipeline: resolve → stream → transcribe (captures dynamic ads)
    if (audioUrl && lines.length === 0) {
      try {
        // Step 3: Resolve Audio Stream — HEAD request to follow redirects, get metadata
        sendEvent('progress', { step: 'step_resolve_audio_stream', message: 'Resolving audio URL...' });
        console.log(`[sandbox] Resolving audio URL: ${audioUrl.slice(0, 80)}...`);
        const headRes = await fetch(audioUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
          redirect: 'follow',
        });
        audioDetails.resolvedUrl = headRes.url || audioUrl;
        audioDetails.contentType = headRes.headers.get('content-type') || 'audio/mpeg';
        const cl = headRes.headers.get('content-length');
        audioDetails.contentLengthBytes = cl ? parseInt(cl, 10) : 0;
        // Compute download size immediately from HEAD (available even if transcription fails)
        if (audioDetails.contentLengthBytes > 0) {
          audioDetails.downloadSizeMb = (audioDetails.contentLengthBytes / 1024 / 1024).toFixed(1);
        }
        console.log(`[sandbox] Audio resolved: ${audioDetails.resolvedUrl.slice(0, 80)}, ${audioDetails.contentType}, ${audioDetails.contentLengthBytes} bytes`);
        sendEvent('progress', {
          step: 'step_resolve_audio_stream',
          status: 'done',
          message: `Audio resolved: ${audioDetails.contentType}, ${audioDetails.downloadSizeMb} MB`,
          audioDetails: { ...audioDetails },
        });

        // Step 4: Plan chunks — calculate 1 MB byte ranges (no download yet)
        const resolvedUrl = audioDetails.resolvedUrl;
        const contentLength = audioDetails.contentLengthBytes;
        const bitrate = DEFAULT_BITRATE;
        const allChunksCount = Math.ceil(contentLength / CHUNK_SIZE_BYTES);
        const numChunks = testMode ? Math.min(allChunksCount, TEST_MODE_MAX_CHUNKS) : allChunksCount;
        const estChunkDuration = (CHUNK_SIZE_BYTES * 8) / bitrate; // ~65.5s at 128kbps
        const estDuration = (contentLength * 8) / bitrate;

        if (testMode && allChunksCount > TEST_MODE_MAX_CHUNKS) {
          console.log(`[sandbox] TEST MODE: limiting from ${allChunksCount} to ${numChunks} chunks`);
        }

        sendEvent('progress', { step: 'step_plan_chunks', message: `Planning ${numChunks} chunks (1 MB each)${testMode ? ' [TEST MODE]' : ''}...` });
        console.log(`[sandbox] Planned ${numChunks} chunks for ${(contentLength / 1024 / 1024).toFixed(1)} MB, ~${estDuration.toFixed(0)}s${testMode ? ' [TEST MODE]' : ''}`);
        sendEvent('progress', {
          step: 'step_plan_chunks',
          status: 'done',
          message: `${numChunks}${testMode ? `/${allChunksCount}` : ''} chunks planned (${(contentLength / 1024 / 1024).toFixed(1)} MB, ~${Math.round(estDuration)}s)${testMode ? ' [TEST MODE]' : ''}`,
          audioDetails: { ...audioDetails },
        });

        // ── Parallel per-chunk pipeline: Fetch → Transcribe → Classify → Refine → Emit ──
        // Each chunk independently fetches via Range request, processes, and emits skip ranges.
        // Semaphore limits concurrent OpenAI STT calls to avoid rate limits.
        const STT_CONCURRENCY = 3;
        let activeCalls = 0;
        const waitQueue: Array<() => void> = [];
        const acquireSemaphore = (): Promise<void> => {
          if (activeCalls < STT_CONCURRENCY) { activeCalls++; return Promise.resolve(); }
          return new Promise<void>(resolve => waitQueue.push(resolve));
        };
        const releaseSemaphore = () => {
          activeCalls--;
          if (waitQueue.length > 0) { activeCalls++; waitQueue.shift()!(); }
        };

        interface ChunkResult {
          chunkIndex: number;
          text: string;
          segments: Array<{ start: number; end: number; text: string }>;
          lines: SandboxLine[];
          adBlocks: SandboxAdBlock[];
        }

        // Ordered results array — filled by parallel workers
        const chunkResults: (ChunkResult | null)[] = new Array(numChunks).fill(null);

        // Process a single chunk: Fetch → Transcribe → Classify → Refine → Emit
        const processChunk = async (ci: number): Promise<void> => {
          const threadId = `chunk-${ci}`;
          const startByte = ci * CHUNK_SIZE_BYTES;
          const endByte = Math.min((ci + 1) * CHUNK_SIZE_BYTES - 1, contentLength - 1);
          const offsetSec = (startByte * 8) / bitrate;
          const chunkSizeKB = ((endByte - startByte + 1) / 1024).toFixed(0);

          // ── Fetch chunk via Range request ──
          sendEvent('progress', {
            step: 'step_fetch_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
            message: `Fetching chunk ${ci + 1}/${numChunks} (${chunkSizeKB} KB)...`,
            input: {
              resolvedUrl: resolvedUrl.slice(0, 120),
              byteRange: `${startByte}-${endByte}`,
              chunkSizeKB: Number(chunkSizeKB),
              offsetSec: Math.round(offsetSec * 10) / 10,
            },
          });

          let chunkBuf: Buffer;
          const audioRes = await fetch(resolvedUrl, {
            headers: {
              'User-Agent': 'NPR-Podcast-Player/1.0',
              'Range': `bytes=${startByte}-${endByte}`,
            },
          });
          if (audioRes.status === 206 || audioRes.ok) {
            chunkBuf = Buffer.from(await audioRes.arrayBuffer());
          } else {
            throw new Error(`Range request failed: ${audioRes.status}`);
          }
          // Align to first valid MP3 frame sync (Range start may be mid-frame)
          chunkBuf = alignToMp3Frame(chunkBuf);
          console.log(`[sandbox] Chunk ${ci + 1}/${numChunks}: fetched ${chunkSizeKB} KB, offset ~${offsetSec.toFixed(0)}s`);

          sendEvent('progress', {
            step: 'step_fetch_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
            status: 'done', message: `${chunkSizeKB} KB fetched`,
            bytesFetched: endByte - startByte + 1,
            byteRange: `${startByte}-${endByte}`,
            offsetSec: Math.round(offsetSec * 10) / 10,
            audioUrl: resolvedUrl.slice(0, 120),
          });

          // ── Transcribe chunk with Whisper ──
          sendEvent('progress', {
            step: 'step_transcribe_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
            message: `Transcribing chunk ${ci + 1}/${numChunks}...`,
            input: {
              model: 'gpt-4o-mini-transcribe',
              responseFormat: 'verbose_json',
              language: 'en',
              bufferSizeKB: Math.round(chunkBuf.length / 1024),
              offsetSec: Math.round(offsetSec * 10) / 10,
            },
          });

          let chunkText = '';
          let segs: Array<{ start: number; end: number; text: string }> = [];

          await acquireSemaphore();
          try {
            const { toFile } = await import('openai');
            const file = await toFile(chunkBuf, `chunk_${ci}.mp3`);
            const result = await sttOpenai.audio.transcriptions.create({ file, model: 'gpt-4o-mini-transcribe', response_format: 'verbose_json' }) as any;
            chunkText = (result.text || '').trim();
            segs = (result.segments || []).map((s: any) => ({
              start: (s.start || 0) + offsetSec,
              end: (s.end || 0) + offsetSec,
              text: (s.text || '').trim(),
            }));
            console.log(`[sandbox] Chunk ${ci + 1}: ${segs.length} segments, ${chunkText.split(/\s+/).length} words`);
          } catch (chunkErr: any) {
            console.warn(`[sandbox] Chunk ${ci + 1} STT failed: ${chunkErr.message}`);
            try {
              const plainText = await speechToText(chunkBuf, 'mp3');
              if (plainText) {
                chunkText = plainText;
                segs = [{ start: offsetSec, end: offsetSec + estChunkDuration, text: plainText.trim() }];
              }
            } catch { /* skip chunk */ }
          } finally {
            releaseSemaphore();
          }

          const chunkWordCount = chunkText.split(/\s+/).filter(Boolean).length;
          const chunkAudioDuration = segs.length > 0 ? Math.round((segs[segs.length - 1].end - segs[0].start) * 10) / 10 : 0;
          sendEvent('progress', {
            step: 'step_transcribe_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
            status: 'done', message: `${segs.length} segments, ${chunkWordCount} words`,
            segmentCount: segs.length,
            wordCount: chunkWordCount,
            transcript: chunkText,
            durationSec: chunkAudioDuration,
            timeRange: segs.length > 0
              ? { startSec: Math.round(segs[0].start * 10) / 10, endSec: Math.round(segs[segs.length - 1].end * 10) / 10 }
              : null,
            segments: segs.map(s => ({
              start: Math.round(s.start * 10) / 10,
              end: Math.round(s.end * 10) / 10,
              text: s.text,
            })),
          });

          // ── Classify ads in this chunk ──
          const chunkLines = buildLinesFromSegments(segs);
          let chunkAdBlocks: SandboxAdBlock[] = [];

          if (chunkLines.length >= 3) {
            sendEvent('progress', {
              step: 'step_classify_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
              message: `Classifying ads in chunk ${ci + 1}...`,
              input: {
                linesCount: chunkLines.length,
                totalWords: chunkLines.length > 0 ? chunkLines[chunkLines.length - 1].cumulativeWords : 0,
                episodeTitle,
                strategy: LLM_API_KEY ? 'llm' : 'keyword-heuristic',
                firstLine: chunkLines[0]?.text.slice(0, 120),
                lastLine: chunkLines[chunkLines.length - 1]?.text.slice(0, 120),
              },
            });

            let classifyLlmRaw = '';
            try {
              const chunkClassify = await classifyAdsFromLines(chunkLines, episodeTitle, estDuration);
              chunkAdBlocks = chunkClassify.adBlocks;
              classifyLlmRaw = chunkClassify.llmRaw;
            } catch (classifyErr: any) {
              console.warn(`[sandbox] Chunk ${ci + 1} ad classification failed (non-fatal): ${classifyErr.message}`);
            }

            // Build per-line classification breakdown
            const lineClassification = chunkLines.map(l => {
              const adBlock = chunkAdBlocks.find(b => l.lineNum >= b.startLine && l.lineNum <= b.endLine);
              const totalWords = chunkLines.length > 0 ? chunkLines[chunkLines.length - 1].cumulativeWords : 0;
              const approxTime = estDuration > 0 && totalWords > 0 ? (l.cumulativeWords / totalWords) * estDuration : 0;
              return {
                lineNum: l.lineNum,
                text: l.text,
                speaker: l.speaker || undefined,
                timestamp: fmtTs(approxTime),
                classification: adBlock ? 'AD' as const : 'CONTENT' as const,
                adReason: adBlock?.reason || undefined,
              };
            });

            sendEvent('progress', {
              step: 'step_classify_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
              status: 'done', message: `${chunkAdBlocks.length} ad blocks`,
              adBlockCount: chunkAdBlocks.length,
              linesAnalyzed: chunkLines.length,
              adBlocks: chunkAdBlocks.map(b => ({
                startLine: b.startLine,
                endLine: b.endLine,
                reason: b.reason,
                textPreview: b.textPreview,
                startTimeSec: b.startTimeSec,
                endTimeSec: b.endTimeSec,
              })),
              lineClassification,
              rawResponse: classifyLlmRaw || undefined,
            });
          } else {
            sendEvent('progress', {
              step: 'step_classify_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
              status: 'done', message: `skipped (${chunkLines.length} lines)`,
              adBlockCount: 0,
              linesAnalyzed: chunkLines.length,
              reason: `Too few lines to classify (${chunkLines.length} < 3)`,
            });
          }

          // ── Refine ad boundaries (per-chunk, local context only) ──
          if (chunkAdBlocks.length > 0 && LLM_API_KEY) {
            const anchorSummary = chunkAdBlocks.map(b => ({
              startLine: b.startLine, endLine: b.endLine,
              reason: b.reason,
              startTimeSec: b.startTimeSec, endTimeSec: b.endTimeSec,
              textPreview: b.textPreview,
            }));
            sendEvent('progress', {
              step: 'step_refine_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
              message: `Refining ${chunkAdBlocks.length} boundaries...`,
              input: {
                anchorCount: chunkAdBlocks.length,
                anchors: anchorSummary,
                contextWindow: 5,
                linesCount: chunkLines.length,
                episodeTitle,
              },
            });
            let refineLlmRaw = '';
            try {
              const refined = await refineBoundariesWithLLM(chunkAdBlocks, chunkLines, estDuration, episodeTitle, '');
              refineLlmRaw = refined.llmRaw;
              chunkAdBlocks = refined.adBlocks;
            } catch (refineErr: any) {
              console.warn(`[sandbox] Chunk ${ci + 1} refine failed (non-fatal): ${refineErr.message}`);
            }
            const refinedAdTimeSec = chunkAdBlocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);
            sendEvent('progress', {
              step: 'step_refine_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
              status: 'done', message: `${chunkAdBlocks.length} refined, ${Math.round(refinedAdTimeSec)}s ads`,
              refinedBlocks: chunkAdBlocks.length,
              totalAdTimeSec: Math.round(refinedAdTimeSec * 10) / 10,
              refinedBoundaries: chunkAdBlocks.map(b => ({
                startLine: b.startLine, endLine: b.endLine,
                reason: b.reason,
                startTimeSec: b.startTimeSec, endTimeSec: b.endTimeSec,
                durationSec: Math.round((b.endTimeSec - b.startTimeSec) * 10) / 10,
                textPreview: b.textPreview,
              })),
              rawResponse: refineLlmRaw || undefined,
            });
          } else {
            sendEvent('progress', {
              step: 'step_refine_chunk', threadId, chunkIndex: ci, totalChunks: numChunks,
              status: 'done',
              message: chunkAdBlocks.length === 0 ? 'no ads found' : 'no LLM key',
              refinedBlocks: 0,
              reason: chunkAdBlocks.length === 0 ? 'No ad blocks from classification step' : 'No LLM API key configured',
            });
          }

          // ── Emit skip ranges to player ──
          const partialSkipMap = chunkAdBlocks.map(b => ({
            startTime: Math.round(b.startTimeSec * 10) / 10,
            endTime: Math.round(b.endTimeSec * 10) / 10,
            type: 'mid-roll' as const,
            confidence: 0.85,
            reason: b.reason,
          }));
          if (chunkAdBlocks.length > 0) {
            sendEvent('progress', {
              step: 'step_emit_skips', threadId, chunkIndex: ci, totalChunks: numChunks,
              message: `Emitting ${chunkAdBlocks.length} skip ranges...`,
              input: {
                adBlockCount: chunkAdBlocks.length,
                skipRanges: partialSkipMap,
              },
            });
            sendEvent('partial_ads', { skipMap: partialSkipMap, source: `chunk-${ci}` });
            console.log(`[sandbox] Chunk ${ci + 1}: ${chunkAdBlocks.length} skip ranges emitted to player`);
          }
          const totalSkipSec = partialSkipMap.reduce((s, r) => s + (r.endTime - r.startTime), 0);
          sendEvent('progress', {
            step: 'step_emit_skips', threadId, chunkIndex: ci, totalChunks: numChunks,
            status: 'done',
            message: chunkAdBlocks.length > 0 ? `${chunkAdBlocks.length} ranges (${Math.round(totalSkipSec)}s)` : 'no ads to skip',
            emittedRanges: chunkAdBlocks.length,
            skipMap: partialSkipMap.length > 0 ? partialSkipMap : undefined,
            totalSkipSec: totalSkipSec > 0 ? Math.round(totalSkipSec * 10) / 10 : 0,
          });

          chunkResults[ci] = { chunkIndex: ci, text: chunkText, segments: segs, lines: chunkLines, adBlocks: chunkAdBlocks };
        };

        // Launch all chunks concurrently (semaphore throttles STT to STT_CONCURRENCY)
        const chunkPromises = Array.from({ length: numChunks }, (_, ci) => processChunk(ci));
        await Promise.allSettled(chunkPromises);

        // Merge results in order
        let allText = '';
        let allSegments: Array<{ start: number; end: number; text: string }> = [];
        const allChunkAdBlocks: SandboxAdBlock[] = [];
        for (let ci = 0; ci < numChunks; ci++) {
          const cr = chunkResults[ci];
          if (cr) {
            allText += cr.text + ' ';
            allSegments.push(...cr.segments);
            allChunkAdBlocks.push(...cr.adBlocks);
          }
        }

        // Build final lines from all segments
        lines = buildLinesFromSegments(allSegments);
        const cumW = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

        // If segments produced no lines but we have accumulated text, split into sentences
        if (lines.length === 0 && allText.trim().length > 50) {
          console.log(`[sandbox] No segments but got raw text (${allText.trim().split(/\s+/).length} words) — splitting into sentences`);
          const sentences = allText.trim().split(/(?<=[.!?])\s+/);
          let cw = 0;
          let ln = 0;
          for (const sent of sentences) {
            const trimmed = sent.trim();
            if (!trimmed) continue;
            ln++;
            const wc = trimmed.split(/\s+/).filter(Boolean).length;
            cw += wc;
            lines.push({ lineNum: ln, speaker: '', text: trimmed, wordCount: wc, cumulativeWords: cw });
          }
        }

        transcriptSource = 'audio-transcription-chunked';
        html = allText.trim();
        rawHtmlLength = html.length;
        audioDetails.segmentCount = allSegments.length;
        audioDetails.audioDurationSec = estDuration;

        console.log(`[sandbox] Audio transcription complete: ${lines.length} lines, ${cumW} words, ${allSegments.length} segments`);

        // Per-chunk refine + emit already ran — no post-processing needed
        // Store merged ad blocks for the final result
        (audioDetails as any).chunkAdAnchors = allChunkAdBlocks;
      } catch (sttErr: any) {
        audioDetails.error = sttErr.message;
        console.warn(`[sandbox] Audio transcription failed: ${sttErr.message} — falling back to text transcript`);
        sendEvent('progress', { step: 'step_transcribe_chunk', status: 'error', message: `Audio transcription failed: ${sttErr.message}` });
      }
    }

    // Step 2: Try direct podcast transcript files (SRT, VTT, JSON from RSS)
    if (lines.length === 0 && podcastTranscripts && podcastTranscripts.length > 0) {
      sendEvent('progress', { step: 'step_fetch_html_transcript', message: 'Trying podcast transcript files (SRT/VTT/JSON)...' });
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
      sendEvent('progress', { step: 'step_fetch_html_transcript', message: 'Fetching HTML transcript...' });
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
        sendEvent('progress', { step: 'step_fetch_html_transcript', status: 'done', message: `HTML transcript fetched: ${lines.length} lines` });
      } catch (htmlErr: any) {
        console.warn(`[sandbox] HTML transcript fetch failed: ${htmlErr.message}`);
        sendEvent('progress', { step: 'step_fetch_html_transcript', status: 'error', message: `HTML fetch failed: ${htmlErr.message}` });
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

    // Derive topic context from title + opening content (no extra LLM call)
    const dur = durationSec || 0;
    const topicContext = deriveTopicContext(episodeTitle, lines);
    console.log(`[sandbox] Topic context: "${topicContext.slice(0, 120)}..."`);

    // Ad blocks already refined + emitted per-chunk — merge for final result
    const chunkAdAnchors: SandboxAdBlock[] = (audioDetails as any).chunkAdAnchors || [];
    let adBlocks: SandboxAdBlock[];
    let llmRaw = '';
    let systemPrompt = '';
    let userPrompt = '';

    if (chunkAdAnchors.length > 0) {
      adBlocks = chunkAdAnchors;
      llmRaw = `(per-chunk pipeline: ${chunkAdAnchors.length} ad blocks from ${new Set(chunkAdAnchors.map(b => Math.floor(b.startTimeSec / 65))).size} chunks)`;
    } else {
      // No audio chunks ran — fall back to full-transcript classification
      const classifyResult = await classifyAdsFromLines(lines, episodeTitle, dur, topicContext);
      adBlocks = classifyResult.adBlocks;
      llmRaw = classifyResult.llmRaw;
      systemPrompt = classifyResult.systemPrompt;
      userPrompt = classifyResult.userPrompt;
    }

    // Build final skip map (already emitted per-chunk, this is for the complete result)

    const skipMap = adBlocks.map(b => ({
      startTime: Math.round(b.startTimeSec * 10) / 10,
      endTime: Math.round(b.endTimeSec * 10) / 10,
      type: 'mid-roll' as const,
      confidence: LLM_API_KEY ? 0.85 : 0.5,
      reason: b.reason,
    }));

    const totalAdWords = adBlocks.reduce((s, b) => s + (b.endWord - b.startWord), 0);
    const totalAdTimeSec = adBlocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);

    // Compute QA diagnostics
    const speechRateWpm = 155;
    const expectedSpeechSec = totalWords > 0 ? (totalWords / speechRateWpm) * 60 : 0;
    const impliedAdTimeSec = Math.max(0, dur - expectedSpeechSec);

    // Send the complete result
    sendEvent('complete', {
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
      audioDetails,
    });
    res.end();
  } catch (err: any) {
    console.error('Sandbox analyze error:', err.message);
    sendEvent('error', { error: 'Sandbox analysis failed', detail: err.message });
    res.end();
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
const PORT = parseInt(String(process.env.PORT || '3001'), 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`NPR Podcast server running on http://0.0.0.0:${PORT}`);
  console.log(`OpenAI model: ${LLM_MODEL}, key: ${LLM_API_KEY ? '***set***' : 'NOT SET (fallback mode)'}`);
});
