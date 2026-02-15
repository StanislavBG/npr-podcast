import type { AdDetectionResult, AdSegment, LLMTranscriptResult, PlaybackConfig } from './adDetector';

const BASE = '/api';

export interface Podcast {
  id: string;
  name: string;
}

export interface PodcastTranscript {
  url: string;
  type: string;
}

export interface Episode {
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

// ─── Existing endpoints ─────────────────────────────────────────────────────

export async function fetchPodcasts(): Promise<Podcast[]> {
  const res = await fetch(`${BASE}/podcasts`);
  if (!res.ok) throw new Error('Failed to fetch podcasts');
  return res.json();
}

export async function fetchEpisodes(
  podcastId: string
): Promise<{ podcastName: string; episodes: Episode[] }> {
  const res = await fetch(`${BASE}/podcast/${podcastId}/episodes`);
  if (!res.ok) throw new Error('Failed to fetch episodes');
  return res.json();
}

/** Fetch raw transcript HTML (server parses it into numbered lines) */
export async function fetchTranscriptHtml(
  transcriptUrl: string
): Promise<{ html: string }> {
  const res = await fetch(
    `${BASE}/transcript?url=${encodeURIComponent(transcriptUrl)}`
  );
  if (!res.ok) throw new Error('Failed to fetch transcript');
  return res.json();
}

export function getAudioProxyUrl(audioUrl: string): string {
  return `${BASE}/audio?url=${encodeURIComponent(audioUrl)}`;
}

// ─── LLM Pipeline endpoints (v2 — OpenAI on server) ─────────────────────────

/** Step 4: LLM parses raw HTML into structured transcript with ad flags */
export async function llmParseTranscript(html: string): Promise<LLMTranscriptResult> {
  const res = await fetch(`${BASE}/llm/parse-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'LLM parse-transcript failed');
  }
  return res.json();
}

/** Step 5: LLM analyzes transcript + duration to produce ad time ranges */
export async function llmDetectAds(
  transcript: LLMTranscriptResult,
  audioDurationSeconds: number,
  episodeTitle: string,
): Promise<AdDetectionResult> {
  const res = await fetch(`${BASE}/llm/detect-ads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, audioDurationSeconds, episodeTitle }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'LLM detect-ads failed');
  }
  return res.json();
}

/** Step 6: LLM summarizes episode and produces final skip map */
export async function llmPreparePlayback(
  transcript: LLMTranscriptResult,
  adDetection: AdDetectionResult,
  episodeTitle: string,
  episodeDescription: string,
): Promise<PlaybackConfig> {
  const res = await fetch(`${BASE}/llm/prepare-playback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, adDetection, episodeTitle, episodeDescription }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'LLM prepare-playback failed');
  }
  return res.json();
}

// ─── Chunked Audio Processing endpoints ─────────────────────────────────────

export interface AudioMeta {
  resolvedUrl: string;
  contentLength: number;
  acceptRanges: boolean;
  contentType: string;
  durationSec: number;
  bitrate: number;
  totalChunks: number;
  chunkDurationSec: number;
}

export interface ChunkResult {
  chunkIndex: number;
  startTimeSec: number;
  endTimeSec: number;
  transcript: { text: string; segments: Array<{ start: number; end: number; text: string }> };
  adSegments: AdSegment[];
  trailingText: string;
}

/** Step 3: Resolve audio URL — HEAD request, follow redirects, get metadata */
export async function resolveAudio(audioUrl: string): Promise<AudioMeta> {
  const res = await fetch(`${BASE}/audio/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Audio resolve failed');
  }
  return res.json();
}

/** Step 6: Detect ads from the full assembled transcript (all chunks) */
export async function detectAdsFromTranscript(params: {
  segments: Array<{ start: number; end: number; text: string }>;
  episodeTitle: string;
  durationSec: number;
}): Promise<{ adSegments: AdSegment[] }> {
  const res = await fetch(`${BASE}/audio/detect-ads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Ad detection failed');
  }
  return res.json();
}

/** Steps 4+5: Process a single audio chunk — fetch and transcribe */
export async function processAudioChunk(params: {
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
}): Promise<ChunkResult> {
  const res = await fetch(`${BASE}/audio/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `Chunk ${params.chunkIndex} processing failed`);
  }
  return res.json();
}

// ─── Sandbox endpoint ────────────────────────────────────────────────────────

export interface SandboxLine {
  lineNum: number;
  speaker: string;
  text: string;
  wordCount: number;
  cumulativeWords: number;
}

