import {
  type Workflow,
  type Step,
  WorkflowStatus,
  DeterminismGrade,
} from 'bilko-flow';

/**
 * Podcast processing workflow using bilko-flow DSL.
 *
 * Pipeline (parallelized per-chunk, no join):
 *   1. fetch_rss              – Pull the podcast RSS feed              (http.request)
 *   2. parse_episodes         – Extract episode list from XML          (http.request — server parses)
 *     ── user selects episode ──
 *   3. resolve_audio_stream   – Resolve CDN URL, get duration/size     (http.request — HEAD)
 *   4. plan_chunks            – Calculate 1 MB byte-range chunks       (compute)
 *     ── fork: parallel per-chunk threads (no join — each emits independently) ──
 *     Per chunk:
 *       a. fetch_chunk        – HTTP Range request for 1 MB slice      (http.request)
 *       b. transcribe_chunk   – STT on chunk audio                     (ai.speech-to-text)
 *       c. classify_chunk     – LLM classifies chunk as content/ad     (ai.generate-text)
 *       d. refine_chunk       – LLM refines ad boundaries locally      (ai.generate-text)
 *       e. emit_skips         – Push skip ranges to player             (compute)
 *
 * Each chunk independently emits skip ranges to the player — no join needed.
 */

export function createPodcastWorkflow(podcastId: string): Workflow {
  const steps: Step[] = [
    // ─── Discovery Phase ────────────────────────────────────────────────
    {
      id: 'step_fetch_rss',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Fetch RSS Feed',
      type: 'http.request',
      dependsOn: [],
      inputs: {
        url: `/api/podcast/${podcastId}/episodes`,
        method: 'GET',
      },
      policy: { timeoutMs: 15000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'NPR RSS Feed',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_parse_episodes',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Parse Episodes',
      type: 'http.request',
      dependsOn: ['step_fetch_rss'],
      inputs: { transform: 'extract_episode_metadata' },
      policy: { timeoutMs: 5000, maxAttempts: 1 },
      determinism: { pureFunction: true },
    },

    // ─── Audio Streaming Phase (after episode selection) ────────────────

    {
      id: 'step_resolve_audio_stream',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Resolve Audio Stream',
      type: 'http.request',
      dependsOn: ['step_parse_episodes'],
      inputs: {
        // HEAD request to follow podtrac → megaphone → CDN redirects
        // Returns: final URL, Content-Length, Content-Type, Accept-Ranges
        url: '/api/audio/resolve',
        method: 'HEAD',
      },
      policy: { timeoutMs: 10000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'Podcast CDN (podtrac/megaphone)',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-headers',
          },
        ],
      },
    },
    {
      id: 'step_plan_chunks',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Plan Chunks',
      type: 'compute',
      dependsOn: ['step_resolve_audio_stream'],
      inputs: {
        // Pure computation — divide Content-Length into 1 MB byte ranges.
        // Each chunk will be fetched independently via HTTP Range request.
        chunkSizeBytes: 1_048_576,       // 1 MB per chunk (~65s at 128kbps)
        strategy: 'byte-range',          // HTTP Range requests
      },
      policy: { timeoutMs: 5000, maxAttempts: 1 },
      determinism: { pureFunction: true },
    },
    // ─── Per-chunk threads: Fetch → Transcribe → Classify → Refine → Emit ──
    // Each chunk independently fetches, processes, and emits skip ranges.
    // No join — the player receives progressive results.

    // ─── Per-chunk threads emit independently — no join/finalize needed ──
  ];

  return {
    id: `wf_podcast_${podcastId}`,
    accountId: 'acct_npr_player',
    projectId: 'proj_npr_podcast',
    environmentId: 'env_browser',
    name: `Podcast Processing: ${podcastId}`,
    version: 3,
    specVersion: '1.0.0',
    status: WorkflowStatus.Active,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    determinism: { targetGrade: DeterminismGrade.BestEffort },
    entryStepId: 'step_fetch_rss',
    steps,
    secrets: [],
  };
}

// ─── Step metadata for flow visualizer ────────────────────────────────────

const STEP_META: Record<string, { label: string; type: string }> = {
  step_fetch_rss:              { label: 'Fetch RSS Feed',           type: 'http.request' },
  step_parse_episodes:         { label: 'Parse Episodes',           type: 'http.request' },
  step_resolve_audio_stream:   { label: 'Resolve Audio Stream',     type: 'http.request' },
  step_plan_chunks:            { label: 'Plan Chunks',              type: 'compute' },
  // Per-chunk thread steps live in parallelThreads, not here
};

/** Main chain step order. Per-chunk threads fork after step_plan_chunks. */
const STEP_ORDER = [
  'step_fetch_rss',
  'step_parse_episodes',
  'step_resolve_audio_stream',
  'step_plan_chunks',
  // ← parallelThreads (chunk-0..N: Fetch → Transcribe → Classify → Refine → Emit)
];

