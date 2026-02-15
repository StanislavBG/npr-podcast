import { useState, useMemo, useCallback, useRef } from 'react';
import {
  FlowErrorBoundary,
  FlowProgress,
  StepDetail,
  resolveStepMeta,
} from 'bilko-flow/react/components';
import type {
  FlowProgressStep,
  ParallelThread,
  ParallelConfig,
  StepExecution,
  FlowDefinition,
} from 'bilko-flow/react/components';
import { PipelineWaterfall } from './PipelineWaterfall';
import {
  formatTimestamp,
  type SandboxResult,
  type Episode,
} from '../services/api';
import { STEP_ORDER } from '../workflows/podcastFlow';

// ─── Chunk thread step ID mapping ────────────────────────────────────────────

/** Map a chunk thread step suffix to the generic chunk step ID for FlowStep lookup */
const SUFFIX_TO_CHUNK_STEP: Record<string, string> = {
  fetch: 'step_fetch_chunk',
  transcribe: 'step_transcribe_chunk',
  classify: 'step_classify_chunk',
  refine: 'step_refine_chunk',
  emit: 'step_emit_skips',
};

/** Parse a chunk thread step ID (e.g. "chunk-0-transcribe") into its generic step ID */
function resolveChunkStepId(threadStepId: string): string | null {
  // Format: chunk-{N}-{suffix}
  const lastDash = threadStepId.lastIndexOf('-');
  if (lastDash === -1) return null;
  const suffix = threadStepId.slice(lastDash + 1);
  return SUFFIX_TO_CHUNK_STEP[suffix] || null;
}

// ─── Props: SandboxPage receives data from App (no self-fetching) ────────────

interface Props {
  onBack: () => void;
  result: SandboxResult | null;
  episode: Episode | null;
  podcastName: string;
  podcastId: string;
  pipelineSteps: FlowProgressStep[];
  pipelineStatus: 'idle' | 'running' | 'complete' | 'error';
  chunkThreads: ParallelThread[];
  parallelConfig: ParallelConfig;
  stepExecutions: Record<string, StepExecution>;
  flowDefinition: FlowDefinition;
}

// ─── Copy Feedback: accumulate debug info for agent/developer ────────────────

