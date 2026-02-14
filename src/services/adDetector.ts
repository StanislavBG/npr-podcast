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

// ─── Chunk merge/dedup (used by App.tsx chunk orchestrator) ─────────────────

/**
 * Merge ad segments from a new chunk into the existing accumulated segments.
 * Handles deduplication from overlapping chunk regions and merges adjacent segments.
 */
export function mergeChunkAdSegments(
  existing: AdSegment[],
  incoming: AdSegment[],
): AdSegment[] {
  const all = [...existing, ...incoming];
  if (all.length === 0) return [];

  // Sort by startTime
  all.sort((a, b) => a.startTime - b.startTime);

  // Merge overlapping or adjacent segments (within 3s gap)
  const merged: AdSegment[] = [{ ...all[0] }];
  for (let i = 1; i < all.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = all[i];
    if (curr.startTime <= prev.endTime + 3) {
      // Merge: extend range, keep higher confidence
      prev.endTime = Math.max(prev.endTime, curr.endTime);
      if (curr.confidence > prev.confidence) {
        prev.confidence = curr.confidence;
        prev.reason = curr.reason;
        prev.type = curr.type;
      }
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
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
