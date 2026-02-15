# Implementation Plan: Chunked Parallel Pipeline + Tubes Visualization

## Summary

Restructure the pipeline so Steps 5+6 run **per-chunk in parallel** (dispatched as each chunk is produced by Step 4), add a new **Step 7** (LLM boundary refinement), and render it all using bilko-flow's `parallelThreads` as a tubes/lanes visualization.

---

## Open Question: Real-Time Transport

**Recommendation: Keep SSE** (current transport). Reasons:

- SSE is already wired end-to-end (server `sendEvent` → client `ReadableStream` parser).
- The data flow is **server→client only** — no client-to-server messages needed mid-pipeline.
- WebSockets add bidirectional complexity, reconnection logic, and a separate upgrade path for no benefit here.
- SSE natively handles reconnection via `EventSource` (though we use `fetch` streaming, same idea).
- Polling would add latency and waste bandwidth.

No transport change needed. The only change is the **shape of SSE events** — they'll now carry a `threadId` / `chunkIndex` to identify which parallel lane they belong to.

---

## Architecture Overview

### Current Flow (sequential)
```
Step 4 (download+chunk all) → Step 5 (transcribe sequentially) → Step 6 (classify all at once) → Step 7 (skip map) → Step 9 (finalize)
```

### New Flow (per-chunk parallel)
```
Step 4 (download + split) ─┬─ Thread "chunk-0": Step 5.0 (STT) → Step 6.0 (classify)
                           ├─ Thread "chunk-1": Step 5.1 (STT) → Step 6.1 (classify)
                           ├─ Thread "chunk-2": Step 5.2 (STT) → Step 6.2 (classify)
                           └─ ...
                              ↓ (all threads join)
                           Step 7 (LLM boundary refinement) → Step 8 (skip map) → Step 9 (finalize)
```

Step 8 (fetch HTML transcript) still runs in parallel with the main pipeline, joining at Step 9.

---

## Phase 1: Server — Parallelize Steps 5+6 Per Chunk

### File: `server/index.ts`

**1a. Restructure the transcription loop to dispatch chunks concurrently**

Currently (lines 1870–1931): sequential `for` loop calling OpenAI STT one chunk at a time.

Change to:
- After `splitMp3IntoChunks`, launch all chunks as concurrent promises with `Promise.allSettled`.
- Each chunk promise does: STT → classify ads → send progress per step.
- Throttle concurrency to ~3 concurrent chunks (OpenAI rate limits). Use a simple semaphore pattern.
- Each chunk sends SSE events tagged with `threadId: chunk-${i}` so the client can route them to the right parallel lane.

```typescript
// Pseudocode
const CONCURRENCY = 3;
const semaphore = new Semaphore(CONCURRENCY);

const chunkPromises = mp3Chunks.map((chunk, ci) =>
  semaphore.run(async () => {
    // Step 5.x: Transcribe this chunk
    sendEvent('progress', {
      step: 'step_transcribe_chunk',
      threadId: `chunk-${ci}`,
      chunkIndex: ci,
      totalChunks: numChunks,
      message: `Transcribing chunk ${ci+1}/${numChunks}...`
    });
    const segments = await transcribeChunk(chunk);

    // Step 6.x: Classify ads in this chunk immediately
    sendEvent('progress', {
      step: 'step_classify_chunk',
      threadId: `chunk-${ci}`,
      chunkIndex: ci,
      totalChunks: numChunks,
      message: `Classifying ads in chunk ${ci+1}...`
    });
    const chunkLines = buildLinesFromSegments(segments);
    const adBlocks = await classifyAdsFromLines(chunkLines, ...);

    // Send partial ads to player immediately
    sendEvent('partial_ads', { skipMap: ..., source: `chunk-${ci}` });

    return { segments, adBlocks, lines: chunkLines };
  })
);

const results = await Promise.allSettled(chunkPromises);
```

**1b. Send `partial_ads` after each chunk's Step 6 completes**

Instead of only sending early ads after chunk 0, send partial results after _every_ chunk's classification completes. The player accumulates ad segments progressively.

**1c. New SSE event shape**

Add `threadId` and `chunkIndex` fields to progress events:
```typescript
interface ChunkedProgressEvent {
  step: string;              // 'step_transcribe_chunk' | 'step_classify_chunk'
  threadId: string;          // 'chunk-0', 'chunk-1', ...
  chunkIndex: number;
  totalChunks: number;
  status?: 'done' | 'error';
  message: string;
}
```

### New Step 7 — LLM Boundary Refinement

**1d. Add Step 7 after all chunk threads join**

After all chunk threads complete:
1. Merge all ad block anchors from Step 6 results across all chunks.
2. For each anchor, extract surrounding transcript context (±5 sentences).
3. Send to LLM with a refinement prompt asking it to find the precise start/end of each ad segment.
4. Output: `{ adStart: number, adEnd: number }[]` in seconds from episode start, precision 0.1s.
5. Send refined boundaries to the player via `partial_ads` (replaces earlier partials).

