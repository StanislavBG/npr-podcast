/**
 * PipelineTracker — Custom tracker replacing bilko-flow FlowProgress.
 *
 * Shows:
 *  1. Main pipeline steps as a compact horizontal chain
 *  2. Audio chunks fully expanded with all 5 substeps visible per chunk
 *  3. Rich inline detail panel when a step is selected
 */

import { useState, useMemo } from 'react';
import type {
  FlowProgressStep,
  ParallelThread,
  StepExecution,
} from 'bilko-flow/react/components';
import {
  STEP_META,
  STEP_DESCRIPTIONS,
  CHUNK_STEP_META,
  CHUNK_STEP_DEFINITIONS,
} from '../workflows/podcastFlow';

// ─── Chunk thread step ID resolution ──────────────────────────────────────

const SUFFIX_TO_CHUNK_STEP: Record<string, string> = {
  fetch: 'step_fetch_chunk',
  transcribe: 'step_transcribe_chunk',
  classify: 'step_classify_chunk',
  refine: 'step_refine_chunk',
  emit: 'step_emit_skips',
};

function resolveChunkStepId(threadStepId: string): string | null {
  const lastDash = threadStepId.lastIndexOf('-');
  if (lastDash === -1) return null;
  const suffix = threadStepId.slice(lastDash + 1);
  return SUFFIX_TO_CHUNK_STEP[suffix] || null;
}

// ─── Types ────────────────────────────────────────────────────────────────

interface Props {
  steps: FlowProgressStep[];
  chunkThreads: ParallelThread[];
  status: 'idle' | 'running' | 'complete' | 'error';
  stepExecutions: Record<string, StepExecution>;
  selectedStepId: string | null;
  onStepSelect: (stepId: string | null) => void;
}

// ─── Status helpers ───────────────────────────────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case 'complete': return '\u2713';
    case 'active': case 'running': return '\u25CF';
    case 'error': return '\u2717';
    case 'skipped': return '\u2014';
    default: return '\u25CB';
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'complete': return 'pt-step-done';
    case 'active': case 'running': return 'pt-step-active';
    case 'error': return 'pt-step-error';
    case 'skipped': return 'pt-step-skipped';
    default: return 'pt-step-pending';
  }
}

