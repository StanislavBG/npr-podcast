/**
 * Ad segment detection for NPR podcasts — LLM-powered via bilko-flow chatJSON.
 *
 * The old approach: regex patterns + word-count-divided-by-155-WPM heuristics.
 * The new approach: three chained chatJSON calls that actually understand content.
 *
 * Pipeline:
 *   1. chatJSON parses raw transcript HTML → structured segments with ad flags
 *   2. chatJSON analyzes transcript + duration → ad time ranges with reasoning
 *   3. chatJSON summarizes + validates → final skip map
 *
 * All three calls go through bilko-flow's chatJSON with its 3-layer defense:
 *   Layer 1: response_format JSON constraint (OpenAI/Gemini)
 *   Layer 2: cleanLLMResponse + repairJSON
 *   Layer 3: Retry with corrective re-prompt
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
