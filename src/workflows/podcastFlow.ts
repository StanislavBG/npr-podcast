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
 *   4. plan_chunks            – Calculate byte-range chunks (priority sub-chunks + regular 2 MB)  (compute)
 *     ── fork: parallel per-chunk threads (no join — each emits independently) ──
 *     Phase 1: 6 priority sub-chunks (~350 KB, ~22s each) from first 2 MB
 *     Phase 2: regular 2 MB chunks for remaining audio
 *     Per chunk:
 *       a. fetch_chunk        – HTTP Range request for chunk slice     (http.request)
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
        // Priority sub-chunking: first 2 MB → 6 sub-chunks (~350 KB, ~22s each),
        // remaining audio → standard 2 MB chunks (~131s at 128kbps).
        chunkSizeBytes: 2_097_152,       // 2 MB per regular chunk
        subChunkSizeBytes: 349_525,      // ~350 KB per priority sub-chunk
        prioritySubChunks: 6,
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
export { STEP_ORDER, STEP_META, STEP_DESCRIPTIONS, CHUNK_STEP_META, FORK_INDEX };

// ─── FlowDefinition bridge for bilko-flow StepDetail ──────────────────────

import type { FlowStep, FlowDefinition, UIStepType, SchemaField } from 'bilko-flow/react/components';

/** Map pipeline step types to bilko-flow UIStepType */
const TYPE_MAP: Record<string, UIStepType> = {
  'http.request':       'external-input',
  'compute':            'transform',
  'ai.speech-to-text':  'llm',
  'ai.generate-text':   'llm',
};

/** Step descriptions, prompts, and schemas for the StepDetail tabs */
const STEP_DESCRIPTIONS: Record<string, {
  description: string;
  prompt?: string;
  userMessage?: string;
  model?: string;
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
}> = {
  step_fetch_rss: {
    description: 'Fetch the podcast RSS feed from NPR via the server proxy. The server fetches the feed XML, parses episode metadata, and returns structured JSON.',
    inputSchema: [
      { name: 'podcastId', type: 'string', required: true, description: 'NPR podcast feed ID' },
      { name: 'url', type: 'string', required: true, description: 'API endpoint: /api/podcast/{id}/episodes' },
      { name: 'method', type: 'string', required: true, description: 'HTTP method (GET)' },
      { name: 'timeout_ms', type: 'number', required: false, description: 'Request timeout (15000ms)' },
      { name: 'max_attempts', type: 'number', required: false, description: 'Retry count (3)' },
    ],
    outputSchema: [
      { name: 'podcastName', type: 'string', required: true, description: 'Name of the podcast' },
      { name: 'episodeCount', type: 'number', required: true, description: 'Number of episodes found' },
    ],
  },
  step_parse_episodes: {
    description: 'Extract episode metadata from the RSS XML response: title, duration, audio URL, and transcript URL for each episode. The server handles XML parsing; this step extracts structured episode data.',
    inputSchema: [
      { name: 'transform', type: 'string', required: true, description: 'Extraction method (extract_episode_metadata)' },
      { name: 'timeout_ms', type: 'number', required: false, description: 'Parse timeout (5000ms)' },
    ],
    outputSchema: [
      { name: 'episodeTitle', type: 'string', required: true, description: 'Selected episode title' },
      { name: 'duration', type: 'string', required: true, description: 'Episode duration (HH:MM:SS)' },
      { name: 'durationSec', type: 'number', required: true, description: 'Duration in seconds' },
      { name: 'transcriptUrl', type: 'string', required: false, description: 'NPR transcript page URL' },
      { name: 'audioUrl', type: 'string', required: false, description: 'Audio stream URL (podtrac-wrapped)' },
      { name: 'episodeCount', type: 'number', required: true, description: 'Total episodes in feed' },
    ],
  },
  step_resolve_audio_stream: {
    description: 'HEAD request to follow the podtrac → megaphone → CDN redirect chain and resolve the final audio stream URL. Returns content metadata needed for byte-range chunking: Content-Length, Content-Type, and Accept-Ranges header.',
    inputSchema: [
      { name: 'audioUrl', type: 'string', required: true, description: 'Original podtrac-wrapped audio URL' },
      { name: 'method', type: 'string', required: true, description: 'HTTP method (HEAD, follow redirects)' },
      { name: 'timeout_ms', type: 'number', required: false, description: 'Request timeout (10000ms)' },
      { name: 'max_attempts', type: 'number', required: false, description: 'Retry count (3)' },
    ],
    outputSchema: [
      { name: 'resolvedUrl', type: 'string', required: true, description: 'Final CDN URL after redirects' },
      { name: 'contentType', type: 'string', required: true, description: 'Audio MIME type (e.g. audio/mpeg)' },
      { name: 'contentLengthBytes', type: 'number', required: true, description: 'Total file size in bytes' },
      { name: 'acceptRanges', type: 'string', required: true, description: 'Range request support (bytes)' },
      { name: 'redirected', type: 'boolean', required: true, description: 'Whether URL was redirected' },
    ],
  },
  step_plan_chunks: {
    description: 'Two-phase chunk planning: the first 2 MB of audio is split into 6 priority sub-chunks (~350 KB, ~22s each) for fast playback start. Remaining audio uses standard 2 MB chunks (~131s at 128kbps). All chunks are processed independently via HTTP Range requests.',
    inputSchema: [
      { name: 'contentLengthBytes', type: 'number', required: true, description: 'Total audio file size from HEAD' },
      { name: 'chunkSizeBytes', type: 'number', required: true, description: 'Regular chunk size (2,097,152 = 2 MB)' },
      { name: 'subChunkSizeBytes', type: 'number', required: false, description: 'Priority sub-chunk size (~349,525 bytes)' },
      { name: 'strategy', type: 'string', required: true, description: 'Chunking strategy (byte-range)' },
      { name: 'format', type: 'string', required: false, description: 'Audio format from Content-Type' },
      { name: 'resolvedUrl', type: 'string', required: true, description: 'CDN URL for byte-range requests' },
    ],
    outputSchema: [
      { name: 'chunkCount', type: 'number', required: true, description: 'Total number of chunks planned (priority + regular)' },
      { name: 'priorityChunks', type: 'number', required: true, description: 'Number of priority sub-chunks (first 2 MB)' },
      { name: 'regularChunks', type: 'number', required: true, description: 'Number of regular 2 MB chunks' },
      { name: 'totalEstimatedAudioSec', type: 'number', required: true, description: 'Total estimated audio duration' },
      { name: 'fileSizeMb', type: 'string', required: true, description: 'File size formatted in MB' },
    ],
  },
};

