const BASE = '/api';

export interface Podcast {
  id: string;
  name: string;
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
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
}

export interface TranscriptData {
  segments: TranscriptSegment[];
  fullText: string;
  adMarkers: Array<{ type: string; pattern: string }>;
}

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

export async function fetchTranscript(
  transcriptUrl: string
): Promise<TranscriptData> {
  const res = await fetch(
    `${BASE}/transcript?url=${encodeURIComponent(transcriptUrl)}`
  );
  if (!res.ok) throw new Error('Failed to fetch transcript');
  return res.json();
}

export function getAudioProxyUrl(audioUrl: string): string {
  return `${BASE}/audio?url=${encodeURIComponent(audioUrl)}`;
}

/** Parse "MM:SS" or "HH:MM:SS" or raw seconds into seconds number */
export function parseDuration(duration: string): number {
  if (!duration) return 0;
  // Already a number (seconds)
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
