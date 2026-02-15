import {
  type Workflow,
  type Step,
  WorkflowStatus,
  DeterminismGrade,
} from 'bilko-flow';

/**
 * Podcast processing workflow using bilko-flow DSL.
 *
 * Pipeline (parallelized per-chunk):
 *   1. fetch_rss              – Pull the podcast RSS feed              (http.request)
 *   2. parse_episodes         – Extract episode list from XML          (http.request — server parses)
 *     ── user selects episode ──
 *   3. resolve_audio_stream   – Resolve CDN URL, get duration/size     (http.request — HEAD)
 *   4. start_audio_streaming  – Download & split into ~5-min chunks    (stream.chunk)
 *     ── parallel per-chunk threads (shown as tubes in UI) ──
 *     5.x  transcribe_chunk   – STT on each chunk concurrently         (ai.speech-to-text)
 *     6.x  classify_chunk     – LLM classifies chunk as content/ad     (ai.generate-text)
 *     ── all threads join ──
 *   7. refine_ad_boundaries   – LLM refines anchor → precise bounds   (ai.generate-text)
 *   8. build_skip_map         – Accumulate ad ranges into skip map     (compute)
 *   8b. fetch_html_transcript – Parallel: get NPR HTML for cross-ref   (http.request)
 *   9. finalize_playback      – Reconcile + summary + quality gate     (ai.summarize)
 *
 * Steps 5+6 run as parallel per-chunk threads (visualized via bilko-flow parallelThreads).
 * Step 8b runs in parallel with the main pipeline.
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
        chunkStrategy: 'time-based',      // chunk by ~5min of audio
        chunkDurationSec: 300,             // 5 minutes per chunk (~4.7MB at 128kbps)
        overlapSec: 10,                    // 10s overlap for boundary ad detection
        lookaheadChunks: 2,                // process 2 chunks (~10min) ahead of playback
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
    // ─── Steps 5+6 run as parallel per-chunk threads (not in main chain) ──

    // ─── Step 7: Refine Ad Boundaries ────────────────────────────────────
    {
      id: 'step_refine_ad_boundaries',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Refine Ad Boundaries',
      type: 'ai.generate-text',
      dependsOn: ['step_start_audio_streaming'],
      inputs: {
        // After all per-chunk threads complete, takes anchor boundaries
        // from per-chunk classification and refines them using full
        // transcript context. Outputs precise adStart/adEnd in seconds
        // from episode start, 0.1s precision.
        prompt: 'Refine per-chunk ad anchor boundaries using surrounding transcript context. Expand/contract to find precise ad start/end times.',
        model: 'configurable',
        precision: 0.1,
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
    {
      id: 'step_build_skip_map',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Build Skip Map',
      type: 'compute',
      dependsOn: ['step_refine_ad_boundaries'],
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
  step_start_audio_streaming:  { label: 'Download & Chunk Audio',   type: 'stream.chunk' },
  // Steps 5+6 are per-chunk parallel threads — not in STEP_ORDER
  step_refine_ad_boundaries:   { label: 'Refine Ad Boundaries',     type: 'ai.generate-text' },
  step_build_skip_map:         { label: 'Build Skip Map',           type: 'compute' },
  step_fetch_html_transcript:  { label: 'Fetch HTML Transcript',    type: 'http.request' },
  step_finalize_playback:      { label: 'Finalize Playback',        type: 'ai.summarize' },
};

/** Main chain step order. Per-chunk thread steps (5+6) live in parallelThreads, not here. */
const STEP_ORDER = [
  'step_fetch_rss',
  'step_parse_episodes',
  'step_resolve_audio_stream',
  'step_start_audio_streaming',
  // ← parallelThreads (chunk-0..N: Transcribe → Classify) inserted here visually
  'step_refine_ad_boundaries',
  'step_build_skip_map',
  'step_fetch_html_transcript',
  'step_finalize_playback',
];

/** Per-chunk thread step definitions (used to build ParallelThread.steps) */
const CHUNK_STEP_META: Record<string, { label: string; type: string }> = {
  step_transcribe_chunk:  { label: 'Transcribe', type: 'ai.speech-to-text' },
  step_classify_chunk:    { label: 'Classify Ads', type: 'ai.generate-text' },
};

/** Export step order and metadata for consumers */
export { STEP_ORDER, STEP_META, CHUNK_STEP_META };