function buildFeedbackText(
  result: SandboxResult | null,
  pipelineSteps: FlowProgressStep[],
  pipelineStatus: string,
  episode: Episode | null,
  podcastName: string,
  stepExecutions: Record<string, StepExecution>,
): string {
  const lines: string[] = [];
  lines.push('# Pipeline Debug Feedback');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Episode');
  if (episode) {
    lines.push(`- Title: ${episode.title}`);
    lines.push(`- Podcast: ${podcastName}`);
    lines.push(`- Duration: ${episode.duration}`);
    lines.push(`- Audio URL: ${episode.audioUrl || '(none)'}`);
    lines.push(`- Transcript URL: ${episode.transcriptUrl || '(none)'}`);
  } else {
    lines.push('(no episode selected)');
  }
  lines.push('');

  lines.push('## Pipeline Status');
  lines.push(`Overall: ${pipelineStatus}`);
  lines.push('');
  for (const step of pipelineSteps) {
    const resolved = resolveStepMeta(step.meta);
    const msg = resolved.message || resolved.error || resolved.skipReason || '';
    const exec = stepExecutions[step.id];
    const dur = exec?.durationMs ? ` (${exec.durationMs}ms)` : '';
    const icon = step.status === 'complete' ? '[OK]' :
                 step.status === 'error' ? '[ERROR]' :
                 step.status === 'skipped' ? '[SKIP]' :
                 step.status === 'active' ? '[RUNNING]' : '[PENDING]';
    lines.push(`${icon} ${step.label}: ${msg}${dur}`);
  }
  lines.push('');

  // Step execution details
  lines.push('## Step Executions');
  for (const [id, exec] of Object.entries(stepExecutions)) {
    lines.push(`### ${id}`);
    lines.push(`- Status: ${exec.status}`);
    if (exec.durationMs) lines.push(`- Duration: ${exec.durationMs}ms`);
    if (exec.input) lines.push(`- Input: ${JSON.stringify(exec.input)}`);
    if (exec.output) lines.push(`- Output: ${JSON.stringify(exec.output)}`);
    if (exec.rawResponse) lines.push(`- Raw Response: ${typeof exec.rawResponse === 'string' ? exec.rawResponse.slice(0, 500) : JSON.stringify(exec.rawResponse).slice(0, 500)}`);
    if (exec.error) lines.push(`- Error: ${exec.error}`);
    lines.push('');
  }

  if (result) {
    lines.push('## Analysis Results');
    lines.push('### Ad Detection');
    lines.push(`- Strategy: ${result.summary.strategy}`);
    lines.push(`- Ad blocks: ${result.summary.totalAdBlocks}`);
    lines.push(`- Ad time: ${result.summary.totalAdTimeSec}s`);
    lines.push(`- Content time: ${result.summary.contentTimeSec}s`);
    lines.push(`- Ad word %: ${result.summary.adWordPercent}%`);
    lines.push('');

    lines.push('### Skip Map');
    if (result.skipMap.length === 0) {
      lines.push('(empty)');
    } else {
      for (const s of result.skipMap) {
        lines.push(`- ${formatTimestamp(s.startTime)} -> ${formatTimestamp(s.endTime)} | conf: ${s.confidence} | ${s.reason}`);
      }
    }
    lines.push('');

    if (result.prompts) {
      lines.push('### LLM Prompts');
      lines.push('#### System Prompt');
      lines.push('```');
      lines.push(result.prompts.system);
      lines.push('```');
      lines.push('#### User Prompt (truncated)');
      lines.push('```');
      lines.push(result.prompts.user.length > 1000
        ? result.prompts.user.slice(0, 500) + `\n... (${result.prompts.user.length} chars total) ...\n` + result.prompts.user.slice(-300)
        : result.prompts.user);
      lines.push('```');
      lines.push('');
    }

    if (result.llmResponse) {
      lines.push('### Raw LLM Response');
      lines.push('```json');
      lines.push(result.llmResponse);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

// ─── Main SandboxPage ────────────────────────────────────────────────────────

export function SandboxPage({
  onBack,
  result,
  episode,
  podcastName,
  podcastId,
  pipelineSteps,
  pipelineStatus,
  chunkThreads,
  parallelConfig,
  stepExecutions,
  flowDefinition,
}: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const handleCopyFeedback = useCallback(() => {
    const text = buildFeedbackText(result, pipelineSteps, pipelineStatus, episode, podcastName, stepExecutions);
    navigator.clipboard.writeText(text).then(() => {
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    }).catch(() => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    });
  }, [result, pipelineSteps, pipelineStatus, episode, podcastName, stepExecutions]);

  // Handle step click from FlowProgress
  const handleStepClick = useCallback((stepId: string) => {
    setSelectedStepId(prev => prev === stepId ? null : stepId);
  }, []);

  // Find the FlowStep definition for the selected step.
  // For chunk thread steps (e.g. "chunk-0-transcribe"), resolve to the generic
  // FlowStep (e.g. step_transcribe_chunk) but customize the name with thread context.
  const selectedFlowStep = useMemo(() => {
    if (!selectedStepId) return null;
    // Try direct lookup first (main pipeline steps)
    const direct = flowDefinition.steps.find(s => s.id === selectedStepId);
    if (direct) return direct;
    // Try chunk thread step resolution
    const genericId = resolveChunkStepId(selectedStepId);
    if (!genericId) return null;
    const generic = flowDefinition.steps.find(s => s.id === genericId);
    if (!generic) return null;
    // Extract thread label from the step ID (e.g. "chunk-0" from "chunk-0-transcribe")
    const lastDash = selectedStepId.lastIndexOf('-');
    const threadPart = selectedStepId.slice(0, lastDash);
    return { ...generic, name: `${generic.name} (${threadPart})` };
  }, [selectedStepId, flowDefinition]);

  // Get the execution data for the selected step (works for both main + chunk steps)
  const selectedExecution = selectedStepId ? stepExecutions[selectedStepId] : undefined;

  // Activity text
  const activity = useMemo(() => {
    const active = pipelineSteps.find(s => s.status === 'active');
    return active ? `${active.label}...` : undefined;
  }, [pipelineSteps]);

  // Build execution list for analysis — all steps + chunk sub-steps
  const allExecutions = useMemo(() => {
    const entries: Array<{ id: string; label: string; execution: StepExecution }> = [];
    // Main pipeline steps
    for (const id of STEP_ORDER) {
      if (stepExecutions[id]) {
        const step = pipelineSteps.find(s => s.id === id);
        entries.push({ id, label: step?.label || id, execution: stepExecutions[id] });
      }
    }
    // Per-chunk thread step executions
    for (const thread of chunkThreads) {
      for (const step of thread.steps) {
        if (stepExecutions[step.id]) {
          entries.push({ id: step.id, label: `${thread.label} > ${step.label}`, execution: stepExecutions[step.id] });
        }
      }
    }
    // Synthetic LLM execution if present
    if (stepExecutions['pipeline_llm_classify']) {
      entries.push({ id: 'pipeline_llm_classify', label: 'LLM Ad Classification', execution: stepExecutions['pipeline_llm_classify'] });
    }
    return entries;
  }, [stepExecutions, pipelineSteps, chunkThreads]);

  const isIdle = pipelineStatus === 'idle';

  return (
    <div className="sb-page">
      {/* Header */}
      <header className="sb-header">
        <button className="sb-back" onClick={onBack}>Back</button>
        <div className="sb-header-center">
          <h1 className="sb-title">Pipeline Debug</h1>
          {episode && <span className="sb-header-ep">{episode.title}</span>}
        </div>
        <button
          className={`sb-copy-feedback ${copyState === 'copied' ? 'copied' : ''}`}
          onClick={handleCopyFeedback}
          title="Copy pipeline debug info"
        >
          {copyState === 'copied' ? 'Copied!' : 'Copy Feedback'}
        </button>
      </header>

      {/* Idle state */}
      {isIdle && (
        <div className="sb-error-full">
          <div className="sb-error-icon">?</div>
          <p>No pipeline running. Select an episode on the main screen to start.</p>
          <button className="sb-retry-btn" onClick={onBack}>Go Back</button>
        </div>
      )}

      {/* Active / complete state */}
      {!isIdle && (
        <div className="sb-body">
          {/* bilko-flow FlowProgress replaces custom tracker */}
          <div className="sb-tracker">
            <FlowErrorBoundary>
              <FlowProgress
                mode="expanded"
                steps={pipelineSteps}
                parallelThreads={chunkThreads}
                parallelConfig={parallelConfig}
                status={pipelineStatus}
                label="Ad Detection Pipeline"
                activity={activity}
                onStepClick={handleStepClick}
              />
            </FlowErrorBoundary>
          </div>

          {/* StepDetail panel — bilko-flow's rich step inspection */}
          {selectedFlowStep && (
            <div className="sb-detail-panel" ref={detailRef}>
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <h2 className="text-sm font-medium text-gray-400">Step Inspector</h2>
                <button
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  onClick={() => setSelectedStepId(null)}
                >
                  Close
                </button>
              </div>
              <StepDetail
                step={selectedFlowStep}
                flow={flowDefinition}
                execution={selectedExecution}
              />
            </div>
          )}

          {/* When no step is selected: show waterfall + execution call log */}
          {!selectedStepId && (
            <div className="sb-no-selection">
              <FlowErrorBoundary>
                <PipelineWaterfall
                  steps={pipelineSteps}
                  status={pipelineStatus}
                  parallelThreads={chunkThreads}
                  label="Ad Detection Pipeline"
                  activity={activity}
                />
              </FlowErrorBoundary>

              {/* Execution call log — analyze every call */}
              {allExecutions.length > 0 && (
                <div className="mt-4 border border-gray-700 rounded-lg overflow-hidden">
                  <div className="bg-gray-800/50 px-4 py-2 border-b border-gray-700">
                    <h3 className="text-sm font-medium text-gray-300">Call Log</h3>
                    <p className="text-xs text-gray-500">Every call made during pipeline execution</p>
                  </div>
                  <div className="divide-y divide-gray-800">
                    {allExecutions.map(({ id, label, execution }) => (
                      <button
                        key={id}
                        className="w-full text-left px-4 py-2.5 hover:bg-gray-800/30 transition-colors flex items-center gap-3"
                        onClick={() => {
                          // Main pipeline step or chunk thread step → open StepDetail
                          if (flowDefinition.steps.find(s => s.id === id) || resolveChunkStepId(id)) {
                            setSelectedStepId(id);
                          }
                        }}
                      >
                        {/* Status indicator */}
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          execution.status === 'success' ? 'bg-green-500' :
                          execution.status === 'error' ? 'bg-red-500' :
                          execution.status === 'running' ? 'bg-blue-500 animate-pulse' :
                          'bg-gray-600'
                        }`} />

                        {/* Label and type */}
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-gray-200">{label}</span>
                          {execution.durationMs != null && (
                            <span className="text-xs text-gray-500 ml-2">
                              {execution.durationMs < 1000 ? `${execution.durationMs}ms` : `${(execution.durationMs / 1000).toFixed(1)}s`}
                            </span>
                          )}
                        </div>

                        {/* Quick data preview */}
                        <div className="text-xs text-gray-500 flex-shrink-0">
                          {execution.output && typeof execution.output === 'object' && (
                            <span className="font-mono">
                              {Object.keys(execution.output as Record<string, unknown>).length} fields
                            </span>
                          )}
                          {execution.rawResponse && (
                            <span className="ml-2 text-amber-600">LLM</span>
                          )}
                          {execution.error && (
                            <span className="text-red-400">{execution.error.slice(0, 40)}</span>
                          )}
                        </div>

                        {/* Chevron */}
                        <span className="text-gray-600 text-xs">{'>'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="sb-no-selection-hint">Click a step in the tracker or call log to inspect its execution data.</p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
