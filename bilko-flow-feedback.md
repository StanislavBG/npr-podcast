# bilko-flow Feedback: Why It Was Dropped and What Would Have Prevented That

## What happened

During the NPR podcast pipeline build, bilko-flow was adopted as the workflow orchestration and visualization layer. Over several iterations the project evolved from a multi-API orchestration model in App.tsx toward a single server-side SSE streaming endpoint (`/api/sandbox/analyze`). At that point I replaced bilko-flow's React visualization components with a 40-line inline `FlowTracker` component and reduced `FlowVisualizer.tsx` to a no-op.

The workflow *definition* in `podcastFlow.ts` still imports bilko-flow types and still formally describes the 9-step DAG. But the execution engine, state management, and visualization are all custom now. bilko-flow is effectively dead weight in the dependency tree.

This was the wrong call. Here's why I made it and what bilko-flow could change so that the next developer doesn't reach the same conclusion.

---

## Why I dropped it

### 1. The React components couldn't consume SSE events natively

The core problem was data flow. The pipeline runs server-side and streams progress via SSE. Each SSE event carries a step ID, a status, and a free-form message string (e.g., `"Transcribing chunk 3/5 — 2.1 MB"`). I needed a visualization component that could accept this shape directly.

bilko-flow's `<FlowProgress>` expects `FlowProgressStep[]` — which is close but not the same. Each step has `id`, `label`, `status`, and an optional `type`. In theory this maps 1:1, but in practice:

- The status enum doesn't match (`'complete'` vs my `'done'`; no `'skipped'` state).
- There's no `message` field on `FlowProgressStep` — the only text channel is `activity` on the parent `FlowProgressProps`, which is flow-wide, not per-step.
- The `FlowExecution` model tracks `durationMs`, `attempts`, `outputSizeBytes`, etc. — all server-side concerns that the SSE events don't carry and the frontend shouldn't need to synthesize.

I ended up writing a `toFlowProgressSteps()` adapter in `podcastFlow.ts` to map between the two worlds. When the adapter became the most brittle part of the code — breaking every time I added a message field or changed a status — I asked myself whether the adapter was worth it, and concluded it wasn't.

### 2. No streaming/progressive state model

The pipeline sends intermediate results *within* a step. During transcription (step 5), I emit progress like `"Chunk 2/5 transcribed (3.2s)"`. During ad classification (step 6), early partial results arrive before the step is "complete." bilko-flow's execution model is step-granular: a step is idle, running, success, or error. There's no concept of a step that is running and has produced partial output.

The `FlowStepExecution.output` field exists but it's typed as `unknown` and is meant for the final output. There's no `partialOutput` or `progress` field. For a streaming pipeline where the whole point is progressive results, this was a fundamental mismatch.

### 3. The execution engine wasn't used at all

bilko-flow includes an execution engine (`ReferenceExecutor`) and in-memory store. The NPR pipeline doesn't use either. Execution is handled by an Express endpoint that manually sequences steps, calls Whisper, calls the LLM, and streams results. The bilko-flow executor wasn't designed for this — it's a reference implementation meant for simpler workflows.

This meant bilko-flow was only being used for two things: (a) the workflow type definition in `podcastFlow.ts` and (b) the `<FlowProgress>` React component. When (b) became more friction than value, the entire library was only providing types — which plain TypeScript interfaces can do without a dependency.

### 4. Bundle size pressure

The project had a target of keeping the JS bundle under 200KB. With bilko-flow included, the Tailwind config was scanning all of `node_modules/bilko-flow/src/**/*.tsx` for class names. After removing bilko-flow from the render path, the bundle dropped from 241KB to 194KB. That 47KB difference was entirely bilko-flow's React component CSS being included even though the components weren't rendered.

---

## What bilko-flow got right

To be clear — the library has real strengths that my 40-line replacement doesn't match:

1. **Typed workflow DSL.** The formal step definition with `dependsOn`, `StepType`, `DeterminismGrade`, and `StepPolicy` is genuinely useful for documenting and validating the pipeline. I kept `podcastFlow.ts` because it's the best documentation of the pipeline's architecture.

2. **DAG visualization.** `FlowCanvas` can render the actual dependency graph. My replacement is a flat vertical list that doesn't show that step 8 (HTML transcript) runs in parallel with steps 4-7. That's a real loss of information.

