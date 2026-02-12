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
            <span className="ep-date">{date}</span>
            <span className="ep-title">{ep.title}</span>
            {ep.link && (
              <a
                className="ep-link-icon"
                href={ep.link}
                target="_blank"
                rel="noopener noreferrer"
                title={ep.link}
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            )}
          </button>
        );
      })}
    </div>
  );
}
