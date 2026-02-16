import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { mergeChunkAdSegments } from './services/adDetector';
import { STEP_ORDER, STEP_META, createFlowDefinition } from './workflows/podcastFlow';
import type { FlowProgressStep, ParallelThread, ParallelConfig, StepExecution } from 'bilko-flow/react/components';

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
  // Test mode: limit to 5 chunks for faster iteration
  const [testMode, setTestMode] = useState(true);
  // Tracks which chunks have completed scanning — used by Player scrubber
  const [scanProgress, setScanProgress] = useState<{ totalChunks: number; completedChunks: Set<number> }>({ totalChunks: 0, completedChunks: new Set() });
  // Accumulator ref for partial ads (avoids stale closure in SSE callback)
  const accumulatedAdsRef = useRef<AdSegment[]>([]);
  // Execution tracking for StepDetail analysis
  const [stepExecutions, setStepExecutions] = useState<Record<string, StepExecution>>({});
  const stepStartTimesRef = useRef<Record<string, number>>({});
  const flowDefinition = useMemo(() => createFlowDefinition(), []);

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

  // Helper: update execution tracking for a step
  const updateExecution = useCallback((stepId: string, updates: Partial<StepExecution>) => {
    setStepExecutions(prev => ({
      ...prev,
      [stepId]: { ...prev[stepId], stepId, status: prev[stepId]?.status || 'idle', ...updates } as StepExecution,
    }));
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
      setStepExecutions({});
      stepStartTimesRef.current = {};

      // Steps 1-2: Fetch RSS and parse episodes (client-side)
      updateStep('step_fetch_rss', { status: 'active', meta: { message: 'Loading...' } });
      const fetchStart = Date.now();
      updateExecution('step_fetch_rss', { status: 'running', startedAt: fetchStart, input: { podcastId: id, url: `/api/podcast/${id}/episodes`, method: 'GET', timeout_ms: 15000, max_attempts: 3 } });

      try {
        const data = await fetchEpisodes(id);
        setEpisodes(data.episodes);
        setPodcastName(data.podcastName);
        const fetchEnd = Date.now();
        updateStep('step_fetch_rss', { status: 'complete', meta: { message: 'RSS loaded' } });
        updateExecution('step_fetch_rss', { status: 'success', completedAt: fetchEnd, durationMs: fetchEnd - fetchStart, output: { podcastName: data.podcastName, episodeCount: data.episodes.length } });
        updateStep('step_parse_episodes', { status: 'complete', meta: { message: `${data.episodes.length} episodes` } });
        updateExecution('step_parse_episodes', { status: 'success', startedAt: fetchStart, completedAt: fetchEnd, durationMs: fetchEnd - fetchStart, input: { transform: 'extract_episode_metadata', timeout_ms: 5000 }, output: { episodeCount: data.episodes.length, podcastName: data.podcastName } });
      } catch (e: any) {
        const fetchEnd = Date.now();
        updateStep('step_fetch_rss', { status: 'error', meta: { error: 'Failed' } });
        updateExecution('step_fetch_rss', { status: 'error', completedAt: fetchEnd, durationMs: fetchEnd - fetchStart, error: e?.message || 'Failed' });
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
    setScanProgress({ totalChunks: 0, completedChunks: new Set() });
    accumulatedAdsRef.current = [];

    const steps = createInitialSteps();
    // Mark steps 1-2 as already done (episodes loaded)
    steps[0] = { ...steps[0], status: 'complete', meta: { message: 'RSS loaded' } };
    steps[1] = { ...steps[1], status: 'complete', meta: { message: ep.title } };
    setPipelineSteps(steps);

    const durationSec = parseDuration(ep.duration);

    // Enrich parse_episodes execution with the selected episode data
    updateExecution('step_parse_episodes', {
      status: 'success',
      output: {
        episodeTitle: ep.title,
        duration: ep.duration,
        durationSec,
        transcriptUrl: ep.transcriptUrl || '(none)',
        audioUrl: ep.audioUrl ? 'available' : '(none)',
        episodeCount: episodes.length,
      },
    });

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

          // Track per-chunk-step execution data for StepDetail inspection
          const STEP_SUFFIX_MAP_EXEC: Record<string, string> = {
            step_fetch_chunk: 'fetch',
            step_transcribe_chunk: 'transcribe',
            step_classify_chunk: 'classify',
            step_refine_chunk: 'refine',
            step_emit_skips: 'emit',
          };
          const chunkSuffix = STEP_SUFFIX_MAP_EXEC[evt.step] || 'fetch';
          const chunkStepId = `${evt.threadId}-${chunkSuffix}`;
          const now = Date.now();
          const { step: _cs, status: _cst, message: _cm, threadId: _ct, chunkIndex: _cci, totalChunks: _ctc, input: sseInput, rawResponse: sseRawResponse, ...chunkExtraData } = evt;

          // Use server-sent input when available, fall back to static config
          const fallbackConfig: Record<string, Record<string, unknown>> = {
            step_fetch_chunk: {
              audioUrl: ep.audioUrl || '(none)',
              chunkIndex: evt.chunkIndex,
              totalChunks: evt.totalChunks,
              chunkSizeBytes: 2_097_152,
              method: 'GET (Range header)',
            },
            step_transcribe_chunk: {
              model: 'gpt-4o-mini-transcribe',
              format: 'verbose_json',
              language: 'en',
              chunkIndex: evt.chunkIndex,
              totalChunks: evt.totalChunks,
            },
            step_classify_chunk: {
              model: 'claude-3-5-sonnet',
              chunkIndex: evt.chunkIndex,
              totalChunks: evt.totalChunks,
              episodeTitle: ep.title,
            },
            step_refine_chunk: {
              model: 'claude-3-5-sonnet',
              chunkIndex: evt.chunkIndex,
              totalChunks: evt.totalChunks,
            },
            step_emit_skips: {
              chunkIndex: evt.chunkIndex,
              totalChunks: evt.totalChunks,
              target: 'player-scrubber',
            },
          };

          // Prefer server-sent input data; merge with fallback config
          const config = fallbackConfig[evt.step];
          const inputData = sseInput
            ? { ...config, ...(sseInput as Record<string, unknown>) }
            : config;

          if (!stepStartTimesRef.current[chunkStepId]) {
            stepStartTimesRef.current[chunkStepId] = now;
          }

          if (evt.status === 'done') {
            const startedAt = stepStartTimesRef.current[chunkStepId];
            setStepExecutions(prev => {
              const existing = prev[chunkStepId];
              return {
                ...prev,
                [chunkStepId]: {
                  ...existing,
                  stepId: chunkStepId,
                  status: 'success' as const,
                  completedAt: now,
                  durationMs: now - startedAt,
                  input: sseInput ? { ...inputData, ...(sseInput as Record<string, unknown>) } : (existing?.input ?? inputData),
                  output: Object.keys(chunkExtraData).length > 0 ? chunkExtraData : { message: evt.message },
                  rawResponse: sseRawResponse || existing?.rawResponse || undefined,
                },
              };
            });
          } else if (evt.status === 'error') {
            const startedAt = stepStartTimesRef.current[chunkStepId];
            setStepExecutions(prev => {
              const existing = prev[chunkStepId];
              return {
                ...prev,
                [chunkStepId]: {
                  ...existing,
                  stepId: chunkStepId,
                  status: 'error' as const,
                  completedAt: now,
                  durationMs: now - startedAt,
                  input: sseInput ? { ...inputData, ...(sseInput as Record<string, unknown>) } : (existing?.input ?? inputData),
                  error: evt.message,
                  rawResponse: sseRawResponse || existing?.rawResponse || undefined,
                },
              };
            });
          } else {
            updateExecution(chunkStepId, { status: 'running', startedAt: stepStartTimesRef.current[chunkStepId], input: inputData });
          }

          // Track scan progress: when a chunk's last step completes, mark it scanned
          if (evt.step === 'step_emit_skips' && evt.status === 'done' && evt.chunkIndex != null) {
            setScanProgress(prev => {
              const next = new Set(prev.completedChunks);
              next.add(evt.chunkIndex!);
              return { totalChunks: evt.totalChunks || prev.totalChunks, completedChunks: next };
            });
          }
          // Capture totalChunks as early as possible (first chunk event)
          if (evt.totalChunks && evt.totalChunks > 0) {
            setScanProgress(prev => prev.totalChunks === 0 ? { ...prev, totalChunks: evt.totalChunks! } : prev);
          }
        } else {
          // Main pipeline step — use bilko-flow well-known meta keys
          const stepId = evt.step;
          const now = Date.now();
          // Capture all extra event fields as execution output data
          const { step: _s, status: _st, message: _m, threadId: _t, chunkIndex: _ci, totalChunks: _tc, ...extraData } = evt;

          // Build step-specific config for input enrichment
          const stepConfig: Record<string, Record<string, unknown>> = {
            step_resolve_audio_stream: {
              audioUrl: ep.audioUrl || '(none)',
              method: 'HEAD (follow redirects)',
              timeout_ms: 10000,
              max_attempts: 3,
            },
            step_plan_chunks: {
              chunkSizeBytes: 2_097_152,
              chunkSizeLabel: '2 MB',
              strategy: 'byte-range',
              estimatedChunkDuration: '~65s at 128kbps',
              audioUrl: ep.audioUrl || '(none)',
            },
          };

          // Pre-compute input data for all event types
          const config = stepConfig[stepId];
          const sseData = Object.keys(extraData).length > 0 ? extraData : undefined;
          const inputData = config ? { ...config, ...sseData } : sseData;

          if (!stepStartTimesRef.current[stepId]) {
            stepStartTimesRef.current[stepId] = now;
          }

          if (evt.status === 'done') {
            const startedAt = stepStartTimesRef.current[stepId];
            updateStep(stepId, { status: 'complete', meta: { message: evt.message } });
            const baseOutput = Object.keys(extraData).length > 0 ? extraData : { message: evt.message };
            // Use functional updater to preserve input if already set
            setStepExecutions(prev => {
              const existing = prev[stepId];
              return {
                ...prev,
                [stepId]: {
                  ...existing,
                  stepId,
                  status: 'success' as const,
                  completedAt: now,
                  durationMs: now - startedAt,
                  input: existing?.input ?? inputData,
                  output: baseOutput,
                },
              };
            });
          } else if (evt.status === 'error') {
            const startedAt = stepStartTimesRef.current[stepId];
            updateStep(stepId, { status: 'error', meta: { error: evt.message } });
            setStepExecutions(prev => {
              const existing = prev[stepId];
              return {
                ...prev,
                [stepId]: {
                  ...existing,
                  stepId,
                  status: 'error' as const,
                  completedAt: now,
                  durationMs: now - startedAt,
                  input: existing?.input ?? inputData,
                  error: evt.message,
                },
              };
            });
          } else if (evt.status === 'skipped') {
            updateStep(stepId, { status: 'skipped', meta: { skipReason: evt.message } });
            updateExecution(stepId, { status: 'skipped' });
          } else {
            updateStep(stepId, { status: 'active', meta: {
              message: evt.message,
              ...(evt.chunkIndex != null ? { chunksProcessed: evt.chunkIndex + 1 } : {}),
              ...(evt.totalChunks != null ? { chunksTotal: evt.totalChunks } : {}),
            } });
            updateExecution(stepId, { status: 'running', startedAt: stepStartTimesRef.current[stepId], input: inputData });
          }
        }
      };

      // Handle early ad detection — accumulate and merge across chunks
      const handlePartialAds = (evt: PartialAdsEvent) => {
        if (evt.skipMap && evt.skipMap.length > 0) {
          const incoming: AdSegment[] = evt.skipMap.map(s => ({
            startTime: s.startTime,
            endTime: s.endTime,
            type: (s.type || 'mid-roll') as AdSegment['type'],
            confidence: s.confidence,
            reason: s.reason,
          }));
          const merged = mergeChunkAdSegments(accumulatedAdsRef.current, incoming);
          accumulatedAdsRef.current = merged;
          const totalAdTime = merged.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0);
          setAds({
            segments: merged,
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
        testMode,
      );

      // Final result replaces any partial ads with the full topic-aware classification
      const adResult = sandboxResultToAdDetection(result);
      setAds(adResult);
      setSandboxResult(result);

      // Enrich step executions with final result data from SandboxResult
      setStepExecutions(prev => {
        const enriched = { ...prev };

        // Enrich step_resolve_audio_stream with audioDetails from result
        if (result.audioDetails && enriched['step_resolve_audio_stream']) {
          enriched['step_resolve_audio_stream'] = {
            ...enriched['step_resolve_audio_stream'],
            output: {
              available: result.audioDetails.available,
              resolvedUrl: result.audioDetails.resolvedUrl,
              contentType: result.audioDetails.contentType,
              contentLengthBytes: result.audioDetails.contentLengthBytes,
              downloadSizeMb: result.audioDetails.downloadSizeMb,
              redirected: result.audioDetails.resolvedUrl !== result.audioDetails.originalUrl,
              audioDurationSec: result.audioDetails.audioDurationSec,
              error: result.audioDetails.error,
            },
          };
        }

        // Enrich step_plan_chunks with chunk planning data
        if (result.audioDetails && enriched['step_plan_chunks']) {
          const chunkCount = result.audioDetails.segmentCount || 0;
          const fileSizeMb = result.audioDetails.downloadSizeMb;
          enriched['step_plan_chunks'] = {
            ...enriched['step_plan_chunks'],
            output: {
              chunkCount,
              fileSizeMb,
              format: result.audioDetails.contentType,
              resolvedUrl: result.audioDetails.resolvedUrl,
              transcriptionModel: result.audioDetails.transcriptionModel,
              estimatedChunkDuration: '~65s at 128kbps',
              audioDurationSec: result.audioDetails.audioDurationSec,
            },
          };
        }

        // Enrich step_parse_episodes with transcript/validation info from result
        if (enriched['step_parse_episodes']) {
          enriched['step_parse_episodes'] = {
            ...enriched['step_parse_episodes'],
            output: {
              ...(enriched['step_parse_episodes'].output as Record<string, unknown> || {}),
              transcriptSource: result.transcriptSource,
              transcriptLines: result.transcript.lineCount,
              transcriptWords: result.transcript.totalWords,
              validation: result.validation ? {
                isValid: result.validation.isValid,
                reason: result.validation.reason,
                speechRateWpm: result.qa.speechRateWpm,
              } : undefined,
            },
          };
        }

        // Attach prompts + LLM response to a synthetic 'pipeline_llm' key visible in analysis
        if (result.prompts) {
          enriched['pipeline_llm_classify'] = {
            stepId: 'pipeline_llm_classify',
            status: 'success',
            input: {
              systemPrompt: result.prompts.system,
              userPrompt: result.prompts.user.length > 2000
                ? result.prompts.user.slice(0, 800) + `\n... (${result.prompts.user.length} chars) ...\n` + result.prompts.user.slice(-500)
                : result.prompts.user,
            },
            output: {
              strategy: result.summary.strategy,
              adBlocks: result.adBlocks.length,
              skipRanges: result.skipMap.length,
              totalAdTimeSec: result.summary.totalAdTimeSec,
              contentTimeSec: result.summary.contentTimeSec,
              adWordPercent: result.summary.adWordPercent,
            },
            rawResponse: result.llmResponse || undefined,
          };
        }

        return enriched;
      });

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
  }, [updateStep, testMode]);

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
        stepExecutions={stepExecutions}
        flowDefinition={flowDefinition}
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
          <div className="header-actions">
            <button
              className={`test-mode-toggle ${testMode ? 'on' : 'off'}`}
              onClick={() => setTestMode(m => !m)}
              title={testMode ? 'Test mode ON: processing max 5 chunks' : 'Test mode OFF: processing all chunks'}
            >
              <span className="test-mode-label">{testMode ? 'TEST' : 'FULL'}</span>
              <span className="test-mode-hint">{testMode ? '5 chunks' : 'all'}</span>
            </button>
            <button
              className={`header-sandbox-link ${!pipelineStarted ? 'disabled' : ''}`}
              onClick={goToSandbox}
              disabled={!pipelineStarted}
              title={pipelineStarted ? 'View pipeline details' : 'Select an episode first'}
            >
              View Details
            </button>
          </div>
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
            <Player
              episode={episode}
              adDetection={ads}
              scanProgress={scanProgress}
              pipelineStatus={pipelineStatus}
              autoPlay
            />
          </div>
        )}
      </div>
    </div>
  );
}
