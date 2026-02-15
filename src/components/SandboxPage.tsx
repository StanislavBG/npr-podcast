import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { FlowErrorBoundary, resolveStepMeta } from 'bilko-flow/react/components';
import type { FlowProgressStep, ParallelThread, ParallelConfig } from 'bilko-flow/react/components';
import { PipelineWaterfall } from './PipelineWaterfall';
import {
  formatTime,
  formatTimestamp,
  type SandboxResult,
  type Episode,
} from '../services/api';
import { STEP_ORDER, STEP_META } from '../workflows/podcastFlow';

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
}

// ─── Unified step definitions (includes virtual "chunk processing" step) ─────

interface StepDef {
  id: string;
  label: string;
  subtitle: string;
  type: string;
}

const ALL_STEPS: StepDef[] = [
  ...STEP_ORDER.slice(0, 4).map(id => ({
    id,
    label: STEP_META[id].label,
    type: STEP_META[id].type,
    subtitle: {
      step_fetch_rss:              'Pull podcast RSS feed from NPR',
      step_parse_episodes:         'Extract episode metadata from feed',
      step_resolve_audio_stream:   'Resolve CDN URL, get audio metadata',
      step_plan_chunks:            'Calculate 1 MB byte-range chunks for parallel processing',
    }[id] || '',
  })),
  // Virtual step for chunk processing
  {
    id: 'step_chunk_processing',
    label: 'Chunk Processing',
    subtitle: 'Fetch → Transcribe → Classify → Refine → Emit (per chunk, parallel)',
    type: 'ai.speech-to-text',
  },
  ...STEP_ORDER.slice(4).map(id => ({
    id,
    label: STEP_META[id].label,
    type: STEP_META[id].type,
    subtitle: {
      step_fetch_html_transcript:  'Fetch NPR HTML transcript for cross-reference',
      step_finalize_playback:      'Reconcile + summary + build player config',
    }[id] || '',
  })),
];

// ─── Copy Feedback: accumulate debug info for agent/developer ────────────────

function buildFeedbackText(
  result: SandboxResult | null,
  pipelineSteps: FlowProgressStep[],
  pipelineStatus: string,
  episode: Episode | null,
  podcastName: string,
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
    const icon = step.status === 'complete' ? '[OK]' :
                 step.status === 'error' ? '[ERROR]' :
                 step.status === 'skipped' ? '[SKIP]' :
                 step.status === 'active' ? '[RUNNING]' : '[PENDING]';
    lines.push(`${icon} ${step.label}: ${msg}`);
  }
  lines.push('');

  const errorSteps = pipelineSteps.filter(s => s.status === 'error');
  if (errorSteps.length > 0) {
    lines.push('## Errors');
    for (const step of errorSteps) {
      const resolved = resolveStepMeta(step.meta);
      lines.push(`### ${step.label}`);
      lines.push(`- Step ID: ${step.id}`);
      lines.push(`- Type: ${step.type || 'unknown'}`);
      lines.push(`- Error: ${resolved.error || 'Unknown error'}`);
      lines.push('');
    }
  }

  if (result) {
    lines.push('## Analysis Results');
    lines.push('### Transcript');
    lines.push(`- Source: ${result.transcriptSource || 'unknown'}`);
    lines.push(`- Lines: ${result.transcript.lines.length}`);
    lines.push(`- Total words: ${result.transcript.totalWords}`);
    if (result.validation) {
      lines.push(`- Validation: ${result.validation.isValid ? 'PASS' : 'FAIL'} — ${result.validation.reason}`);
    }
    lines.push('');

    lines.push('### Ad Detection');
    lines.push(`- Strategy: ${result.summary.strategy}`);
    lines.push(`- Ad blocks: ${result.summary.totalAdBlocks}`);
    lines.push(`- Ad time: ${result.summary.totalAdTimeSec}s`);
    lines.push(`- Content time: ${result.summary.contentTimeSec}s`);
    lines.push(`- Ad word %: ${result.summary.adWordPercent}%`);
    lines.push('');

    lines.push('### Skip Map');
    if (result.skipMap.length === 0) {
      lines.push('(empty — no ads detected or skip map generation failed)');
    } else {
      for (const s of result.skipMap) {
        lines.push(`- ${formatTimestamp(s.startTime)} → ${formatTimestamp(s.endTime)} | conf: ${s.confidence} | ${s.reason}`);
      }
    }
    lines.push('');

    if (result.audioDetails) {
      const a = result.audioDetails;
      lines.push('### Audio');
      lines.push(`- Available: ${a.available}`);
      if (a.error) lines.push(`- Error: ${a.error}`);
      lines.push(`- Original URL: ${a.originalUrl}`);
      lines.push(`- Resolved URL: ${a.resolvedUrl || '(same)'}`);
      lines.push(`- Content-Type: ${a.contentType || 'unknown'}`);
      lines.push(`- Size: ${a.contentLengthBytes > 0 ? `${(a.contentLengthBytes / 1024 / 1024).toFixed(1)} MB` : 'unknown'}`);
      lines.push(`- Segments: ${a.segmentCount}`);
      lines.push(`- Model: ${a.transcriptionModel}`);
      lines.push('');
    }

    if (result.qa) {
      lines.push('### QA Metrics');
      lines.push(`- Audio duration: ${result.qa.audioDurationSec}s`);
      lines.push(`- Transcript words: ${result.qa.transcriptWords}`);
      lines.push(`- Speech rate: ${result.qa.speechRateWpm} wpm`);
      lines.push(`- Expected speech: ${result.qa.expectedSpeechSec}s`);
      lines.push(`- Implied ad time: ${result.qa.impliedAdTimeSec}s`);
      lines.push('');
    }

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

// ─── Detail panel sub-section ────────────────────────────────────────────────

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="sb-detail-section">
      <h3 className="sb-detail-section-title">{title}</h3>
      <div className="sb-detail-section-body">{children}</div>
    </div>
  );
}

