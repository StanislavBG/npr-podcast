import { useRef, useEffect } from 'react';
import type { Episode } from '../services/api';

interface Props {
  episodes: Episode[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (episode: Episode) => void;
}

export function EpisodeList({ episodes, loading, selectedId, onSelect }: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [selectedId]);

  if (loading) return <div className="episodes"><div className="dot" /></div>;
  if (!episodes.length) return null;

  return (
    <div className="episodes">
      {episodes.map((ep) => {
        const on = selectedId === ep.id;
        const date = ep.pubDate
          ? new Date(ep.pubDate).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })
          : '';

        return (
          <button
            key={ep.id}
            ref={on ? selectedRef : undefined}
            className={`ep ${on ? 'on' : ''}`}
            onClick={() => onSelect(ep)}
          >
            <div className="ep-meta">
              {date && <span className="ep-date">{date}</span>}
              {ep.duration && <span className="ep-duration">{ep.duration}</span>}
            </div>
            <span className="ep-title">{ep.title}</span>
            {ep.description && (
              <span className="ep-desc">{ep.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
