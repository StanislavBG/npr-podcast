import { useState, useCallback, useRef, useEffect } from 'react';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import { FlowVisualizer } from './components/FlowVisualizer';
import { SandboxPage } from './components/SandboxPage';
import {
  fetchPodcasts,
  fetchEpisodes,
  fetchTranscriptHtml,
  llmParseTranscript,
  llmDetectAds,
  llmPreparePlayback,
  parseDuration,
  type Podcast,
  type Episode,
} from './services/api';
import type { AdDetectionResult, PlaybackConfig } from './services/adDetector';
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

function getInitialPage(): 'app' | 'sandbox' {
  return window.location.pathname === '/sandbox' ? 'sandbox' : 'app';
}

export default function App() {
  const [page, setPage] = useState<'app' | 'sandbox'>(getInitialPage);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [selected, setSelected] = useState('510325');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [ads, setAds] = useState<AdDetectionResult | null>(null);
  const [playback, setPlayback] = useState<PlaybackConfig | null>(null);
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
      setPlayback(null);
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
    setPlayback(null);

    setFlow((prev) => ({
      ...prev,
      steps: {
        ...prev.steps,
        step_fetch_transcript: 'pending',
        step_llm_parse_transcript: 'pending',
        step_llm_detect_ads: 'pending',
        step_llm_prepare_player: 'pending',
      },
    }));

    const durationSec = parseDuration(ep.duration);

    // Step 1: Get transcript — prefer audio transcription, fall back to HTML
    let html = '';
    let audioTranscriptText = '';
    setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'running'));

    // Try audio transcription first (captures dynamic ads in audio)
    if (ep.audioUrl) {
      try {
        const transcribeRes = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioUrl: ep.audioUrl }),
        });
        if (transcribeRes.ok) {
          const transcription = await transcribeRes.json();
          audioTranscriptText = transcription.text || '';
          if (audioTranscriptText.length > 100) {
            // Wrap the transcription as simple HTML paragraphs for the LLM pipeline
            html = audioTranscriptText.split(/(?<=[.!?])\s+/).map((s: string) => `<p>${s}</p>`).join('\n');
            setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'completed'));
          }
        }
      } catch (err) {
        console.warn('Audio transcription failed, falling back to HTML transcript:', err);
      }
    }

    // Fall back to HTML transcript if audio transcription didn't work
    if (!html && ep.transcriptUrl) {
      try {
        const result = await fetchTranscriptHtml(ep.transcriptUrl);
        html = result.html;
        setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'completed'));
      } catch {
        setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'skipped'));
      }
    } else if (!html) {
      setFlow((prev) => setStep(prev, 'step_fetch_transcript', 'skipped'));
    }

    setFlow((prev) => setStep(prev, 'step_llm_parse_transcript', 'running'));
    let transcript;
    try {
      transcript = await llmParseTranscript(html || `<p>${ep.description}</p>`);
      setFlow((prev) => setStep(prev, 'step_llm_parse_transcript', 'completed'));
    } catch (err) {
      console.error('LLM parse failed:', err);
      setFlow((prev) => setStep(prev, 'step_llm_parse_transcript', 'failed'));
      return;
    }

    setFlow((prev) => setStep(prev, 'step_llm_detect_ads', 'running'));
    let adResult: AdDetectionResult;
    try {
      adResult = await llmDetectAds(transcript, durationSec, ep.title);
      setAds(adResult);
      setFlow((prev) => setStep(prev, 'step_llm_detect_ads', 'completed'));
    } catch (err) {
      console.error('LLM ad detection failed:', err);
      setFlow((prev) => setStep(prev, 'step_llm_detect_ads', 'failed'));
      return;
    }

    setFlow((prev) => setStep(prev, 'step_llm_prepare_player', 'running'));
    try {
      const config = await llmPreparePlayback(
        transcript,
        adResult,
        ep.title,
        ep.description,
      );
      setPlayback(config);
      if (config.skipMap && config.skipMap.length > 0) {
        setAds({
          segments: config.skipMap,
          totalAdTime: config.totalAdTime,
          contentDuration: config.contentDuration,
          strategy: 'llm-verified',
        });
      }
      setFlow((prev) => {
        const fs = setStep(prev, 'step_llm_prepare_player', 'completed');
        return { ...fs, currentStep: null };
      });
    } catch (err) {
      console.error('LLM prepare-playback failed:', err);
      setFlow((prev) => {
        const fs = setStep(prev, 'step_llm_prepare_player', 'skipped');
        return { ...fs, currentStep: null };
      });
    }
  }, []);

  const goToSandbox = useCallback(() => {
    window.history.pushState(null, '', '/sandbox');
    setPage('sandbox');
  }, []);

  const goToApp = useCallback(() => {
    window.history.pushState(null, '', '/');
    setPage('app');
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => setPage(getInitialPage());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  if (page === 'sandbox') {
    return <SandboxPage onBack={goToApp} />;
  }

  return (
    <div className="phone-frame">
      <div className="phone-notch" />
      <div className="shell">
        <header className="header">
          <h1 className="header-title">NPR Podcasts</h1>
          <button className="header-sandbox-link" onClick={goToSandbox}>
            Sandbox
          </button>
        </header>

        <PodcastSelector
          podcasts={podcasts}
          selected={selected}
          onSelect={setSelected}
        />

        <main className="content">
          {error && !episodes.length ? (
            <div className="empty">{error}</div>
          ) : (
            <EpisodeList
              episodes={episodes}
              loading={loading}
              selectedId={episode?.id || null}
              onSelect={pick}
            />
          )}

          <FlowVisualizer flowState={flow} />
        </main>

        {/* Player dock pinned to bottom with progress bar at very bottom */}
        {episode && (
          <div className="player-dock">
            <Player episode={episode} adDetection={ads} />
          </div>
        )}
      </div>
    </div>
  );
}
