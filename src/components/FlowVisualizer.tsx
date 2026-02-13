import { FlowProgress } from 'bilko-flow/react';
import {
  type FlowState,
  toFlowProgressSteps,
  getFlowStatus,
  getFlowActivity,
} from '../workflows/podcastFlow';

interface Props {
  flowState: FlowState;
}

export function FlowVisualizer({ flowState }: Props) {
  const steps = toFlowProgressSteps(flowState);
  const status = getFlowStatus(flowState);
  const activity = getFlowActivity(flowState);

  return (
    <div className="flow-widget">
      <FlowProgress
        mode="vertical"
        steps={steps}
        label="NPR Podcast Pipeline"
        status={status}
        activity={activity}
        theme={{
          activeColor: 'bg-indigo-500',
          completedColor: 'bg-green-600',
          errorColor: 'bg-red-500',
          pendingColor: 'bg-gray-700',
          stepColors: {
            'http.request': 'bg-blue-600',
            'ai.generate-text': 'bg-purple-500',
            'ai.summarize': 'bg-violet-600',
            'external-input': 'bg-blue-600',
            transform: 'bg-purple-600',
            llm: 'bg-purple-500',
            display: 'bg-emerald-600',
          },
          activeTextColor: 'text-indigo-200',
          completedTextColor: 'text-green-200',
          errorTextColor: 'text-red-200',
          pendingTextColor: 'text-gray-400',
        }}
      />
    </div>
  );
}