3. **Step detail panel.** `StepDetail` shows input/output, timing, retry counts. My replacement just has a one-line message per step. For debugging, bilko-flow's version is far superior.

4. **Parallel thread visualization.** `ParallelThreadsSection` is something I'd need to build from scratch if the pipeline adds more parallel branches.

5. **Determinism tracking.** Knowing that a step is `BestEffort` (calls external LLM API) vs `Pure` (local compute) is valuable metadata. I just don't render it.

---

## Enhancement 1: Add `message` field to `FlowProgressStep`

### Problem

`FlowProgressStep` (defined in `src/react/types.ts` lines 94–101) has 4 fields: `id`, `label`, `status`, `type`. There is no field for a per-step status message. The only text channel is the `activity` prop on `FlowProgressProps`, which is a single string for the entire flow — not per step.

Real pipelines produce per-step messages constantly: `"Transcribing chunk 3/5 — 2.1 MB"`, `"3 ad blocks found"`, `"Fetching https://..."`. Without a place to put these, the consumer has to either (a) cram them into `label` (ugly, label should be static) or (b) ignore them.

### Files to modify

**`src/react/types.ts`** — Add `message` to the interface:

```typescript
// BEFORE (lines 94–101):
interface FlowProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'complete' | 'error';
  type?: string;
}

// AFTER:
interface FlowProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'complete' | 'error';
  type?: string;
  /** Optional real-time status message shown below or beside the step label.
   *  Updates frequently during 'active' state (e.g., "Chunk 3/5 — 2.1 MB").
   *  Preserved after completion (e.g., "3 ad blocks found"). */
  message?: string;
}
```

**`src/react/flow-progress.tsx`** — Render the message in each mode:

In **FullMode** (around line 270, inside the step circle rendering loop), after the step label `<span>`:

```tsx
// Add after the label span, inside the per-step column div:
{step.message && step.status !== 'pending' && (
  <span className="text-[10px] text-gray-400 truncate max-w-[120px] block text-center mt-0.5">
    {step.message}
  </span>
)}
```

In **ExpandedMode** (around line 650, inside each step card), after the step label:

```tsx
// Add inside the step card div, after the label/type row:
{step.message && step.status !== 'pending' && (
  <span className="text-[10px] text-gray-400 truncate block mt-0.5">
    {step.message}
  </span>
)}
```

In **CompactMode** (around line 470), the message for the active step should replace or augment the `activity` line:

```tsx
// In the compact mode footer, prefer per-step message over flow-wide activity:
const activeStep = visibleSteps.find(s => s.status === 'active');
const activityText = activeStep?.message || activity;
{activityText && (
  <p className="text-xs text-gray-400 mt-1 truncate">{activityText}</p>
)}
```

In **FlowProgressVertical** (`src/react/flow-progress-vertical.tsx`), after the step label in each row:

```tsx
{step.message && step.status !== 'pending' && (
  <span className="text-[10px] text-gray-500 block mt-0.5 truncate max-w-[180px]">
    {step.message}
  </span>
)}
```

### Tests to add

In the existing test file for FlowProgress (or create `src/react/__tests__/flow-progress-message.test.tsx`):

```typescript
it('renders step message when provided and status is not pending', () => {
  const { container } = render(
    <FlowProgress
      mode="expanded"
      steps={[
        { id: '1', label: 'Fetch', status: 'active', message: 'Loading chunk 3/5' },
        { id: '2', label: 'Parse', status: 'pending', message: 'Should not render' },
      ]}
      status="running"
    />
  );
  expect(container.textContent).toContain('Loading chunk 3/5');
  expect(container.textContent).not.toContain('Should not render');
});

it('preserves message after step completes', () => {
  const { container } = render(
    <FlowProgress
      mode="expanded"
      steps={[
        { id: '1', label: 'Fetch', status: 'complete', message: '42 items found' },
      ]}
      status="complete"
    />
  );
  expect(container.textContent).toContain('42 items found');
});
```

### Acceptance criteria

