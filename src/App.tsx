import { useState, useCallback, useEffect } from 'react';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import { SandboxPage } from './components/SandboxPage';
import {
  fetchPodcasts,
  fetchEpisodes,
  sandboxAnalyzeStream,
  parseDuration,
  type Podcast,
  type Episode,
  type SandboxResult,
  type SandboxProgressEvent,
} from './services/api';
import type { AdDetectionResult, AdSegment } from './services/adDetector';
import { STEP_ORDER, STEP_META } from './workflows/podcastFlow';

// ─── Pipeline step tracking (same shape as SandboxPage) ──────────────────────

interface PipelineStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error' | 'skipped';
  message: string;
}

function createInitialSteps(): PipelineStep[] {
  return STEP_ORDER.map(id => ({
    id,
    label: STEP_META[id].label,
    status: 'pending' as const,
    message: '',
  }));
}

/** Convert SandboxResult skipMap + adBlocks into the AdDetectionResult the Player expects */
function sandboxResultToAdDetection(result: SandboxResult): AdDetectionResult {
  const segments: AdSegment[] = result.skipMap.map(s => ({
    startTime: s.startTime,
    endTime: s.endTime,
    type: (s.type || 'mid-roll') as AdSegment['type'],
    confidence: s.confidence,
    reason: s.reason,
  }));

  // Also include adBlocks mapped to timestamps if skipMap is empty but adBlocks exist
  if (segments.length === 0 && result.adBlocks.length > 0) {
    for (const b of result.adBlocks) {
      segments.push({
        startTime: b.startTimeSec,
        endTime: b.endTimeSec,
        type: 'mid-roll',
        confidence: 0.85,
        reason: b.reason,
      });
    }
  }

  const totalAdTime = segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
  return {
    segments,
    totalAdTime,
    contentDuration: result.episode.durationSec - totalAdTime,
    strategy: result.summary.strategy,
  };
}

function getInitialPage(): 'app' | 'sandbox' {
  return window.location.pathname === '/sandbox' ? 'sandbox' : 'app';
}

// ─── Inline flow visualizer (replaces bilko-flow dependency) ─────────────────

function FlowTracker({ steps, visible }: { steps: PipelineStep[]; visible: boolean }) {
  if (!visible) return null;
  const anyActive = steps.some(s => s.status === 'active');
  const allPending = steps.every(s => s.status === 'pending');
  if (allPending) return null;

  return (
    <div className="flow-widget">
      <div className="flow-label">Pipeline Progress</div>
      <div className="flow-steps">
        {steps.map((step, i) => (
          <div key={step.id} className={`flow-step flow-step-${step.status}`}>
            <span className="flow-step-icon">
              {step.status === 'done' && '\u2713'}
              {step.status === 'active' && '\u25B6'}
              {step.status === 'error' && '\u2717'}
              {step.status === 'skipped' && '\u2013'}
              {step.status === 'pending' && '\u2022'}
            </span>
            <span className="flow-step-name">
              {i + 1}. {step.label}
            </span>
            {step.message && step.status !== 'pending' && (
              <span className="flow-step-msg">{step.message}</span>
            )}
          </div>
        ))}
      </div>
      {anyActive && (
        <div className="flow-active-spinner">
          <div className="sb-loading-spinner" />
        </div>
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<'app' | 'sandbox'>(getInitialPage);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [selected, setSelected] = useState('510325');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [ads, setAds] = useState<AdDetectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>(createInitialSteps());
  const [pipelineActive, setPipelineActive] = useState(false);

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

  // Helper: update a single pipeline step
  const updateStep = (stepId: string, updates: Partial<PipelineStep>) => {
    setPipelineSteps(prev => prev.map(s =>
      s.id === stepId ? { ...s, ...updates } : s
    ));
  };

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setEpisode(null);
      setAds(null);
      setError(null);
      setPipelineSteps(createInitialSteps());
      setPipelineActive(true);

      // Steps 1-2: Fetch RSS and parse episodes (client-side)
      updateStep('step_fetch_rss', { status: 'active', message: 'Loading...' });

      try {
        const data = await fetchEpisodes(id);
        setEpisodes(data.episodes);
        updateStep('step_fetch_rss', { status: 'done', message: 'RSS loaded' });
        updateStep('step_parse_episodes', { status: 'done', message: `${data.episodes.length} episodes` });
      } catch {
        updateStep('step_fetch_rss', { status: 'error', message: 'Failed' });
        setError('Could not load episodes. Check your connection.');
        setPipelineActive(false);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    load(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Episode selection: run the unified sandbox pipeline ─────────────────────
  const pick = useCallback(async (ep: Episode) => {
    setEpisode(ep);
    setAds(null);

    const steps = createInitialSteps();
    // Mark steps 1-2 as already done (episodes loaded)
    steps[0].status = 'done';
    steps[0].message = 'RSS loaded';
    steps[1].status = 'done';
    steps[1].message = ep.title;
    setPipelineSteps(steps);
    setPipelineActive(true);

    const durationSec = parseDuration(ep.duration);

    try {
      const handleProgress = (evt: SandboxProgressEvent) => {
        const stepId = evt.step;
        if (evt.status === 'done') {
          updateStep(stepId, { status: 'done', message: evt.message });
        } else if (evt.status === 'error') {
          updateStep(stepId, { status: 'error', message: evt.message });
        } else {
          updateStep(stepId, { status: 'active', message: evt.message });
        }
      };

      const result: SandboxResult = await sandboxAnalyzeStream(
        ep.transcriptUrl || '',
        ep.title,
        durationSec,
        handleProgress,
        ep.podcastTranscripts,
        ep.audioUrl || undefined,
      );

      // Convert sandbox result to the AdDetectionResult the Player expects
      const adResult = sandboxResultToAdDetection(result);
      setAds(adResult);

      // Mark all remaining steps as done
      setPipelineSteps(prev => prev.map(s =>
        s.status === 'pending' || s.status === 'active'
          ? { ...s, status: 'done' as const, message: s.message || 'Complete' }
          : s
      ));
      setPipelineActive(false);
    } catch (err: any) {
      console.error('Pipeline failed:', err);
      setPipelineSteps(prev => prev.map(s =>
        s.status === 'active'
          ? { ...s, status: 'error' as const, message: err.message || 'Failed' }
          : s
      ));
      setPipelineActive(false);
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
            Enhanced View
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

          <FlowTracker steps={pipelineSteps} visible={pipelineActive} />
        </main>

        {/* Player dock pinned to bottom */}
        {episode && (
          <div className="player-dock">
            <Player episode={episode} adDetection={ads} />
          </div>
        )}
      </div>
    </div>
  );
}
