# bilko-flow Feedback: Why It Was Dropped and What Would Have Prevented That

## What happened

During the NPR podcast pipeline build, bilko-flow was adopted as the workflow orchestration and visualization layer. Over several iterations the project evolved from a multi-API orchestration model in App.tsx toward a single server-side SSE streaming endpoint (`/api/sandbox/analyze`). At that point I replaced bilko-flow's React visualization components with a 40-line inline `FlowTracker` component and reduced `FlowVisualizer.tsx` to a no-op.

The workflow *definition* in `podcastFlow.ts` still imports bilko-flow types and still formally describes the 9-step DAG. But the execution engine, state management, and visualization are all custom now. bilko-flow is effectively dead weight in the dependency tree.

This was the wrong call. Here's why I made it and what bilko-flow could change so that the next developer doesn't reach the same conclusion.

---

## Why I dropped it

### 1. The React components couldn't consume SSE events natively

The core problem was data flow. The pipeline runs server-side and streams progress via SSE. Each SSE event carries a step ID, a status, and a free-form message string (e.g., `"Transcribing chunk 3/5 — 2.1 MB"`). I needed a visualization component that could accept this shape directly.

bilko-flow's `<FlowProgress>` expects `FlowProgressStep[]` — which is close but not the same. Each step has `id`, `label`, `status`, and an optional `message`. In theory this maps 1:1, but in practice:

- The status enum doesn't match (`'complete'` vs `'done'`; no `'skipped'` state).
- There's no obvious way to push real-time message updates (chunk counts, byte sizes, timing) into the component without reconstructing the full step array on every SSE tick.
- The `FlowExecution` model tracks `durationMs`, `attempts`, `outputSizeBytes`, etc. — all server-side concerns that the SSE events don't carry and the frontend shouldn't need to synthesize.

I ended up writing a `toFlowProgressSteps()` adapter in `podcastFlow.ts` to map between the two worlds. When the adapter became the most brittle part of the code — breaking every time I added a message field or changed a status — I asked myself whether the adapter was worth it, and concluded it wasn't.

**What would have helped:** A lower-level "bring your own state" mode. Something like:

```tsx
<FlowProgress
  steps={mySteps}        // just { id, label, status, message }[]
  statusMap={{            // let me define my own status strings
    pending: 'pending',
    active: 'active',
    done: 'complete',
    error: 'error',
    skipped: 'complete',
  }}
/>
```

Or even simpler — accept a generic `status: string` and let the consumer provide a render function or class map for each status. The current typed enum is too rigid for real-world integrations where the status model is defined by whatever backend you're talking to.

### 2. No streaming/progressive state model

The pipeline sends intermediate results *within* a step. During transcription (step 5), I emit progress like `"Chunk 2/5 transcribed (3.2s)"`. During ad classification (step 6), early partial results arrive before the step is "complete." bilko-flow's execution model is step-granular: a step is idle, running, success, or error. There's no concept of a step that is running and has produced partial output.

The `FlowStepExecution.output` field exists but it's typed as `unknown` and is meant for the final output. There's no `partialOutput` or `progress` field. For a streaming pipeline where the whole point is progressive results, this was a fundamental mismatch.

**What would have helped:** A `progress` field on `FlowStepExecution`:

```typescript
interface FlowStepExecution {
  // ... existing fields ...
  progress?: {
    message?: string;
    percent?: number;
    partialOutput?: unknown;
  };
}
```

And on the React side, a callback or render prop for step progress:

```tsx
<FlowProgress
  steps={steps}
  renderStepDetail={(step) => step.progress?.message}
/>
```

### 3. The execution engine wasn't used at all

bilko-flow includes an execution engine (`ReferenceExecutor`) and in-memory store. The NPR pipeline doesn't use either. Execution is handled by an Express endpoint that manually sequences steps, calls Whisper, calls the LLM, and streams results. The bilko-flow executor wasn't designed for this — it's a reference implementation meant for simpler workflows.

This meant bilko-flow was only being used for two things: (a) the workflow type definition in `podcastFlow.ts` and (b) the `<FlowProgress>` React component. When (b) became more friction than value, the entire library was only providing types — which plain TypeScript interfaces can do without a dependency.

**What would have helped:** This is harder to fix because it's an architectural mismatch. But a "headless" mode where bilko-flow provides *only* the visualization layer (no execution engine, no storage, no audit trail) would make it much lighter to adopt. Something like:

