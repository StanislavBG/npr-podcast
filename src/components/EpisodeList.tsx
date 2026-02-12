import { useRef, useEffect } from 'react';
import type { Episode } from '../services/api';

interface Props {
  episodes: Episode[];
  podcastName: string;
  loading: boolean;
  selectedId: string | null;
  onSelect: (episode: Episode) => void;
}

export function EpisodeList({
  episodes,
  podcastName,
  loading,
  selectedId,
  onSelect,
}: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Scroll selected card into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [selectedId]);

  if (loading) {
    return (
      <div className="episode-list">
        <div className="episode-list-header">
          <span className="episode-list-title">Loading...</span>
        </div>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div className="episode-list">
        <div className="episode-list-header">
          <span className="episode-list-title">No episodes</span>
        </div>
      </div>
    );
  }

  return (
    <div className="episode-list">
      <div className="episode-list-header">
        <span className="episode-list-title">{podcastName}</span>
        <span className="episode-count">{episodes.length} episodes</span>
      </div>
      <div className="episodes-scroll">
        {episodes.map((ep) => {
          const isSelected = selectedId === ep.id;
          const date = ep.pubDate
            ? new Date(ep.pubDate).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })
            : '';

          return (
            <button
              key={ep.id}
              ref={isSelected ? selectedRef : undefined}
              className={`episode-card ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(ep)}
            >
              <div className="episode-meta">
                <span className="episode-date">{date}</span>
                {ep.duration && (
                  <span className="episode-duration">{ep.duration}</span>
                )}
              </div>
              <h3 className="episode-title">{ep.title}</h3>
              {ep.transcriptUrl && (
                <span className="transcript-badge">Transcript</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
