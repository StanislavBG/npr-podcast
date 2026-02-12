import { useState, useRef, useEffect } from 'react';
import type { Podcast } from '../services/api';

interface Props {
  podcasts: Podcast[];
  selected: string;
  onSelect: (id: string) => void;
}

export function PodcastSelector({ podcasts, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = podcasts.find((p) => p.id === selected);

  // Close on outside tap
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  return (
    <div className="podcast-selector" ref={ref}>
      <button
        className="podcast-trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="podcast-trigger-label">
          {current?.name || 'Select podcast'}
        </span>
        <span className={`podcast-chevron ${open ? 'open' : ''}`}>&#9662;</span>
      </button>

      {open && (
        <div className="podcast-dropdown">
          {podcasts.map((p) => (
            <button
              key={p.id}
              className={`podcast-option ${selected === p.id ? 'active' : ''}`}
              onClick={() => {
                onSelect(p.id);
                setOpen(false);
              }}
            >
              <span className="podcast-option-dot">
                {selected === p.id ? '\u25CF' : '\u25CB'}
              </span>
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