- `message` is optional and backward-compatible (existing consumers with no `message` are unaffected)
- Message renders in all 4 modes (full, expanded, compact, vertical) when `status !== 'pending'`
- Message truncates with ellipsis when wider than its container
- Message uses `text-gray-400` or `text-gray-500` — subdued, not competing with the label

---

## Enhancement 2: Add `skipped` status

### Problem

`FlowProgressStep.status` is a closed union: `'pending' | 'active' | 'complete' | 'error'`. Real pipelines have a 5th state: `skipped` — a step that was not executed because a condition wasn't met or a dependency made it unnecessary. The NPR pipeline uses this for step 8 (HTML transcript) when no transcript URL is available.

Without `skipped`, the consumer must map it to either `complete` (misleading — it didn't run) or `pending` (misleading — it won't run). Both are wrong.

### Files to modify

**`src/react/types.ts`** — Extend the status union:

```typescript
// BEFORE:
status: 'pending' | 'active' | 'complete' | 'error';

// AFTER:
status: 'pending' | 'active' | 'complete' | 'error' | 'skipped';
```

**`src/react/step-type-config.ts`** — Add skipped to the theme and visual config:

```typescript
// In DEFAULT_FLOW_PROGRESS_THEME, add:
skippedColor: 'bg-gray-600',
skippedTextColor: 'text-gray-500',
```

Update `FlowProgressTheme` in `src/react/types.ts` accordingly:

```typescript
// Add to FlowProgressTheme interface:
skippedColor: string;
skippedTextColor: string;
```

**`src/react/flow-progress.tsx`** — Handle `skipped` in icon/color resolution:

In the `getStatusIcon` or equivalent logic within each mode (FullMode, ExpandedMode, CompactMode), add the skipped case. The pattern is consistent across modes — search for the switch/if on `step.status`:

```typescript
// Wherever status icons are resolved (appears ~4 times across modes):
// Add this case alongside the existing 'complete', 'active', 'error', 'pending' cases:

// For icon: use MinusCircle from lucide-react (or a dash)
case 'skipped':
  icon = <MinusCircle className="w-4 h-4 text-gray-500" />;
  break;

// For circle fill color (FullMode numbered circles):
case 'skipped':
  fillClass = theme.skippedColor;  // 'bg-gray-600'
  break;

// For opacity/text treatment:
case 'skipped':
  textClass = theme.skippedTextColor;  // 'text-gray-500'
  opacity = 'opacity-50';
  break;
```

In `flow-progress-shared.ts`, if there's a `getStatusColor` utility, add:

```typescript
case 'skipped': return theme.skippedColor;
```

**`src/react/flow-progress-vertical.tsx`** — Same pattern, add `skipped` to the status-to-icon mapping.

**`src/react/parallel-threads.tsx`** — If thread status resolution checks step statuses, ensure `skipped` is treated like `complete` for thread-level rollup (a thread with all steps complete or skipped is a complete thread).

### Import addition

Add `MinusCircle` to the lucide-react import in `flow-progress.tsx`:

```typescript
// Find the existing lucide-react import (near top of file), add MinusCircle:
import { CheckCircle2, Loader2, AlertCircle, Circle, MinusCircle, ... } from 'lucide-react';
```

### Tests to add

```typescript
it('renders skipped step with MinusCircle icon and reduced opacity', () => {
  const { container } = render(
    <FlowProgress
      mode="expanded"
      steps={[
        { id: '1', label: 'Fetch', status: 'complete' },
        { id: '2', label: 'Optional', status: 'skipped' },
        { id: '3', label: 'Done', status: 'complete' },
      ]}
      status="complete"
    />
  );
  // Skipped step should be visually dimmed
  const skippedStep = container.querySelector('[class*="opacity"]');
  expect(skippedStep).toBeTruthy();
});

it('counts skipped steps as done for progress calculation', () => {
  // The progress bar should show 100% when all steps are complete or skipped
  const { container } = render(
    <FlowProgress
      mode="full"
      steps={[
        { id: '1', label: 'A', status: 'complete' },
        { id: '2', label: 'B', status: 'skipped' },
      ]}
      status="complete"
    />
  );
  // Progress bar should be fully filled
  const bar = container.querySelector('[style*="width"]');
  expect(bar?.getAttribute('style')).toContain('100%');
});
```

### Acceptance criteria