/** Per-chunk thread step definitions (used to build ParallelThread.steps) */
const CHUNK_STEP_META: Record<string, { label: string; type: string }> = {
  step_fetch_chunk:       { label: 'Fetch',       type: 'http.request' },
  step_transcribe_chunk:  { label: 'Transcribe',  type: 'ai.speech-to-text' },
  step_classify_chunk:    { label: 'Classify',    type: 'ai.generate-text' },
  step_refine_chunk:      { label: 'Refine',      type: 'ai.generate-text' },
  step_emit_skips:        { label: 'Emit Skips',  type: 'compute' },
};

/**
 * Fork index: parallel per-chunk threads run AFTER this index in STEP_ORDER.
 * Steps 0..FORK_INDEX-1 are pre-fork, steps FORK_INDEX.. are post-fork.
 * No join — each chunk emits independently.
 */
const FORK_INDEX = 4; // After step_plan_chunks (index 3)

/** Export step order and metadata for consumers */
export { STEP_ORDER, STEP_META, CHUNK_STEP_META, FORK_INDEX };

// ─── FlowDefinition bridge for bilko-flow StepDetail ──────────────────────

import type { FlowStep, FlowDefinition, UIStepType } from 'bilko-flow/react/components';

/** Map pipeline step types to bilko-flow UIStepType */
const TYPE_MAP: Record<string, UIStepType> = {
  'http.request':       'external-input',
  'compute':            'transform',
  'ai.speech-to-text':  'llm',
  'ai.generate-text':   'llm',
};

/** Step descriptions for the StepDetail prompt/schema tabs */
const STEP_DESCRIPTIONS: Record<string, { description: string; prompt?: string }> = {
  step_fetch_rss: {
    description: 'Pull the podcast RSS feed from NPR and return the raw XML.',
  },
  step_parse_episodes: {
    description: 'Extract episode metadata (title, duration, audio URL, transcript URL) from the RSS XML.',
  },
  step_resolve_audio_stream: {
    description: 'HEAD request to follow podtrac → megaphone → CDN redirects. Returns final URL, Content-Length, Content-Type, Accept-Ranges.',
  },
  step_plan_chunks: {
    description: 'Pure computation — divide Content-Length into 1 MB byte-range chunks for parallel processing.',
  },
};

/** Build a FlowStep from our pipeline step metadata */
function toFlowStep(id: string, index: number): FlowStep {
  const meta = STEP_META[id];
  const desc = STEP_DESCRIPTIONS[id];
  const dslStep = {
    step_fetch_rss: { dependsOn: [] as string[], inputs: { url: '/api/podcast/{id}/episodes', method: 'GET' } },
    step_parse_episodes: { dependsOn: ['step_fetch_rss'], inputs: { transform: 'extract_episode_metadata' } },
    step_resolve_audio_stream: { dependsOn: ['step_parse_episodes'], inputs: { url: '/api/audio/resolve', method: 'HEAD' } },
    step_plan_chunks: { dependsOn: ['step_resolve_audio_stream'], inputs: { chunkSizeBytes: 1_048_576, strategy: 'byte-range' } },
  }[id] || { dependsOn: [] as string[], inputs: {} };

  return {
    id,
    name: meta.label,
    type: TYPE_MAP[meta.type] || 'transform',
    description: desc?.description || '',
    prompt: desc?.prompt,
    dependsOn: dslStep.dependsOn,
    inputSchema: Object.entries(dslStep.inputs).map(([name, value]) => ({
      name,
      type: typeof value,
      required: true,
    })),
    outputSchema: [],
  };
}

/** Per-chunk thread FlowSteps for StepDetail */
const CHUNK_FLOW_STEPS: FlowStep[] = Object.entries(CHUNK_STEP_META).map(([id, meta]) => ({
  id,
  name: meta.label,
  type: TYPE_MAP[meta.type] || 'transform',
  description: {
    step_fetch_chunk: 'HTTP Range request for 1 MB audio slice.',
    step_transcribe_chunk: 'Speech-to-text via Whisper on chunk audio.',
    step_classify_chunk: 'LLM classifies chunk transcript as content or ad.',
    step_refine_chunk: 'LLM refines ad block boundaries within chunk.',
    step_emit_skips: 'Push skip ranges for this chunk to the player.',
  }[id] || '',
  dependsOn: [],
  inputSchema: [],
  outputSchema: [],
}));

/**
 * Build a bilko-flow FlowDefinition from the pipeline step definitions.
 * Used by StepDetail to resolve step names, dependencies, and schema.
 */
export function createFlowDefinition(): FlowDefinition {
  return {
    id: 'flow_podcast_pipeline',
    name: 'NPR Podcast Ad Detection Pipeline',
    description: 'Fetch, transcribe, classify, and skip ads in NPR podcast episodes.',
    version: '3.0.0',
    steps: [
      ...STEP_ORDER.map((id, i) => toFlowStep(id, i)),
      ...CHUNK_FLOW_STEPS,
    ],
    tags: ['podcast', 'ad-detection', 'audio', 'llm'],
  };
}

export { CHUNK_FLOW_STEPS };
