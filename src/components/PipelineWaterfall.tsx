/**
 * PipelineWaterfall — vertical pipeline visualization with fork/parallel support.
 *
 * Renders steps as a vertical waterfall. When parallelThreads are present,
 * they appear as side-by-side mini-waterfalls after the fork point.
 *
 * NOTE: This component will be proposed as a bilko-flow feature
 * (vertical mode with parallelThreads). Until then it lives here
 * as a project-specific visualization using bilko-flow types.
 */
import type { FlowProgressStep, ParallelThread } from 'bilko-flow/react/components';
import { resolveStepMeta } from 'bilko-flow/react/components';
import { FORK_INDEX } from '../workflows/podcastFlow';

interface PipelineWaterfallProps {
  steps: FlowProgressStep[];
  status: 'idle' | 'running' | 'complete' | 'error';
  parallelThreads?: ParallelThread[];
  label?: string;
  activity?: string;
}

function statusClass(status: string): string {
  switch (status) {
    case 'complete': return 'pw-complete';
    case 'active': return 'pw-active';
    case 'error': return 'pw-error';
    case 'skipped': return 'pw-skipped';
    default: return 'pw-pending';
  }
}

function StepRow({ step, isLast, index }: { step: FlowProgressStep; isLast: boolean; index?: number }) {
  const meta = resolveStepMeta(step.meta);
  const msg = meta.message || meta.error || meta.skipReason || '';

  return (
    <div className="pw-step">
      <div className="pw-rail">
        <div className={`pw-dot ${statusClass(step.status)}`} />
        {!isLast && <div className={`pw-line ${step.status === 'complete' ? 'pw-line-done' : ''}`} />}
      </div>
      <div className="pw-step-body">
        <div className="pw-step-row">
          {index != null && <span className="pw-step-num">{index + 1}</span>}
          <span className={`pw-step-label ${step.status === 'skipped' ? 'pw-label-skipped' : ''}`}>
            {step.label}
          </span>
        </div>
        {msg && <div className="pw-step-meta">{msg}</div>}
      </div>
    </div>
  );
}

function ThreadColumn({ thread }: { thread: ParallelThread }) {
  return (
    <div className={`pw-thread pw-thread-${thread.status}`}>
      <div className="pw-thread-header">
        <div className={`pw-dot pw-dot-sm ${statusClass(thread.status)}`} />
        <span className="pw-thread-title">{thread.label}</span>
      </div>
      <div className="pw-thread-steps">
        {thread.steps.map((step, i) => {
          const meta = resolveStepMeta(step.meta);
          const msg = meta.message || meta.error || '';
          return (
            <div key={step.id} className="pw-thread-step">
              <div className="pw-rail pw-rail-sm">
                <div className={`pw-dot pw-dot-xs ${statusClass(step.status)}`} />
                {i < thread.steps.length - 1 && (
                  <div className={`pw-line pw-line-sm ${step.status === 'complete' ? 'pw-line-done' : ''}`} />
                )}
              </div>
              <span className={`pw-thread-step-label ${step.status === 'complete' ? 'pw-done-text' : ''}`}>
                {step.label}
              </span>
              {msg && step.status === 'active' && (
                <span className="pw-thread-step-meta">{msg}</span>
              )}
            </div>
          );
        })}
      </div>
      {thread.activity && thread.status === 'running' && (
        <div className="pw-thread-activity">{thread.activity}</div>
      )}
      {thread.error && (
        <div className="pw-thread-error">{thread.error}</div>
      )}
    </div>
  );
}

export function PipelineWaterfall({ steps, status, parallelThreads, label, activity }: PipelineWaterfallProps) {
  const preFork = steps.slice(0, FORK_INDEX);
  const postJoin = steps.slice(FORK_INDEX);
  const hasThreads = parallelThreads && parallelThreads.length > 0;
  const showFork = hasThreads || preFork.some(s => s.status === 'complete' || s.status === 'active');

  const statusLabel = status === 'running' ? 'Running'
    : status === 'complete' ? 'Done'
    : status === 'error' ? 'Error' : 'Idle';

  return (
    <div className={`pw-container pw-status-${status}`}>
      {/* Header */}
      {label && (
        <div className="pw-header">
          <div className={`pw-header-dot ${statusClass(status)}`} />
          <span className="pw-header-label">{label}</span>
          <span className={`pw-header-status pw-hs-${status}`}>{statusLabel}</span>
          {activity && <span className="pw-header-activity">{activity}</span>}
        </div>
      )}

      {/* Pre-fork steps */}
      <div className="pw-steps">
        {preFork.map((step, i) => (
          <StepRow key={step.id} step={step} index={i} isLast={i === preFork.length - 1 && !showFork} />
        ))}
      </div>

      {/* Fork + parallel threads */}
      {showFork && (
        <>
          {/* Connector from last pre-fork step into fork */}
          <div className="pw-rail" style={{ paddingLeft: 11, height: 4 }}>
            <div className="pw-line pw-line-done" style={{ height: '100%' }} />
          </div>

          <div className="pw-fork-indicator">
            <span className="pw-fork-text">fork</span>
          </div>

          {hasThreads ? (
            <div className="pw-threads">
              {parallelThreads!.map(thread => (
                <ThreadColumn key={thread.id} thread={thread} />
              ))}
            </div>
          ) : (
            <div className="pw-threads-pending">
              Waiting for chunks...
            </div>
          )}

          {/* Connector from threads to post-join */}
          {postJoin.length > 0 && (
            <>
              <div className="pw-rail" style={{ paddingLeft: 11, height: 4 }}>
                <div className="pw-line" style={{ height: '100%' }} />
              </div>
            </>
          )}
        </>
      )}

      {/* Post-join steps */}
      {postJoin.length > 0 && (
        <div className="pw-steps">
          {postJoin.map((step, i) => (
            <StepRow key={step.id} step={step} index={FORK_INDEX + i} isLast={i === postJoin.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}