```
npm install bilko-flow         # full framework
npm install bilko-flow/react   # just the React components, zero server-side deps
```

If `bilko-flow/react` were a standalone package with no dependency on the execution engine or storage layer, I would have kept using it. The visualization components are genuinely good — `FlowCanvas` for DAG rendering and `ParallelThreadsSection` for fork-join are things I didn't bother rebuilding and the app is worse for not having them.

### 4. Bundle size pressure

The project had a target of keeping the JS bundle under 200KB. With bilko-flow included, the Tailwind config was scanning all of `node_modules/bilko-flow/src/**/*.tsx` for class names. After removing bilko-flow from the render path, the bundle dropped from 241KB to 194KB. That 47KB difference was entirely bilko-flow's React component CSS being included even though the components weren't rendered.

**What would have helped:** Ship pre-built CSS or use CSS modules / CSS-in-JS scoped to actual component usage rather than requiring Tailwind to scan the library's source files.

---

## What bilko-flow got right

To be clear — the library has real strengths that my 40-line replacement doesn't match:

1. **Typed workflow DSL.** The formal step definition with `dependsOn`, `StepType`, `DeterminismGrade`, and `StepPolicy` is genuinely useful for documenting and validating the pipeline. I kept `podcastFlow.ts` because it's the best documentation of the pipeline's architecture.

2. **DAG visualization.** `FlowCanvas` can render the actual dependency graph. My replacement is a flat vertical list that doesn't show that step 8 (HTML transcript) runs in parallel with steps 4-7. That's a real loss of information.

3. **Step detail panel.** `StepDetail` shows input/output, timing, retry counts. My replacement just has a one-line message per step. For debugging, bilko-flow's version is far superior.

4. **Parallel thread visualization.** `ParallelThreadsSection` is something I'd need to build from scratch if the pipeline adds more parallel branches.

5. **Determinism tracking.** Knowing that a step is `BestEffort` (calls external LLM API) vs `Pure` (local compute) is valuable metadata. I just don't render it.

---

## Concrete enhancement recommendations

### Priority 1: Decouple the React package

Ship `bilko-flow/react` as a standalone package (or at least a tree-shakeable entry point) that doesn't pull in the execution engine, storage, planner, or audit modules. The React components should depend only on the domain types.

### Priority 2: Accept generic status strings

Change `FlowProgressStep.status` from a closed enum to `string`, with built-in styling for known values (`pending`, `active`, `complete`, `error`) and a fallback/customization API for anything else. Real-world integrations always have status models that don't match exactly.

### Priority 3: Add a step progress/message channel

Add a `message?: string` or `progress?: { message: string; percent?: number }` to `FlowProgressStep` and render it inline in the visualization. Every real pipeline has sub-step progress ("chunk 3/5", "calling LLM...") and there's currently no place to put it.

### Priority 4: Support SSE/EventSource as a first-class data source

Provide a React hook like:

```tsx
const { steps, status } = useFlowSSE('/api/pipeline/stream', {
  stepEvent: 'progress',
  completeEvent: 'complete',
  errorEvent: 'error',
  mapEvent: (event) => ({ id: event.step, status: event.status, message: event.message }),
});

<FlowProgress steps={steps} status={status} />
```

Server-sent events are the natural transport for streaming pipelines. If bilko-flow had a hook that consumed an SSE stream and produced `FlowProgressStep[]`, I never would have needed to write my own state management or visualization.

### Priority 5: Smaller CSS footprint

Either ship pre-built CSS that can be imported directly, or scope styles so that Tailwind doesn't need to scan the library's entire source tree. The current approach (`@source "../../node_modules/bilko-flow/src/**/*.tsx"`) pulls in classes for every component even if only one is used.

---

## Summary

bilko-flow was dropped not because it's a bad library, but because it was designed for a different integration pattern. It assumes the host app will use bilko-flow's execution engine and feed results into bilko-flow's state model, which then drives the React components. When the execution happens elsewhere (a streaming Express endpoint) and the state arrives via SSE, the library becomes an awkward adapter layer rather than a helpful abstraction.

The fixes above — especially decoupled React package, generic status strings, and SSE support — would have kept bilko-flow in this project. The visualization components are genuinely better than what replaced them.
