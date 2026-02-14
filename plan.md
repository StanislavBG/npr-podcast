# Chunked Podcast Processing — Implementation Plan

## Problem

The audio file is 32.7 MB, exceeding OpenAI Whisper's 25 MB limit. The current code in `transcribeAudioFromUrl()` (`server/index.ts:360-464`) downloads the entire file in one shot and sends it to Whisper as a single request — this fails for long podcasts (2h+).

## Strategy: Lazy 5-Minute Chunks with 2-Chunk Lookahead

Process **5-minute chunks on-demand**, staying **2 chunks (~10 min) ahead of playback**. A 2-hour podcast starts playing after processing just the first 2 chunks (~9.4 MB total), not the full 32+ MB file.

### Key Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Chunk duration | 300s (5 min) | ~4.7 MB at 128kbps — well under 25 MB Whisper limit |
| Lookahead | 2 chunks | Processes chunks `N` and `N+1` while user listens to chunk `N-1` |
| Overlap | 10 seconds | Catches ad boundaries that straddle chunk edges |
| Parallel chunk processing | 2 concurrent | Faster initial load |

### Boundary Ad Detection

The 10-second overlap between adjacent chunks is how we catch ads that cross boundaries:

```
Chunk 0: [0:00 ──────────────── 5:00] + overlap [5:00 ── 5:10]
Chunk 1: overlap [4:50 ── 5:00] + [5:00 ──────────────── 10:00] + overlap [10:00 ── 10:10]
```

An ad starting at 4:55 is detected in chunk 0 (at 4:55) AND chunk 1 (at 4:55 after timestamp offset). The merge logic deduplicates overlapping segments.

---

## Updated bilko-flow Pipeline

The 9-step flow structure stays the same but **steps 4-7 now operate per-chunk in a loop** rather than on the whole file:

```
RSS → Parse ─┬─→ Resolve Audio → [Chunk Loop: Stream → Transcribe → Mark Ads → Merge Skip Map] ─┬─→ Finalize
             └─→ Fetch HTML Transcript ──────────────────────────────────────────────────────────┘
```

The bilko-flow step definitions in `podcastFlow.ts` are updated:

- **Step 4 (`stream.chunk`)**: Now fetches a single 5-min chunk via HTTP Range request (called per-chunk)
- **Step 5 (`ai.speech-to-text`)**: Transcribes one chunk at a time (under 25 MB limit)
- **Step 6 (`ai.generate-text`)**: LLM classifies that chunk's segments (lightweight per-chunk call)
- **Step 7 (`compute`)**: Merges new chunk's ad segments into the growing skip map, deduplicates overlaps

The flow visualizer shows progress as "Chunk 2/24" on steps 4-7.

---

## Implementation Steps

### Step 1: New server endpoint `POST /api/audio/resolve`

**File:** `server/index.ts`

HEAD request to the audio URL, follows all redirects (podtrac → megaphone → CDN), returns metadata for chunking.

```typescript
// Request:  { audioUrl: string }
// Response: {
//   resolvedUrl: string,       // Final CDN URL after redirects
//   contentLength: number,     // Total file size in bytes
//   acceptRanges: boolean,     // Whether server supports Range requests
//   contentType: string,       // "audio/mpeg"
//   durationSec: number,       // Estimated: contentLength * 8 / 128000
//   bitrate: number,           // Default 128000
//   totalChunks: number,       // ceil(durationSec / 300)
//   chunkDurationSec: number,  // 300
// }
```

Maps to bilko-flow **Step 3 (`step_resolve_audio_stream`)** — `http.request` type, HEAD method.

### Step 2: New server endpoint `POST /api/audio/chunk`

**File:** `server/index.ts`

The core new endpoint — processes a single 5-minute chunk. Combines steps 4+5+6+7 for one chunk into a single server round-trip.

```typescript
// Request: {
//   resolvedUrl: string,
//   chunkIndex: number,         // 0-based
//   totalChunks: number,
//   contentLength: number,
//   durationSec: number,
//   bitrate: number,
//   chunkDurationSec: number,   // 300
//   overlapSec: number,         // 10
//   episodeTitle: string,
//   prevChunkTrailingText: string,  // Last ~200 chars from previous chunk for context
// }
// Response: {
//   chunkIndex: number,
//   startTimeSec: number,       // Chunk start in full audio
//   endTimeSec: number,         // Chunk end in full audio
//   transcript: {
//     text: string,
//     segments: Array<{start: number, end: number, text: string}>,
//   },
//   adSegments: Array<{startTime, endTime, type, confidence, reason}>,
//   trailingText: string,       // Last ~200 chars for next chunk's context
// }
```

**Internal flow within this endpoint:**
1. **Stream chunk (bilko step 4):** Calculate byte range from `chunkIndex * chunkDurationSec * bitrate / 8`. Fetch via `Range: bytes=startByte-endByte`. MP3 is frame-based so any byte-boundary cut works (decoder syncs to next frame header).
2. **Transcribe chunk (bilko step 5):** Send chunk buffer (≤5 MB) to `openai.audio.transcriptions.create()` with `response_format: 'verbose_json'`. Offset all segment timestamps by `chunkStartTimeSec`.
3. **Detect ads in chunk (bilko step 6):** Send chunk transcript + trailing context from previous chunk to LLM for classification (same `callLLM()` logic, but per-chunk — ~500 tokens in, ~200 out).
4. **Return results** — the frontend merges into the skip map (bilko step 7).

### Step 3: Frontend chunk orchestrator in `App.tsx`

Replace the single `POST /api/transcribe` call with a progressive chunk loop:

