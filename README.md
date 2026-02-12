# NPR Podcast Player

Ad-free listening experience for NPR podcasts, powered by [bilko-flow](https://github.com/StanislavBG/bilko-flow) workflow orchestration.

## Features

- **Podcast Selection** — Choose from The Indicator, Planet Money, Short Wave, Hidden Brain, Up First
- **Automatic Ad Skipping** — Detects and auto-skips pre-roll, mid-roll, and post-roll ads
- **Transcript View** — Fetches and displays NPR transcripts with sponsor mention highlighting
- **bilko-flow Pipeline** — Visual workflow showing the fetch → parse → transcript → detect → play pipeline
- **Ad Detection Strategies**:
  - Transcript-duration analysis (compares transcript word count to audio length)
  - Heuristic fallback for episodes without transcripts

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  RSS Feed   │────▶│  Parse       │────▶│  Fetch         │
│  Proxy      │     │  Episodes    │     │  Transcript    │
└─────────────┘     └──────────────┘     └────────────────┘
                                                │
                                         ┌──────▼──────┐
                                         │  Detect Ad  │
                                         │  Segments   │
                                         └──────┬──────┘
                                                │
                                         ┌──────▼──────┐
                                         │  Player w/  │
                                         │  Auto-Skip  │
                                         └─────────────┘
```

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: Express (proxy for RSS, transcripts, audio)
- **Workflow**: bilko-flow DSL + FlowProgress React component
- **Ad Detection**: Transcript gap analysis + NPR-specific heuristics

## Getting Started

```bash
npm install
npm run dev
```

This starts both:
- Vite dev server on `http://localhost:3000`
- Express API server on `http://localhost:3001`

## How Ad Detection Works

1. Fetch the RSS feed to get episode metadata and audio URLs
2. Fetch the NPR transcript (available at `npr.org/transcripts/{id}`)
3. Count words in transcript and estimate expected speech duration (~155 wpm)
4. Compare to actual audio duration — the difference is estimated ad time
5. Distribute ad time across pre-roll, mid-roll, and post-roll based on NPR patterns
6. During playback, auto-skip detected ad segments
