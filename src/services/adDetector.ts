/**
 * Ad segment detection for NPR podcasts — LLM-powered (OpenAI).
 *
 * v2 pipeline (same logic as sandbox):
 *   1. Server-side HTML parsing → numbered transcript lines
 *   2. Single LLM call: "which line ranges are ad blocks?"
 *   3. Map line ranges → audio timestamps via proportional word position
 *   4. LLM summarizes + validates → final skip map
 */

// ─── Types (kept for Player compatibility) ──────────────────────────────────

export interface AdSegment {
  startTime: number;
  endTime: number;
  type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention';
  confidence: number;
  reason?: string;
}

export interface AdDetectionResult {
  segments: AdSegment[];
  totalAdTime: number;
  contentDuration: number;
  strategy: string;
}

export interface LLMTranscriptResult {
  segments: Array<{
    speaker: string;
    text: string;
    isAd: boolean;
    adType: string | null;
  }>;
  fullText: string;
  adMentions: Array<{
    segmentIndex: number;
    reason: string;
  }>;
  estimatedContentWords: number;
}

export interface PlaybackConfig {
  summary: string;
  topics: string[];
  skipMap: AdSegment[];
  contentDuration: number;
  totalAdTime: number;
  recommendation: string;
}

// ─── Player helpers (unchanged — used by Player.tsx timeupdate listener) ────

/** Check if a given time falls within an ad segment */
export function isInAdSegment(
  currentTime: number,
  segments: AdSegment[]
): AdSegment | null {
  for (const seg of segments) {
    if (currentTime >= seg.startTime && currentTime < seg.endTime) {
      return seg;
    }
  }
  return null;
}

/** Get the next content start time after an ad segment */
export function getNextContentTime(
  currentTime: number,
  segments: AdSegment[]
): number {
  for (const seg of segments) {
    if (currentTime >= seg.startTime && currentTime < seg.endTime) {
      return seg.endTime;
    }
  }
  return currentTime;
}
