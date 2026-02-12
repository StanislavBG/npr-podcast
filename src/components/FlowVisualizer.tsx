import {
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Globe,
  ArrowRightLeft,
  Monitor,
} from 'lucide-react';
import {
  type FlowState,
  type ProgressStepStatus,
  toFlowProgressSteps,
  getFlowStatus,
  getFlowActivity,
} from '../workflows/podcastFlow';

interface Props {
  flowState: FlowState;
}

function StepIcon({ type }: { type?: string }) {
  switch (type) {
    case 'external-input':
      return <Globe size={14} />;
    case 'transform':
      return <ArrowRightLeft size={14} />;
    case 'display':
      return <Monitor size={14} />;
    default:
      return <Circle size={14} />;
  }
}

function StatusIndicator({ status }: { status: ProgressStepStatus }) {
  switch (status) {
    case 'complete':
      return <CheckCircle2 size={14} className="flow-step-icon-done" />;
    case 'active':
      return <Loader2 size={14} className="flow-step-icon-active" />;
    case 'error':
      return <XCircle size={14} className="flow-step-icon-error" />;
    default:
      return <Circle size={6} className="flow-step-icon-pending" />;
  }
}

export function FlowVisualizer({ flowState }: Props) {
  const steps = toFlowProgressSteps(flowState);
  const status = getFlowStatus(flowState);
  const activity = getFlowActivity(flowState);

  return (
    <div className="flow-widget">
      <div className="flow-widget-header">
        <span className="flow-widget-title">Pipeline</span>
        <span className="flow-widget-badge">bilko-flow</span>
      </div>

      <div className="flow-stack">
        {steps.map((step, i) => (
          <div key={step.id} className={`flow-step flow-step--${step.status}`}>
            <div className="flow-step-type">
              <StepIcon type={step.type} />
            </div>
            {i < steps.length - 1 && <div className="flow-step-line" />}
            <div className="flow-step-body">
              <span className="flow-step-label">{step.label}</span>
            </div>
            <div className="flow-step-status">
              <StatusIndicator status={step.status} />
            </div>
          </div>
        ))}
      </div>

      {status === 'running' && activity && (
        <div className="flow-activity">{activity}</div>
      )}
    </div>
  );
}
