import {
  type Workflow,
  type Step,
  WorkflowStatus,
  DeterminismGrade,
} from 'bilko-flow';
import type { FlowDefinition, FlowProgressStep } from 'bilko-flow/react';

/**
 * Podcast processing workflow using bilko-flow DSL.
 *
 * Pipeline:
 *   1. fetch_rss       – Pull the podcast RSS feed
 *   2. parse_episodes  – Extract episode list from XML
 *   3. fetch_transcript – Get NPR transcript for selected episode
 *   4. detect_ads       – Analyze transcript to find ad/sponsor segments
 *   5. prepare_player   – Build skip-map and emit playback-ready data
 */

export function createPodcastWorkflow(podcastId: string): Workflow {
  const steps: Step[] = [
    {
      id: 'step_fetch_rss',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Fetch RSS Feed',
      type: 'http.request',
      dependsOn: [],
      inputs: {
        url: `/api/podcast/${podcastId}/episodes`,
        method: 'GET',
      },
      policy: { timeoutMs: 15000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'NPR RSS Feed',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_parse_episodes',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Parse Episodes',
      type: 'transform.map',
      dependsOn: ['step_fetch_rss'],
      inputs: { transform: 'extract_episode_metadata' },
      policy: { timeoutMs: 5000, maxAttempts: 1 },
      determinism: { pureFunction: true },
    },
    {
      id: 'step_fetch_transcript',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Fetch Transcript',
      type: 'http.request',
      dependsOn: ['step_parse_episodes'],
      inputs: { url: '/api/transcript', method: 'GET' },
      policy: { timeoutMs: 15000, maxAttempts: 2 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'NPR Transcript Page',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_detect_ads',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Detect Ad Segments',
      type: 'transform.filter',
      dependsOn: ['step_fetch_transcript'],
      inputs: { strategy: 'transcript_gap_analysis' },
      policy: { timeoutMs: 10000, maxAttempts: 1 },
      determinism: { pureFunction: true },
    },
    {
      id: 'step_prepare_player',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'Prepare Player',
      type: 'transform.reduce',
      dependsOn: ['step_detect_ads'],
      inputs: { output: 'playback_config' },
      policy: { timeoutMs: 5000, maxAttempts: 1 },
      determinism: { pureFunction: true },
    },
  ];

  return {
    id: `wf_podcast_${podcastId}`,
    accountId: 'acct_npr_player',
    projectId: 'proj_npr_podcast',
    environmentId: 'env_browser',
    name: `Podcast Processing: ${podcastId}`,
    version: 1,
    specVersion: '1.0.0',
    status: WorkflowStatus.Active,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    determinism: { targetGrade: DeterminismGrade.BestEffort },
    entryStepId: 'step_fetch_rss',
    steps,
    secrets: [],
  };
}

/** Step metadata for the flow visualizer */
const STEP_META: Record<string, { label: string; type: string }> = {
  step_fetch_rss:        { label: 'Fetch RSS Feed',     type: 'external-input' },
  step_parse_episodes:   { label: 'Parse Episodes',     type: 'transform' },
  step_fetch_transcript: { label: 'Fetch Transcript',   type: 'external-input' },
  step_detect_ads:       { label: 'Detect Ad Segments', type: 'transform' },
  step_prepare_player:   { label: 'Prepare Player',     type: 'display' },
};

const STEP_ORDER = [
  'step_fetch_rss',
  'step_parse_episodes',
  'step_fetch_transcript',
  'step_detect_ads',
  'step_prepare_player',
];

/** Internal step tracking status */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface FlowState {
  steps: Record<string, StepStatus>;
  currentStep: string | null;
  error: string | null;
}

export function createInitialFlowState(): FlowState {
  return {
    steps: {
      step_fetch_rss: 'pending',
      step_parse_episodes: 'pending',
      step_fetch_transcript: 'pending',
      step_detect_ads: 'pending',
      step_prepare_player: 'pending',
    },
    currentStep: null,
    error: null,
  };
}

/** Bilko-flow progress step status values */
export type ProgressStepStatus = 'pending' | 'active' | 'complete' | 'error';

/** Map internal status to bilko-flow FlowProgressStep status */
function mapStatus(s: StepStatus): FlowProgressStep['status'] {
  switch (s) {
    case 'running': return 'active';
    case 'completed': return 'complete';
    case 'failed': return 'error';
    case 'skipped': return 'complete';
    default: return 'pending';
  }
}

/** Convert our FlowState to bilko-flow FlowProgressStep array */
export function toFlowProgressSteps(state: FlowState): FlowProgressStep[] {
  return STEP_ORDER.map((id) => ({
    id,
    label: STEP_META[id].label,
    status: mapStatus(state.steps[id]),
    type: STEP_META[id].type,
  }));
}

/** Build a bilko-flow FlowDefinition for canvas visualization */
export function toFlowDefinition(podcastId: string): FlowDefinition {
  return {
    id: `wf_podcast_${podcastId}`,
    name: 'NPR Podcast Pipeline',
    description: 'Fetch, parse, transcript, detect ads, play',
    version: '1.0.0',
    tags: ['podcast', 'npr', 'ad-skip'],
    steps: STEP_ORDER.map((id) => ({
      id,
      name: STEP_META[id].label,
      type: STEP_META[id].type as any,
      description: STEP_META[id].label,
      dependsOn: id === 'step_fetch_rss' ? [] : [STEP_ORDER[STEP_ORDER.indexOf(id) - 1]],
    })),
  };
}

/** Get overall flow status */
export function getFlowStatus(state: FlowState): 'idle' | 'running' | 'complete' | 'error' {
  const statuses = Object.values(state.steps);
  if (statuses.some((s) => s === 'failed')) return 'error';
  if (statuses.some((s) => s === 'running')) return 'running';
  if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'complete';
  return 'idle';
}

/** Get activity description for the current step */
export function getFlowActivity(state: FlowState): string {
  if (!state.currentStep) return '';
  const meta = STEP_META[state.currentStep];
  return meta ? `${meta.label}...` : '';
}
