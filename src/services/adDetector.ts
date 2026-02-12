/**
 * Ad segment detection for NPR podcasts.
 *
 * NPR podcasts delivered via Megaphone have dynamically-inserted ads.
 * The strategy:
 *
 * 1. **Transcript-based detection**: NPR transcripts contain only the editorial
 *    content. By computing the expected speech duration from word count and
 *    comparing to the total audio duration, we can estimate how much of the
 *    audio is ads.
 *
 * 2. **Known NPR ad patterns**: NPR podcasts follow predictable structures —
 *    a pre-roll ad (first ~30-60s), a mid-roll break, and sometimes a post-roll.
 *    For ~10-minute shows like The Indicator, we use heuristic timing.
 *
 * 3. **Transcript gap matching**: If the transcript has sponsor mentions, we
 *    flag those time regions.
 */

export interface AdSegment {
  startTime: number;   // seconds
  endTime: number;     // seconds
  type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention';
  confidence: number;  // 0-1
}

export interface AdDetectionResult {
  segments: AdSegment[];
  totalAdTime: number;
  contentDuration: number;
  strategy: string;
}

// Average speaking rate in words per minute for NPR hosts
const WORDS_PER_MINUTE = 155;

export function detectAdSegments(
  audioDurationSeconds: number,
  transcriptWordCount: number,
  hasTranscript: boolean
): AdDetectionResult {
  const segments: AdSegment[] = [];

  if (!hasTranscript || transcriptWordCount === 0) {
    // Fallback: use heuristic-only detection for NPR podcasts
    return heuristicDetection(audioDurationSeconds);
  }

  // Estimate expected content duration from transcript word count
  const expectedContentSeconds = (transcriptWordCount / WORDS_PER_MINUTE) * 60;
  const adTimeEstimate = Math.max(0, audioDurationSeconds - expectedContentSeconds);

  // If difference is negligible (<15s), likely no ads or very short ones
  if (adTimeEstimate < 15) {
    return {
      segments: [],
      totalAdTime: 0,
      contentDuration: audioDurationSeconds,
      strategy: 'transcript-match-clean',
    };
  }

  // NPR Indicator episodes (~10 min) typically have:
  // - Pre-roll: 0 to ~30-45 seconds
  // - Mid-roll: around 40-60% through, lasting 30-90 seconds
  // - Post-roll: last ~15-20 seconds (NPR funding credits)

  // Pre-roll: almost always present
  const preRollDuration = Math.min(45, adTimeEstimate * 0.3);
  if (preRollDuration > 10) {
    segments.push({
      startTime: 0,
      endTime: preRollDuration,
      type: 'pre-roll',
      confidence: 0.85,
    });
  }

  // Mid-roll: present if there's enough ad time
  const midRollDuration = Math.min(90, adTimeEstimate * 0.5);
  if (midRollDuration > 15) {
    // Mid-roll typically at ~45-55% of the episode
    const midPoint = audioDurationSeconds * 0.48;
    segments.push({
      startTime: midPoint,
      endTime: midPoint + midRollDuration,
      type: 'mid-roll',
      confidence: 0.75,
    });
  }

  // Post-roll: shorter, at the very end
  const postRollDuration = Math.min(20, adTimeEstimate * 0.2);
  if (postRollDuration > 8) {
    segments.push({
      startTime: audioDurationSeconds - postRollDuration,
      endTime: audioDurationSeconds,
      type: 'post-roll',
      confidence: 0.7,
    });
  }

  const totalAdTime = segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);

  return {
    segments,
    totalAdTime,
    contentDuration: audioDurationSeconds - totalAdTime,
    strategy: 'transcript-duration-analysis',
  };
}

function heuristicDetection(audioDurationSeconds: number): AdDetectionResult {
  const segments: AdSegment[] = [];

  // For NPR shows, assume ~30s pre-roll, ~60s mid-roll, ~15s post-roll
  if (audioDurationSeconds > 120) {
    segments.push({
      startTime: 0,
      endTime: 30,
      type: 'pre-roll',
      confidence: 0.6,
    });
  }

  if (audioDurationSeconds > 300) {
    const midPoint = audioDurationSeconds * 0.48;
    segments.push({
      startTime: midPoint,
      endTime: midPoint + 60,
      type: 'mid-roll',
      confidence: 0.5,
    });
  }

  if (audioDurationSeconds > 180) {
    segments.push({
      startTime: audioDurationSeconds - 15,
      endTime: audioDurationSeconds,
      type: 'post-roll',
      confidence: 0.5,
    });
  }

  const totalAdTime = segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);

  return {
    segments,
    totalAdTime,
    contentDuration: audioDurationSeconds - totalAdTime,
    strategy: 'heuristic-only',
  };
}

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