// ─── Per-step detail renderers (INPUT / CONFIG / OUTPUT) ─────────────────────

function DetailFetchRss({ podcastName, podcastId, pipelineStep }: { podcastName: string; podcastId: string; pipelineStep?: FlowProgressStep }) {
  const meta = resolveStepMeta(pipelineStep?.meta);
  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Podcast</span><span className="sb-kv-v">{podcastName}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Feed ID</span><span className="sb-kv-v">{podcastId}</span></div>
        </div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Endpoint</span><span className="sb-kv-v">/api/podcast/{podcastId}/episodes</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Method</span><span className="sb-kv-v">GET</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">15000ms</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Max attempts</span><span className="sb-kv-v">3</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        {meta.message && <div className="sb-qa-ok">{meta.message}</div>}
        {meta.error && <div className="sb-qa-alert">{meta.error}</div>}
        {!meta.message && !meta.error && <div className="sb-qa-callout">Waiting for result...</div>}
      </DetailSection>
    </>
  );
}

function DetailParseEpisodes({ result, pipelineStep }: { result: SandboxResult | null; pipelineStep?: FlowProgressStep }) {
  const meta = resolveStepMeta(pipelineStep?.meta);
  if (!result) {
    return (
      <>
        <DetailSection title="INPUT">
          <div className="sb-qa-callout">RSS feed XML from Step 1</div>
        </DetailSection>
        <DetailSection title="CONFIG">
          <div className="sb-kv-grid">
            <div className="sb-kv"><span className="sb-kv-k">Transform</span><span className="sb-kv-v">extract_episode_metadata</span></div>
          </div>
        </DetailSection>
        <DetailSection title="OUTPUT">
          {meta.message && <div className="sb-qa-ok">{meta.message}</div>}
          {meta.error && <div className="sb-qa-alert">{meta.error}</div>}
          {!meta.message && !meta.error && <div className="sb-qa-callout">Waiting...</div>}
        </DetailSection>
      </>
    );
  }

  const { episode } = result;
  const audio = result.audioDetails;
  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-qa-callout">RSS feed XML from Step 1 (parsed by server)</div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Transform</span><span className="sb-kv-v">extract_episode_metadata</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">5000ms</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        <h4 className="sb-detail-subtitle">{episode.title}</h4>
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Duration</span><span className="sb-kv-v">{formatTime(episode.durationSec)} ({episode.durationSec}s)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Transcript URL</span><span className="sb-kv-v sb-kv-url">{episode.transcriptUrl || '(none)'}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Audio URL</span><span className="sb-kv-v">{audio?.available ? 'Available' : 'Not available'}</span></div>
        </div>
      </DetailSection>
    </>
  );
}

