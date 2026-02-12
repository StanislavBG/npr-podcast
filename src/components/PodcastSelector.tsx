import type { Podcast } from '../services/api';

interface Props {
  podcasts: Podcast[];
  selected: string;
  onSelect: (id: string) => void;
}

export function PodcastSelector({ podcasts, selected, onSelect }: Props) {
  return (
    <div className="podcast-selector">
      <h2>Podcasts</h2>
      <div className="podcast-list">
        {podcasts.map((p) => (
          <button
            key={p.id}
            className={`podcast-item ${selected === p.id ? 'active' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="podcast-icon">
              {selected === p.id ? '\u25B6' : '\u25CB'}
            </span>
            <span className="podcast-name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
