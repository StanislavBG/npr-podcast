# NPR Podcast Player

## Overview
An ad-free NPR podcast player with automatic ad-skipping, transcript viewing, and bilko-flow workflow visualization. Uses Express backend and React/Vite frontend.

## Project Architecture
- **Frontend**: React + Vite + TailwindCSS (src/)
- **Backend**: Express server (server/index.ts)
- **LLM Integration**: bilko-flow library for AI-powered ad detection and transcript parsing
- **AI Provider**: Replit AI Integrations (OpenAI-compatible, no separate API key needed)

## Key Files
- `server/index.ts` - Express backend with API routes for podcasts, transcripts, LLM processing, and audio proxy
- `src/App.tsx` - Main React application component
- `src/components/` - React UI components
- `vite.config.ts` - Vite configuration (DO NOT EDIT)
- `index.html` - Entry HTML file

## Running the App
- **Development**: The .replit `run` command starts Express on port 5000, serving the pre-built frontend from `dist/`
- **Build**: `npx vite build` builds the frontend into `dist/`
- **Deployment**: CloudRun deployment with health check at `/health`

## API Endpoints
- `GET /health` - Health check
- `GET /api/podcasts` - List available podcasts
- `GET /api/podcast/:id/episodes` - Get episodes for a podcast
- `GET /api/transcript?url=...` - Fetch raw transcript HTML from NPR
- `POST /api/llm/parse-transcript` - LLM-powered transcript parsing
- `POST /api/llm/detect-ads` - LLM-powered ad segment detection
- `POST /api/llm/prepare-playback` - LLM-powered playback configuration
- `GET /api/audio?url=...` - Audio proxy (bypasses CORS)

## LLM Configuration
The app uses Replit AI Integrations as fallback for LLM calls. Environment variables:
- `AI_INTEGRATIONS_OPENAI_API_KEY` - Auto-set by Replit
- `AI_INTEGRATIONS_OPENAI_BASE_URL` - Auto-set by Replit
- Can be overridden with `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`

## Recent Changes
- Wired LLM configuration to use Replit AI Integrations as fallback (no separate API key required)
- Fixed OpenAI adapter to properly construct API endpoint URL from base URL
- Frontend built and served via Express on port 5000