- `skipped` is a valid status value (TypeScript compiles without error)
- Skipped steps render with a distinct visual (MinusCircle icon, gray, ~50% opacity)
- Skipped steps count as "done" for progress bar percentage and flow-level status rollup
- Existing consumers passing only the original 4 statuses are unaffected (backward-compatible)

---

## Enhancement 3: Support custom status mapping via `statusMap` prop

### Problem

Even with `skipped` added, real-world integrations often have their own status vocabulary. The NPR pipeline uses `done` instead of `complete`. Other systems might use `running` instead of `active`, `failed` instead of `error`, `queued` instead of `pending`. Forcing every consumer to map their status strings to bilko-flow's enum is friction that leads to dropping the library.

### Files to modify

**`src/react/types.ts`** — Add the `statusMap` type and update `FlowProgressProps`:

```typescript
/** Maps consumer status strings to bilko-flow's internal statuses.
 *  Keys are the consumer's status values. Values are bilko-flow visual treatments. */
export type StatusMap = Record<string, 'pending' | 'active' | 'complete' | 'error' | 'skipped'>;

// In FlowProgressProps, add:
interface FlowProgressProps {
  // ... all existing props ...

  /** Maps custom status strings to built-in visual treatments.
   *  Example: { done: 'complete', running: 'active', queued: 'pending' }
   *  When provided, step.status values are first looked up in this map
   *  before applying styling. Unknown statuses fall back to 'pending'. */
  statusMap?: StatusMap;
}
```

**`src/react/flow-progress.tsx`** — Resolve status through the map:

Near the top of the `FlowProgress` component function, after props destructuring, add a resolution helper:

```typescript
export function FlowProgress(props: FlowProgressProps) {
  const { steps, statusMap, mode, ...rest } = props;

  // Resolve custom statuses to internal ones
  const resolvedSteps: FlowProgressStep[] = statusMap
    ? steps.map(s => ({
        ...s,
        status: statusMap[s.status] ?? (s.status as FlowProgressStep['status']),
      }))
    : steps;

  // Pass resolvedSteps to all sub-renderers instead of steps
  // ...
}
```

Then replace every reference to `steps` inside the component with `resolvedSteps`. The sub-components (FullMode, ExpandedMode, CompactMode) receive `resolvedSteps`.

**Important**: The `FlowProgressStep.status` type must be loosened to `string` in the interface to allow consumers to pass custom strings:

```typescript
// In FlowProgressStep:
interface FlowProgressStep {
  id: string;
  label: string;
  /** Status string. Use built-in values ('pending', 'active', 'complete', 'error', 'skipped')
   *  or custom values with a statusMap on FlowProgressProps. */
  status: string;
  type?: string;
  message?: string;
}
```

The internal resolution ensures the rendering code always works with known statuses.

**`src/react/flow-progress-vertical.tsx`** — Apply the same resolution. If this component accepts props separately, thread `statusMap` through. If it receives pre-resolved steps from the parent, no change needed.

### Tests to add

```typescript
it('maps custom status strings via statusMap', () => {
  const { container } = render(
    <FlowProgress
      mode="expanded"
      steps={[
        { id: '1', label: 'Step 1', status: 'done' },      // custom
        { id: '2', label: 'Step 2', status: 'running' },    // custom
        { id: '3', label: 'Step 3', status: 'waiting' },    // custom
      ]}
      statusMap={{
        done: 'complete',
        running: 'active',
        waiting: 'pending',
      }}
      status="running"
    />
  );
  // Step 1 should render as complete (green check)
  // Step 2 should render as active (spinning loader)
  // Step 3 should render as pending (gray circle)
});

it('falls back to raw status if not in statusMap', () => {
  const { container } = render(
    <FlowProgress
      mode="expanded"
      steps={[
        { id: '1', label: 'Step 1', status: 'active' },  // known, not in map
        { id: '2', label: 'Step 2', status: 'unknown_thing' },  // unknown
      ]}
      statusMap={{ done: 'complete' }}
      status="running"
    />
  );
  // 'active' should render as active (it's a known built-in)
  // 'unknown_thing' should fall back to 'pending' (safe default)
});
```

### Acceptance criteria