function DetailResolveAudio({ result, pipelineStep }: { result: SandboxResult | null; pipelineStep?: FlowProgressStep }) {
  const meta = resolveStepMeta(pipelineStep?.meta);
  const audio = result?.audioDetails;

  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Audio URL</span><span className="sb-kv-v sb-kv-url">{audio?.originalUrl || '(from episode metadata)'}</span></div>
        </div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Method</span><span className="sb-kv-v">HEAD (follow redirects)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">10000ms</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Max attempts</span><span className="sb-kv-v">3</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Purpose</span><span className="sb-kv-v">Resolve CDN URL, get Content-Length/Type</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        {!audio || !audio.available ? (
          <div className="sb-qa-alert">No audio URL available — audio pipeline skipped.</div>
        ) : (
          <>
            <div className="sb-kv-grid">
              <div className="sb-kv"><span className="sb-kv-k">Resolved URL</span><span className="sb-kv-v sb-kv-url">{audio.resolvedUrl || '(same)'}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Content-Type</span><span className="sb-kv-v">{audio.contentType || '(unknown)'}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Content-Length</span><span className="sb-kv-v">{audio.contentLengthBytes > 0 ? `${(audio.contentLengthBytes / 1024 / 1024).toFixed(1)} MB (${audio.contentLengthBytes.toLocaleString()} bytes)` : '(unknown)'}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Redirected</span><span className="sb-kv-v">{audio.resolvedUrl && audio.resolvedUrl !== audio.originalUrl ? 'Yes' : 'No'}</span></div>
            </div>
            {audio.contentLengthBytes > 25 * 1024 * 1024 && (
              <div className="sb-qa-callout">
                Audio file exceeds Whisper's 25 MB limit — chunked processing required.
              </div>
            )}
          </>
        )}
        {meta.error && <div className="sb-qa-alert">{meta.error}</div>}
      </DetailSection>
    </>
  );
}

function DetailPlanChunks({ result, pipelineStep }: { result: SandboxResult | null; pipelineStep?: FlowProgressStep }) {
  const meta = resolveStepMeta(pipelineStep?.meta);
  const audio = result?.audioDetails;
  const CHUNK_SIZE_BYTES = 1_048_576;

  if (!audio || !audio.available) {
    return (
      <>
        <DetailSection title="INPUT"><div className="sb-qa-alert">Audio not available — step skipped.</div></DetailSection>
        <DetailSection title="CONFIG"><div className="sb-qa-callout">N/A</div></DetailSection>
        <DetailSection title="OUTPUT"><div className="sb-qa-alert">No chunks planned.</div></DetailSection>
      </>
    );
  }

  const fileSizeMb = audio.contentLengthBytes > 0 ? (audio.contentLengthBytes / 1024 / 1024).toFixed(1) : audio.downloadSizeMb;
  const estimatedChunks = audio.contentLengthBytes > 0 ? Math.ceil(audio.contentLengthBytes / CHUNK_SIZE_BYTES) : 0;
  const chunkDurationSec = Math.round(CHUNK_SIZE_BYTES / (128000 / 8));

  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">File size</span><span className="sb-kv-v">{fileSizeMb} MB ({audio.contentLengthBytes.toLocaleString()} bytes)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Format</span><span className="sb-kv-v">{audio.contentType}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Resolved URL</span><span className="sb-kv-v sb-kv-url">{audio.resolvedUrl}</span></div>
        </div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Chunk size</span><span className="sb-kv-v">1 MB (1,048,576 bytes)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Strategy</span><span className="sb-kv-v">HTTP byte-range requests</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Chunk duration</span><span className="sb-kv-v">~{chunkDurationSec}s at 128 kbps</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Step type</span><span className="sb-kv-v">compute (pure — no I/O)</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Chunks planned</span><span className="sb-kv-v">{estimatedChunks}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Total estimated audio</span><span className="sb-kv-v">~{Math.round((audio.contentLengthBytes * 8) / 128000)}s</span></div>
        </div>
        {meta.message && <div className="sb-qa-ok">{meta.message}</div>}
        {audio.error && <div className="sb-qa-alert">{audio.error}</div>}

        {audio.resolvedUrl && (
          <div style={{ marginTop: '12px' }}>
            <h4 className="sb-detail-subtitle">Audio Preview</h4>
            <audio
              controls
              preload="none"
              src={audio.resolvedUrl}
              style={{ width: '100%', borderRadius: '6px' }}
            />
          </div>
        )}
      </DetailSection>
    </>
  );
}

