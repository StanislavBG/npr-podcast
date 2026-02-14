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

    const durationSec = parseDuration(ep.duration);
    let html = '';

    // ── Steps 3-5: Audio Pipeline (resolve → stream → transcribe) ────
    if (ep.audioUrl) {
      setFlow((prev) => setStep(prev, 'step_resolve_audio_stream', 'running'));

      try {
        // Step 3 done: audio URL resolved from RSS feed
        setFlow((prev) => {
          let fs = setStep(prev, 'step_resolve_audio_stream', 'completed');
          // Step 4: audio is being fetched for transcription
          fs = setStep(fs, 'step_start_audio_streaming', 'running');
          return fs;
        });

        setFlow((prev) => {
          let fs = setStep(prev, 'step_start_audio_streaming', 'completed');
          // Step 5: transcription running
          fs = setStep(fs, 'step_transcribe_chunks', 'running');
          return fs;
        });

        const transcribeRes = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioUrl: ep.audioUrl }),
        });

        if (transcribeRes.ok) {
          const transcription = await transcribeRes.json();
          const audioText = transcription.text || '';
          if (audioText.length > 100) {
            html = audioText.split(/(?<=[.!?])\s+/).map((s: string) => `<p>${s}</p>`).join('\n');
            setFlow((prev) => setStep(prev, 'step_transcribe_chunks', 'completed'));
          } else {
            throw new Error('Transcription too short');
          }
        } else {
          throw new Error(`Transcription request failed: ${transcribeRes.status}`);
        }
      } catch (err) {
        console.warn('Audio transcription failed, falling back to HTML transcript:', err);
        // Mark any incomplete audio steps as failed/skipped
        setFlow((prev) => {
          let fs = prev;
          if (fs.steps.step_resolve_audio_stream === 'running') fs = setStep(fs, 'step_resolve_audio_stream', 'failed');
          if (fs.steps.step_start_audio_streaming === 'running') fs = setStep(fs, 'step_start_audio_streaming', 'failed');
          else if (fs.steps.step_start_audio_streaming === 'pending') fs = setStep(fs, 'step_start_audio_streaming', 'skipped');
          if (fs.steps.step_transcribe_chunks === 'running') fs = setStep(fs, 'step_transcribe_chunks', 'failed');
          else if (fs.steps.step_transcribe_chunks === 'pending') fs = setStep(fs, 'step_transcribe_chunks', 'skipped');
          return fs;
        });
      }
    } else {
      // No audio URL — skip audio pipeline
      setFlow((prev) => {
        let fs = setStep(prev, 'step_resolve_audio_stream', 'skipped');
        fs = setStep(fs, 'step_start_audio_streaming', 'skipped');
        fs = setStep(fs, 'step_transcribe_chunks', 'skipped');
        return fs;
      });
    }

    // ── Step 8: Fetch HTML Transcript (parallel path / fallback) ─────
    if (!html && ep.transcriptUrl) {
      setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'running'));
      try {
        const result = await fetchTranscriptHtml(ep.transcriptUrl);
        html = result.html;
        setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'completed'));
      } catch {
        setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'skipped'));
      }
    } else {
      // Audio transcription succeeded or no transcript URL available
      setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'skipped'));
    }

    // ── Step 6: Mark Ad Locations (parse transcript + detect ads) ────
    setFlow((prev) => setStep(prev, 'step_mark_ad_locations', 'running'));
    let transcript;
    try {
      transcript = await llmParseTranscript(html || `<p>${ep.description}</p>`);
    } catch (err) {
      console.error('LLM parse failed:', err);
      setFlow((prev) => {
        let fs = setStep(prev, 'step_mark_ad_locations', 'failed');
        fs = setStep(fs, 'step_build_skip_map', 'skipped');
        fs = setStep(fs, 'step_finalize_playback', 'skipped');
        return { ...fs, currentStep: null };
      });
      return;
    }

    let adResult: AdDetectionResult;
    try {
      adResult = await llmDetectAds(transcript, durationSec, ep.title);
      setAds(adResult);
      setFlow((prev) => setStep(prev, 'step_mark_ad_locations', 'completed'));
    } catch (err) {
      console.error('LLM ad detection failed:', err);
      setFlow((prev) => {
        let fs = setStep(prev, 'step_mark_ad_locations', 'failed');
        fs = setStep(fs, 'step_build_skip_map', 'skipped');
        fs = setStep(fs, 'step_finalize_playback', 'skipped');
        return { ...fs, currentStep: null };
      });
      return;
    }

    // ── Step 7: Build Skip Map ───────────────────────────────────────
    setFlow((prev) => setStep(prev, 'step_build_skip_map', 'running'));
    // Skip map is produced as part of ad detection; mark complete
    setFlow((prev) => setStep(prev, 'step_build_skip_map', 'completed'));

    // ── Step 9: Finalize Playback ────────────────────────────────────
    setFlow((prev) => setStep(prev, 'step_finalize_playback', 'running'));
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
        const fs = setStep(prev, 'step_finalize_playback', 'completed');
        return { ...fs, currentStep: null };
      });
    } catch (err) {
      console.error('LLM prepare-playback failed:', err);
      setFlow((prev) => {
        const fs = setStep(prev, 'step_finalize_playback', 'skipped');
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