- `statusMap` is optional; omitting it preserves existing behavior exactly
- Custom status strings are resolved before any icon/color/opacity logic
- Unknown statuses (not in map and not built-in) default to `'pending'`
- TypeScript consumers can pass `status: string` without a type error

---

## Enhancement 4: Add `useFlowSSE` hook

### Problem

The most common real-world pattern for consuming a bilko-flow visualization is: (1) a server emits SSE events with step status updates, (2) the frontend parses them into `FlowProgressStep[]`, (3) the array is passed to `<FlowProgress>`. Every consumer writes the same boilerplate: create an `EventSource`, parse JSON, maintain a `Map<string, FlowProgressStep>`, and update state on each event. This should be a provided hook.

### Files to create

**`src/react/use-flow-sse.ts`** — New file:

```typescript
import { useState, useEffect, useRef, useCallback } from 'react';
import type { FlowProgressStep } from './types';

export interface UseFlowSSEOptions {
  /** The SSE endpoint URL. Pass null/undefined to disable connection. */
  url: string | null | undefined;

  /** SSE event name that carries step updates. Default: 'progress'. */
  stepEvent?: string;

  /** SSE event name that signals flow completion. Default: 'complete'. */
  completeEvent?: string;

  /** SSE event name that signals flow error. Default: 'error'. */
  errorEvent?: string;

  /** Map a raw parsed SSE payload to a FlowProgressStep update.
   *  Must return at minimum { id, status }. Fields not returned are
   *  preserved from the previous state for that step ID. */
  mapEvent: (parsed: any) => Partial<FlowProgressStep> & { id: string };

  /** Initial steps array (e.g., all steps in 'pending' status).
   *  If not provided, steps are created on first event. */
  initialSteps?: FlowProgressStep[];

  /** Called when the complete event fires. Receives the parsed payload. */
  onComplete?: (parsed: any) => void;

  /** Called when the error event fires. Receives the parsed payload. */
  onError?: (parsed: any) => void;

  /** Optional: additional SSE event names to listen for, with handlers. */
  customEvents?: Record<string, (parsed: any) => void>;
}

export interface UseFlowSSEReturn {
  /** Current step array, suitable for passing to <FlowProgress steps={...} /> */
  steps: FlowProgressStep[];

  /** Overall flow status derived from step statuses. */
  status: 'idle' | 'running' | 'complete' | 'error';

  /** True while the EventSource connection is open. */
  connected: boolean;

  /** Error message if the SSE connection or a flow error occurred. */
  error: string | null;

  /** Manually close the SSE connection. */
  close: () => void;

  /** Reset to initial state and reconnect. */
  reset: () => void;
}

export function useFlowSSE(options: UseFlowSSEOptions): UseFlowSSEReturn {
  const {
    url,
    stepEvent = 'progress',
    completeEvent = 'complete',
    errorEvent = 'error',
    mapEvent,
    initialSteps,
    onComplete,
    onError,
    customEvents,
  } = options;

  const [stepMap, setStepMap] = useState<Map<string, FlowProgressStep>>(
    () => new Map((initialSteps ?? []).map(s => [s.id, s]))
  );
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Store latest callbacks in refs to avoid re-creating EventSource on every render
  const mapEventRef = useRef(mapEvent);
  mapEventRef.current = mapEvent;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const close = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
  }, []);

  const reset = useCallback(() => {
    close();
    setStepMap(new Map((initialSteps ?? []).map(s => [s.id, s])));
    setStatus('idle');
    setError(null);
  }, [close, initialSteps]);

  useEffect(() => {
    if (!url) return;

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setStatus('running');
    };

    es.onerror = () => {
      // EventSource auto-reconnects on network errors.
      // Only set error if the connection is fully closed.
      if (es.readyState === EventSource.CLOSED) {
        setConnected(false);
        setError('SSE connection closed');
      }
    };

    // Step progress events
    es.addEventListener(stepEvent, (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data);
        const update = mapEventRef.current(parsed);
        setStepMap(prev => {
          const next = new Map(prev);
          const existing = next.get(update.id);
          next.set(update.id, { ...existing, ...update } as FlowProgressStep);
          return next;
        });
      } catch { /* ignore malformed events */ }
    });

    // Complete event
    es.addEventListener(completeEvent, (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data);
        setStatus('complete');
        onCompleteRef.current?.(parsed);
      } catch { /* ignore */ }
      es.close();
      setConnected(false);
    });

    // Error event (flow-level, not connection-level)
    es.addEventListener(errorEvent, (e: MessageEvent) => {
      try {
        const parsed = JSON.parse(e.data);
        setStatus('error');
        setError(parsed.message || parsed.error || 'Flow error');
        onErrorRef.current?.(parsed);
      } catch { /* ignore */ }
      es.close();
      setConnected(false);
    });

    // Custom event listeners
    if (customEvents) {
      for (const [eventName, handler] of Object.entries(customEvents)) {
        es.addEventListener(eventName, (e: MessageEvent) => {
          try { handler(JSON.parse(e.data)); } catch { /* ignore */ }
        });
      }
    }

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [url, stepEvent, completeEvent, errorEvent]);
  // Note: customEvents intentionally excluded from deps — use refs if it needs to be dynamic.

  // Derive steps array from map (stable order: initialSteps order, then insertion order for new)
  const steps: FlowProgressStep[] = Array.from(stepMap.values());

  return { steps, status, connected, error, close, reset };
}
```

