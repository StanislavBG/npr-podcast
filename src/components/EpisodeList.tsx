import { useRef, useEffect, useMemo } from 'react';
import type { Episode } from '../services/api';
import { ScrollableSlider } from './ScrollableSlider';

interface Props {
  episodes: Episode[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (episode: Episode) => void;
}

/** Group episodes by date label, e.g. "Today", "Yesterday", "Feb 10" */
function groupByDay(episodes: Episode[]): { label: string; eps: Episode[] }[] {
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  const map = new Map<string, Episode[]>();
  const labels = new Map<string, string>();

  for (const ep of episodes) {
    const d = ep.pubDate ? new Date(ep.pubDate) : null;
    const key = d ? d.toDateString() : 'Unknown';
    if (!map.has(key)) {
      map.set(key, []);
      if (key === todayStr) labels.set(key, 'Today');
      else if (key === yesterdayStr) labels.set(key, 'Yesterday');
      else if (d)
        labels.set(
          key,
          d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        );
      else labels.set(key, 'Unknown');
    }
    map.get(key)!.push(ep);
  }

  return Array.from(map.entries()).map(([key, eps]) => ({
    label: labels.get(key) || key,
    eps,
  }));
}

export function EpisodeList({ episodes, loading, selectedId, onSelect }: Props) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Take latest 3 episodes per the request
  const latest = useMemo(() => episodes.slice(0, 3), [episodes]);
  const groups = useMemo(() => groupByDay(latest), [latest]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [selectedId]);

  if (loading)
    return (
      <div className="episodes-h">
        <div className="dot" />
      </div>
    );
  if (!episodes.length) return null;

  return (
    <div className="episodes-h-wrapper">
      <ScrollableSlider className="episodes-h">
        {groups.map((group) => (
          <div key={group.label} className="ep-day-group">
            <div className="ep-day-label">{group.label}</div>
            <div className="ep-day-tiles">
              {group.eps.map((ep) => {
                const on = selectedId === ep.id;
                const time = ep.pubDate
                  ? new Date(ep.pubDate).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : '';

                return (
                  <button
                    key={ep.id}
                    ref={on ? selectedRef : undefined}
                    className={`ep-tile ${on ? 'on' : ''}`}
                    onClick={() => onSelect(ep)}
                  >
                    <div className="ep-tile-meta">
                      {time && <span className="ep-tile-time">{time}</span>}
                      {ep.duration && (
                        <span className="ep-tile-dur">{ep.duration}</span>
                      )}
                    </div>
                    <span className="ep-tile-title">{ep.title}</span>
                    {ep.description && (
                      <span className="ep-tile-desc">{ep.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </ScrollableSlider>
      {episodes.length > 3 && (
        <div className="ep-swipe-hint">Swipe for more episodes</div>
      )}
    </div>
  );
}