```typescript
// New state:
const [audioMeta, setAudioMeta] = useState<AudioMeta | null>(null);
const chunksRef = useRef<Map<number, ChunkResult>>(new Map());
const processingRef = useRef<Set<number>>(new Set());

// On episode select (inside pick()):
//   1. POST /api/audio/resolve → get audioMeta
//      → bilko step 3 completes
//   2. processChunk(0) and processChunk(1) in parallel
//      → bilko steps 4-7 update with "Chunk 1/N"
//   3. Start playback immediately after chunk 0 completes
//   4. On timeupdate: ensureLookahead(currentChunkIndex)
//      → triggers next chunk processing as user listens

async function processChunk(index: number): Promise<ChunkResult> {
  // POST /api/audio/chunk with index
  // On response: merge adSegments into global ads state
  // Update bilko flow steps 4-7 progress
}

function ensureLookahead(currentChunkIndex: number) {
  // If chunk currentChunk+1 and currentChunk+2 aren't processed,
  // kick off processing
}
```

The bilko-flow step statuses update progressively:
- Steps 4-7 show `running` with a progress annotation ("Chunk 3/24")
- After ALL chunks processed, steps 4-7 show `completed`
- Steps 4-7 only show `completed` after every chunk is done

### Step 4: API client functions in `src/services/api.ts`

```typescript
export interface AudioMeta {
  resolvedUrl: string;
  contentLength: number;
  acceptRanges: boolean;
  contentType: string;
  durationSec: number;
  bitrate: number;
  totalChunks: number;
  chunkDurationSec: number;
}

export interface ChunkResult {
  chunkIndex: number;
  startTimeSec: number;
  endTimeSec: number;
  transcript: { text: string; segments: Array<{start: number; end: number; text: string}> };
  adSegments: AdSegment[];
  trailingText: string;
}

export async function resolveAudio(audioUrl: string): Promise<AudioMeta>
export async function processAudioChunk(params: ChunkRequest): Promise<ChunkResult>
```

### Step 5: Ad segment merge/dedup in `src/services/adDetector.ts`

```typescript
export function mergeChunkAdSegments(
  existing: AdSegment[],
  incoming: AdSegment[],
  overlapSec: number,
): AdSegment[] {
  // 1. Combine existing + incoming
  // 2. Sort by startTime
  // 3. Merge segments that overlap or are within 3s gap
  // 4. Deduplicate segments from the overlap region between chunks
  // 5. Add padding: 0.5s before, 0.3s after
  // 6. Return merged array
}
```

### Step 6: Update `podcastFlow.ts` bilko-flow workflow

Update the step inputs in `createPodcastWorkflow()` to reflect 5-minute chunking:

```typescript
// Step 4 - updated
{
  id: 'step_start_audio_streaming',
  type: 'stream.chunk',
  inputs: {
    chunkStrategy: 'time-based',
    chunkDurationSec: 300,          // 5 minutes
    overlapSec: 10,                 // 10s overlap for boundary ads
    lookaheadChunks: 2,             // process 2 ahead of playback
    parallelDownloads: 2,
  },
}
```

Add progress metadata support to `FlowState`:

```typescript
export interface FlowState {
  steps: Record<string, StepStatus>;
  currentStep: string | null;
  error: string | null;
  chunkProgress?: {                 // NEW
    currentChunk: number;
    totalChunks: number;
  };
}
```

Update `getFlowActivity()` to show chunk progress:

```typescript
export function getFlowActivity(state: FlowState): string {
  if (!state.currentStep) return '';
  const meta = STEP_META[state.currentStep];
  if (!meta) return '';
  if (state.chunkProgress && ['step_start_audio_streaming', 'step_transcribe_chunks', 'step_mark_ad_locations', 'step_build_skip_map'].includes(state.currentStep)) {
    return `${meta.label} (${state.chunkProgress.currentChunk}/${state.chunkProgress.totalChunks})...`;
  }
  return `${meta.label}...`;
}
```

### Step 7: Remove old whole-file transcription

- Remove `transcribeAudioFromUrl()` from `server/index.ts`
- Remove `POST /api/transcribe` endpoint
- Keep `POST /api/llm/detect-ads` but make it accept per-chunk transcripts
- Keep `/api/audio` proxy endpoint unchanged (player still streams full audio for playback)

---

## Edge Cases

1. **Server doesn't support Range requests**: `acceptRanges: false` from resolve. Fall back to downloading full file in memory on server, slice into 5-min buffers, process as chunks. Warn in UI.
2. **User seeks forward**: If user jumps to 45:00 and chunk 9 isn't processed yet, immediately prioritize chunks 9-10 over sequential processing.
3. **Short podcast (<5 min)**: Single chunk, no lookahead needed. Processed identically.
4. **Last chunk is short**: May be <1 min. Still run through the pipeline, but ad detection context may be limited.
5. **MP3 frame alignment**: MP3 decoders sync to the next valid frame header after any byte boundary cut. A few ms of silence/artifact at chunk start is fine since this audio is only used for transcription, not playback.

## Files to Modify

| File | Changes |
|------|---------|
| `server/index.ts` | Add `POST /api/audio/resolve` + `POST /api/audio/chunk` endpoints. Refactor `callLLM()` ad detection to accept per-chunk transcripts. Remove `transcribeAudioFromUrl()` and `POST /api/transcribe`. |
| `src/App.tsx` | Replace single transcribe call with chunk orchestrator loop. Add `audioMeta` state, `processChunk()`, `ensureLookahead()`. Wire up `timeupdate` for progressive chunk processing. |
| `src/services/api.ts` | Add `resolveAudio()` and `processAudioChunk()` client functions + types. |
| `src/services/adDetector.ts` | Add `mergeChunkAdSegments()` dedup/merge function. |
| `src/workflows/podcastFlow.ts` | Update step inputs for 5-min chunks. Add `chunkProgress` to `FlowState`. Update `getFlowActivity()` for chunk progress display. |