**`src/react/index.ts`** — Add the export:

```typescript
// Add alongside the existing hook exports:
export { useFlowSSE } from './use-flow-sse';
export type { UseFlowSSEOptions, UseFlowSSEReturn } from './use-flow-sse';
```

### Consumer usage example (what the NPR app would look like)

```tsx
import { FlowProgress, useFlowSSE } from 'bilko-flow/react';

function PipelineView({ episodeUrl }: { episodeUrl: string }) {
  const { steps, status } = useFlowSSE({
    url: episodeUrl ? `/api/sandbox/analyze?url=${encodeURIComponent(episodeUrl)}` : null,
    stepEvent: 'progress',
    completeEvent: 'complete',
    errorEvent: 'error',
    initialSteps: STEP_ORDER.map(id => ({
      id,
      label: STEP_META[id].label,
      status: 'pending',
      type: STEP_META[id].type,
    })),
    mapEvent: (evt) => ({
      id: evt.step,
      status: evt.status === 'done' ? 'complete' : evt.status,
      message: evt.message,
    }),
    customEvents: {
      partial_ads: (evt) => handlePartialAds(evt),
    },
  });

  return <FlowProgress mode="expanded" steps={steps} status={status} />;
}
```

This replaces approximately 80 lines of manual SSE parsing + state management that the NPR app currently has in `api.ts` and `App.tsx`.

### Tests to add

Create `src/react/__tests__/use-flow-sse.test.ts`:

```typescript
import { renderHook, act } from '@testing-library/react';
import { useFlowSSE } from '../use-flow-sse';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }, 0);
  }

  addEventListener(event: string, handler: (e: MessageEvent) => void) {
    (this.listeners[event] ??= []).push(handler);
  }

  close() { this.readyState = 2; }

  // Test helper: simulate an SSE event
  emit(event: string, data: any) {
    for (const h of this.listeners[event] ?? []) {
      h(new MessageEvent(event, { data: JSON.stringify(data) }));
    }
  }
}

beforeAll(() => { (global as any).EventSource = MockEventSource; });
afterEach(() => { MockEventSource.instances = []; });

it('connects and parses step events', async () => {
  const { result } = renderHook(() =>
    useFlowSSE({
      url: '/api/test',
      mapEvent: (e) => ({ id: e.step, status: e.status, message: e.msg }),
      initialSteps: [
        { id: 's1', label: 'Step 1', status: 'pending' },
        { id: 's2', label: 'Step 2', status: 'pending' },
      ],
    })
  );

  // Wait for EventSource to open
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  expect(result.current.status).toBe('running');
  expect(result.current.connected).toBe(true);

  // Simulate a step update
  act(() => {
    MockEventSource.instances[0].emit('progress', { step: 's1', status: 'active', msg: 'Working...' });
  });

  expect(result.current.steps[0].status).toBe('active');
  expect(result.current.steps[0].message).toBe('Working...');
});

it('handles complete event', async () => {
  const onComplete = jest.fn();
  const { result } = renderHook(() =>
    useFlowSSE({
      url: '/api/test',
      mapEvent: (e) => ({ id: e.step, status: e.status }),
      onComplete,
    })
  );

  await act(async () => { await new Promise(r => setTimeout(r, 10)); });

  act(() => {
    MockEventSource.instances[0].emit('complete', { result: 'ok' });
  });

  expect(result.current.status).toBe('complete');
  expect(result.current.connected).toBe(false);
  expect(onComplete).toHaveBeenCalledWith({ result: 'ok' });
});

it('returns idle when url is null', () => {
  const { result } = renderHook(() =>
    useFlowSSE({ url: null, mapEvent: (e) => ({ id: e.id, status: e.status }) })
  );
  expect(result.current.status).toBe('idle');
  expect(result.current.connected).toBe(false);
  expect(MockEventSource.instances).toHaveLength(0);
});
```