```typescript
// Step 7: Refine ad boundaries
sendEvent('progress', { step: 'step_refine_ad_boundaries', message: 'Refining ad boundaries with LLM...' });

const refinedAds = await refineBoundariesWithLLM(allAdAnchors, allLines, durationSec, episodeTitle);
// refinedAds = [{ adStart: 45.3, adEnd: 112.8 }, ...]

sendEvent('progress', {
  step: 'step_refine_ad_boundaries',
  status: 'done',
  message: `Refined ${refinedAds.length} ad boundaries`,
});
```

**Refinement prompt design:**
```
You are refining ad segment boundaries in a podcast transcript.

Each anchor below was identified by a per-chunk classifier. Your job is to find
the PRECISE start and end of each ad segment by examining the surrounding transcript.

Rules:
- Anchors are approximate. Examine sentences before/after each anchor boundary.
- If sentences immediately before adStart are also ad content, expand adStart earlier.
- If sentences immediately after adEnd are also ad content, expand adEnd later.
- If edge sentences are editorial content, contract the boundary inward.
- An ad block is typically 3-10 consecutive sentences (sponsor reads, funding credits, promos).
- Output adStart and adEnd as seconds from episode start, rounded to 0.1s precision.

For each anchor, output ONLY:
  { "adStart": <seconds>, "adEnd": <seconds> }
```

**1e. Timestamp precision**

All Step 7 output timestamps use 0.1s precision:
```typescript
const adStart = Math.round(rawStart * 10) / 10;
const adEnd = Math.round(rawEnd * 10) / 10;
```

---

## Phase 2: Client — Parallel Threads (Tubes) Visualization

### File: `src/workflows/podcastFlow.ts`

**2a. Update STEP_ORDER and STEP_META**

- Steps 1–4 remain in main chain (sequential).
- Steps 5+6 are removed from main chain — they live inside parallel chunk threads.
- Step 7 (`step_refine_ad_boundaries`) is new — joins after all chunk threads complete.
- Step 8 (`step_build_skip_map`) stays.
- Step 8b (`step_fetch_html_transcript`) stays parallel with the main pipeline.
- Step 9 (`step_finalize_playback`) joins both.

```typescript
const STEP_META = {
  step_fetch_rss:              { label: 'Fetch RSS Feed',              type: 'http.request' },
  step_parse_episodes:         { label: 'Parse Episodes',              type: 'http.request' },
  step_resolve_audio_stream:   { label: 'Resolve Audio Stream',        type: 'http.request' },
  step_start_audio_streaming:  { label: 'Download & Chunk Audio',      type: 'stream.chunk' },
  // Steps 5+6 per-chunk — defined dynamically as ParallelThread steps
  step_refine_ad_boundaries:   { label: 'Refine Ad Boundaries',        type: 'ai.generate-text' },
  step_build_skip_map:         { label: 'Build Skip Map',              type: 'compute' },
  step_fetch_html_transcript:  { label: 'Fetch HTML Transcript',       type: 'http.request' },
  step_finalize_playback:      { label: 'Finalize Playback',           type: 'ai.summarize' },
};

// Main chain only — per-chunk steps are in parallelThreads
const STEP_ORDER = [
  'step_fetch_rss',
  'step_parse_episodes',
  'step_resolve_audio_stream',
  'step_start_audio_streaming',
  // ← parallelThreads inserted here visually
  'step_refine_ad_boundaries',
  'step_build_skip_map',
  'step_fetch_html_transcript',
  'step_finalize_playback',
];

// Per-chunk thread step definitions (used to build ParallelThread.steps)
const CHUNK_STEP_META = {
  step_transcribe_chunk:  { label: 'Transcribe', type: 'ai.speech-to-text' },
  step_classify_chunk:    { label: 'Classify Ads', type: 'ai.generate-text' },
};
```

### File: `src/App.tsx`

**2b. Add `parallelThreads` state**

```typescript
import type { ParallelThread } from 'bilko-flow/react/components';

const [chunkThreads, setChunkThreads] = useState<ParallelThread[]>([]);
```

**2c. Handle chunked progress events**

When an SSE event arrives with `threadId`:
1. Find or create the `ParallelThread` for that `threadId`.
2. Find or create the step within that thread.
3. Update step status + meta.

```typescript
const handleProgress = (evt: SandboxProgressEvent) => {
  if (evt.threadId) {
    // Per-chunk progress → update parallel thread
    setChunkThreads(prev => {
      const threads = [...prev];
      let thread = threads.find(t => t.id === evt.threadId);
      if (!thread) {
        thread = {
          id: evt.threadId!,
          label: `Chunk ${(evt.chunkIndex ?? 0) + 1}`,
          status: 'running' as const,
          steps: [
            { id: `${evt.threadId}-transcribe`, label: 'Transcribe', status: 'pending' as const, type: 'ai.speech-to-text' },
            { id: `${evt.threadId}-classify`, label: 'Classify Ads', status: 'pending' as const, type: 'ai.generate-text' },
          ],
        };
        threads.push(thread);
      }
      // Map step + status onto the thread's steps
      const stepSuffix = evt.step === 'step_transcribe_chunk' ? 'transcribe' : 'classify';
      const stepId = `${evt.threadId}-${stepSuffix}`;
      const mappedStatus = evt.status === 'done' ? 'complete' : evt.status === 'error' ? 'error' : 'active';
      thread.steps = thread.steps.map(s =>
        s.id === stepId ? { ...s, status: mappedStatus, meta: { message: evt.message } } : s
      );
      // Update thread-level status
      const allComplete = thread.steps.every(s => s.status === 'complete' || s.status === 'skipped');
      const anyError = thread.steps.some(s => s.status === 'error');
      thread.status = anyError ? 'error' : allComplete ? 'complete' : 'running';
      return threads;
    });
  } else {
    // Main pipeline step
    updateStep(evt.step, ...);
  }
};
```

