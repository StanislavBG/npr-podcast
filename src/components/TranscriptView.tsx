import type { LLMTranscriptResult, AdDetectionResult } from '../services/adDetector';

interface Props {
  transcript: LLMTranscriptResult;
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
            {transcript.estimatedContentWords} words
            {transcript.adMentions.length > 0 &&
              ` \u00B7 ${transcript.adMentions.length} ad mentions detected by LLM`}
          </span>
        )}
      </div>
      <div className="transcript-content">
        {transcript.segments.map((seg, i) => {
          const adMention = transcript.adMentions.find(
            (m) => m.segmentIndex === i
          );
          return (
            <div
              key={i}
              className={`transcript-segment ${seg.isAd ? 'ad-mention' : ''}`}
            >
              {seg.speaker && (
                <span className="transcript-speaker">{seg.speaker}:</span>
              )}
              <span className="transcript-text">{seg.text}</span>
              {adMention && (
                <span className="ad-reason" title={adMention.reason}>
                  [{adMention.reason}]
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