export interface SandboxAdBlock {
  startLine: number;
  endLine: number;
  reason: string;
  textPreview: string;
  startWord: number;
  endWord: number;
  startTimeSec: number;
  endTimeSec: number;
}

export interface SandboxAudioDetails {
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
}

export interface SandboxResult {
  episode: { title: string; durationSec: number; transcriptUrl: string };
  rawHtml: { length: number; pTagCount: number; snippet: string };
  transcript: { lineCount: number; totalWords: number; lines: SandboxLine[] };
  transcriptSource?: string;
  validation?: {
    isValid: boolean;
    reason: string;
    details: {
      lineCount: number;
      totalWords: number;
      linesWithSpeaker: number;
      expectedMinWords: number;
      avgWordsPerLine: number;
    };
  };
  adBlocks: SandboxAdBlock[];
  summary: {
    totalAdBlocks: number;
    totalAdWords: number;
    totalAdTimeSec: number;
    contentTimeSec: number;
    adWordPercent: number;
    strategy: string;
  };
  qa: {
    expectedSpeechSec: number;
    impliedAdTimeSec: number;
    speechRateWpm: number;
    audioDurationSec: number;
    transcriptWords: number;
    linesWithSpeaker: number;
    linesWithoutSpeaker: number;
  };
  prompts: { system: string; user: string };
  llmResponse: string;
  skipMap: Array<{
    startTime: number;
    endTime: number;
    type: string;
    confidence: number;
    reason: string;
  }>;
  audioDetails?: SandboxAudioDetails;
}

/** Progress event from the SSE sandbox stream */
export interface SandboxProgressEvent {
  step: string;
  status?: 'done' | 'error' | 'skipped';
  message: string;
  // Parallel chunk tracking — present for per-chunk Steps 5+6
  threadId?: string;
  chunkIndex?: number;
  totalChunks?: number;
  [key: string]: unknown;
}

/** Partial ad detection result sent before full analysis completes */
export interface PartialAdsEvent {
  skipMap: Array<{
    startTime: number;
    endTime: number;
    type: string;
    confidence: number;
    reason: string;
  }>;
  source: string;
}

/**
 * Stream sandbox analysis via SSE. Calls onProgress for each pipeline step,
 * onPartialAds for early ad detection results, then resolves with the final SandboxResult.
 */
export async function sandboxAnalyzeStream(
  transcriptUrl: string,
  episodeTitle: string,
  durationSec: number,
  onProgress: (event: SandboxProgressEvent) => void,
  podcastTranscripts?: PodcastTranscript[],
  audioUrl?: string,
  onPartialAds?: (event: PartialAdsEvent) => void,
  testMode?: boolean,
): Promise<SandboxResult> {
  const res = await fetch(`${BASE}/sandbox/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcriptUrl, episodeTitle, durationSec, podcastTranscripts, audioUrl, testMode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Sandbox analysis failed');
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: SandboxResult | null = null;
  let streamError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || ''; // keep incomplete last part

    for (const part of parts) {
      if (!part.trim()) continue;
      let eventType = 'message';
      let data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        if (eventType === 'progress') {
          onProgress(parsed as SandboxProgressEvent);
        } else if (eventType === 'partial_ads') {
          onPartialAds?.(parsed as PartialAdsEvent);
        } else if (eventType === 'complete') {
          result = parsed as SandboxResult;
        } else if (eventType === 'error') {
          streamError = parsed.error || parsed.detail || 'Unknown error';
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('Sandbox stream ended without a result');
  return result;
}

/** Legacy non-streaming sandbox call (kept for compatibility) */
export async function sandboxAnalyze(
  transcriptUrl: string,
  episodeTitle: string,
  durationSec: number,
  podcastTranscripts?: PodcastTranscript[],
  audioUrl?: string,
): Promise<SandboxResult> {
  return sandboxAnalyzeStream(
    transcriptUrl, episodeTitle, durationSec,
    () => {}, // ignore progress
    podcastTranscripts, audioUrl,
  );
}

/** Parse "MM:SS" or "HH:MM:SS" or raw seconds into seconds number */
export function parseDuration(duration: string): number {
  if (!duration) return 0;
  if (/^\d+$/.test(duration)) return parseInt(duration, 10);
  const parts = duration.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** Format seconds as MM:SS */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format seconds as 00h:00m:00s */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}h:${m.toString().padStart(2, '0')}m:${s.toString().padStart(2, '0')}s`;
}
