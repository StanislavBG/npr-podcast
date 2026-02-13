import {
  type Workflow,
  type Step,
  WorkflowStatus,
  DeterminismGrade,
} from 'bilko-flow';
import type { FlowProgressStep } from 'bilko-flow/react';

/**
 * Podcast processing workflow using bilko-flow DSL.
 *
 * Clarified flow: audio streaming happens BEFORE transcription.
 * We stream audio ahead of the listener, transcribe chunks as they arrive,
 * and mark ad locations progressively so they're known before the user
 * reaches them.
 *
 * Pipeline:
 *   1. fetch_rss              – Pull the podcast RSS feed              (http.request)
 *   2. parse_episodes         – Extract episode list from XML          (http.request — server parses)
 *     ── user selects episode ──
 *   3. resolve_audio_stream   – Resolve CDN URL, get duration/size     (http.request — HEAD)
 *   4. start_audio_streaming  – Stream audio chunks ahead of playback  (stream.chunk)
 *   5. transcribe_chunks      – Speech-to-text on each audio chunk     (ai.speech-to-text)
 *   6. mark_ad_locations      – LLM classifies segments as content/ad  (ai.generate-text)
 *   7. build_skip_map         – Accumulate ad ranges into skip map     (compute)
 *   8. fetch_html_transcript  – Parallel: get NPR HTML for cross-ref   (http.request)
 *   9. finalize_playback      – Reconcile + summary + quality gate     (ai.summarize)
 *
 * Steps 4–7 run as a streaming pipeline: chunks flow through in order.
 * Step 8 runs in parallel with 4–7.
 * Step 9 waits for both branches to complete.
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
      id: 'step_start_audio_streaming',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Stream Audio Chunks',
      type: 'stream.chunk',
      dependsOn: ['step_resolve_audio_stream'],
      inputs: {
        // Fetch audio in ~30-second chunks via HTTP Range requests
        // Feed each chunk to transcription pipeline AND player buffer
        url: '/api/audio/stream',
        method: 'GET',
        chunkStrategy: 'time-based',      // chunk by ~30s of audio
        chunkSizeBytes: 480_000,           // ~30s at 128kbps MP3
        lookaheadChunks: 3,                // stay 3 chunks (~90s) ahead of playback
        parallelDownloads: 2,              // fetch 2 chunks concurrently
      },
      policy: { timeoutMs: 120000, maxAttempts: 2 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'Podcast CDN Audio Stream',
            kind: 'http-api',
            deterministic: true,         // same bytes for same range
            evidenceCapture: 'chunk-hash',
          },
        ],
      },
    },
    {
      id: 'step_transcribe_chunks',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Transcribe Audio Chunks',
      type: 'ai.speech-to-text',
      dependsOn: ['step_start_audio_streaming'],
      inputs: {
        // As each audio chunk arrives, transcribe it to timestamped text.
        //
        // Primary: OpenAI Realtime API (WebSocket streaming)
        //   Protocol: wss://api.openai.com/v1/realtime
        //   Model: gpt-4o-mini-transcribe
        //   Input: raw PCM/MP3 audio frames
        //   Output: streaming transcript with word-level timestamps
        //
        // Fallback: Chunked Whisper batch API
        //   POST /v1/audio/transcriptions with response_format=verbose_json
        //   Each chunk processed independently, timestamps offset by chunk position
        //
        model: 'gpt-4o-mini-transcribe',
        responseFormat: 'verbose_json',
        timestampGranularity: 'segment',
        streamingMode: 'realtime-preferred',
      },
      policy: { timeoutMs: 30000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'OpenAI Speech-to-Text',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_mark_ad_locations',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Mark Ad Locations',
      type: 'ai.generate-text',
      dependsOn: ['step_transcribe_chunks'],
      inputs: {
        // As transcript segments arrive from each chunk, classify each as
        // content or ad. Uses a lightweight LLM call per chunk (~500 tokens
        // in, ~200 tokens out) so latency is minimal.
        //
        // Prompt approach: provide the transcript segment with ~2 sentences
        // of surrounding context, ask the LLM to classify:
        //   - "content"         → editorial podcast content
        //   - "sponsor_read"    → host reading a sponsor message
        //   - "funding_credit"  → NPR funding acknowledgment
        //   - "npr_promo"       → NPR show/network promotion
        //   - "dynamic_ad"      → inserted ad (detected via audio artifacts:
        //                         volume shift, different speaker/mic quality,
        //                         abrupt topic change)
        //
        // The "dynamic_ad" type is NEW — it catches Megaphone-inserted ads
        // that only exist in the audio stream, never in the HTML transcript.
        //
        prompt: 'Classify each transcript segment as content or ad type. Look for: sponsor reads, funding credits, NPR promos, and dynamic ad insertions (volume/quality shifts, abrupt topic changes).',
        model: 'gpt-4o-mini',
        outputFormat: 'chatJSON',
      },
      policy: { timeoutMs: 15000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'LLM Provider',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_build_skip_map',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Build Skip Map',
      type: 'compute',
      dependsOn: ['step_mark_ad_locations'],
      inputs: {
        // Pure computation — no external calls.
        // As classified segments arrive:
        //   1. Merge adjacent ad segments of the same type into ranges
        //   2. Add padding (0.5s before, 0.3s after) for clean transitions
        //   3. Assign confidence scores based on classification certainty
        //   4. Push updated skip map to player via state callback
        //
        // The skip map grows progressively. The player receives updates
        // as new ad ranges are confirmed, so it can skip ads even while
        // the stream is still being processed ahead.
        //
        transform: 'merge_adjacent_ad_segments',
        paddingBeforeMs: 500,
        paddingAfterMs: 300,
        minConfidence: 0.6,
      },
      policy: { timeoutMs: 5000, maxAttempts: 1 },
      determinism: { pureFunction: true },
    },

    // ─── Parallel: HTML Transcript for Cross-Reference ──────────────────

    {
      id: 'step_fetch_html_transcript',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Fetch HTML Transcript',
      type: 'http.request',
      // Runs in PARALLEL with the streaming pipeline (steps 4-7).
      // Only depends on episode selection (step 2), not on audio steps.
      dependsOn: ['step_parse_episodes'],
      inputs: {
        url: '/api/transcript',
        method: 'GET',
        // HTML transcript provides:
        //   - Accurate speaker names (audio STT often misses these)
        //   - Editorial-only content (no dynamic ads)
        //   - Cross-reference to validate audio-detected ad boundaries
      },
      policy: { timeoutMs: 15000, maxAttempts: 2 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'NPR Transcript Page',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },

    // ─── Finalization Phase ─────────────────────────────────────────────

    {
      id: 'step_finalize_playback',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Finalize Playback',
      type: 'ai.summarize',
      // Waits for BOTH the streaming pipeline AND the HTML transcript
      dependsOn: ['step_build_skip_map', 'step_fetch_html_transcript'],
      inputs: {
        // Final quality gate. The LLM receives:
        //   - Progressive skip map from audio analysis (step 7)
        //   - HTML transcript with speaker names (step 8)
        //   - Full audio transcription assembled from chunks
        //
        // The LLM:
        //   1. Cross-references audio-detected ads against HTML transcript
        //      to reduce false positives (if a "detected ad" matches editorial
        //      content in the HTML, it's probably not a dynamic insertion)
        //   2. Enriches speaker names from HTML onto audio segments
        //   3. Validates skip map timing boundaries
        //   4. Produces episode summary, topics, recommendation
        //   5. Can adjust confidence scores or remove false positives
        //
        prompt: 'Reconcile audio-detected ad segments with HTML editorial transcript. Validate skip map, enrich speaker names, produce episode summary and final playback configuration.',
        model: 'configurable',
        output: 'playback_config',
      },
      policy: { timeoutMs: 30000, maxAttempts: 2 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'LLM Provider',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
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
  step_start_audio_streaming:  { label: 'Stream Audio Chunks',      type: 'stream.chunk' },
  step_transcribe_chunks:      { label: 'Transcribe Audio Chunks',  type: 'ai.speech-to-text' },
  step_mark_ad_locations:      { label: 'Mark Ad Locations',        type: 'ai.generate-text' },
  step_build_skip_map:         { label: 'Build Skip Map',           type: 'compute' },
  step_fetch_html_transcript:  { label: 'Fetch HTML Transcript',    type: 'http.request' },
  step_finalize_playback:      { label: 'Finalize Playback',        type: 'ai.summarize' },
};

const STEP_ORDER = [
  'step_fetch_rss',
  'step_parse_episodes',
  'step_resolve_audio_stream',
  'step_start_audio_streaming',
  'step_transcribe_chunks',
  'step_mark_ad_locations',
  'step_build_skip_map',
  'step_fetch_html_transcript',
  'step_finalize_playback',
];

/** Internal step tracking status */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface FlowState {
  steps: Record<string, StepStatus>;
  currentStep: string | null;
  error: string | null;
}

