# Bilko Flow: Post-Episode-Selection Pipeline

The bilko flow is a 5-step linear pipeline defined in `src/workflows/podcastFlow.ts`.
Steps 1–2 run at podcast load time. Steps 3–5 fire when the user selects an episode,
orchestrated by the `pick` callback in `src/App.tsx:96-148`.

## Pipeline Overview

```
Step 1: Fetch RSS Feed        (podcast load)
Step 2: Parse Episodes         (podcast load)
  ── user selects episode ──
Step 3: Fetch Transcript       (episode-level)
Step 4: Detect Ad Segments     (episode-level)
Step 5: Prepare Player         (episode-level, handoff)
```

---

## Step 3 — Fetch Transcript

**Goal:** Retrieve the NPR transcript HTML for the selected episode and extract
structured text with ad-pattern annotations.

**Trigger:** `App.tsx:121-130` — calls `fetchTranscript(ep.transcriptUrl)` when a
transcript URL exists. If no URL is available the step is marked `skipped`.

**Server-side handler:** `server/index.ts:142-166` — proxies the request to
`npr.org/transcripts/{storyId}` with a browser User-Agent.

### Transcript Parsing (`server/index.ts:211-294`)

Three phases:

1. **HTML extraction** (lines 224–234)
   Searches for content inside `<div class="storytext">`, then
   `<article class="transcript">`, then any `<article>` tag, in priority order.

2. **Paragraph extraction** (lines 237–250)
   Iterates `<p>` tags, strips HTML tags, decodes entities (`&amp;`, `&lt;`,
   `&nbsp;`, etc.) to produce clean text paragraphs.

3. **Speaker parsing** (lines 253–264)
   Each paragraph is matched against `/^([A-Z][A-Z\s.'-]+):(.*)/` — the standard
   NPR transcript convention of `SPEAKER NAME: spoken text`. Produces
   `{ speaker, text }` segment objects.

### Ad-Text Pattern Detection (lines 267–287)

Every transcript segment is tested against seven regex patterns that identify
sponsor/funding language:

```
/\b(support|supported|sponsor|sponsored)\s+(by|for|comes?\s+from)\b/i
/\bnpr\.org\b/i
/\bthis is npr\b/i
/\bthis message comes from\b/i
/\bsupport for (this|the) (podcast|show|program)\b/i
/\bfunding for\b/i
/\bnpr\+?\s*(plus)?\b.*\bsponsor.?free\b/i
```

Matches produce `adMarker` entries of type `sponsor_mention` keyed to the segment
index. The function returns:

```typescript
{ segments, fullText, adMarkers }
```

The `fullText` (joined paragraphs) feeds downstream — specifically its **word count**
(`App.tsx:125`).

---

## Step 4 — Detect Ad Segments

**Goal:** Compare transcript word count against audio duration to estimate where
dynamically-injected ads sit, and produce time-range boundaries for skipping.

**Trigger:** `App.tsx:136-139` — calls `detectAdSegments(durationSec, wordCount, hasTranscript)`.

**Core algorithm:** `src/services/adDetector.ts:37-111`

### Key Insight

NPR transcripts contain **only editorial content** — no ad copy. Megaphone
dynamically injects ads into the audio file. The transcript word count therefore
represents content-only time, while the audio duration includes content + ads.

### Primary Path (transcript available)

1. **Expected content duration** (line 50):
   ```
   expectedContentSeconds = (wordCount / 155) * 60
   ```
   155 WPM is the calibrated NPR host speaking rate.

2. **Estimate total ad time** (line 51):
   ```
   adTimeEstimate = max(0, audioDuration - expectedContentSeconds)
   ```

3. **If difference < 15 seconds** (line 54): No meaningful ads — return empty segments.

4. **Distribute ad time across NPR's known structure** (lines 68–101):

   | Segment    | Duration                          | Position                      | Confidence |
   |------------|-----------------------------------|-------------------------------|------------|
   | Pre-roll   | `min(45s, 30% of adTimeEstimate)` | `0s`                          | 0.85       |
   | Mid-roll   | `min(90s, 50% of adTimeEstimate)` | `48%` of episode duration     | 0.75       |
   | Post-roll  | `min(20s, 20% of adTimeEstimate)` | `duration - postRollDuration` | 0.70       |

### Fallback Path (no transcript) — `adDetector.ts:113-153`

Fixed heuristic values:

| Segment    | Duration | Position           | Confidence |
|------------|----------|--------------------|------------|
| Pre-roll   | 30s      | `0s`               | 0.6        |
| Mid-roll   | 60s      | `48%` of duration  | 0.5        |
| Post-roll  | 15s      | `duration - 15s`   | 0.5        |

### Output (`AdDetectionResult`)

```typescript
{
  segments: AdSegment[],      // [{startTime, endTime, type, confidence}]
  totalAdTime: number,
  contentDuration: number,    // audioDuration - totalAdTime
  strategy: string            // 'transcript-duration-analysis' | 'heuristic-only' | 'transcript-match-clean'
}
```

---

## Step 5 — Prepare Player (Handoff)

**Goal:** Pass the ad detection result to the Player component for real-time
auto-skipping.

**Trigger:** `App.tsx:141-147` — marks the flow as completed, clears `currentStep`.

**The handoff** is a React prop at `App.tsx:170`:

```tsx
<Player episode={episode} adDetection={ads} />
```

The `ads` state variable (set at line 138) carries the full `AdDetectionResult`
directly into the Player.

---

## Player Auto-Skip

**Implementation:** `src/components/Player.tsx:20-35`

The Player registers a `timeupdate` listener on the `<audio>` element. On every tick:

1. **Check** if `audio.currentTime` falls inside any ad segment via
   `isInAdSegment()` (`adDetector.ts:156-166`) — linear scan of the segments array.

2. **If inside an ad:** Set `audio.currentTime = seg.endTime` via
   `getNextContentTime()` (`adDetector.ts:169-179`), jumping playback past the ad.

3. **Notify** the user with a 2-second toast: `"Skipped pre-roll"`,
   `"Skipped mid-roll"`, etc. (`Player.tsx:29-30`).

### Visual Markers (`Player.tsx:97-108`)

Each ad segment renders as a colored overlay on the progress bar, positioned by
`startTime / duration` and sized by `(endTime - startTime) / duration`, with a
tooltip showing type, time range, and confidence percentage.

---

## Complete Data Flow

```
Episode selected
  │
  ├─ App.tsx:pick()
  │    ├─ parse duration string → durationSec
  │    │
  │    ├─ Step 3: fetchTranscript(url)
  │    │    └─ server: fetch HTML → parseTranscript()
  │    │         ├─ extract <p> tags from storytext/article
  │    │         ├─ parse "SPEAKER: text" segments
  │    │         ├─ test 7 ad-text regexes → adMarkers[]
  │    │         └─ return { segments, fullText, adMarkers }
  │    │    └─ wordCount = fullText.split(/\s+/).length
  │    │
  │    ├─ Step 4: detectAdSegments(durationSec, wordCount, hasTranscript)
  │    │    ├─ expectedContent = (wordCount / 155) * 60
  │    │    ├─ adTime = audioDuration - expectedContent
  │    │    └─ distribute into pre/mid/post-roll with time ranges
  │    │
  │    └─ Step 5: setAds(adResult) → props to <Player>
  │
  └─ Player.tsx
       ├─ timeupdate listener: isInAdSegment(time) → jump to endTime
       └─ progress bar: render ad-marker divs at segment positions
```
