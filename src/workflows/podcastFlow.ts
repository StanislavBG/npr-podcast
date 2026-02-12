import {
  type Workflow,
  type Step,
  WorkflowStatus,
  DeterminismGrade,
} from 'bilko-flow';
import type { FlowProgressStep } from 'bilko-flow/react';

/**
 * Podcast processing workflow using bilko-flow DSL.
 *
 * Every post-episode-selection step uses bilko-flow LLM components.
 * No regex. No word-count heuristics. chatJSON all the way down.
 *
 * Pipeline:
 *   1. fetch_rss            – Pull the podcast RSS feed          (http.request)
 *   2. parse_episodes       – Extract episode list from XML      (http.request — server parses)
 *   3. fetch_transcript     – Get NPR transcript HTML            (http.request)
 *   4. llm_parse_transcript – LLM extracts structured segments   (ai.generate-text)
 *   5. llm_detect_ads       – LLM identifies ad time ranges      (ai.generate-text)
 *   6. llm_prepare_player   – LLM builds skip-map + summary      (ai.summarize)
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
      type: 'http.request',
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
      id: 'step_llm_parse_transcript',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'LLM Parse Transcript',
      type: 'ai.generate-text',
      dependsOn: ['step_fetch_transcript'],
      inputs: {
        prompt: 'Extract structured transcript segments with speakers from raw HTML. Identify all sponsor/ad language.',
        model: 'configurable',
      },
      policy: { timeoutMs: 30000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'LLM Provider',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_llm_detect_ads',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'LLM Detect Ads',
      type: 'ai.generate-text',
      dependsOn: ['step_llm_parse_transcript'],
      inputs: {
        prompt: 'Given parsed transcript and audio duration, identify ad segments with precise time ranges, types, and confidence scores.',
        model: 'configurable',
      },
      policy: { timeoutMs: 30000, maxAttempts: 3 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'LLM Provider',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
    {
      id: 'step_llm_prepare_player',
      workflowId: `wf_podcast_${podcastId}`,
      name: 'LLM Prepare Player',
      type: 'ai.summarize',
      dependsOn: ['step_llm_detect_ads'],
      inputs: {
        prompt: 'Summarize episode content and produce final playback configuration with skip-map.',
        model: 'configurable',
        output: 'playback_config',
      },
      policy: { timeoutMs: 30000, maxAttempts: 2 },
      determinism: {
        usesExternalApis: true,
        pureFunction: false,
        externalDependencies: [
          {
            name: 'LLM Provider',
            kind: 'http-api',
            deterministic: false,
            evidenceCapture: 'response-hash',
          },
        ],
      },
    },
  ];

  return {
    id: `wf_podcast_${podcastId}`,
    accountId: 'acct_npr_player',
    projectId: 'proj_npr_podcast',
    environmentId: 'env_browser',
    name: `Podcast Processing: ${podcastId}`,
    version: 2,
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

// ─── Step metadata for flow visualizer ────────────────────────────────────

const STEP_META: Record<string, { label: string; type: string }> = {
  step_fetch_rss:              { label: 'Fetch RSS Feed',         type: 'http.request' },
  step_parse_episodes:         { label: 'Parse Episodes',         type: 'http.request' },
  step_fetch_transcript:       { label: 'Fetch Transcript',       type: 'http.request' },
  step_llm_parse_transcript:   { label: 'LLM Parse Transcript',   type: 'ai.generate-text' },
  step_llm_detect_ads:         { label: 'LLM Detect Ads',         type: 'ai.generate-text' },
  step_llm_prepare_player:     { label: 'LLM Prepare Player',     type: 'ai.summarize' },
};

const STEP_ORDER = [
  'step_fetch_rss',
  'step_parse_episodes',
  'step_fetch_transcript',
  'step_llm_parse_transcript',
  'step_llm_detect_ads',
  'step_llm_prepare_player',
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
    steps: Object.fromEntries(STEP_ORDER.map((id) => [id, 'pending' as StepStatus])),
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

/** Export step order for consumers */
export { STEP_ORDER, STEP_META };
