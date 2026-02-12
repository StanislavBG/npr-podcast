import { useState, useCallback, useRef, useEffect } from 'react';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import { FlowVisualizer } from './components/FlowVisualizer';
import { TranscriptView } from './components/TranscriptView';
import {
  fetchPodcasts,
  fetchEpisodes,
  fetchTranscript,
  type Podcast,
  type Episode,
  type TranscriptData,
} from './services/api';
import {
  detectAdSegments,
  type AdDetectionResult,
} from './services/adDetector';
import {
  createInitialFlowState,
  type FlowState,
  type StepStatus,
} from './workflows/podcastFlow';

export default function App() {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [selectedPodcast, setSelectedPodcast] = useState<string>('510325');
  const [podcastName, setPodcastName] = useState('');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedEpisode, setSelectedEpisode] = useState<Episode | null>(null);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [adDetection, setAdDetection] = useState<AdDetectionResult | null>(null);
  const [flowState, setFlowState] = useState<FlowState>(createInitialFlowState());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const loadedPodcastRef = useRef<string | null>(null);

  const updateStep = useCallback(
    (stepId: string, status: StepStatus) => {
      setFlowState((prev) => ({
        ...prev,
        steps: { ...prev.steps, [stepId]: status },
        currentStep: status === 'running' ? stepId : prev.currentStep,
      }));
    },
    []
  );

  // Load podcasts on mount
  useEffect(() => {
    fetchPodcasts()
      .then(setPodcasts)
      .catch(() => {
        setPodcasts([
          { id: '510325', name: 'The Indicator from Planet Money' },
          { id: '510289', name: 'Planet Money' },
          { id: '510318', name: 'Short Wave' },
          { id: '510308', name: 'Hidden Brain' },
          { id: '344098539', name: 'Up First' },
        ]);
      });
  }, []);

  // Load episodes when podcast selection changes
  const loadEpisodes = useCallback(
    async (podcastId: string) => {
      if (loadedPodcastRef.current === podcastId && episodes.length > 0) return;

      setLoading(true);
      setError(null);
      setSelectedEpisode(null);
      setTranscript(null);
      setAdDetection(null);
      setFlowState(createInitialFlowState());

      updateStep('step_fetch_rss', 'running');
      try {
        const data = await fetchEpisodes(podcastId);
        updateStep('step_fetch_rss', 'completed');

        updateStep('step_parse_episodes', 'running');
        setEpisodes(data.episodes);
        setPodcastName(data.podcastName);
        loadedPodcastRef.current = podcastId;
        updateStep('step_parse_episodes', 'completed');
      } catch (err: any) {
        updateStep('step_fetch_rss', 'failed');
        setError(err.message || 'Failed to load episodes');
      } finally {
        setLoading(false);
      }
    },
    [episodes.length, updateStep]
  );

  useEffect(() => {
    loadEpisodes(selectedPodcast);
  }, [selectedPodcast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load transcript and detect ads for selected episode
  const selectEpisode = useCallback(
    async (episode: Episode) => {
      setSelectedEpisode(episode);
      setTranscript(null);
      setAdDetection(null);
      setShowTranscript(false);

      setFlowState((prev) => ({
        ...prev,
        steps: {
          ...prev.steps,
          step_fetch_transcript: 'pending',
          step_detect_ads: 'pending',
          step_prepare_player: 'pending',
        },
      }));

      if (episode.transcriptUrl) {
        updateStep('step_fetch_transcript', 'running');
        try {
          const t = await fetchTranscript(episode.transcriptUrl);
          setTranscript(t);
          updateStep('step_fetch_transcript', 'completed');

          updateStep('step_detect_ads', 'running');
          const wordCount = t.fullText.split(/\s+/).length;
          const durationParts = episode.duration.split(':').map(Number);
          let durationSec = 0;
          if (durationParts.length === 3)
            durationSec =
              durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
          else if (durationParts.length === 2)
            durationSec = durationParts[0] * 60 + durationParts[1];
          else durationSec = parseInt(episode.duration) || 600;

          const detection = detectAdSegments(durationSec, wordCount, true);
          setAdDetection(detection);
          updateStep('step_detect_ads', 'completed');

          updateStep('step_prepare_player', 'running');
          await new Promise((r) => setTimeout(r, 200));
          updateStep('step_prepare_player', 'completed');
        } catch {
          updateStep('step_fetch_transcript', 'failed');
          updateStep('step_detect_ads', 'running');
          const durationSec = parseInt(episode.duration) || 600;
          const detection = detectAdSegments(durationSec, 0, false);
          setAdDetection(detection);
          updateStep('step_detect_ads', 'completed');
          updateStep('step_prepare_player', 'running');
          await new Promise((r) => setTimeout(r, 200));
          updateStep('step_prepare_player', 'completed');
        }
      } else {
        updateStep('step_fetch_transcript', 'skipped');
        updateStep('step_detect_ads', 'running');
        const durationSec = parseInt(episode.duration) || 600;
        const detection = detectAdSegments(durationSec, 0, false);
        setAdDetection(detection);
        updateStep('step_detect_ads', 'completed');
        updateStep('step_prepare_player', 'running');
        await new Promise((r) => setTimeout(r, 200));
        updateStep('step_prepare_player', 'completed');
      }
    },
    [updateStep]
  );

  return (
    <div className="app">
      {/* ── Top bar: branding + podcast dropdown ── */}
      <header className="app-header">
        <div className="header-row">
          <div className="header-brand">
            <h1>NPR Podcast Player</h1>
            <span className="subtitle">Ad-free listening</span>
          </div>
          <PodcastSelector
            podcasts={podcasts}
            selected={selectedPodcast}
            onSelect={setSelectedPodcast}
          />
        </div>
      </header>

      {/* ── Episode strip: horizontal scrollable cards ── */}
      <section className="section-episodes">
        {error && <div className="error-banner">{error}</div>}
        <EpisodeList
          episodes={episodes}
          podcastName={podcastName}
          loading={loading}
          selectedId={selectedEpisode?.id || null}
          onSelect={selectEpisode}
        />
      </section>

      {/* ── Player / Ad widget ── */}
      <section className="section-player">
        {selectedEpisode ? (
          <Player episode={selectedEpisode} adDetection={adDetection} />
        ) : (
          <div className="player-placeholder">
            <p>Select an episode to start listening</p>
          </div>
        )}
      </section>

      {/* ── Flow control widget ── */}
      <section className="section-flow">
        <FlowVisualizer flowState={flowState} />
      </section>

      {/* ── Transcript (collapsible) ── */}
      {transcript && selectedEpisode && (
        <section className="section-transcript">
          <button
            className="transcript-toggle"
            onClick={() => setShowTranscript(!showTranscript)}
          >
            <span>Transcript</span>
            <span className={`toggle-chevron ${showTranscript ? 'open' : ''}`}>
              &#9662;
            </span>
          </button>
          {showTranscript && (
            <TranscriptView transcript={transcript} adDetection={adDetection} />
          )}
        </section>
      )}
    </div>
  );
}
