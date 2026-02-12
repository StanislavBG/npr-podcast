import { useState, useCallback, useRef, useEffect } from 'react';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import {
  fetchPodcasts,
  fetchEpisodes,
  fetchTranscript,
  type Podcast,
  type Episode,
} from './services/api';
import { detectAdSegments, type AdDetectionResult } from './services/adDetector';

export default function App() {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [selected, setSelected] = useState('510325');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [ads, setAds] = useState<AdDetectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    fetchPodcasts()
      .then(setPodcasts)
      .catch(() =>
        setPodcasts([
          { id: '510325', name: 'The Indicator from Planet Money' },
          { id: '510289', name: 'Planet Money' },
          { id: '510318', name: 'Short Wave' },
          { id: '510308', name: 'Hidden Brain' },
          { id: '344098539', name: 'Up First' },
        ])
      );
  }, []);

  const load = useCallback(
    async (id: string) => {
      if (loaded.current === id && episodes.length > 0) return;
      setLoading(true);
      setEpisode(null);
      setAds(null);
      try {
        const data = await fetchEpisodes(id);
        setEpisodes(data.episodes);
        loaded.current = id;
      } catch {
        /* silent */
      } finally {
        setLoading(false);
      }
    },
    [episodes.length]
  );

  useEffect(() => {
    load(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = useCallback(async (ep: Episode) => {
    setEpisode(ep);
    setAds(null);

    let wordCount = 0;
    if (ep.transcriptUrl) {
      try {
        const t = await fetchTranscript(ep.transcriptUrl);
        wordCount = t.fullText.split(/\s+/).length;
      } catch {
        /* continue without transcript */
      }
    }

    const parts = ep.duration.split(':').map(Number);
    let sec = 0;
    if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
    else sec = parseInt(ep.duration) || 600;

    setAds(detectAdSegments(sec, wordCount, wordCount > 0));
  }, []);

  return (
    <div className="app">
      <PodcastSelector
        podcasts={podcasts}
        selected={selected}
        onSelect={setSelected}
      />

      <EpisodeList
        episodes={episodes}
        loading={loading}
        selectedId={episode?.id || null}
        onSelect={pick}
      />

      {episode ? (
        <Player episode={episode} adDetection={ads} />
      ) : (
        <div className="empty">Tap an episode</div>
      )}
    </div>
  );
}
