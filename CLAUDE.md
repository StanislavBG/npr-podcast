# Project Rules

## bilko-flow Dependency Policy

**bilko-flow** is the workflow orchestration and visualization library for this project. It provides:
- Workflow DSL types (`Workflow`, `Step`, etc.) in `bilko-flow`
- React visualization components (`FlowProgress`, `StepDetail`, `useFlowSSE`) in `bilko-flow/react`

### Rules

1. **Never drop or replace bilko-flow** without first alerting:
   - The user (via conversation)
   - The bilko-flow maintainers at https://github.com/StanislavBG/bilko-flow/issues
   Include the specific pain point so they can address it in a release.

2. **Never write inline replacements** for bilko-flow components (e.g., custom FlowTracker, custom ProgressTracker). Use the library's components directly.

3. **If bilko-flow is missing a feature you need**, file an issue on the repo with a detailed spec (exact types, props, rendering behavior, tests) before implementing a workaround.

4. **Import from the decoupled entry point** when you only need visualization:
   ```typescript
   import { FlowProgress, useFlowSSE } from 'bilko-flow/react/components';
   ```
   Only import from `bilko-flow/react` when you need execution hooks (`useFlowExecution`, `useExecutionStore`).

## Architecture

- The pipeline runs server-side and streams progress via SSE from `/api/sandbox/analyze`
- The frontend consumes SSE events and maps them to bilko-flow's `FlowProgressStep[]` via `useFlowSSE` hook
- Sandbox/View Details is a debug view of a completed pipeline run — it requires a selected episode with results
- The `podcastFlow.ts` file is the single source of truth for step definitions (STEP_ORDER, STEP_META)
