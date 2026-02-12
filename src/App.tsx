import { useState, useCallback, useRef, useEffect } from 'react';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import { FlowVisualizer } from './components/FlowVisualizer';
import {
  fetchPodcasts,
  fetchEpisodes,
  fetchTranscript,
  type Podcast,
  type Episode,
} from './services/api';
import { detectAdSegments, type AdDetectionResult } from './services/adDetector';
import {
  createInitialFlowState,
  type FlowState,
  type StepStatus,
} from './workflows/podcastFlow';

function setStep(
  prev: FlowState,
  stepId: string,
  status: StepStatus,
): FlowState {
  return {
    ...prev,
    steps: { ...prev.steps, [stepId]: status },
    currentStep: status === 'running' ? stepId : prev.currentStep,
  };
}

export default function App() {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [selected, setSelected] = useState('510325');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [ads, setAds] = useState<AdDetectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowState>(createInitialFlowState());
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
      setError(null);

      let fs = createInitialFlowState();
      fs = setStep(fs, 'step_fetch_rss', 'running');
      setFlow(fs);

      try {
        const data = await fetchEpisodes(id);
        setEpisodes(data.episodes);
        loaded.current = id;

        fs = setStep(fs, 'step_fetch_rss', 'completed');
        fs = setStep(fs, 'step_parse_episodes', 'running');
        setFlow(fs);

        fs = setStep(fs, 'step_parse_episodes', 'completed');
        setFlow(fs);
      } catch {
        fs = setStep(fs, 'step_fetch_rss', 'failed');
        fs = { ...fs, error: 'RSS fetch failed' };
        setFlow(fs);
        setError('Could not load episodes. Check your connection.');
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

    setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'running'));

    let wordCount = 0;
    if (ep.transcriptUrl) {
      try {
        const t = await fetchTranscript(ep.transcriptUrl);
        wordCount = t.fullText.split(/\s+/).length;
        setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'completed'));
      } catch {
        setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'skipped'));
      }
    } else {
      setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'skipped'));
    }

    setFlow((prev) => setStep(prev, 'step_detect_ads', 'running'));

    const parts = ep.duration.split(':').map(Number);
    let sec = 0;
    if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
    else sec = parseInt(ep.duration) || 600;

    const adResult = detectAdSegments(sec, wordCount, wordCount > 0);
    setAds(adResult);

    setFlow((prev) => {
      let fs = setStep(prev, 'step_detect_ads', 'completed');
      fs = setStep(fs, 'step_prepare_player', 'running');
      return fs;
    });

    setFlow((prev) => {
      const fs = setStep(prev, 'step_prepare_player', 'completed');
      return { ...fs, currentStep: null };
    });
  }, []);

  return (
    <div className="phone-frame">
      <div className="phone-notch" />
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

        {error && !episodes.length ? (
          <div className="empty">{error}</div>
        ) : episode ? (
          <Player episode={episode} adDetection={ads} />
        ) : (
          <div className="empty">Tap an episode</div>
        )}

        <FlowVisualizer flowState={flow} />
        <div className="home-indicator" />
      </div>
    </div>
  );
}
