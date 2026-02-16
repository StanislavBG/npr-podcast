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

// ─── ChunkCard: full-width vertical pipeline trace per chunk ────────────

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

  // Gather executions for each substep
  const getExec = (suffix: string) => {
    const step = thread.steps.find(s => s.id.endsWith(`-${suffix}`));
    return step ? { step, exec: stepExecutions[step.id] } : null;
  };

  const fetch = getExec('fetch');
  const transcribe = getExec('transcribe');
  const classify = getExec('classify');
  const refine = getExec('refine');
  const emit = getExec('emit');

  const fetchOut = fetch?.exec?.output as Record<string, any> | undefined;
  const transcribeOut = transcribe?.exec?.output as Record<string, any> | undefined;
  const classifyOut = classify?.exec?.output as Record<string, any> | undefined;
  const refineOut = refine?.exec?.output as Record<string, any> | undefined;
  const emitOut = emit?.exec?.output as Record<string, any> | undefined;

  const lineClassification = classifyOut?.lineClassification as Array<{
    lineNum: number; text: string; speaker?: string; timestamp: string;
    classification: 'AD' | 'CONTENT'; adReason?: string;
  }> | undefined;

  const refinedBoundaries = refineOut?.refinedBoundaries as Array<{
    startTimeSec: number; endTimeSec: number; durationSec: number;
    reason: string; textPreview?: string;
  }> | undefined;

  const skipMap = emitOut?.skipMap as Array<{
    startTime: number; endTime: number; reason: string; confidence: number;
  }> | undefined;

  // Helper: render a step section
  const renderStepSection = (
    label: string,
    suffix: string,
    stepData: ReturnType<typeof getExec>,
    children: React.ReactNode,
  ) => {
    if (!stepData) return null;
    const { step, exec } = stepData;
    const isSelected = selectedStepId === step.id;
    return (
      <div className={`pt-stage ${statusClass(step.status)} ${isSelected ? 'pt-stage-selected' : ''}`}>
        <button
          className="pt-stage-header"
          onClick={() => onStepSelect(step.id)}
          title="Click to inspect full details"
        >
          <span className="pt-stage-icon">{statusIcon(step.status)}</span>
          <span className="pt-stage-label">{label}</span>
          {exec?.durationMs != null && (
            <span className="pt-stage-dur">{fmtDuration(exec.durationMs)}</span>
          )}
          <span className="pt-stage-arrow">{isSelected ? '\u25BC' : '\u25B6'}</span>
        </button>
        {/* Always show inline data summary */}
        {step.status === 'complete' || step.status === 'error' ? (
          <div className="pt-stage-body">{children}</div>
        ) : step.status === 'active' || step.status === 'running' ? (
          <div className="pt-stage-body pt-stage-running">
            <span className="pt-stage-spinner">Processing...</span>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className={`pt-chunk-v2 ${threadStatusClass(thread.status)}`}>
      {/* Chunk header */}
      <div className="pt-chunk-header-v2">
        <span className="pt-chunk-label-v2">{thread.label}</span>
        <span className="pt-chunk-progress-v2">{completedCount}/{totalCount} steps</span>
        <div className="pt-chunk-bar-v2">
          <div className="pt-chunk-bar-fill-v2" style={{ width: `${progressPct}%` }} />
        </div>
        {thread.activity && <span className="pt-chunk-activity-v2">{thread.activity}</span>}
      </div>

      {/* ── Stage 1: Fetch Audio ── */}
      {renderStepSection('1. Fetch Audio', 'fetch', fetch, (
        <div className="pt-stage-data">
          {fetchOut?.byteRange && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Byte Range</span>
              <span className="pt-stage-val">{fetchOut.byteRange}</span>
            </div>
          )}
          {fetchOut?.bytesFetched != null && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Size</span>
              <span className="pt-stage-val">{fmtBytes(fetchOut.bytesFetched)}</span>
            </div>
          )}
          {fetchOut?.offsetSec != null && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Audio Offset</span>
              <span className="pt-stage-val">{fetchOut.offsetSec}s into episode</span>
            </div>
          )}
        </div>
      ))}

      {/* ── Stage 2: Transcribe ── */}
      {renderStepSection('2. Transcribe', 'transcribe', transcribe, (
        <div className="pt-stage-data">
          <div className="pt-stage-row-group">
            {transcribeOut?.segmentCount != null && (
              <div className="pt-stage-row">
                <span className="pt-stage-key">Segments</span>
                <span className="pt-stage-val">{transcribeOut.segmentCount}</span>
              </div>
            )}
            {transcribeOut?.wordCount != null && (
              <div className="pt-stage-row">
                <span className="pt-stage-key">Words</span>
                <span className="pt-stage-val">{transcribeOut.wordCount}</span>
              </div>
            )}
            {transcribeOut?.durationSec != null && (
              <div className="pt-stage-row">
                <span className="pt-stage-key">Duration</span>
                <span className="pt-stage-val">{transcribeOut.durationSec}s</span>
              </div>
            )}
          </div>
          {/* Show full transcript if classify hasn't completed yet */}
          {transcribeOut?.transcript && !lineClassification && (
            <div className="pt-stage-transcript">
              <div className="pt-stage-transcript-label">Transcript</div>
              <div className="pt-stage-transcript-text">{transcribeOut.transcript}</div>
            </div>
          )}
        </div>
      ))}

      {/* ── Stage 3: Classify (with per-line breakdown) ── */}
      {renderStepSection('3. Classify Ads', 'classify', classify, (
        <div className="pt-stage-data">
          <div className="pt-stage-row-group">
            {classifyOut?.linesAnalyzed != null && (
              <div className="pt-stage-row">
                <span className="pt-stage-key">Lines Analyzed</span>
                <span className="pt-stage-val">{classifyOut.linesAnalyzed}</span>
              </div>
            )}
            {classifyOut?.adBlockCount != null && (
              <div className="pt-stage-row">
                <span className="pt-stage-key">Ad Blocks Found</span>
                <span className="pt-stage-val pt-stage-val-highlight">
                  {classifyOut.adBlockCount}
                </span>
              </div>
            )}
          </div>

          {/* Per-line classification breakdown */}
          {lineClassification && lineClassification.length > 0 && (
            <div className="pt-stage-classification">
              <div className="pt-stage-classification-header">
                Per-Sentence Classification ({lineClassification.length} lines)
              </div>
              <div className="pt-classification-lines">
                {lineClassification.map(l => (
                  <div
                    key={l.lineNum}
                    className={`pt-cl-line ${l.classification === 'AD' ? 'pt-cl-ad' : 'pt-cl-content'}`}
                  >
                    <span className="pt-cl-num">[{l.lineNum}]</span>
                    <span className="pt-cl-ts">{l.timestamp}</span>
                    <span className={`pt-cl-tag ${l.classification === 'AD' ? 'pt-cl-tag-ad' : 'pt-cl-tag-content'}`}>
                      {l.classification}
                    </span>
                    {l.speaker && <span className="pt-cl-speaker">{l.speaker}:</span>}
                    <span className="pt-cl-text">{l.text}</span>
                    {l.adReason && <span className="pt-cl-reason">({l.adReason})</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {/* ── Stage 4: Refine Boundaries ── */}
      {renderStepSection('4. Refine Boundaries', 'refine', refine, (
        <div className="pt-stage-data">
          {refineOut?.refinedBlocks != null && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Refined Blocks</span>
              <span className="pt-stage-val">{refineOut.refinedBlocks}</span>
            </div>
          )}
          {refineOut?.totalAdTimeSec != null && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Total Ad Time</span>
              <span className="pt-stage-val pt-stage-val-highlight">{refineOut.totalAdTimeSec}s</span>
            </div>
          )}
          {refinedBoundaries && refinedBoundaries.length > 0 && (
            <div className="pt-stage-boundaries">
              <div className="pt-stage-classification-header">Refined Ad Boundaries</div>
              {refinedBoundaries.map((b, i) => (
                <div key={i} className="pt-boundary-block">
                  <div className="pt-boundary-time">
                    {Math.round(b.startTimeSec)}s &rarr; {Math.round(b.endTimeSec)}s
                    <span className="pt-boundary-dur">({b.durationSec}s)</span>
                  </div>
                  <div className="pt-boundary-reason">{b.reason}</div>
                  {b.textPreview && (
                    <div className="pt-boundary-preview">{b.textPreview}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {refineOut?.refinedBlocks === 0 && (
            <div className="pt-stage-empty">{refineOut?.reason || refineOut?.message || 'No ads to refine'}</div>
          )}
        </div>
      ))}

      {/* ── Stage 5: Emit Skip Ranges ── */}
      {renderStepSection('5. Emit Skip Ranges', 'emit', emit, (
        <div className="pt-stage-data">
          {emitOut?.emittedRanges != null && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Ranges Emitted</span>
              <span className="pt-stage-val">{emitOut.emittedRanges}</span>
            </div>
          )}
          {emitOut?.totalSkipSec != null && emitOut.totalSkipSec > 0 && (
            <div className="pt-stage-row">
              <span className="pt-stage-key">Skip Duration</span>
              <span className="pt-stage-val pt-stage-val-highlight">{emitOut.totalSkipSec}s</span>
            </div>
          )}
          {skipMap && skipMap.length > 0 && (
            <div className="pt-stage-skipmap">
              <div className="pt-stage-classification-header">Skip Map (sent to player)</div>
              {skipMap.map((s, i) => (
                <div key={i} className="pt-skip-range">
                  <span className="pt-skip-times">
                    {s.startTime}s &rarr; {s.endTime}s
                  </span>
                  <span className="pt-skip-conf">conf: {s.confidence}</span>
                  <span className="pt-skip-reason">{s.reason}</span>
                </div>
              ))}
            </div>
          )}
          {emitOut?.emittedRanges === 0 && (
            <div className="pt-stage-empty">No ads detected in this chunk</div>
          )}
        </div>
      ))}
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