/** Step dependency graph */
const STEP_DEPENDS_ON: Record<string, string[]> = {
  step_fetch_rss: [],
  step_parse_episodes: ['step_fetch_rss'],
  step_resolve_audio_stream: ['step_parse_episodes'],
  step_plan_chunks: ['step_resolve_audio_stream'],
};

/** Build a FlowStep from our pipeline step metadata */
function toFlowStep(id: string, _index: number): FlowStep {
  const meta = STEP_META[id];
  const desc = STEP_DESCRIPTIONS[id];

  return {
    id,
    name: meta.label,
    type: TYPE_MAP[meta.type] || 'transform',
    description: desc?.description || '',
    prompt: desc?.prompt,
    userMessage: desc?.userMessage,
    model: desc?.model,
    dependsOn: STEP_DEPENDS_ON[id] || [],
    inputSchema: desc?.inputSchema || [],
    outputSchema: desc?.outputSchema || [],
  };
}

/** Per-chunk thread step definitions for StepDetail */
export const CHUNK_STEP_DEFINITIONS: Record<string, {
  description: string;
  prompt?: string;
  userMessage?: string;
  model?: string;
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
  dependsOn: string[];
}> = {
  step_fetch_chunk: {
    description: 'HTTP Range request to fetch an audio slice from the CDN. Priority sub-chunks are ~350 KB (~22s), regular chunks are 2 MB (~131s). Uses byte-range headers to download only the relevant portion.',
    inputSchema: [
      { name: 'audioUrl', type: 'string', required: true, description: 'CDN URL for byte-range request' },
      { name: 'chunkIndex', type: 'number', required: true, description: 'Zero-based chunk index' },
      { name: 'totalChunks', type: 'number', required: true, description: 'Total number of chunks' },
      { name: 'chunkSizeBytes', type: 'number', required: true, description: 'Chunk size in bytes (varies: ~350 KB or 2 MB)' },
      { name: 'method', type: 'string', required: true, description: 'HTTP method (GET with Range header)' },
    ],
    outputSchema: [
      { name: 'bytesFetched', type: 'number', required: true, description: 'Bytes downloaded' },
      { name: 'byteRange', type: 'string', required: true, description: 'Byte range fetched (e.g. "0-1048575")' },
      { name: 'offsetSec', type: 'number', required: true, description: 'Estimated audio offset in seconds' },
      { name: 'audioUrl', type: 'string', required: true, description: 'Resolved CDN URL (truncated)' },
    ],
    dependsOn: [],
  },
  step_transcribe_chunk: {
    description: 'Speech-to-text transcription of the audio chunk using OpenAI Whisper. Produces timestamped segments with word-level confidence scores.',
    model: 'whisper-1',
    inputSchema: [
      { name: 'model', type: 'string', required: true, description: 'STT model (whisper-1)' },
      { name: 'format', type: 'string', required: true, description: 'Output format (verbose_json)' },
      { name: 'language', type: 'string', required: true, description: 'Language hint (en)' },
      { name: 'chunkIndex', type: 'number', required: true, description: 'Zero-based chunk index' },
      { name: 'totalChunks', type: 'number', required: true, description: 'Total number of chunks' },
    ],
    outputSchema: [
      { name: 'segmentCount', type: 'number', required: true, description: 'Number of timed segments' },
      { name: 'wordCount', type: 'number', required: true, description: 'Total word count' },
      { name: 'transcript', type: 'string', required: true, description: 'Full transcribed text for this chunk' },
      { name: 'durationSec', type: 'number', required: true, description: 'Audio duration transcribed in seconds' },
    ],
    dependsOn: ['step_fetch_chunk'],
  },
  step_classify_chunk: {
    description: 'LLM classifies each sentence in the chunk transcript as content or advertisement. Uses topic-aware context from surrounding chunks to improve boundary detection.',
    prompt: 'You are an expert podcast ad detector. Analyze the transcript and classify each segment as CONTENT or AD. Ads include: sponsor reads, promo codes, calls to action, network promos, and mid-roll ad breaks. Content includes: news, interviews, analysis, and editorial segments.',
    userMessage: 'Classify each line of this podcast transcript chunk as content or ad. Return a JSON array of { lineIndex, classification, confidence, reason } objects.',
    model: 'claude-3-5-sonnet',
    inputSchema: [
      { name: 'model', type: 'string', required: true, description: 'LLM model (claude-3-5-sonnet)' },
      { name: 'chunkIndex', type: 'number', required: true, description: 'Current chunk index' },
      { name: 'totalChunks', type: 'number', required: true, description: 'Total chunks in episode' },
      { name: 'episodeTitle', type: 'string', required: true, description: 'Episode title for context' },
    ],
    outputSchema: [
      { name: 'adBlockCount', type: 'number', required: true, description: 'Number of contiguous ad blocks found' },
      { name: 'linesAnalyzed', type: 'number', required: true, description: 'Total transcript lines analyzed' },
    ],
    dependsOn: ['step_transcribe_chunk'],
  },
  step_refine_chunk: {
    description: 'LLM refines ad block boundaries by examining transition points between content and ads. Adjusts start/end timestamps to natural sentence boundaries and merges small gaps between adjacent ad segments.',
    prompt: 'You are refining ad block boundaries in a podcast transcript. Given the raw classifications, adjust boundaries to align with natural sentence breaks. Merge ad blocks separated by less than 3 seconds. Output precise start/end timestamps.',
    userMessage: 'Refine these ad block boundaries. Input: chunk transcript with timestamps and raw classifications. Output: adjusted skip ranges with precise timestamps.',
    model: 'claude-3-5-sonnet',
    inputSchema: [
      { name: 'model', type: 'string', required: true, description: 'LLM model (claude-3-5-sonnet)' },
      { name: 'chunkIndex', type: 'number', required: true, description: 'Zero-based chunk index' },
      { name: 'totalChunks', type: 'number', required: true, description: 'Total number of chunks' },
    ],
    outputSchema: [
      { name: 'refinedBlocks', type: 'number', required: true, description: 'Number of refined ad blocks' },
      { name: 'totalAdTimeSec', type: 'number', required: false, description: 'Total ad time in this chunk (seconds)' },
    ],
    dependsOn: ['step_classify_chunk'],
  },
  step_emit_skips: {
    description: 'Push skip ranges for this chunk to the audio player. Each chunk emits independently — no join needed. The player receives progressive results and updates the scrubber in real-time.',
    inputSchema: [
      { name: 'chunkIndex', type: 'number', required: true, description: 'Chunk index being emitted' },
      { name: 'totalChunks', type: 'number', required: true, description: 'Total chunks for progress tracking' },
      { name: 'target', type: 'string', required: true, description: 'Target component (player-scrubber)' },
    ],
    outputSchema: [
      { name: 'emittedRanges', type: 'number', required: true, description: 'Number of skip ranges sent to player' },
    ],
    dependsOn: ['step_refine_chunk'],
  },
};

/** Per-chunk thread FlowSteps for StepDetail */
const CHUNK_FLOW_STEPS: FlowStep[] = Object.entries(CHUNK_STEP_META).map(([id, meta]) => {
  const def = CHUNK_STEP_DEFINITIONS[id];
  return {
    id,
    name: meta.label,
    type: TYPE_MAP[meta.type] || 'transform',
    description: def?.description || '',
    prompt: def?.prompt,
    userMessage: def?.userMessage,
    model: def?.model,
    dependsOn: def?.dependsOn || [],
    inputSchema: def?.inputSchema || [],
    outputSchema: def?.outputSchema || [],
  };
});

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
