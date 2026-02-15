import type { Podcast } from '../services/api';
import { ScrollableSlider } from './ScrollableSlider';

interface Props {
  podcasts: Podcast[];
  selected: string;
  onSelect: (id: string) => void;
}

export function PodcastSelector({ podcasts, selected, onSelect }: Props) {
  return (
    <ScrollableSlider className="shows">
      {podcasts.map((p) => (
        <button
          key={p.id}
          className={`show ${selected === p.id ? 'on' : ''}`}
          onClick={() => onSelect(p.id)}
        >
          {p.name.replace(/ from Planet Money$/, '')}
        </button>
      ))}
    </ScrollableSlider>
  );
}
