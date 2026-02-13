# Clarified Sandblox Flow: Audio-First Ad Detection

The original flow jumped from episode selection straight to "Fetch Transcript",
skipping the most critical step: **getting the audio**. You need audio before
you can get a transcript. We're not downloading it all at once — we're
**streaming audio ahead of the user** and marking ad locations as we go.

## What Changed

**Old flow (6 steps):**
```
RSS → Parse → Fetch Transcript → LLM Parse → LLM Detect Ads → LLM Prepare Player
```

**New flow (9 steps, with parallelism):**
```
RSS → Parse ─┬─→ Resolve Audio → Stream Chunks → Transcribe → Mark Ads → Build Skip Map ─┬─→ Finalize
             └─→ Fetch HTML Transcript ──────────────────────────────────────────────────────┘
```

The key differences:
1. Audio streaming is now an explicit step, not hidden inside transcript fetch
2. Processing is **chunked and progressive** — ads are detected before the user reaches them
3. HTML transcript runs **in parallel** as a cross-reference, not as the primary source
4. A new ad type `dynamic_ad` catches Megaphone-inserted ads only present in audio

---

## Post-Episode-Selection Steps (3–9)

### Step 3: Resolve Audio Stream
**Type:** `http.request` (HEAD)
**Purpose:** Follow the redirect chain from the RSS enclosure URL to the actual CDN endpoint.

NPR podcast URLs go through multiple redirects:
```
play.podtrac.com/npr-{id}/traffic.megaphone.fm/... → cdn.megaphone.fm/... → final CDN
```

**What it does:**
- Sends HTTP HEAD request following all redirects
- Captures final CDN URL, `Content-Length`, `Content-Type`, `Accept-Ranges`
- Validates the stream is reachable and supports range requests
- Extracts duration from HTTP headers or MP3 frame headers

**Library/Protocol:**
- Standard HTTP HEAD with redirect follow (`fetch()` with `redirect: 'follow'`)
- Parse MP3 MPEG frame header for duration if not in HTTP headers

**Server endpoint:** `GET /api/audio/resolve?url={enclosureUrl}`

**Output:**
```typescript
{
  resolvedUrl: string;        // Final CDN URL after redirects
  contentLength: number;      // Total file size in bytes
  contentType: string;        // "audio/mpeg" typically
  acceptRanges: boolean;      // Whether Range requests are supported
  estimatedDurationSec: number; // From headers or MP3 frame scan
  bitrate: number;            // e.g. 128000 (128kbps)
}
```

---

### Step 4: Stream Audio Chunks
**Type:** `stream.chunk`
**Purpose:** Fetch audio ahead of the listener's playback position using HTTP Range requests.

**How it works:**
- Calculates chunk boundaries: at 128kbps, 30 seconds ≈ 480KB
- Maintains a **lookahead buffer** of 3 chunks (~90 seconds ahead)
- As the user's playback position advances, fetches the next chunk
- Each chunk is routed to two consumers:
  1. **Transcription pipeline** (Step 5) — for ad detection
  2. **Player buffer** — the `<audio>` element plays from the proxy URL

**Library/Protocol:**
- **HTTP Range Requests**: `Range: bytes=0-479999`, `Range: bytes=480000-959999`, etc.
- Server-side: Node.js `stream.pipeline()` or `ReadableStream` with backpressure
- Client-side coordination: tracks `audio.currentTime` and pre-fetches ahead

**Server endpoint:** `GET /api/audio/stream?url={cdnUrl}&start={byteStart}&end={byteEnd}`

**Chunk strategy:**
```typescript
{
  chunkStrategy: 'time-based',    // chunk by audio duration, not arbitrary bytes
  chunkSizeBytes: 480_000,        // ~30s at 128kbps MP3
  lookaheadChunks: 3,             // always stay ~90s ahead of playback
  parallelDownloads: 2,           // fetch 2 chunks concurrently for throughput
}
```

**Note:** The player itself still uses the standard `<audio src="/api/audio?url=...">` proxy
for playback. The chunked streaming is a *separate parallel path* for the ad detection
pipeline — we're analyzing audio faster than the user listens to it.

---

### Step 5: Transcribe Audio Chunks
**Type:** `ai.speech-to-text`
**Purpose:** Convert each audio chunk to timestamped text as it arrives.

**Primary approach — OpenAI Realtime API (WebSocket):**
```
Protocol: wss://api.openai.com/v1/realtime
Model:    gpt-4o-mini-transcribe
Auth:     Bearer token in connection header
```

The Realtime API accepts streaming audio input and returns transcript segments
with word-level timestamps in real-time. This is the lowest-latency option.

- Send: raw PCM or MP3 frames as they arrive from Step 4
- Receive: `transcript.text.delta` events with timestamped words
- Accumulate into segments with `{start, end, text}` per utterance

