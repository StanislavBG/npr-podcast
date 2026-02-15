import { useState, useCallback, useEffect, useMemo } from 'react';
import { FlowProgress } from 'bilko-flow/react/components';
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
  type PartialAdsEvent,
} from './services/api';
import type { AdDetectionResult, AdSegment } from './services/adDetector';
import { STEP_ORDER, STEP_META } from './workflows/podcastFlow';
import type { FlowProgressStep } from 'bilko-flow/react/components';

// ─── Pipeline step tracking ────────────────────────────────────────────────

function createInitialSteps(): FlowProgressStep[] {
  return STEP_ORDER.map(id => ({
    id,
    label: STEP_META[id].label,
    status: 'pending',
    type: STEP_META[id].type,
  }));
}

/** Status map: our SSE uses 'done' → bilko-flow uses 'complete' */
const STATUS_MAP = {
  done: 'complete' as const,
  skipped: 'skipped' as const,
};

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
  const [pipelineSteps, setPipelineSteps] = useState<FlowProgressStep[]>(createInitialSteps());
  const [pipelineStatus, setPipelineStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [sandboxResult, setSandboxResult] = useState<SandboxResult | null>(null);
  const [podcastName, setPodcastName] = useState('');

  // Derived: is the pipeline done (so View Details can be enabled)?
  const pipelineDone = pipelineStatus === 'complete' || pipelineStatus === 'error';

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
  const updateStep = useCallback((stepId: string, updates: Partial<FlowProgressStep>) => {
    setPipelineSteps(prev => prev.map(s =>
      s.id === stepId ? { ...s, ...updates } : s
    ));
  }, []);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      setEpisode(null);
      setAds(null);
      setError(null);
      setSandboxResult(null);
      setPipelineSteps(createInitialSteps());
      setPipelineStatus('idle');

      // Steps 1-2: Fetch RSS and parse episodes (client-side)
      updateStep('step_fetch_rss', { status: 'active', meta: { message: 'Loading...' } });

      try {
        const data = await fetchEpisodes(id);
        setEpisodes(data.episodes);
        setPodcastName(data.podcastName);
        updateStep('step_fetch_rss', { status: 'complete', meta: { message: 'RSS loaded' } });
        updateStep('step_parse_episodes', { status: 'complete', meta: { message: `${data.episodes.length} episodes` } });
      } catch {
        updateStep('step_fetch_rss', { status: 'error', meta: { error: 'Failed' } });
        setError('Could not load episodes. Check your connection.');
      } finally {
        setLoading(false);
      }
    },
    [updateStep]
  );

  useEffect(() => {
    load(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Episode selection: run the unified sandbox pipeline ─────────────────────
  const pick = useCallback(async (ep: Episode) => {
    setEpisode(ep);
    setAds(null);
    setSandboxResult(null);
    setPipelineStatus('running');

    const steps = createInitialSteps();
    // Mark steps 1-2 as already done (episodes loaded)
    steps[0] = { ...steps[0], status: 'complete', meta: { message: 'RSS loaded' } };
    steps[1] = { ...steps[1], status: 'complete', meta: { message: ep.title } };
    setPipelineSteps(steps);

    const durationSec = parseDuration(ep.duration);

    try {
      const handleProgress = (evt: SandboxProgressEvent) => {
        const stepId = evt.step;
        if (evt.status === 'done') {
          updateStep(stepId, { status: 'complete', meta: { message: evt.message } });
        } else if (evt.status === 'error') {
          updateStep(stepId, { status: 'error', meta: { error: evt.message } });
        } else if (evt.status === 'skipped') {
          updateStep(stepId, { status: 'skipped', meta: { skipReason: evt.message } });
        } else {
          updateStep(stepId, { status: 'active', meta: { message: evt.message } });
        }
      };

      // Handle early ad detection — apply partial results to the player immediately
      const handlePartialAds = (evt: PartialAdsEvent) => {
        if (evt.skipMap && evt.skipMap.length > 0) {
          const segments: AdSegment[] = evt.skipMap.map(s => ({
            startTime: s.startTime,
            endTime: s.endTime,
            type: (s.type || 'mid-roll') as AdSegment['type'],
            confidence: s.confidence,
            reason: s.reason,
          }));
          const totalAdTime = segments.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0);
          setAds({
            segments,
            totalAdTime,
            contentDuration: durationSec - totalAdTime,
            strategy: `early-${evt.source}`,
          });
        }
      };

      const result: SandboxResult = await sandboxAnalyzeStream(
        ep.transcriptUrl || '',
        ep.title,
        durationSec,
        handleProgress,
        ep.podcastTranscripts,
        ep.audioUrl || undefined,
        handlePartialAds,
      );

      // Final result replaces any partial ads with the full topic-aware classification
      const adResult = sandboxResultToAdDetection(result);
      setAds(adResult);
      setSandboxResult(result);

      // Mark all remaining steps as done
      setPipelineSteps(prev => prev.map(s =>
        s.status === 'pending' || s.status === 'active'
          ? { ...s, status: 'complete' as const, meta: { ...s.meta, message: (s.meta as any)?.message || 'Complete' } }
          : s
      ));
      setPipelineStatus('complete');
    } catch (err: any) {
      console.error('Pipeline failed:', err);
      setPipelineSteps(prev => prev.map(s =>
        s.status === 'active'
          ? { ...s, status: 'error' as const, meta: { error: err.message || 'Failed' } }
          : s
      ));
      setPipelineStatus('error');
    }
  }, [updateStep]);

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

  // Flow status for bilko-flow (map our pipeline status)
  const flowStatus = useMemo(() => {
    const allPending = pipelineSteps.every(s => s.status === 'pending');
    if (allPending) return 'idle' as const;
    return pipelineStatus;
  }, [pipelineSteps, pipelineStatus]);

  // Derive activity text from the active step
  const activity = useMemo(() => {
    const active = pipelineSteps.find(s => s.status === 'active');
    if (!active) return undefined;
    return (active.meta as any)?.message || `${active.label}...`;
  }, [pipelineSteps]);

  if (page === 'sandbox') {
    return (
      <SandboxPage
        onBack={goToApp}
        result={sandboxResult}
        episode={episode}
        podcastName={podcastName}
        podcastId={selected}
        pipelineSteps={pipelineSteps}
        pipelineStatus={pipelineStatus}
      />
    );
  }

  const showFlow = flowStatus !== 'idle';

  return (
    <div className="phone-frame">
      <div className="phone-notch" />
      <div className="shell">
        <header className="header">
          <h1 className="header-title">NPR Podcasts</h1>
          <button
            className={`header-sandbox-link ${!pipelineDone ? 'disabled' : ''}`}
            onClick={goToSandbox}
            disabled={!pipelineDone}
            title={pipelineDone ? 'View pipeline debug details' : 'Select a podcast episode first'}
          >
            View Details
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

          {showFlow && (
            <div className="flow-widget-container">
              <FlowProgress
                mode="auto"
                steps={pipelineSteps}
                status={flowStatus}
                activity={activity}
                label="Ad Detection Pipeline"
                statusMap={STATUS_MAP}
              />
            </div>
          )}
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