function threadStatusClass(status: string): string {
  switch (status) {
    case 'complete': return 'pt-thread-done';
    case 'running': return 'pt-thread-running';
    case 'error': return 'pt-thread-error';
    default: return 'pt-thread-pending';
  }
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── StepInspector: rich metadata panel ───────────────────────────────────

function StepInspector({
  stepId,
  execution,
  onClose,
}: {
  stepId: string;
  execution: StepExecution | undefined;
  onClose: () => void;
}) {
  // Resolve the step definition (main step or chunk step)
  const genericId = resolveChunkStepId(stepId) || stepId;
  const mainDef = STEP_DESCRIPTIONS[genericId];
  const chunkDef = CHUNK_STEP_DEFINITIONS[genericId];
  const def = mainDef || chunkDef;
  const meta = STEP_META[genericId] || CHUNK_STEP_META[genericId];

  // Parse chunk context from step ID (e.g. "chunk-2-transcribe")
  const chunkMatch = stepId.match(/^chunk-(\d+)-/);
  const chunkIndex = chunkMatch ? parseInt(chunkMatch[1], 10) : null;

  const label = meta?.label || stepId;
  const chunkLabel = chunkIndex != null ? ` (Chunk ${chunkIndex + 1})` : '';

  return (
    <div className="pt-inspector">
      <div className="pt-inspector-header">
        <div>
          <h3 className="pt-inspector-title">{label}{chunkLabel}</h3>
          {meta?.type && <span className="pt-inspector-type">{meta.type}</span>}
          {(def as any)?.model && <span className="pt-inspector-model">{(def as any).model}</span>}
          {execution?.durationMs != null && (
            <span className="pt-inspector-duration">{fmtDuration(execution.durationMs)}</span>
          )}
          {execution?.status && (
            <span className={`pt-inspector-status pt-inspector-status-${execution.status}`}>
              {execution.status}
            </span>
          )}
        </div>
        <button className="pt-inspector-close" onClick={onClose}>Close</button>
      </div>

      {/* Description */}
      {def?.description && (
        <div className="pt-inspector-section">
          <h4>Description</h4>
          <p>{def.description}</p>
        </div>
      )}

      {/* Instructions (LLM steps) */}
      {(def as any)?.prompt && (
        <div className="pt-inspector-section">
          <h4>System Prompt</h4>
          <pre className="pt-inspector-pre">{(def as any).prompt}</pre>
        </div>
      )}
      {(def as any)?.userMessage && (
        <div className="pt-inspector-section">
          <h4>User Message</h4>
          <pre className="pt-inspector-pre">{(def as any).userMessage}</pre>
        </div>
      )}

      {/* Execution Input */}
      {execution?.input && Object.keys(execution.input as object).length > 0 && (
        <div className="pt-inspector-section">
          <h4>Input</h4>
          <div className="pt-inspector-data">
            {Object.entries(execution.input as Record<string, unknown>).map(([k, v]) => {
              const isComplex = v != null && typeof v === 'object';
              return (
                <div key={k} className={`pt-inspector-field ${isComplex ? 'pt-inspector-field-wide' : ''}`}>
                  <span className="pt-inspector-key">{k}</span>
                  {isComplex ? (
                    <pre className="pt-inspector-pre pt-inspector-pre-inline">
                      {JSON.stringify(v, null, 2)}
                    </pre>
                  ) : (
                    <span className="pt-inspector-value">{String(v)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Execution Output */}
      {execution?.output && Object.keys(execution.output as object).length > 0 && (
        <div className="pt-inspector-section">
          <h4>Output</h4>
          <div className="pt-inspector-data">
            {Object.entries(execution.output as Record<string, unknown>).map(([k, v]) => {
              const isTranscript = k === 'transcriptPreview' || k === 'transcript';
              const isComplex = v != null && typeof v === 'object';
              return (
                <div key={k} className={`pt-inspector-field ${isTranscript || isComplex ? 'pt-inspector-field-wide' : ''}`}>
                  <span className="pt-inspector-key">{k}</span>
                  {isTranscript ? (
                    <span className="pt-inspector-value pt-inspector-transcript">{String(v)}</span>
                  ) : isComplex ? (
                    <pre className="pt-inspector-pre pt-inspector-pre-inline">
                      {JSON.stringify(v, null, 2)}
                    </pre>
                  ) : (
                    <span className="pt-inspector-value">
                      {typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '...' : String(v)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Raw LLM response */}
      {execution?.rawResponse && (
        <div className="pt-inspector-section">
          <h4>Raw LLM Response</h4>
          <pre className="pt-inspector-pre pt-inspector-pre-long">
            {typeof execution.rawResponse === 'string'
              ? execution.rawResponse
              : JSON.stringify(execution.rawResponse, null, 2)}
          </pre>
        </div>
      )}

      {/* Error */}
      {execution?.error && (
        <div className="pt-inspector-section pt-inspector-error-section">
          <h4>Error</h4>
          <pre className="pt-inspector-pre">{execution.error}</pre>
        </div>
      )}

      {/* Input Schema */}
      {def?.inputSchema && def.inputSchema.length > 0 && (
        <div className="pt-inspector-section">
          <h4>Input Schema</h4>
          <table className="pt-inspector-schema">
            <thead>
              <tr><th>Field</th><th>Type</th><th>Req</th><th>Description</th></tr>
            </thead>
            <tbody>
              {def.inputSchema.map((f: any) => (
                <tr key={f.name}>
                  <td className="pt-schema-name">{f.name}</td>
                  <td className="pt-schema-type">{f.type}</td>
                  <td>{f.required ? '\u2713' : ''}</td>
                  <td className="pt-schema-desc">{f.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Output Schema */}
      {def?.outputSchema && def.outputSchema.length > 0 && (
        <div className="pt-inspector-section">
          <h4>Output Schema</h4>
          <table className="pt-inspector-schema">
            <thead>
              <tr><th>Field</th><th>Type</th><th>Req</th><th>Description</th></tr>
            </thead>
            <tbody>
              {def.outputSchema.map((f: any) => (
                <tr key={f.name}>
                  <td className="pt-schema-name">{f.name}</td>
                  <td className="pt-schema-type">{f.type}</td>
                  <td>{f.required ? '\u2713' : ''}</td>
                  <td className="pt-schema-desc">{f.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── ChunkCard: single audio chunk with all substeps ──────────────────────

function ChunkCard({
  thread,
  stepExecutions,
  selectedStepId,
  onStepSelect,
}: {
  thread: ParallelThread;
  stepExecutions: Record<string, StepExecution>;
  selectedStepId: string | null;
  onStepSelect: (id: string) => void;
}) {
  const completedCount = thread.steps.filter(s => s.status === 'complete').length;
  const totalCount = thread.steps.length;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  // Gather key data from executions for this chunk
  const transcribeStep = thread.steps.find(s => s.id.endsWith('-transcribe'));
  const fetchStep = thread.steps.find(s => s.id.endsWith('-fetch'));
  const transcribeExec = transcribeStep ? stepExecutions[transcribeStep.id] : undefined;
  const fetchExec = fetchStep ? stepExecutions[fetchStep.id] : undefined;

  const fetchOutput = fetchExec?.output as Record<string, any> | undefined;
  const transcribeOutput = transcribeExec?.output as Record<string, any> | undefined;

  return (
    <div className={`pt-chunk ${threadStatusClass(thread.status)}`}>
      {/* Chunk header */}
      <div className="pt-chunk-header">
        <span className="pt-chunk-label">{thread.label}</span>
        <span className="pt-chunk-progress">{completedCount}/{totalCount}</span>
        <div className="pt-chunk-bar">
          <div className="pt-chunk-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Audio chunk metadata summary */}
      <div className="pt-chunk-meta">
        {fetchOutput?.bytesFetched && (
          <span className="pt-chunk-tag">{fmtBytes(fetchOutput.bytesFetched)}</span>
        )}
        {fetchOutput?.offsetSec != null && (
          <span className="pt-chunk-tag">@{fetchOutput.offsetSec}s</span>
        )}
        {transcribeOutput?.wordCount && (
          <span className="pt-chunk-tag">{transcribeOutput.wordCount} words</span>
        )}
        {transcribeOutput?.segmentCount && (
          <span className="pt-chunk-tag">{transcribeOutput.segmentCount} segs</span>
        )}
        {thread.activity && (
          <span className="pt-chunk-activity">{thread.activity}</span>
        )}
      </div>

      {/* Substeps — all visible, not collapsed */}
      <div className="pt-chunk-steps">
        {thread.steps.map((step) => {
          const exec = stepExecutions[step.id];
          const isSelected = selectedStepId === step.id;
          const output = exec?.output as Record<string, any> | undefined;

          return (
            <button
              key={step.id}
              className={`pt-substep ${statusClass(step.status)} ${isSelected ? 'pt-substep-selected' : ''}`}
              onClick={() => onStepSelect(step.id)}
              title={`${step.label} — click to inspect`}
            >
              <span className="pt-substep-icon">{statusIcon(step.status)}</span>
              <span className="pt-substep-label">{step.label}</span>
              {exec?.durationMs != null && (
                <span className="pt-substep-dur">{fmtDuration(exec.durationMs)}</span>
              )}
              {/* Quick data badge */}
              {output?.message && !output.transcript && (
                <span className="pt-substep-badge">{output.message}</span>
              )}
              {output?.transcript && (
                <span className="pt-substep-badge">{output.wordCount || '?'} words</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Full transcript text if available */}
      {transcribeOutput?.transcript && (
        <div className="pt-chunk-transcript">
          <span className="pt-chunk-transcript-label">Transcript:</span>
          {transcribeOutput.transcript}
        </div>
      )}
    </div>
  );
}

// ─── Main PipelineTracker ─────────────────────────────────────────────────

export function PipelineTracker({
  steps,
  chunkThreads,
  status,
  stepExecutions,
  selectedStepId,
  onStepSelect,
}: Props) {
  // Track which chunk cards are collapsed (none by default — all expanded)
  const [collapsedChunks] = useState<Set<string>>(new Set());

  const visibleThreads = useMemo(() => {
    return chunkThreads.filter(t => !collapsedChunks.has(t.id));
  }, [chunkThreads, collapsedChunks]);

  // Aggregate stats
  const totalChunkSteps = chunkThreads.reduce((a, t) => a + t.steps.length, 0);
  const completedChunkSteps = chunkThreads.reduce(
    (a, t) => a + t.steps.filter(s => s.status === 'complete').length, 0
  );

  return (
    <div className="pt-root">
      {/* ── Main pipeline steps (horizontal chain) ── */}
      <div className="pt-main-steps">
        {steps.map((step, i) => {
          const exec = stepExecutions[step.id];
          const isSelected = selectedStepId === step.id;
          return (
            <div key={step.id} className="pt-main-step-wrapper">
              <button
                className={`pt-main-step ${statusClass(step.status)} ${isSelected ? 'pt-substep-selected' : ''}`}
                onClick={() => onStepSelect(step.id)}
              >
                <span className="pt-main-step-icon">{statusIcon(step.status)}</span>
                <span className="pt-main-step-label">{step.label}</span>
                {exec?.durationMs != null && (
                  <span className="pt-main-step-dur">{fmtDuration(exec.durationMs)}</span>
                )}
              </button>
              {i < steps.length - 1 && <span className="pt-main-step-arrow">&rarr;</span>}
            </div>
          );
        })}
      </div>

      {/* ── Audio Chunks section ── */}
      {chunkThreads.length > 0 && (
        <div className="pt-chunks-section">
          <div className="pt-chunks-header">
            <span className="pt-chunks-title">Audio Chunks</span>
            <span className="pt-chunks-count">
              {chunkThreads.length} chunks &middot; {completedChunkSteps}/{totalChunkSteps} steps
            </span>
            {status === 'running' && (
              <span className="pt-chunks-running">Processing...</span>
            )}
          </div>

          <div className="pt-chunks-grid">
            {visibleThreads.map(thread => (
              <ChunkCard
                key={thread.id}
                thread={thread}
                stepExecutions={stepExecutions}
                selectedStepId={selectedStepId}
                onStepSelect={onStepSelect}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Step Inspector (when a step is selected) ── */}
      {selectedStepId && (
        <StepInspector
          stepId={selectedStepId}
          execution={stepExecutions[selectedStepId]}
          onClose={() => onStepSelect(null)}
        />
      )}
    </div>
  );
}
