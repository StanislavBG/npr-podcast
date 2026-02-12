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
  const loadedPodcastRef = useRef<string | null>(null);

  // Update a step in the flow state
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
        // Fallback if server isn't running
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

      // Step 1: Fetch RSS
      updateStep('step_fetch_rss', 'running');
      try {
        const data = await fetchEpisodes(podcastId);
        updateStep('step_fetch_rss', 'completed');

        // Step 2: Parse episodes
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

      // Reset flow steps for transcript + ad detection
      setFlowState((prev) => ({
        ...prev,
        steps: {
          ...prev.steps,
          step_fetch_transcript: 'pending',
          step_detect_ads: 'pending',
          step_prepare_player: 'pending',
        },
      }));

      // Step 3: Fetch transcript
      if (episode.transcriptUrl) {
        updateStep('step_fetch_transcript', 'running');
        try {
          const t = await fetchTranscript(episode.transcriptUrl);
          setTranscript(t);
          updateStep('step_fetch_transcript', 'completed');

          // Step 4: Detect ads
          updateStep('step_detect_ads', 'running');
          const wordCount = t.fullText.split(/\s+/).length;
          // We'll get actual duration from the audio element later;
          // for now use the RSS duration as estimate
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

          // Step 5: Prepare player
          updateStep('step_prepare_player', 'running');
          // Small delay to show the step visually
          await new Promise((r) => setTimeout(r, 200));
          updateStep('step_prepare_player', 'completed');
        } catch {
          updateStep('step_fetch_transcript', 'failed');
          // Still allow playback without transcript — use heuristic detection
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
        // Heuristic-only ad detection
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
      <header className="app-header">
        <div className="header-content">
          <h1>NPR Podcast Player</h1>
          <p className="subtitle">Ad-free listening experience</p>
        </div>
      </header>

      <main className="app-main">
        <div className="sidebar">
          <PodcastSelector
            podcasts={podcasts}
            selected={selectedPodcast}
            onSelect={(id) => {
              setSelectedPodcast(id);
            }}
          />

          <FlowVisualizer flowState={flowState} />
        </div>

        <div className="content">
          {error && <div className="error-banner">{error}</div>}

          <EpisodeList
            episodes={episodes}
            podcastName={podcastName}
            loading={loading}
            selectedId={selectedEpisode?.id || null}
            onSelect={selectEpisode}
          />
        </div>

        <div className="player-panel">
          {selectedEpisode && (
            <>
              <Player
                episode={selectedEpisode}
                adDetection={adDetection}
              />
              {transcript && (
                <TranscriptView
                  transcript={transcript}
                  adDetection={adDetection}
                />
              )}
            </>
          )}
          {!selectedEpisode && (
            <div className="player-placeholder">
              <p>Select an episode to start listening</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