export function createInitialFlowState(): FlowState {
  return {
    steps: Object.fromEntries(STEP_ORDER.map((id) => [id, 'pending' as StepStatus])),
    currentStep: null,
    error: null,
  };
}

/** Bilko-flow progress step status values */
export type ProgressStepStatus = 'pending' | 'active' | 'complete' | 'error';

/** Map internal status to bilko-flow FlowProgressStep status */
function mapStatus(s: StepStatus): FlowProgressStep['status'] {
  switch (s) {
    case 'running': return 'active';
    case 'completed': return 'complete';
    case 'failed': return 'error';
    case 'skipped': return 'complete';
    default: return 'pending';
  }
}

/** Convert our FlowState to bilko-flow FlowProgressStep array */
export function toFlowProgressSteps(state: FlowState): FlowProgressStep[] {
  return STEP_ORDER.map((id) => ({
    id,
    label: STEP_META[id].label,
    status: mapStatus(state.steps[id]),
    type: STEP_META[id].type,
  }));
}

/** Get overall flow status */
export function getFlowStatus(state: FlowState): 'idle' | 'running' | 'complete' | 'error' {
  const statuses = Object.values(state.steps);
  if (statuses.some((s) => s === 'failed')) return 'error';
  if (statuses.some((s) => s === 'running')) return 'running';
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'complete';
  return 'idle';
}

/** Get activity description for the current step */
export function getFlowActivity(state: FlowState): string {
  if (!state.currentStep) return '';
  const meta = STEP_META[state.currentStep];
  return meta ? `${meta.label}...` : '';
}

/** Export step order for consumers */
export { STEP_ORDER, STEP_META };