**Fallback — Chunked Whisper Batch API:**
```
POST https://api.openai.com/v1/audio/transcriptions
Content-Type: multipart/form-data
model: gpt-4o-mini-transcribe
response_format: verbose_json
timestamp_granularities: segment
```

Each 30-second chunk is sent as an independent transcription request.
Timestamps from each chunk are offset by the chunk's position in the
full audio (e.g., chunk 3 starting at 60s → all timestamps += 60).

**Why not Deepgram or AssemblyAI?**
OpenAI is already in the stack (transcription + LLM). Adding another vendor
increases complexity. If latency becomes a bottleneck, Deepgram's streaming
API (`wss://api.deepgram.com/v1/listen`) is the best alternative — it's
purpose-built for real-time transcription and has lower latency than Whisper.

**Output per chunk:**
```typescript
{
  chunkIndex: number;
  offsetSec: number;              // Start time of this chunk in full audio
  segments: Array<{
    start: number;                // Absolute time in seconds
    end: number;
    text: string;
  }>;
  text: string;                   // Concatenated text for this chunk
}
```

---

### Step 6: Mark Ad Locations
**Type:** `ai.generate-text` (chatJSON)
**Purpose:** As transcript segments arrive from each chunk, classify each as content or ad.

This is a **lightweight per-chunk LLM call** — each chunk is ~500 tokens in, ~200 tokens out,
so it completes fast and doesn't block the pipeline.

**Model:** `gpt-4o-mini` via chatJSON (fast, cheap, good enough for classification)

**Prompt:**
```
You are a podcast ad detector analyzing audio transcript segments in real-time.

Episode: "{title}"
Chunk {chunkIndex} of audio (seconds {startSec}–{endSec}):

Segments:
{segments as numbered list with timestamps}

Previous chunk context (last 2 segments):
{trailing context from previous chunk}

Classify EACH segment as one of:
- "content"         – editorial podcast content (interviews, reporting, discussion)
- "sponsor_read"    – host reading a sponsor/advertiser message
- "funding_credit"  – NPR funding acknowledgment ("support comes from...")
- "npr_promo"       – promotion for another NPR show or NPR itself
- "dynamic_ad"      – dynamically inserted advertisement detected by:
                      • abrupt topic change unrelated to episode subject
                      • different speaker not part of the editorial cast
                      • promotional language for a product/service/brand
                      • call-to-action (visit website, use promo code, etc.)

Return JSON:
{
  "classifications": [
    {
      "segmentIndex": number,
      "type": "content" | "sponsor_read" | "funding_credit" | "npr_promo" | "dynamic_ad",
      "confidence": 0.0-1.0,
      "reason": "brief explanation"
    }
  ]
}
```

**Why `dynamic_ad` is new and important:**
NPR uses Megaphone for dynamic ad insertion. These ads exist ONLY in the audio —
the HTML transcript never contains them. The old flow, which prioritized HTML
transcripts, could never detect these. With audio-first processing, we can now
catch them by recognizing the content patterns (topic shifts, promotional language,
different speakers).

**Output per chunk:**
```typescript
{
  chunkIndex: number;
  classifications: Array<{
    segmentIndex: number;
    startTime: number;
    endTime: number;
    type: 'content' | 'sponsor_read' | 'funding_credit' | 'npr_promo' | 'dynamic_ad';
    confidence: number;
    reason: string;
  }>;
}
```

---

### Step 7: Build Skip Map
**Type:** `compute` (pure function, no external calls)
**Purpose:** Merge classified ad segments into a growing skip map for the player.

**Algorithm:**
```
for each classified segment where type != 'content' and confidence >= 0.6:
  1. Check if it's adjacent to an existing ad range (within 2s gap)
     → YES: extend the existing range
     → NO: create a new ad range
  2. Add padding: 0.5s before (catch the transition), 0.3s after (clean exit)
  3. Clamp to audio bounds [0, totalDuration]
  4. Emit updated skip map to player via state callback
```

**Why progressive?**
The player receives skip map updates as they're built. If the user is at second 30
and we've already analyzed through second 120, all ads in that range are known and
will be skipped. No need to wait for the entire file to be processed.

**Output (grows over time):**
```typescript
{
  segments: Array<{
    startTime: number;
    endTime: number;
    type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention';
    confidence: number;
    reason: string;
  }>;
  processedThroughSec: number;    // How far ahead we've analyzed
  totalAdTime: number;            // Running total
  contentDuration: number;        // Duration minus ads so far
}
```

---

### Step 8: Fetch HTML Transcript (Parallel)
**Type:** `http.request`
**Purpose:** Get the NPR editorial transcript for cross-referencing.

This step runs **in parallel** with Steps 4–7. It depends only on Step 2
(episode selection), not on any audio step.

**Why keep it?**
- HTML transcripts have accurate **speaker names** (STT often gets these wrong)
- HTML contains **only editorial content** (no dynamic ads) — useful as a
  ground truth to validate what's really an ad vs. what's editorial content
  that just sounds like an ad