### Acceptance criteria

- Hook manages EventSource lifecycle (open, close, cleanup on unmount)
- `url: null` means "don't connect" — useful for conditional activation
- `mapEvent` is the only required transform — consumer maps their payload shape to FlowProgressStep fields
- Steps array is derived from a Map to handle both ordered initial steps and dynamically-added steps
- `customEvents` allows listening for non-step events (like `partial_ads`) without leaving the hook
- `close()` and `reset()` give the consumer manual control
- The hook does not depend on any bilko-flow execution engine or storage module

---

## Enhancement 5: Decouple `bilko-flow/react` from the execution engine

### Problem

Importing from `bilko-flow/react` currently pulls in the execution engine and storage modules because:
1. `use-flow-execution.ts` imports from `../execution/execution-store`
2. `use-execution-store.ts` imports from `../execution/execution-store`
3. Both import domain types from `../domain/execution`

Even if a consumer only uses `<FlowProgress>` (which has zero dependency on execution), bundlers like Vite and webpack include the full `bilko-flow/react` entry point, which triggers the transitive imports.

### Files to modify

**`src/react/index.ts`** — Split into two export groups with a separate entry point:

Create **`src/react/components.ts`** — Pure visualization exports (no execution dependency):

```typescript
// Components that depend only on types.ts and step-type-config.ts
export { FlowProgress, adaptSteps } from './flow-progress';
export { FlowProgressVertical } from './flow-progress-vertical';
export { FlowErrorBoundary } from './flow-error-boundary';
export { FlowCanvas } from './flow-canvas';
export { StepNode } from './step-node';
export { StepDetail } from './step-detail';
export { FlowTimeline } from './flow-timeline';
export { FlowCard } from './flow-card';
export { CanvasBuilder } from './canvas-builder';
export { ComponentCatalog } from './component-catalog';
export { ParallelThreadsSection, MAX_PARALLEL_THREADS } from './parallel-threads';

// Pure functions (no React, no execution engine)
export { applyMutation, createBlankStep, generateStepId } from './mutations';
export { DEFAULT_COMPONENT_DEFINITIONS, getComponentByType } from './component-definitions';
export { computeLayout, NODE_W, NODE_H, COL_GAP, ROW_GAP, PADDING } from './layout';
export {
  STEP_TYPE_CONFIG, LLM_SUBTYPE_CONFIG, DOMAIN_STEP_TYPE_MAP,
  DEFAULT_FLOW_PROGRESS_THEME, getStepVisuals, mergeTheme,
} from './step-type-config';

// SSE hook (no execution engine dependency)
export { useFlowSSE } from './use-flow-sse';

// Types
export type {
  FlowProgressStep, FlowProgressProps, FlowProgressTheme,
  StatusMap, UseFlowSSEOptions, UseFlowSSEReturn,
  // ... all other type exports that don't reference FlowExecution
} from './types';
```

Keep **`src/react/index.ts`** as the full export (backward-compatible):

```typescript
// Full re-export including execution hooks
export * from './components';
export { useExecutionStore } from './use-execution-store';
export { useFlowExecution } from './use-flow-execution';
// Types that reference FlowExecution:
export type { UseFlowExecutionOptions, UseFlowExecutionReturn } from './use-flow-execution';
```

