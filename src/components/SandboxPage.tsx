import { useState, useCallback } from 'react';
import { resolveStepMeta } from 'bilko-flow/react/components';
import type {
  FlowProgressStep,
  ParallelThread,
  ParallelConfig,
  StepExecution,
  FlowDefinition,
} from 'bilko-flow/react/components';
import { PipelineTracker } from './PipelineTracker';
import { PodcastSelector } from './PodcastSelector';
import { EpisodeList } from './EpisodeList';
import { Player } from './Player';
import type { AdDetectionResult } from '../services/adDetector';
import {
  formatTimestamp,
  type SandboxResult,
  type Episode,
  type Podcast,
} from '../services/api';

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
  // Podcast/episode selection (shared with main app)
  podcasts: Podcast[];
  episodes: Episode[];
  selectedPodcast: string;
  episodesLoading: boolean;
  onSelectPodcast: (id: string) => void;
  onSelectEpisode: (ep: Episode) => void;
  // Audio player (persistent across pages)
  adDetection: AdDetectionResult | null;
  scanProgress?: { totalChunks: number; completedChunks: Set<number> };
  audioRef?: React.RefObject<HTMLAudioElement | null>;
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
  podcasts,
  episodes,
  selectedPodcast,
  episodesLoading,
  onSelectPodcast,
  onSelectEpisode,
  adDetection,
  scanProgress,
  audioRef,
}: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

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

  const handleStepSelect = useCallback((stepId: string | null) => {
    setSelectedStepId(prev => prev === stepId ? null : stepId);
  }, []);

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

      {/* Podcast & episode selection — always visible in sandbox */}
      <div className="sb-selector-bar">
        <PodcastSelector
          podcasts={podcasts}
          selected={selectedPodcast}
          onSelect={onSelectPodcast}
        />
        <EpisodeList
          episodes={episodes}
          loading={episodesLoading}
          selectedId={episode?.id || null}
          onSelect={onSelectEpisode}
        />
      </div>

      {/* Audio player — persistent across page navigation */}
      {episode && (
        <div className="sb-player">
          <Player
            episode={episode}
            adDetection={adDetection}
            scanProgress={scanProgress}
            pipelineStatus={pipelineStatus}
            audioRef={audioRef}
          />
        </div>
      )}

      {/* Active / complete state — custom PipelineTracker */}
      {!isIdle && (
        <div className="sb-body">
          <div className="sb-tracker">
            <PipelineTracker
              steps={pipelineSteps}
              chunkThreads={chunkThreads}
              status={pipelineStatus}
              stepExecutions={stepExecutions}
              selectedStepId={selectedStepId}
              onStepSelect={handleStepSelect}
            />
          </div>
        </div>
      )}
    </div>
  );
}
