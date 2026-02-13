# Bilko Flow: LLM-Powered Ad Detection Pipeline

> **NOTE:** This document describes the original 6-step flow.
> See [clarified-flow.md](./clarified-flow.md) for the updated 9-step
> audio-streaming-first architecture.

Every post-episode-selection step uses bilko-flow LLM components (`chatJSON`).
No regex. No word-count heuristics. Three chained LLM calls that actually
understand podcast content.

## Pipeline Overview (Original — Superseded)

```
Step 1: Fetch RSS Feed             (http.request)
Step 2: Parse Episodes             (http.request)
  ── user selects episode ──
Step 3: Fetch Transcript HTML      (http.request)
Step 4: LLM Parse Transcript       (ai.generate-text  →  chatJSON)
Step 5: LLM Detect Ad Segments     (ai.generate-text  →  chatJSON)
Step 6: LLM Prepare Player         (ai.summarize      →  chatJSON)
```

---

## The Ad-Detection Core (Steps 4–6)

### Step 4 — LLM Parse Transcript (`ai.generate-text`)

**Server:** `POST /api/llm/parse-transcript` → `server/index.ts:294-362`
**bilko-flow call:** `chatJSON<LLMTranscriptResult>()`

The raw transcript HTML goes directly to the LLM. No regex extraction.
The LLM is prompted to:

- Extract every paragraph as a `{ speaker, text, isAd, adType }` segment
- Classify each segment: is it editorial content or an ad read / sponsor mention / funding credit / NPR promo?
- Identify all ad mentions with an `adMentions[]` array explaining *why* each was flagged (e.g. "contains sponsor mention for Squarespace", "NPR funding credit")
- Count the number of editorial (non-ad) words as `estimatedContentWords`

**Output:** `LLMTranscriptResult`
```typescript
{
  segments: [{ speaker, text, isAd, adType }],
  fullText: string,
  adMentions: [{ segmentIndex, reason }],
  estimatedContentWords: number
}
```

### Step 5 — LLM Detect Ad Segments (`ai.generate-text`)

**Server:** `POST /api/llm/detect-ads` → `server/index.ts:381-465`
**bilko-flow call:** `chatJSON<LLMAdDetectionResult>()`

The LLM receives:
- Episode title
- Total audio duration (seconds)
- Transcript editorial word count (from Step 4)
- Number of transcript segments
- The ad mentions array with reasons

The prompt gives the LLM context about NPR's ad insertion model:
- Megaphone dynamically inserts ads not present in the transcript
- The transcript-to-audio duration gap indicates total injected ad time
- NPR uses pre-roll / mid-roll / post-roll structure

The LLM produces ad segments with:
- Precise `startTime` / `endTime` in seconds
- `type`: pre-roll, mid-roll, post-roll, or sponsor-mention
- `confidence`: 0.0–1.0
- `reason`: natural-language explanation of why this is an ad

**Output:** `AdDetectionResult`
```typescript
{
  segments: [{ startTime, endTime, type, confidence, reason }],
  totalAdTime: number,
  contentDuration: number,
  strategy: "llm-transcript-analysis"
}
```

### Step 6 — LLM Prepare Player (`ai.summarize`)

**Server:** `POST /api/llm/prepare-playback` → `server/index.ts:478-551`
**bilko-flow call:** `chatJSON<PlaybackConfig>()`

The LLM receives the full transcript + ad detection results and produces:
- 1–2 sentence episode summary
- 3–5 topic tags
- **Validated skip map** — the LLM can adjust confidence scores or remove false positives from Step 5
- A one-line listener recommendation

This step acts as a quality gate: the LLM reviews its own ad detection
and can correct mistakes before handing off to the player.

**Output:** `PlaybackConfig`
```typescript
{
  summary: string,
  topics: [string],
  skipMap: [{ startTime, endTime, type, confidence, reason }],
  contentDuration: number,
  totalAdTime: number,
  recommendation: string
}
```

---

## chatJSON 3-Layer Defense

All three LLM steps use `chatJSON<T>()` from `bilko-flow/src/llm/index.ts`,
which guarantees valid typed JSON output through three layers:

1. **API-level constraint** — For OpenAI/Gemini, sets `response_format: { type: "json_object" }` to constrain the model at the decoding layer
2. **Parse-level repair** — `cleanLLMResponse()` strips markdown fences, finds the outermost JSON, and `repairJSON()` fixes trailing commas and unescaped control chars
3. **Retry-level correction** — On parse failure, appends a corrective instruction and retries with exponential backoff (up to 3 attempts)

---

## Player Handoff

**App.tsx:174-181** — If Step 6 refines the skip map, the player receives
the LLM-verified segments. Otherwise it uses the Step 5 output.

```tsx
if (config.skipMap && config.skipMap.length > 0) {
  setAds({
    segments: config.skipMap,
    totalAdTime: config.totalAdTime,
    contentDuration: config.contentDuration,
    strategy: 'llm-verified',
  });
}
```

**Player.tsx:20-35** — The `timeupdate` listener checks every tick against
the ad segments. If playback enters an ad range, it jumps to `seg.endTime`
and shows a "Skipped pre-roll" toast.

---

## Configuration

Set via environment variables on the server:

| Variable | Default | Description |
|----------|---------|-------------|
| `BILKO_LLM_PROVIDER` | `openai` | LLM provider: `openai`, `claude`, `ollama`, etc. |
| `BILKO_LLM_MODEL` | `gpt-4o-mini` | Model ID |
| `BILKO_LLM_API_KEY` | *(none)* | API key. Without this, the pipeline falls back to basic heuristics. |
| `BILKO_LLM_BASE_URL` | *(provider default)* | Override API endpoint URL |

---

## Key Files

| File | What changed |
|------|-------------|
| `server/index.ts` | Removed regex `parseTranscript()`. Added 3 LLM endpoints using `chatJSON` with registered Claude + OpenAI adapters. |
| `src/workflows/podcastFlow.ts` | Steps 4–6 now use `ai.generate-text` and `ai.summarize` types. |
| `src/services/adDetector.ts` | Removed `detectAdSegments()`, `heuristicDetection()`, `WORDS_PER_MINUTE`. Kept `isInAdSegment()` and `getNextContentTime()` for the player. Added LLM result types. |
| `src/services/api.ts` | Added `llmParseTranscript()`, `llmDetectAds()`, `llmPreparePlayback()`. Renamed `fetchTranscript` to `fetchTranscriptHtml` (raw HTML only). |
| `src/App.tsx` | `pick()` now runs the 3-step LLM pipeline sequentially. Step 6 can refine Step 5's skip map. |
| `src/components/FlowVisualizer.tsx` | Theme updated with `ai.generate-text` and `ai.summarize` step colors. |
| `src/components/TranscriptView.tsx` | Updated to use `LLMTranscriptResult` types with `isAd` flags and `adMention` reasons. |