- Fast and cheap (single HTTP GET)

**Server endpoint:** `GET /api/transcript?url={transcriptUrl}`

---

### Step 9: Finalize Playback
**Type:** `ai.summarize` (chatJSON)
**Purpose:** Quality gate. Reconcile audio-detected ads with HTML transcript. Produce final config.

Waits for **both** branches:
- Step 7 (progressive skip map from audio analysis)
- Step 8 (HTML editorial transcript)

**Model:** configurable (full model, not mini — this is the quality gate)

**Prompt:**
```
You are the final quality gate for a podcast ad detection system.

Episode: "{title}"
Description: "{description}"

You have TWO data sources to reconcile:

1. AUDIO-DETECTED AD SEGMENTS (from streaming audio analysis):
{skipMap as JSON — includes dynamic_ad types}

2. HTML EDITORIAL TRANSCRIPT (from NPR website):
{parsed HTML transcript with speakers}

Your tasks:
a) CROSS-REFERENCE: For each audio-detected ad segment, check if the corresponding
   time range overlaps with editorial content in the HTML transcript.
   - If an audio "dynamic_ad" has NO matching editorial content → high confidence, keep it
   - If an audio "dynamic_ad" overlaps editorial content → likely false positive, remove it
   - sponsor_read / funding_credit found in both sources → confirmed, keep with high confidence

b) ENRICH: Add speaker names from the HTML transcript onto the audio segments
   where the HTML has better speaker identification.

c) VALIDATE: Check that skip boundaries don't cut into editorial content.
   Adjust startTime/endTime if needed.

d) SUMMARIZE: Produce a 1-2 sentence episode summary and 3-5 topic tags.

Return JSON:
{
  "summary": "string",
  "topics": ["string"],
  "skipMap": [
    { "startTime": number, "endTime": number, "type": string, "confidence": 0.0-1.0, "reason": string }
  ],
  "contentDuration": number,
  "totalAdTime": number,
  "recommendation": "one-line recommendation for the listener",
  "reconciliation": {
    "audioOnlyAds": number,
    "confirmedAds": number,
    "removedFalsePositives": number
  }
}
```

---

## Data Flow Diagram

```
                          ┌─────────────────────────────────────────────────────────────┐
                          │                    STREAMING PIPELINE                        │
                          │                                                             │
  Episode      Step 3     │  Step 4         Step 5          Step 6        Step 7        │  Step 9
  Selected ──→ Resolve ──→│  Stream ──→ Transcribe ──→ Mark Ads ──→ Build Skip Map ────│──→ Finalize ──→ Player
               Audio      │  Chunks      Chunks          (LLM)       (progressive)     │    Playback
               Stream     │  (Range)     (Whisper/                                      │    (LLM)
                          │               Realtime)                                     │
                          └─────────────────────────────────────────────────────────────┘
                                                                                            ↑
               Step 8                                                                       │
            ──→ Fetch HTML Transcript ──────────────────────────────────────────────────────┘
            (parallel)
```

## Technology Stack per Step

| Step | Protocol/Library | Model/API | Latency Target |
|------|-----------------|-----------|----------------|
| 3 - Resolve | HTTP HEAD + redirect follow | — | < 1s |
| 4 - Stream | HTTP Range requests (`Range: bytes=N-M`) | — | ~2s per chunk |
| 5 - Transcribe | OpenAI Realtime WebSocket **or** Whisper batch API | `gpt-4o-mini-transcribe` | < 5s per chunk |
| 6 - Mark Ads | chatJSON via OpenAI/Claude | `gpt-4o-mini` | < 3s per chunk |
| 7 - Build Map | Pure computation (no network) | — | < 50ms |
| 8 - HTML | HTTP GET | — | < 2s |
| 9 - Finalize | chatJSON via OpenAI/Claude | configurable (full model) | < 10s |

**Total time to first ad detection:** ~10s (resolve + first chunk + transcribe + classify)
**Total time to full skip map:** proportional to audio length, but always ahead of playback

## Key Architecture Decisions

1. **Audio-first, not transcript-first.** The HTML transcript misses dynamic ads.
   Audio transcription captures everything the listener will actually hear.

2. **Streaming, not batch.** The old flow downloaded the entire audio file (5-15MB),
   transcribed it in one blocking call, then processed. The new flow streams chunks
   and processes progressively.

3. **Progressive skip map.** The player gets ad skip ranges as they're detected,
   not after the entire file is analyzed. A 10-minute podcast starts skipping ads
   within ~10 seconds of episode selection.

4. **HTML as cross-reference, not primary.** The HTML transcript is still valuable
   for speaker names and as ground truth for editorial content. But it runs in
   parallel as a secondary signal, not as the main pipeline.

5. **`dynamic_ad` as a new classification.** Megaphone-inserted ads aren't in any
   transcript. Only audio analysis can find them. This was impossible in the old flow
   when using HTML transcripts as the primary source.