**2d. Pass threads to FlowProgress**

```tsx
<FlowProgress
  mode="auto"
  steps={pipelineSteps}
  status={flowStatus}
  activity={activity}
  label="Ad Detection Pipeline"
  statusMap={STATUS_MAP}
  parallelThreads={chunkThreads}
  parallelConfig={{ maxVisible: 5, autoCollapseCompleted: true }}
/>
```

bilko-flow renders this as:
- Main step chain (Steps 1–4)
- Fork indicator
- Parallel thread lanes (Chunk 1, Chunk 2, Chunk 3...) — each showing Transcribe → Classify
- Join indicator
- Main step chain resumes (Steps 7–9)

### File: `src/components/SandboxPage.tsx`

**2e. Same parallel threads in expanded mode**

SandboxPage receives `chunkThreads` as a new prop and passes it to FlowProgress in expanded mode.

**2f. Add Step 7 debug section**

New `StepRefineAdBoundaries` component showing:
- Input anchors from Step 6 (aggregated across all chunks)
- LLM refinement prompt/response
- Output: refined `{ adStart, adEnd }` pairs with 0.1s precision
- Comparison of anchor vs refined boundaries

---

## Phase 3: SSE Event Schema Update

### File: `src/services/api.ts`

**3a. Extend `SandboxProgressEvent` type**

```typescript
export interface SandboxProgressEvent {
  step: string;
  status?: 'done' | 'error' | 'skipped';
  message: string;
  // New fields for parallel chunk tracking
  threadId?: string;
  chunkIndex?: number;
  totalChunks?: number;
}
```

**3b. SSE parser — no changes needed**

The existing `sandboxAnalyzeStream` parser is generic — it forwards any parsed JSON to `onProgress`. The new fields (`threadId`, `chunkIndex`) flow through automatically.

---

## Phase 4: Step 7 Output → Player Integration

### File: `src/App.tsx`

**4a. Step 7 output replaces partial_ads**

When Step 7 completes, it sends a final `partial_ads` event with the refined boundaries:
```typescript
{ adStart: 45.3, adEnd: 112.8 }  // seconds from episode start, 0.1s precision
```

These are converted to `AdSegment[]` and passed to the Player, replacing any earlier partial results from per-chunk Step 6.

**4b. Timestamp precision**

All Step 7 timestamps round to nearest 0.1s:
```typescript
const adStart = Math.round(rawStart * 10) / 10;
const adEnd = Math.round(rawEnd * 10) / 10;
```

---

## Files Changed

| File | Changes |
|------|---------|
| `server/index.ts` | Parallelize chunk loop with semaphore, add Step 7 LLM refinement, tag SSE events with `threadId` |
| `src/workflows/podcastFlow.ts` | Add `step_refine_ad_boundaries`, export `CHUNK_STEP_META`, update STEP_ORDER/STEP_META |
| `src/App.tsx` | Add `chunkThreads` state, handle `threadId` in progress events, pass `parallelThreads` to FlowProgress |
| `src/components/SandboxPage.tsx` | Accept + render `chunkThreads` prop, add Step 7 debug section |
| `src/services/api.ts` | Extend `SandboxProgressEvent` type with `threadId`/`chunkIndex`/`totalChunks` |

---

## Risks & Mitigations

1. **OpenAI rate limits with 3 concurrent STT calls** — The semaphore caps concurrency at 3. If rate-limited, back off to 2. Each chunk is ~5 min of audio, so a 15-min episode = 3 chunks = 3 concurrent calls.

2. **bilko-flow 5-thread limit** — `MAX_PARALLEL_THREADS = 5`. Most episodes chunk into 2–4 pieces at 5 min each, so this fits. Long episodes (>25 min) would hit the limit; bilko-flow handles overflow with "+N more" indicator and `autoCollapseCompleted: true` collapses finished threads.

3. **Step 7 LLM accuracy** — The refinement prompt gets full transcript context around each anchor, making it more accurate than per-chunk classification. Validate that `adStart < adEnd` and both are within `[0, durationSec]`. Discard invalid pairs.

4. **Memory** — All chunks already loaded into memory (current behavior). No regression.

5. **Chunk ordering** — Parallel chunks may finish out of order. Accumulate results into an array indexed by `chunkIndex`, merge in order after all complete.
