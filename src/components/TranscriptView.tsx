import type { TranscriptData } from '../services/api';
import type { AdDetectionResult } from '../services/adDetector';

interface Props {
  transcript: TranscriptData;
  adDetection: AdDetectionResult | null;
}

export function TranscriptView({ transcript, adDetection }: Props) {
  if (!transcript.segments.length) {
    return (
      <div className="transcript-view">
        <h3>Transcript</h3>
        <p className="transcript-empty">
          Transcript could not be parsed for this episode.
        </p>
      </div>
    );
  }

  return (
    <div className="transcript-view">
      <div className="transcript-header">
        <h3>Transcript</h3>
        {adDetection && (
          <span className="transcript-stats">
            {transcript.segments.length} segments
            {' \u00B7 '}
            {transcript.fullText.split(/\s+/).length} words
            {transcript.adMarkers.length > 0 &&
              ` \u00B7 ${transcript.adMarkers.length} sponsor mentions detected`}
          </span>
        )}
      </div>
      <div className="transcript-content">
        {transcript.segments.map((seg, i) => {
          const isAdMention = transcript.adMarkers.some(
            (m) => m.pattern === `segment_${i}`
          );
          return (
            <div
              key={i}
              className={`transcript-segment ${isAdMention ? 'ad-mention' : ''}`}
            >
              {seg.speaker && (
                <span className="transcript-speaker">{seg.speaker}:</span>
              )}
              <span className="transcript-text">{seg.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
