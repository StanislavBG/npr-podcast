import { useState, useCallback, useEffect, useMemo } from 'react';
import { FlowErrorBoundary } from 'bilko-flow/react/components';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import { SandboxPage } from './components/SandboxPage';
import { PipelineWaterfall } from './components/PipelineWaterfall';
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
import type { FlowProgressStep, ParallelThread, ParallelConfig } from 'bilko-flow/react/components';

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
  const [chunkThreads, setChunkThreads] = useState<ParallelThread[]>([]);

  // Derived: has the pipeline started? (View Details enabled as soon as flow is non-idle)
  const pipelineStarted = pipelineStatus !== 'idle';

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
      setChunkThreads([]);

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
    setChunkThreads([]);

    const steps = createInitialSteps();
    // Mark steps 1-2 as already done (episodes loaded)
    steps[0] = { ...steps[0], status: 'complete', meta: { message: 'RSS loaded' } };
    steps[1] = { ...steps[1], status: 'complete', meta: { message: ep.title } };
    setPipelineSteps(steps);

    const durationSec = parseDuration(ep.duration);

    try {
      const handleProgress = (evt: SandboxProgressEvent) => {
        if (evt.threadId) {
          // Per-chunk progress → update parallel thread
          setChunkThreads(prev => {
            const threads = prev.map(t => ({ ...t, steps: [...t.steps] }));
            let thread = threads.find(t => t.id === evt.threadId);
            if (!thread) {
              const chunkNum = (evt.chunkIndex ?? 0) + 1;
              const totalLabel = evt.totalChunks ? `/${evt.totalChunks}` : '';
              thread = {
                id: evt.threadId!,
                label: `Chunk ${chunkNum}${totalLabel}`,
                status: 'running' as const,
                steps: [
                  { id: `${evt.threadId}-fetch`, label: 'Fetch', status: 'pending' as const, type: 'http.request' },
                  { id: `${evt.threadId}-transcribe`, label: 'Transcribe', status: 'pending' as const, type: 'ai.speech-to-text' },
                  { id: `${evt.threadId}-classify`, label: 'Classify', status: 'pending' as const, type: 'ai.generate-text' },
                  { id: `${evt.threadId}-refine`, label: 'Refine', status: 'pending' as const, type: 'ai.generate-text' },
                  { id: `${evt.threadId}-emit`, label: 'Emit Skips', status: 'pending' as const, type: 'compute' },
                ],
              };
              threads.push(thread);
            }
            const STEP_SUFFIX_MAP: Record<string, string> = {
              step_fetch_chunk: 'fetch',
              step_transcribe_chunk: 'transcribe',
              step_classify_chunk: 'classify',
              step_refine_chunk: 'refine',
              step_emit_skips: 'emit',
            };
            const stepSuffix = STEP_SUFFIX_MAP[evt.step] || 'fetch';
            const stepId = `${evt.threadId}-${stepSuffix}`;
            const mappedStatus = evt.status === 'done' ? 'complete' as const : evt.status === 'error' ? 'error' as const : 'active' as const;
            thread.steps = thread.steps.map(s =>
              s.id === stepId ? { ...s, status: mappedStatus, meta: {
                ...s.meta,
                message: evt.message,
                // bilko-flow well-known meta: chunk progress tracking
                chunksProcessed: evt.chunkIndex != null ? evt.chunkIndex + 1 : undefined,
                chunksTotal: evt.totalChunks,
              } } : s
            );
            const allDone = thread.steps.every(s => s.status === 'complete' || s.status === 'skipped');
            const anyErr = thread.steps.some(s => s.status === 'error');
            thread.status = anyErr ? 'error' : allDone ? 'complete' : 'running';
            // Set thread activity to describe what's currently happening
            const activeStep = thread.steps.find(s => s.status === 'active');
            thread.activity = activeStep ? `${activeStep.label}: ${evt.message}` : undefined;
            if (anyErr) {
              const errStep = thread.steps.find(s => s.status === 'error');
              thread.error = errStep ? (errStep.meta as Record<string, unknown>)?.message as string || 'Failed' : 'Failed';
            }
            return threads;
          });
        } else {
          // Main pipeline step — use bilko-flow well-known meta keys
          const stepId = evt.step;
          if (evt.status === 'done') {
            updateStep(stepId, { status: 'complete', meta: { message: evt.message } });
          } else if (evt.status === 'error') {
            updateStep(stepId, { status: 'error', meta: { error: evt.message } });
          } else if (evt.status === 'skipped') {
            updateStep(stepId, { status: 'skipped', meta: { skipReason: evt.message } });
          } else {
            updateStep(stepId, { status: 'active', meta: {
              message: evt.message,
              // Propagate chunk progress as bilko-flow well-known meta when available
              ...(evt.chunkIndex != null ? { chunksProcessed: evt.chunkIndex + 1 } : {}),
              ...(evt.totalChunks != null ? { chunksTotal: evt.totalChunks } : {}),
            } });
          }
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

  // Derive flow-level activity text from the active step's label.
  // Per-step detail (e.g. "Transcribing chunk 1/3") is already in meta.message —
  // bilko-flow renders that at the step level, so we use only the label here
  // to avoid showing the same text twice.
  const activity = useMemo(() => {
    const active = pipelineSteps.find(s => s.status === 'active');
    if (!active) return undefined;
    return `${active.label}...`;
  }, [pipelineSteps]);

  // Parallel thread config for bilko-flow tubes visualization
  const parallelConfig: ParallelConfig = useMemo(() => ({
    maxVisible: 5,
    autoCollapseCompleted: true,
    autoCollapseDelayMs: 2000,
  }), []);

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
        chunkThreads={chunkThreads}
        parallelConfig={parallelConfig}
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
            className={`header-sandbox-link ${!pipelineStarted ? 'disabled' : ''}`}
            onClick={goToSandbox}
            disabled={!pipelineStarted}
            title={pipelineStarted ? 'View pipeline details' : 'Select an episode first'}
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
              <FlowErrorBoundary>
                <PipelineWaterfall
                  steps={pipelineSteps}
                  status={flowStatus}
                  parallelThreads={chunkThreads}
                  label="Ad Detection Pipeline"
                  activity={activity}
                />
              </FlowErrorBoundary>
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
