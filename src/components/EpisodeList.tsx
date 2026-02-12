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
      inline: 'center',
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
            <div className="ep-thumb">
              <svg className="ep-thumb-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 12h2l3-7 4 14 4-10 3 6h4" />
              </svg>
            </div>
            <div className="ep-body">
              <span className="ep-date">{date}</span>
              <span className="ep-title">{ep.title}</span>
              {ep.duration && <div className="ep-duration">{ep.duration}</div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