function DetailChunkProcessing({ result, chunkThreads, pipelineStep }: { result: SandboxResult | null; chunkThreads: ParallelThread[]; pipelineStep?: FlowProgressStep }) {
  const audio = result?.audioDetails;

  if (!audio || !audio.available) {
    return (
      <>
        <DetailSection title="INPUT"><div className="sb-qa-alert">Audio not available — chunk processing skipped.</div></DetailSection>
        <DetailSection title="CONFIG"><div className="sb-qa-callout">N/A</div></DetailSection>
        <DetailSection title="OUTPUT">
          {result && <div className="sb-qa-callout">Transcript source: <strong>{result.transcriptSource || 'html'}</strong></div>}
        </DetailSection>
      </>
    );
  }

  const completedThreads = chunkThreads.filter(t => t.status === 'complete').length;
  const errorThreads = chunkThreads.filter(t => t.status === 'error').length;
  const totalThreads = chunkThreads.length;
  const isAudioSource = result ? (result.transcriptSource === 'audio-transcription' || result.transcriptSource === 'audio-transcription-chunked') : false;
  const lines = result?.transcript.lines || [];
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = result?.episode.durationSec || 0;

  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Chunks</span><span className="sb-kv-v">{totalThreads} (1 MB each)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Audio URL</span><span className="sb-kv-v sb-kv-url">{audio.resolvedUrl}</span></div>
        </div>
        <div className="sb-qa-callout" style={{ marginTop: '8px' }}>
          Per-chunk pipeline: <strong>Fetch</strong> (Range request) → <strong>Transcribe</strong> (Whisper STT) → <strong>Classify</strong> (LLM ad detection) → <strong>Refine</strong> (LLM boundary refinement) → <strong>Emit</strong> (skip ranges to player)
        </div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Concurrency</span><span className="sb-kv-v">3 parallel STT calls (semaphore)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">STT Model</span><span className="sb-kv-v">{audio.transcriptionModel}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">STT Format</span><span className="sb-kv-v">verbose_json (segment timestamps)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Ad classifier</span><span className="sb-kv-v">LLM (per-chunk, then merged)</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        {/* Thread status summary */}
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Total chunks</span><span className="sb-kv-v">{totalThreads}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Completed</span><span className="sb-kv-v" style={{ color: completedThreads === totalThreads && totalThreads > 0 ? '#2ecc71' : undefined }}>{completedThreads}</span></div>
          {errorThreads > 0 && (
            <div className="sb-kv"><span className="sb-kv-k">Errors</span><span className="sb-kv-v" style={{ color: '#e74c3c' }}>{errorThreads}</span></div>
          )}
        </div>

        {/* Per-thread detail cards */}
        {chunkThreads.length > 0 && (
          <div className="sb-chunk-grid">
            {chunkThreads.map(thread => {
              const statusColor = thread.status === 'complete' ? '#2ecc71' :
                                  thread.status === 'error' ? '#e74c3c' :
                                  thread.status === 'running' ? '#3498db' : '#666';
              return (
                <div key={thread.id} className={`sb-chunk-card sb-chunk-${thread.status}`}>
                  <div className="sb-chunk-card-header">
                    <span className="sb-chunk-dot" style={{ background: statusColor }} />
                    <span className="sb-chunk-label">{thread.label}</span>
                  </div>
                  <div className="sb-chunk-steps">
                    {thread.steps.map(s => {
                      const sMeta = resolveStepMeta(s.meta);
                      return (
                        <div key={s.id} className="sb-chunk-step-row">
                          <span className={`sb-chunk-step-dot sb-csd-${s.status}`} />
                          <span className="sb-chunk-step-name">{s.label}</span>
                          {s.status === 'active' && sMeta.message && (
                            <span className="sb-chunk-step-msg">{sMeta.message}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {thread.error && <div className="sb-chunk-error">{thread.error}</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* Aggregated transcript */}
        {result && totalThreads > 0 && completedThreads === totalThreads && (
          <div style={{ marginTop: '12px' }}>
            <h4 className="sb-detail-subtitle">Aggregated Transcript</h4>
            <div className="sb-kv-grid">
              <div className="sb-kv"><span className="sb-kv-k">Source</span><span className="sb-kv-v">{isAudioSource ? 'Audio transcription (STT)' : result.transcriptSource || 'html'}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Whisper segments</span><span className="sb-kv-v">{audio.segmentCount}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Sentences</span><span className="sb-kv-v">{lines.length}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Total words</span><span className="sb-kv-v">{totalWords.toLocaleString()}</span></div>
              <div className="sb-kv"><span className="sb-kv-k">Speech rate</span><span className="sb-kv-v">{dur > 0 ? Math.round(totalWords / (dur / 60)) : 0} wpm</span></div>
            </div>
            {result.validation && (
              result.validation.isValid
                ? <div className="sb-qa-ok">Validation passed: {result.validation.reason}</div>
                : <div className="sb-qa-alert">Validation failed: {result.validation.reason}</div>
            )}
          </div>
        )}
      </DetailSection>
    </>
  );
}

function DetailFetchHtmlTranscript({ result, pipelineStep }: { result: SandboxResult | null; pipelineStep?: FlowProgressStep }) {
  const meta = resolveStepMeta(pipelineStep?.meta);

  if (!result) {
    return (
      <>
        <DetailSection title="INPUT"><div className="sb-qa-callout">Transcript URL from episode metadata</div></DetailSection>
        <DetailSection title="CONFIG">
          <div className="sb-kv-grid">
            <div className="sb-kv"><span className="sb-kv-k">Endpoint</span><span className="sb-kv-v">/api/transcript</span></div>
            <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">15000ms</span></div>
          </div>
        </DetailSection>
        <DetailSection title="OUTPUT">
          {meta.message && <div className="sb-qa-ok">{meta.message}</div>}
          {meta.error && <div className="sb-qa-alert">{meta.error}</div>}
          {!meta.message && !meta.error && <div className="sb-qa-callout">Waiting...</div>}
        </DetailSection>
      </>
    );
  }

  const { rawHtml, transcript, qa } = result;
  const source = result.transcriptSource || 'html';
  const isAudioSource = source === 'audio-transcription' || source === 'audio-transcription-chunked';
  const sourceLabels: Record<string, string> = {
    'audio-transcription': 'Audio Transcription (speech-to-text)',
    'audio-transcription-chunked': 'Audio Transcription (chunked)',
    'srt': 'SRT subtitle file',
    'vtt': 'VTT subtitle file',
    'json': 'JSON transcript',
    'html': 'HTML page scraping',
    'fallback': 'Fallback (description only)',
  };
  const { lines } = transcript;
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = result.episode.durationSec;

  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Transcript URL</span><span className="sb-kv-v sb-kv-url">{result.episode.transcriptUrl || '(none)'}</span></div>
        </div>
        <div className="sb-qa-callout" style={{ marginTop: '8px' }}>
          Runs in <strong>parallel</strong> with the audio pipeline.
          {isAudioSource
            ? ' HTML transcript serves as cross-reference for validation.'
            : ' This is the primary transcript source.'}
        </div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Endpoint</span><span className="sb-kv-v">/api/transcript</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Method</span><span className="sb-kv-v">GET</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">15000ms</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Max attempts</span><span className="sb-kv-v">2</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Source</span><span className="sb-kv-v">{sourceLabels[source] || source}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Content size</span><span className="sb-kv-v">{(rawHtml.length / 1024).toFixed(1)} KB</span></div>
          {source === 'html' && (
            <div className="sb-kv"><span className="sb-kv-k">&lt;p&gt; tags</span><span className="sb-kv-v">{rawHtml.pTagCount}</span></div>
          )}
          <div className="sb-kv"><span className="sb-kv-k">Lines parsed</span><span className="sb-kv-v">{lines.length}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Total words</span><span className="sb-kv-v">{totalWords.toLocaleString()}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Speakers</span><span className="sb-kv-v">{new Set(lines.filter(l => l.speaker).map(l => l.speaker)).size}</span></div>
        </div>

        {/* Duration vs Speech Math */}
        <h4 className="sb-detail-subtitle" style={{ marginTop: '12px' }}>Duration vs Speech</h4>
        <div className="sb-qa-math">
          <div className="sb-qa-row">
            <span className="sb-qa-label">Audio duration</span>
            <span className="sb-qa-val">{formatTime(qa.audioDurationSec)} ({qa.audioDurationSec}s)</span>
          </div>
          <div className="sb-qa-row">
            <span className="sb-qa-label">Transcript words</span>
            <span className="sb-qa-val">{qa.transcriptWords.toLocaleString()}</span>
          </div>
          <div className="sb-qa-row">
            <span className="sb-qa-label">Expected speech @ {qa.speechRateWpm} wpm</span>
            <span className="sb-qa-val">{formatTime(qa.expectedSpeechSec)}</span>
          </div>
          <div className="sb-qa-row sb-qa-highlight">
            <span className="sb-qa-label">Implied ad time</span>
            <span className="sb-qa-val">{formatTime(qa.impliedAdTimeSec)} ({qa.impliedAdTimeSec}s)</span>
          </div>
        </div>

        {/* Parsed lines (scrollable) */}
        <h4 className="sb-detail-subtitle" style={{ marginTop: '12px' }}>Parsed Lines ({lines.length})</h4>
        <div className="sb-parsed-lines">
          {lines.map(l => {
            const approxTime = dur > 0 && totalWords > 0
              ? (l.cumulativeWords / totalWords) * dur
              : 0;
            return (
              <div key={l.lineNum} className="sb-parsed-line">
                <span className="sb-pl-time">{formatTime(approxTime)}</span>
                <span className="sb-pl-num">[{l.lineNum}]</span>
                <span className="sb-pl-text">
                  {l.speaker && <strong>{l.speaker}: </strong>}
                  {l.text}
                </span>
                <span className="sb-pl-wc">{l.wordCount}w</span>
              </div>
            );
          })}
        </div>
      </DetailSection>
    </>
  );
}

function DetailFinalizePlayback({ result, pipelineStep }: { result: SandboxResult | null; pipelineStep?: FlowProgressStep }) {
  const meta = resolveStepMeta(pipelineStep?.meta);

  if (!result) {
    return (
      <>
        <DetailSection title="INPUT"><div className="sb-qa-callout">Merged chunk results + HTML transcript</div></DetailSection>
        <DetailSection title="CONFIG">
          <div className="sb-kv-grid">
            <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">30000ms</span></div>
          </div>
        </DetailSection>
        <DetailSection title="OUTPUT">
          {meta.message && <div className="sb-qa-ok">{meta.message}</div>}
          {meta.error && <div className="sb-qa-alert">{meta.error}</div>}
          {!meta.message && !meta.error && <div className="sb-qa-callout">Waiting...</div>}
        </DetailSection>
      </>
    );
  }

  const { summary, adBlocks } = result;
  const dur = result.episode.durationSec;

  // Timeline
  const W = 80;
  const cells = Array(W).fill(false);
  for (const b of adBlocks) {
    const s = Math.floor((b.startTimeSec / dur) * W);
    const e = Math.min(W - 1, Math.floor((b.endTimeSec / dur) * W));
    for (let i = s; i <= e; i++) cells[i] = true;
  }
  const totalAdSec = adBlocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);

  return (
    <>
      <DetailSection title="INPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Chunk ad segments</span><span className="sb-kv-v">{adBlocks.length} blocks</span></div>
          <div className="sb-kv"><span className="sb-kv-k">HTML transcript</span><span className="sb-kv-v">{result.transcript.lineCount} lines</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Audio duration</span><span className="sb-kv-v">{formatTime(dur)} ({dur}s)</span></div>
        </div>
      </DetailSection>
      <DetailSection title="CONFIG">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Strategy</span><span className="sb-kv-v">{summary.strategy}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Step type</span><span className="sb-kv-v">ai.summarize (LLM reconciliation)</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Timeout</span><span className="sb-kv-v">30000ms</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Max attempts</span><span className="sb-kv-v">2</span></div>
        </div>
      </DetailSection>
      <DetailSection title="OUTPUT">
        <div className="sb-kv-grid">
          <div className="sb-kv"><span className="sb-kv-k">Ad blocks</span><span className="sb-kv-v">{summary.totalAdBlocks}</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Ad time</span><span className="sb-kv-v">{summary.totalAdTimeSec}s</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Content time</span><span className="sb-kv-v">{summary.contentTimeSec}s</span></div>
          <div className="sb-kv"><span className="sb-kv-k">Ad word %</span><span className="sb-kv-v">{summary.adWordPercent}%</span></div>
        </div>

        {/* Timeline visualization */}
        {dur > 0 && (
          <div className="sb-timeline">
            <div className="sb-timeline-labels">
              <span>{formatTimestamp(0)}</span>
              <span>{formatTimestamp(dur)}</span>
            </div>
            <div className="sb-timeline-bar">
              {cells.map((isAd, i) => (
                <div key={i} className={`sb-timeline-cell ${isAd ? 'ad' : ''}`} />
              ))}
            </div>
            <div className="sb-timeline-legend">
              <span><span className="sb-legend-dot content" /> content ({formatTimestamp(dur - totalAdSec)})</span>
              <span><span className="sb-legend-dot ad" /> ad ({formatTimestamp(totalAdSec)})</span>
            </div>
          </div>
        )}

        {/* Skip Map JSON */}
        <h4 className="sb-detail-subtitle" style={{ marginTop: '12px' }}>Skip Map (Player JSON)</h4>
        {result.skipMap.length === 0 ? (
          <div className="sb-qa-alert">Empty skip map — player will not skip anything.</div>
        ) : (
          <pre className="sb-code-block sb-json-text">
            {JSON.stringify(result.skipMap, null, 2)}
          </pre>
        )}
      </DetailSection>
    </>
  );
}

// ─── Step Tracker Pill ───────────────────────────────────────────────────────

function TrackerPill({ step, index, status, isSelected, onClick, meta }: {
  step: StepDef;
  index: number;
  status: string;
  isSelected: boolean;
  onClick: () => void;
  meta?: string;
}) {
  const statusDotClass = status === 'complete' ? 'sb-tracker-dot-ok' :
                          status === 'error' ? 'sb-tracker-dot-error' :
                          status === 'active' ? 'sb-tracker-dot-active' :
                          status === 'skipped' ? 'sb-tracker-dot-skipped' : 'sb-tracker-dot-pending';

  return (
    <button
      className={`sb-tracker-pill ${isSelected ? 'selected' : ''} sb-tracker-${status}`}
      onClick={onClick}
      title={`${step.label}: ${step.subtitle}`}
    >
      <span className={`sb-tracker-dot ${statusDotClass}`} />
      <span className="sb-tracker-num">{index + 1}</span>
      <span className="sb-tracker-label">{step.label}</span>
      {meta && <span className="sb-tracker-meta">{meta}</span>}
    </button>
  );
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
}: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const handleCopyFeedback = useCallback(() => {
    const text = buildFeedbackText(result, pipelineSteps, pipelineStatus, episode, podcastName);
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
  }, [result, pipelineSteps, pipelineStatus, episode, podcastName]);

  // Build status map for all steps (including virtual chunk step)
  const stepStatusMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of pipelineSteps) {
      map[s.id] = s.status;
    }
    // Virtual chunk processing step status
    if (chunkThreads.some(t => t.status === 'error')) {
      map['step_chunk_processing'] = 'error';
    } else if (chunkThreads.length > 0 && chunkThreads.every(t => t.status === 'complete')) {
      map['step_chunk_processing'] = 'complete';
    } else if (chunkThreads.some(t => t.status === 'running')) {
      map['step_chunk_processing'] = 'active';
    } else if (chunkThreads.length > 0) {
      map['step_chunk_processing'] = 'active';
    } else {
      map['step_chunk_processing'] = 'pending';
    }
    return map;
  }, [pipelineSteps, chunkThreads]);

  // Meta text for each step
  const stepMetaMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of pipelineSteps) {
      const resolved = resolveStepMeta(s.meta);
      map[s.id] = resolved.message || resolved.error || resolved.skipReason || '';
    }
    // Chunk processing meta
    const completed = chunkThreads.filter(t => t.status === 'complete').length;
    const total = chunkThreads.length;
    if (total > 0) {
      map['step_chunk_processing'] = `${completed}/${total} chunks`;
    }
    return map;
  }, [pipelineSteps, chunkThreads]);

  // Auto-select the first active step, or the last completed step
  useEffect(() => {
    if (selectedStep !== null) return; // user has already selected
    const activeIdx = ALL_STEPS.findIndex(s => stepStatusMap[s.id] === 'active');
    if (activeIdx !== -1) {
      setSelectedStep(activeIdx);
      return;
    }
    // Find last completed step
    let lastComplete = -1;
    for (let i = ALL_STEPS.length - 1; i >= 0; i--) {
      if (stepStatusMap[ALL_STEPS[i].id] === 'complete') {
        lastComplete = i;
        break;
      }
    }
    if (lastComplete !== -1) setSelectedStep(lastComplete);
  }, [stepStatusMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll detail panel into view when step changes
  useEffect(() => {
    if (selectedStep !== null && detailRef.current) {
      detailRef.current.scrollTop = 0;
    }
  }, [selectedStep]);

  const isIdle = pipelineStatus === 'idle';

  // Find pipeline step by ID
  const findPipelineStep = (id: string) => pipelineSteps.find(s => s.id === id);

  // Render the detail panel for the selected step
  const renderDetail = () => {
    if (selectedStep === null) return null;
    const step = ALL_STEPS[selectedStep];
    if (!step) return null;

    switch (step.id) {
      case 'step_fetch_rss':
        return <DetailFetchRss podcastName={podcastName} podcastId={podcastId} pipelineStep={findPipelineStep('step_fetch_rss')} />;
      case 'step_parse_episodes':
        return <DetailParseEpisodes result={result} pipelineStep={findPipelineStep('step_parse_episodes')} />;
      case 'step_resolve_audio_stream':
        return <DetailResolveAudio result={result} pipelineStep={findPipelineStep('step_resolve_audio_stream')} />;
      case 'step_plan_chunks':
        return <DetailPlanChunks result={result} pipelineStep={findPipelineStep('step_plan_chunks')} />;
      case 'step_chunk_processing':
        return <DetailChunkProcessing result={result} chunkThreads={chunkThreads} pipelineStep={findPipelineStep('step_plan_chunks')} />;
      case 'step_fetch_html_transcript':
        return <DetailFetchHtmlTranscript result={result} pipelineStep={findPipelineStep('step_fetch_html_transcript')} />;
      case 'step_finalize_playback':
        return <DetailFinalizePlayback result={result} pipelineStep={findPipelineStep('step_finalize_playback')} />;
      default:
        return <div className="sb-qa-callout">Unknown step: {step.id}</div>;
    }
  };

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
        <>
          {/* Step Tracker (horizontal, scrollable) */}
          <div className="sb-tracker">
            <div className="sb-tracker-scroll">
              {ALL_STEPS.map((step, i) => (
                <TrackerPill
                  key={step.id}
                  step={step}
                  index={i}
                  status={stepStatusMap[step.id] || 'pending'}
                  isSelected={selectedStep === i}
                  onClick={() => setSelectedStep(selectedStep === i ? null : i)}
                  meta={stepMetaMap[step.id]}
                />
              ))}
            </div>
            {/* Pipeline stats bar */}
            <div className="sb-tracker-stats">
              <span className="sb-stat sb-stat-ok">
                {pipelineSteps.filter(s => s.status === 'complete').length} done
              </span>
              {pipelineSteps.some(s => s.status === 'error') && (
                <span className="sb-stat sb-stat-error">
                  {pipelineSteps.filter(s => s.status === 'error').length} error
                </span>
              )}
              {pipelineSteps.some(s => s.status === 'active') && (
                <span className="sb-stat sb-stat-running">running</span>
              )}
              <span className="sb-tracker-status-label">
                {pipelineStatus === 'running' ? 'Pipeline running...' :
                 pipelineStatus === 'complete' ? 'Pipeline complete' :
                 pipelineStatus === 'error' ? 'Pipeline error' : ''}
              </span>
            </div>
          </div>

          {/* Detail panel — appears below tracker when a step is selected */}
          {selectedStep !== null && (
            <div className="sb-detail-panel" ref={detailRef}>
              <div className="sb-detail-header">
                <span className="sb-detail-step-badge">Step {selectedStep + 1}</span>
                <span className="sb-detail-step-type">{ALL_STEPS[selectedStep].type}</span>
                <h2 className="sb-detail-step-title">{ALL_STEPS[selectedStep].label}</h2>
                <button className="sb-detail-close" onClick={() => setSelectedStep(null)}>Close</button>
              </div>
              <p className="sb-detail-step-subtitle">{ALL_STEPS[selectedStep].subtitle}</p>
              <div className="sb-detail-body">
                {renderDetail()}
              </div>
            </div>
          )}

          {/* When no step is selected, show a hint or the pipeline waterfall */}
          {selectedStep === null && (
            <div className="sb-no-selection">
              <FlowErrorBoundary>
                <PipelineWaterfall
                  steps={pipelineSteps}
                  status={pipelineStatus}
                  parallelThreads={chunkThreads}
                  label="Ad Detection Pipeline"
                  activity={pipelineSteps.find(s => s.status === 'active')?.label}
                />
              </FlowErrorBoundary>
              <p className="sb-no-selection-hint">Click a step above to inspect its INPUT, CONFIG, and OUTPUT.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
