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
  if (loading) {
    return (
      <div className="episode-list">
        <h2>Loading episodes...</h2>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div className="episode-list">
        <h2>No episodes found</h2>
        <p>Select a podcast from the sidebar to load episodes.</p>
      </div>
    );
  }

  return (
    <div className="episode-list">
      <h2>{podcastName}</h2>
      <p className="episode-count">{episodes.length} episodes</p>
      <div className="episodes">
        {episodes.map((ep) => {
          const date = ep.pubDate
            ? new Date(ep.pubDate).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '';

          return (
            <button
              key={ep.id}
              className={`episode-card ${selectedId === ep.id ? 'selected' : ''}`}
              onClick={() => onSelect(ep)}
            >
              <div className="episode-meta">
                <span className="episode-date">{date}</span>
                {ep.duration && (
                  <span className="episode-duration">{ep.duration}</span>
                )}
              </div>
              <h3 className="episode-title">{ep.title}</h3>
              <p className="episode-desc">
                {ep.description.length > 150
                  ? ep.description.slice(0, 150) + '...'
                  : ep.description}
              </p>
              {ep.transcriptUrl && (
                <span className="transcript-badge">Transcript available</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