**`package.json`** — Add a third export path:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./react": {
      "types": "./dist/react/index.d.ts",
      "default": "./dist/react/index.js"
    },
    "./react/components": {
      "types": "./dist/react/components.d.ts",
      "default": "./dist/react/components.js"
    }
  }
}
```

### Consumer usage

```typescript
// Lightweight import — no execution engine, no storage:
import { FlowProgress, useFlowSSE } from 'bilko-flow/react/components';

// Full import (backward-compatible, includes execution hooks):
import { FlowProgress, useFlowExecution, useExecutionStore } from 'bilko-flow/react';
```

### Acceptance criteria

- `import { FlowProgress } from 'bilko-flow/react/components'` works and does NOT import anything from `../execution/` or `../storage/`
- `import { FlowProgress } from 'bilko-flow/react'` continues to work (backward-compatible)
- Bundle size of a consumer using only `bilko-flow/react/components` is measurably smaller than `bilko-flow/react` (verify with `npx vite-bundle-analyzer` or similar)
- All existing tests pass without modification

---

## Enhancement 6: Ship pre-built Tailwind CSS

### Problem

Consumers must add `@source "../../node_modules/bilko-flow/src/**/*.tsx"` to their Tailwind config to scan bilko-flow's source for utility classes. This has two problems:
1. It pulls in classes for ALL components even if only one is used (47KB overhead in the NPR app)
2. It requires consumers to know about this setup step — easy to miss

### Files to create/modify

**Add a build step** in `package.json`:

```json
{
  "scripts": {
    "build": "tsc && npm run build:css",
    "build:css": "npx tailwindcss -i src/react/styles.css -o dist/react/bilko-flow.css --minify"
  }
}
```

**Create `src/react/styles.css`** — Tailwind input file:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**Create `tailwind.config.js`** at bilko-flow root (used only for the library's own CSS build):

```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/react/**/*.tsx'],
  theme: { extend: {} },
  plugins: [],
};
```

**Update `package.json` exports** to expose the CSS:

```json
{
  "exports": {
    "./react/styles.css": "./dist/react/bilko-flow.css"
  }
}
```

### Consumer usage

```typescript
// Option A: Import pre-built CSS (no Tailwind scanning needed)
import 'bilko-flow/react/styles.css';
import { FlowProgress } from 'bilko-flow/react';

// Option B: Keep Tailwind scanning (for consumers who want to override/extend)
// @source "../../node_modules/bilko-flow/src/**/*.tsx"  (in tailwind.css)
```

### Acceptance criteria

- `dist/react/bilko-flow.css` is generated during `npm run build`
- The file contains only the Tailwind classes actually used by bilko-flow components
- Consumer can import the CSS file and render FlowProgress without any Tailwind config changes
- The pre-built CSS file is < 20KB minified (estimate: bilko-flow uses ~200 unique utility classes)
- Consumers who prefer Tailwind scanning can still do so (not a breaking change)

---

## Summary of all enhancements

| # | Enhancement | Key file(s) to modify | Estimated effort |
|---|---|---|---|
| 1 | Add `message` field to `FlowProgressStep` | `types.ts`, `flow-progress.tsx`, `flow-progress-vertical.tsx` | Small — add field, render in 4 modes |
| 2 | Add `skipped` status | `types.ts`, `step-type-config.ts`, `flow-progress.tsx`, `flow-progress-vertical.tsx` | Small — new case in status switches |
| 3 | `statusMap` prop for custom status strings | `types.ts`, `flow-progress.tsx` | Medium — resolution layer + loosen type |
| 4 | `useFlowSSE` hook | New `use-flow-sse.ts`, update `index.ts` | Medium — new file, ~120 lines |
| 5 | Decouple `bilko-flow/react/components` | New `components.ts`, update `package.json` exports | Small — reorganize exports |
| 6 | Pre-built Tailwind CSS | New `styles.css`, `tailwind.config.js`, update `package.json` | Small — build step + config |

Enhancements 1–3 address the type rigidity that made the adapter layer brittle. Enhancement 4 eliminates the need for the adapter entirely. Enhancements 5–6 address the dependency weight and bundle size concerns.

If only one enhancement is implemented, it should be **Enhancement 4 (useFlowSSE)**. That single hook would have kept bilko-flow in the NPR podcast app. The others are quality-of-life improvements that reduce friction but aren't individually dealbreakers.
