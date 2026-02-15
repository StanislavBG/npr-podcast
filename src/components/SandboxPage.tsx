import { useState, useMemo, useCallback } from 'react';
import { FlowProgress } from 'bilko-flow/react/components';
import type { FlowProgressStep } from 'bilko-flow/react/components';
import {
  formatTime,
  formatTimestamp,
  type SandboxResult,
  type SandboxAdBlock,
  type SandboxLine,
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
}

// ─── Step definitions derived from podcastFlow.ts ────────────────────────────

interface StepDef {
  id: string;
  label: string;
  subtitle: string;
  type: string;
}

const STEPS: StepDef[] = STEP_ORDER.map(id => ({
  id,
  label: STEP_META[id].label,
  type: STEP_META[id].type,
  subtitle: {
    step_fetch_rss:             'Pull podcast RSS feed from NPR',
    step_parse_episodes:        'Extract episode metadata from feed',
    step_resolve_audio_stream:  'Resolve CDN URL, get audio metadata',
    step_start_audio_streaming: 'Stream audio chunks ahead of playback',
    step_transcribe_chunks:     'Produce timestamped transcript from audio via OpenAI STT',
    step_mark_ad_locations:     'LLM classifies each sentence as content or ad',
    step_build_skip_map:        'Merge adjacent ad segments into skip ranges',
    step_fetch_html_transcript: 'Fetch NPR HTML transcript for cross-reference',
    step_finalize_playback:     'Reconcile + summary + build player config',
  }[id] || '',
}));

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

  // Episode context
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

  // Pipeline status
  lines.push('## Pipeline Status');
  lines.push(`Overall: ${pipelineStatus}`);
  lines.push('');
  for (const step of pipelineSteps) {
    const meta = step.meta as Record<string, unknown> | undefined;
    const msg = meta?.message || meta?.error || meta?.skipReason || '';
    const icon = step.status === 'complete' ? '[OK]' :
                 step.status === 'error' ? '[ERROR]' :
                 step.status === 'skipped' ? '[SKIP]' :
                 step.status === 'active' ? '[RUNNING]' : '[PENDING]';
    lines.push(`${icon} ${step.label}: ${msg}`);
  }
  lines.push('');

  // Errors section (all steps with errors)
  const errorSteps = pipelineSteps.filter(s => s.status === 'error');
  if (errorSteps.length > 0) {
    lines.push('## Errors');
    for (const step of errorSteps) {
      const meta = step.meta as Record<string, unknown> | undefined;
      lines.push(`### ${step.label}`);
      lines.push(`- Step ID: ${step.id}`);
      lines.push(`- Type: ${step.type || 'unknown'}`);
      lines.push(`- Error: ${meta?.error || 'Unknown error'}`);
      lines.push('');
    }
  }

  // Result details (if available)
  if (result) {
    lines.push('## Analysis Results');

    // Transcript stats
    lines.push('### Transcript');
    lines.push(`- Source: ${result.transcriptSource || 'unknown'}`);
    lines.push(`- Lines: ${result.transcript.lines.length}`);
    lines.push(`- Total words: ${result.transcript.totalWords}`);

    // Validation
    if (result.validation) {
      lines.push(`- Validation: ${result.validation.isValid ? 'PASS' : 'FAIL'} — ${result.validation.reason}`);
    }
    lines.push('');

    // Ad detection
    lines.push('### Ad Detection');
    lines.push(`- Strategy: ${result.summary.strategy}`);
    lines.push(`- Ad blocks: ${result.summary.totalAdBlocks}`);
    lines.push(`- Ad time: ${result.summary.totalAdTimeSec}s`);
    lines.push(`- Content time: ${result.summary.contentTimeSec}s`);
    lines.push(`- Ad word %: ${result.summary.adWordPercent}%`);
    lines.push('');

    // Skip map
    lines.push('### Skip Map');
    if (result.skipMap.length === 0) {
      lines.push('(empty — no ads detected or skip map generation failed)');
    } else {
      for (const s of result.skipMap) {
        lines.push(`- ${formatTimestamp(s.startTime)} → ${formatTimestamp(s.endTime)} | conf: ${s.confidence} | ${s.reason}`);
      }
    }
    lines.push('');

    // Audio details
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

    // QA metrics
    if (result.qa) {
      lines.push('### QA Metrics');
      lines.push(`- Audio duration: ${result.qa.audioDurationSec}s`);
      lines.push(`- Transcript words: ${result.qa.transcriptWords}`);
      lines.push(`- Speech rate: ${result.qa.speechRateWpm} wpm`);
      lines.push(`- Expected speech: ${result.qa.expectedSpeechSec}s`);
      lines.push(`- Implied ad time: ${result.qa.impliedAdTimeSec}s`);
      lines.push('');
    }

    // LLM details
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

    // Raw LLM response
    if (result.llmResponse) {
      lines.push('### Raw LLM Response');
      lines.push('```json');
      lines.push(result.llmResponse);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

// ─── Step content renderers ──────────────────────────────────────────────────

function StepFetchRss({ podcastName, podcastId }: { podcastName: string; podcastId: string }) {
  return (
    <div className="sb-step-body">
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Podcast</span><span className="sb-kv-v">{podcastName}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Feed ID</span><span className="sb-kv-v">{podcastId}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Endpoint</span><span className="sb-kv-v">/api/podcast/{podcastId}/episodes</span></div>
      </div>
      <div className="sb-qa-ok">
        RSS feed fetched successfully.
      </div>
    </div>
  );
}

function StepParseEpisodes({ result }: { result: SandboxResult }) {
  const { episode } = result;
  const audio = result.audioDetails;
  return (
    <div className="sb-step-body">
      <h2 className="sb-step-heading">{episode.title}</h2>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Duration</span><span className="sb-kv-v">{formatTime(episode.durationSec)} ({episode.durationSec}s)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Transcript URL</span><span className="sb-kv-v sb-kv-url">{episode.transcriptUrl || '(none)'}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Audio URL</span><span className="sb-kv-v">{audio?.available ? 'Yes' : 'No'}</span></div>
      </div>
      <div className="sb-qa-callout">
        Episode metadata extracted from RSS feed. Next step: resolve the audio stream URL.
      </div>
    </div>
  );
}

function StepResolveAudioStream({ result }: { result: SandboxResult }) {
  const audio = result.audioDetails;
  if (!audio || !audio.available) {
    return (
      <div className="sb-step-body">
        <div className="sb-qa-alert">
          No audio URL available for this episode. Audio pipeline skipped — falling back to text transcript.
        </div>
        <div className="sb-qa-callout">
          The main flow skips steps 3-5 when no audio URL is present in the RSS feed.
          This happens when the episode only provides an HTML transcript link.
        </div>
      </div>
    );
  }

  const headSucceeded = !!(audio.resolvedUrl || audio.contentType);
  const fileSizeMb = audio.contentLengthBytes > 0
    ? (audio.contentLengthBytes / 1024 / 1024).toFixed(1)
    : audio.downloadSizeMb;
  const tooLarge = audio.contentLengthBytes > 25 * 1024 * 1024;

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>HEAD request</strong> follows podtrac/megaphone redirects to resolve the final CDN URL
        and retrieve audio metadata (Content-Type, Content-Length, Accept-Ranges).
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Original URL</span><span className="sb-kv-v sb-kv-url">{audio.originalUrl}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Resolved URL</span><span className="sb-kv-v sb-kv-url">{audio.resolvedUrl || '(same)'}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Content-Type</span><span className="sb-kv-v">{audio.contentType || '(unknown)'}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Content-Length</span><span className="sb-kv-v">{audio.contentLengthBytes > 0 ? `${fileSizeMb} MB (${audio.contentLengthBytes.toLocaleString()} bytes)` : '(unknown)'}</span></div>
      </div>
      {headSucceeded && audio.resolvedUrl !== audio.originalUrl && (
        <div className="sb-qa-ok">
          URL redirected — final CDN endpoint resolved successfully.
        </div>
      )}
      {headSucceeded && !audio.resolvedUrl && (
        <div className="sb-qa-ok">
          Audio URL resolved (no redirect).
        </div>
      )}
      {tooLarge && (
        <div className="sb-qa-callout">
          Audio file is {fileSizeMb} MB — exceeds Whisper's 25 MB single-request limit.
          Chunked processing (5-min chunks, ~4.7 MB each) handles this automatically.
        </div>
      )}
    </div>
  );
}

function StepStreamAudioChunks({ result }: { result: SandboxResult }) {
  const audio = result.audioDetails;
  if (!audio || !audio.available) {
    return (
      <div className="sb-step-body">
        <div className="sb-qa-alert">
          Audio pipeline skipped — no audio URL available.
        </div>
      </div>
    );
  }

  const chunkDurationSec = 300;
  const bytesPerChunk = chunkDurationSec * (128000 / 8);
  const fileSizeMb = audio.contentLengthBytes > 0
    ? (audio.contentLengthBytes / 1024 / 1024).toFixed(1)
    : audio.downloadSizeMb;
  const estimatedChunks = audio.contentLengthBytes > 0
    ? Math.ceil((audio.contentLengthBytes * 8 / 128000) / chunkDurationSec)
    : 0;
  const chunkSizeMb = (bytesPerChunk / 1024 / 1024).toFixed(1);

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        Full audio is downloaded once, then <strong>split at MP3 frame boundaries</strong> into
        ~5-minute chunks. Each chunk is a valid MP3 fragment (&lt;5 MB) — well under Whisper's
        25 MB limit. Frame-accurate splitting ensures clean decoding.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">File size</span><span className="sb-kv-v">{fileSizeMb} MB ({audio.contentLengthBytes.toLocaleString()} bytes)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Format</span><span className="sb-kv-v">{audio.contentType}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Chunk strategy</span><span className="sb-kv-v">~5 min per chunk (~{chunkSizeMb} MB at 128kbps)</span></div>
        {estimatedChunks > 0 && (
          <div className="sb-kv"><span className="sb-kv-k">Estimated chunks</span><span className="sb-kv-v">{estimatedChunks}</span></div>
        )}
        <div className="sb-kv"><span className="sb-kv-k">Lookahead</span><span className="sb-kv-v">2 chunks (~10 min ahead of playback)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Overlap</span><span className="sb-kv-v">10 seconds (boundary ad detection)</span></div>
      </div>
      {audio.error ? (
        <div className="sb-qa-alert">
          Audio download/processing failed: {audio.error}
        </div>
      ) : (
        <div className="sb-qa-ok">
          Audio chunked successfully ({estimatedChunks} chunks, {fileSizeMb} MB total). Feeding into transcription pipeline.
        </div>
      )}

      {audio.resolvedUrl && (
        <div style={{ marginTop: '12px' }}>
          <h3 className="sb-sub-heading">Audio Preview</h3>
          <audio
            controls
            preload="none"
            src={audio.resolvedUrl}
            style={{ width: '100%', borderRadius: '6px' }}
          />
          <div className="sb-qa-callout" style={{ marginTop: '4px', fontSize: '11px' }}>
            Streams directly from CDN. Listen to verify audio is accessible and audible.
          </div>
        </div>
      )}
    </div>
  );
}

function StepTranscribeChunks({ result }: { result: SandboxResult }) {
  const audio = result.audioDetails;
  const isAudioSource = result.transcriptSource === 'audio-transcription' || result.transcriptSource === 'audio-transcription-chunked';
  const { lines } = result.transcript;
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = result.episode.durationSec;
  const validation = result.validation;

  const avgWordsPerLine = lines.length > 0 ? Math.round(totalWords / lines.length) : 0;
  const speakers = [...new Set(lines.filter(l => l.speaker).map(l => l.speaker))];
  const wordsPerMinute = dur > 0 ? Math.round(totalWords / (dur / 60)) : 0;
  const wordCounts = lines.map(l => l.wordCount);
  const maxWordsLine = wordCounts.length > 0 ? Math.max(...wordCounts) : 0;
  const minWordsLine = wordCounts.length > 0 ? Math.min(...wordCounts) : 0;

  if (!audio || !audio.available) {
    return (
      <div className="sb-step-body">
        <div className="sb-qa-alert">
          Audio transcription skipped — no audio URL available.
        </div>
        <div className="sb-qa-callout">
          Transcript was obtained from: <strong>{result.transcriptSource || 'html'}</strong>
        </div>
      </div>
    );
  }

  if (audio.error) {
    return (
      <div className="sb-step-body">
        <div className="sb-qa-alert">
          Audio transcription failed: {audio.error}
        </div>
        <div className="sb-qa-callout">
          Fell back to text transcript source: <strong>{result.transcriptSource || 'html'}</strong>
        </div>
      </div>
    );
  }

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        Each audio chunk is sent to <strong>OpenAI {audio.transcriptionModel}</strong> for
        speech-to-text with <code>verbose_json</code> format. Large segments are then split
        into individual sentences. The output is a timestamped transcript for Step 6.
      </div>

      <h3 className="sb-sub-heading">Transcription Details</h3>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Model</span><span className="sb-kv-v">{audio.transcriptionModel}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Response format</span><span className="sb-kv-v">verbose_json (segment timestamps)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Whisper segments</span><span className="sb-kv-v">{audio.segmentCount}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Audio duration</span><span className="sb-kv-v">{audio.audioDurationSec > 0 ? `${formatTimestamp(audio.audioDurationSec)} (${audio.audioDurationSec.toFixed(1)}s)` : '(not reported)'}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Transcript source</span><span className="sb-kv-v">{isAudioSource ? 'Audio transcription (STT)' : result.transcriptSource || 'html'}</span></div>
      </div>

      <h3 className="sb-sub-heading">Transcript Quality</h3>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Sentences</span><span className="sb-kv-v">{lines.length} ({audio.segmentCount} Whisper segments → {lines.length} sentences after splitting)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Total words</span><span className="sb-kv-v">{totalWords.toLocaleString()}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Avg words/sentence</span><span className="sb-kv-v">{avgWordsPerLine}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Min / Max words</span><span className="sb-kv-v">{minWordsLine} / {maxWordsLine}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Speech rate</span><span className="sb-kv-v">{wordsPerMinute} words/min (expected ~155 wpm)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Speakers detected</span><span className="sb-kv-v">{speakers.length > 0 ? speakers.join(', ') : '(none — typical for STT)'}</span></div>
      </div>

      {validation && (
        validation.isValid ? (
          <div className="sb-qa-ok">
            Transcript validation passed: {validation.reason}
          </div>
        ) : (
          <div className="sb-qa-alert">
            Transcript validation failed: {validation.reason}
          </div>
        )
      )}

      {isAudioSource ? (
        <div className="sb-qa-ok">
          Timestamped transcript ready. {lines.length} sentences covering {formatTimestamp(dur)}.
        </div>
      ) : (
        <div className="sb-qa-alert">
          Audio transcription did not produce the final transcript. Source used: {result.transcriptSource}
        </div>
      )}

      <h3 className="sb-sub-heading">Full Transcript ({lines.length} sentences)</h3>
      <div className="sb-qa-callout">
        This is the exact input Step 6 receives. Each sentence has a timestamp and word count.
      </div>
      <div className="sb-parsed-lines">
        {lines.map(l => {
          const approxTime = dur > 0 && totalWords > 0
            ? (l.cumulativeWords / totalWords) * dur
            : 0;
          return (
            <div key={l.lineNum} className="sb-parsed-line">
              <span className="sb-pl-time">{formatTimestamp(approxTime)}</span>
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
    </div>
  );
}

function StepMarkAdLocations({ result }: { result: SandboxResult }) {
  const { adBlocks, episode, summary, transcript } = result;
  const { lines } = transcript;
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = episode.durationSec;
  let parsed: any = null;
  try { parsed = JSON.parse(result.llmResponse); } catch { /* not JSON */ }

  const adSentenceCount = adBlocks.reduce((s, b) => s + (b.endLine - b.startLine + 1), 0);
  const contentSentenceCount = lines.length - adSentenceCount;

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        The LLM reads every sentence from Step 5 and classifies it as <strong>CONTENT</strong> or
        {' '}<strong>AD</strong>. Adjacent ad sentences are grouped into blocks. Strategy: {summary.strategy}
      </div>

      <h3 className="sb-sub-heading">Classification Summary</h3>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Input sentences</span><span className="sb-kv-v">{lines.length}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Classified as CONTENT</span><span className="sb-kv-v">{contentSentenceCount} sentences ({lines.length > 0 ? ((contentSentenceCount / lines.length) * 100).toFixed(1) : 0}%)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Classified as AD</span><span className="sb-kv-v">{adSentenceCount} sentences in {adBlocks.length} block(s) ({lines.length > 0 ? ((adSentenceCount / lines.length) * 100).toFixed(1) : 0}%)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad words</span><span className="sb-kv-v">{summary.totalAdWords.toLocaleString()} / {totalWords.toLocaleString()} ({summary.adWordPercent}%)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad time</span><span className="sb-kv-v">{formatTimestamp(summary.totalAdTimeSec)} ({summary.totalAdTimeSec}s)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Content time</span><span className="sb-kv-v">{formatTimestamp(summary.contentTimeSec)} ({summary.contentTimeSec}s)</span></div>
      </div>

      {summary.adWordPercent > 20 && (
        <div className="sb-qa-alert">
          Ad content is {summary.adWordPercent}% of transcript — this is unusually high.
          Most NPR episodes have 5-15% ads. The LLM may be over-classifying editorial content as ads.
        </div>
      )}
      {adBlocks.length === 0 && (
        <div className="sb-qa-alert">
          No ad blocks detected. The LLM found zero ad sentences. This could mean the episode
          genuinely has no ads, or the transcript quality was too poor for classification.
        </div>
      )}

      {adBlocks.length > 0 && <Timeline result={result} />}

      {adBlocks.length > 0 && (
        <>
          <h3 className="sb-sub-heading">Detected Ad Blocks ({adBlocks.length})</h3>
          <div className="sb-ad-list">
            {adBlocks.map((b, i) => {
              const blockLines = lines.filter(l => l.lineNum >= b.startLine && l.lineNum <= b.endLine);
              const blockWords = blockLines.reduce((s, l) => s + l.wordCount, 0);
              const duration = b.endTimeSec - b.startTimeSec;
              return (
                <div key={i} className="sb-ad-card">
                  <div className="sb-ad-card-header">
                    <span className="sb-ad-badge">AD {i + 1}</span>
                    <span className="sb-ad-lines">Sentences {b.startLine}–{b.endLine} ({b.endLine - b.startLine + 1} sentences)</span>
                    <span className="sb-ad-time">
                      {formatTimestamp(b.startTimeSec)} – {formatTimestamp(b.endTimeSec)}
                    </span>
                    <span className="sb-ad-dur">{duration.toFixed(0)}s, {blockWords} words</span>
                  </div>
                  <div className="sb-ad-card-reason"><strong>Reason:</strong> {b.reason}</div>
                  <div className="sb-parsed-lines" style={{ marginTop: '8px', borderLeft: '3px solid #e74c3c', paddingLeft: '8px' }}>
                    {blockLines.map(l => {
                      const approxTime = dur > 0 && totalWords > 0
                        ? (l.cumulativeWords / totalWords) * dur
                        : 0;
                      return (
                        <div key={l.lineNum} className="sb-parsed-line">
                          <span className="sb-pl-time">{formatTimestamp(approxTime)}</span>
                          <span className="sb-pl-num">[{l.lineNum}]</span>
                          <span className="sb-pl-text" style={{ color: '#e74c3c' }}>
                            {l.speaker && <strong>{l.speaker}: </strong>}
                            {l.text}
                          </span>
                          <span className="sb-pl-wc">{l.wordCount}w</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <h3 className="sb-sub-heading">Annotated Transcript (full)</h3>
      <div className="sb-qa-callout">
        Sentences in red are classified as ads. Scan to verify the LLM's classification is correct.
      </div>
      <TranscriptViewer
        lines={lines}
        adBlocks={adBlocks}
        durationSec={dur}
      />

      <h3 className="sb-sub-heading">LLM System Prompt</h3>
      <pre className="sb-code-block sb-prompt-text">{result.prompts.system}</pre>

      <h3 className="sb-sub-heading">LLM User Prompt (first 500 chars + last 300 chars)</h3>
      <pre className="sb-code-block sb-prompt-text">
        {result.prompts.user.length > 800
          ? result.prompts.user.slice(0, 500) + '\n\n... (' + result.prompts.user.length.toLocaleString() + ' chars total) ...\n\n' + result.prompts.user.slice(-300)
          : result.prompts.user}
      </pre>

      <h3 className="sb-sub-heading">Raw LLM Response</h3>
      {parsed && (
        <div className="sb-kv-grid" style={{ marginBottom: '8px' }}>
          <div className="sb-kv"><span className="sb-kv-k">Blocks returned</span><span className="sb-kv-v">{parsed.adBlocks?.length ?? '(parse error)'}</span></div>
        </div>
      )}
      <pre className="sb-code-block sb-json-text">{result.llmResponse}</pre>
    </div>
  );
}

function StepBuildSkipMap({ result }: { result: SandboxResult }) {
  const { adBlocks, episode } = result;
  const totalWords = result.transcript.lines.length > 0
    ? result.transcript.lines[result.transcript.lines.length - 1].cumulativeWords
    : 0;
  const dur = episode.durationSec;
  const totalAdTimeSec = adBlocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>Pure computation</strong> — no external calls. Sentence-level ad classifications from
        Step 6 are mapped to audio timestamps using proportional word position, then merged
        into skip ranges for the player.
      </div>

      <h3 className="sb-sub-heading">Word-to-Time Mapping</h3>
      <div className="sb-qa-math">
        <div className="sb-qa-row">
          <span className="sb-qa-label">Total transcript words</span>
          <span className="sb-qa-val">{totalWords.toLocaleString()}</span>
        </div>
        <div className="sb-qa-row">
          <span className="sb-qa-label">Audio duration</span>
          <span className="sb-qa-val">{formatTimestamp(dur)} ({dur}s)</span>
        </div>
        <div className="sb-qa-row">
          <span className="sb-qa-label">Mapping formula</span>
          <span className="sb-qa-val">time = (cumulativeWords / {totalWords}) x {dur}s</span>
        </div>
      </div>

      <h3 className="sb-sub-heading">Time Breakdown</h3>
      <div className="sb-qa-math">
        <div className="sb-qa-row">
          <span className="sb-qa-label">Total episode</span>
          <span className="sb-qa-val">{formatTimestamp(dur)}</span>
        </div>
        <div className="sb-qa-row" style={{ color: '#e74c3c' }}>
          <span className="sb-qa-label">Ad time ({adBlocks.length} blocks)</span>
          <span className="sb-qa-val">{formatTimestamp(totalAdTimeSec)} ({dur > 0 ? ((totalAdTimeSec / dur) * 100).toFixed(1) : 0}%)</span>
        </div>
        <div className="sb-qa-row sb-qa-highlight">
          <span className="sb-qa-label">Content time</span>
          <span className="sb-qa-val">{formatTimestamp(dur - totalAdTimeSec)} ({dur > 0 ? (((dur - totalAdTimeSec) / dur) * 100).toFixed(1) : 0}%)</span>
        </div>
      </div>

      {adBlocks.length > 0 && (
        <>
          <h3 className="sb-sub-heading">Skip Ranges ({adBlocks.length})</h3>
          <div className="sb-ad-list">
            {adBlocks.map((b, i) => {
              const blockDuration = b.endTimeSec - b.startTimeSec;
              const blockWords = b.endWord - b.startWord;
              return (
                <div key={i} className="sb-ad-card">
                  <div className="sb-ad-card-header">
                    <span className="sb-ad-badge">SKIP {i + 1}</span>
                    <span className="sb-ad-lines">Sentences {b.startLine}–{b.endLine}</span>
                  </div>
                  <div className="sb-qa-math" style={{ marginTop: '0.5rem' }}>
                    <div className="sb-qa-row">
                      <span className="sb-qa-label">Start</span>
                      <span className="sb-qa-val">word {b.startWord}/{totalWords} → {formatTimestamp(b.startTimeSec)} ({b.startTimeSec.toFixed(1)}s)</span>
                    </div>
                    <div className="sb-qa-row">
                      <span className="sb-qa-label">End</span>
                      <span className="sb-qa-val">word {b.endWord}/{totalWords} → {formatTimestamp(b.endTimeSec)} ({b.endTimeSec.toFixed(1)}s)</span>
                    </div>
                    <div className="sb-qa-row sb-qa-highlight">
                      <span className="sb-qa-label">Skip duration</span>
                      <span className="sb-qa-val">{blockDuration.toFixed(1)}s ({blockWords} words)</span>
                    </div>
                    <div className="sb-qa-row">
                      <span className="sb-qa-label">Reason</span>
                      <span className="sb-qa-val">{b.reason}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <Timeline result={result} />

      <h3 className="sb-sub-heading">Skip Map JSON</h3>
      <div className="sb-qa-callout">
        This JSON is passed to the audio player to auto-skip ad segments during playback.
      </div>
      {result.skipMap.length === 0 && (
        <div className="sb-qa-alert">
          Empty skip map — the player will not skip anything for this episode.
        </div>
      )}
      <pre className="sb-code-block sb-json-text">
        {JSON.stringify(result.skipMap, null, 2)}
      </pre>
    </div>
  );
}

function StepFetchHtmlTranscript({ result }: { result: SandboxResult }) {
  const { rawHtml, transcript, qa } = result;
  const source = result.transcriptSource || 'html';
  const isAudioSource = source === 'audio-transcription' || source === 'audio-transcription-chunked';
  const sourceLabels: Record<string, string> = {
    'audio-transcription': 'Audio Transcription (speech-to-text)',
    'audio-transcription-chunked': 'Audio Transcription (chunked, speech-to-text)',
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
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        Runs in <strong>parallel</strong> with the audio pipeline (steps 3-7).
        {isAudioSource
          ? ' Since audio transcription succeeded, this HTML transcript serves as a cross-reference for validation in step 9.'
          : ' This is the primary transcript source for this episode.'}
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Source</span><span className="sb-kv-v">{sourceLabels[source] || source}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Content size</span><span className="sb-kv-v">{(rawHtml.length / 1024).toFixed(1)} KB ({rawHtml.length.toLocaleString()} chars)</span></div>
        {source === 'html' && (
          <div className="sb-kv"><span className="sb-kv-k">&lt;p&gt; tags found</span><span className="sb-kv-v">{rawHtml.pTagCount}</span></div>
        )}
        <div className="sb-kv"><span className="sb-kv-k">Lines parsed</span><span className="sb-kv-v">{lines.length}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Total words</span><span className="sb-kv-v">{totalWords.toLocaleString()}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Speakers detected</span><span className="sb-kv-v">{new Set(lines.filter(l => l.speaker).map(l => l.speaker)).size}</span></div>
      </div>

      {source === 'html' && rawHtml.pTagCount === 0 && (
        <div className="sb-qa-alert">
          Zero &lt;p&gt; tags found. The transcript HTML may have changed structure,
          or NPR may be blocking the request.
        </div>
      )}

      <h3 className="sb-sub-heading">Duration vs Speech Math</h3>
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
          <span className="sb-qa-val">{formatTime(qa.expectedSpeechSec)} ({qa.expectedSpeechSec}s)</span>
        </div>
        <div className="sb-qa-row sb-qa-highlight">
          <span className="sb-qa-label">Unaccounted time (implied ads)</span>
          <span className="sb-qa-val">{formatTime(qa.impliedAdTimeSec)} ({qa.impliedAdTimeSec}s)</span>
        </div>
      </div>

      <h3 className="sb-sub-heading">Parsed Lines</h3>
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
    </div>
  );
}

function StepFinalizePlayback({ result }: { result: SandboxResult }) {
  const { summary } = result;
  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        Waits for <strong>both</strong> the audio pipeline (steps 3-7) and the HTML transcript
        (step 8). Cross-references audio-detected ads against editorial transcript, validates
        skip map, and produces episode summary + final playback config.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Total ad blocks</span><span className="sb-kv-v">{summary.totalAdBlocks}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad time</span><span className="sb-kv-v">{summary.totalAdTimeSec}s</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Content time</span><span className="sb-kv-v">{summary.contentTimeSec}s</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Strategy</span><span className="sb-kv-v">{summary.strategy}</span></div>
      </div>

      <Timeline result={result} />

      <h3 className="sb-sub-heading">Skip Map (Player JSON)</h3>
      <div className="sb-qa-callout">
        This JSON is what the audio player uses to auto-skip ad segments.
        Each entry defines a time range, confidence score, and reason.
      </div>
      {result.skipMap.length === 0 && (
        <div className="sb-qa-alert">
          Empty skip map — the player will not skip anything for this episode.
        </div>
      )}
      <pre className="sb-code-block sb-json-text">
        {JSON.stringify(result.skipMap, null, 2)}
      </pre>
    </div>
  );
}

// ─── Shared sub-components ───────────────────────────────────────────────────

function Timeline({ result }: { result: SandboxResult }) {
  const dur = result.episode.durationSec;
  if (!dur) return null;

  const W = 80;
  const cells = Array(W).fill(false);
  for (const b of result.adBlocks) {
    const s = Math.floor((b.startTimeSec / dur) * W);
    const e = Math.min(W - 1, Math.floor((b.endTimeSec / dur) * W));
    for (let i = s; i <= e; i++) cells[i] = true;
  }

  const totalAdSec = result.adBlocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);

  return (
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
  );
}

function TranscriptViewer({
  lines,
  adBlocks,
  durationSec,
}: {
  lines: SandboxLine[];
  adBlocks: SandboxAdBlock[];
  durationSec: number;
}) {
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

  const adLineSet = new Set<number>();
  const adLineToBlock = new Map<number, SandboxAdBlock>();
  for (const b of adBlocks) {
    for (let i = b.startLine; i <= b.endLine; i++) {
      adLineSet.add(i);
      adLineToBlock.set(i, b);
    }
  }

  let lastWasAd = false;
  const elements: JSX.Element[] = [];

  for (const l of lines) {
    const isAd = adLineSet.has(l.lineNum);
    const approxTime = durationSec > 0 && totalWords > 0
      ? (l.cumulativeWords / totalWords) * durationSec
      : 0;

    if (isAd && !lastWasAd) {
      const block = adLineToBlock.get(l.lineNum)!;
      elements.push(
        <div key={`ad-start-${l.lineNum}`} className="sb-ad-banner start">
          AD BLOCK (sentences {block.startLine}–{block.endLine}){' '}
          {formatTimestamp(block.startTimeSec)} – {formatTimestamp(block.endTimeSec)}
          {' — '}{block.reason}
        </div>
      );
    }

    elements.push(
      <div key={l.lineNum} className={`sb-line ${isAd ? 'is-ad' : ''}`}>
        <span className="sb-line-time">{formatTimestamp(approxTime)}</span>
        <span className="sb-line-num">{l.lineNum}</span>
        {isAd && <span className="sb-line-ad-mark" />}
        <span className="sb-line-text">
          {l.speaker && <strong>{l.speaker}: </strong>}
          {l.text}
        </span>
      </div>
    );

    if (lastWasAd && !isAd) {
      elements.push(
        <div key={`ad-end-${l.lineNum}`} className="sb-ad-banner end">
          END AD BLOCK
        </div>
      );
    }
    lastWasAd = isAd;
  }
  if (lastWasAd) {
    elements.push(
      <div key="ad-end-final" className="sb-ad-banner end">
        END AD BLOCK
      </div>
    );
  }

  return <div className="sb-transcript">{elements}</div>;
}

// ─── Collapsible step wrapper ────────────────────────────────────────────────

function StepSection({ index, step, children, defaultOpen = false, stepStatus }: {
  index: number;
  step: StepDef;
  children: React.ReactNode;
  defaultOpen?: boolean;
  stepStatus?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const statusBadge = stepStatus === 'error' ? 'sb-status-error' :
                       stepStatus === 'skipped' ? 'sb-status-skipped' :
                       stepStatus === 'complete' ? 'sb-status-ok' : '';

  return (
    <section className={`sb-section ${open ? 'open' : 'collapsed'}`}>
      <button className="sb-section-header" onClick={() => setOpen(o => !o)}>
        <span className="sb-step-badge">Step {index + 1}</span>
        <span className="sb-step-type">{step.type}</span>
        {statusBadge && <span className={`sb-step-status-dot ${statusBadge}`} />}
        <h2 className="sb-step-title">{step.label}</h2>
        <span className="sb-section-toggle">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      <p className="sb-step-subtitle">{step.subtitle}</p>
      {open && children}
    </section>
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
}: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  const handleCopyFeedback = useCallback(() => {
    const text = buildFeedbackText(result, pipelineSteps, pipelineStatus, episode, podcastName);
    navigator.clipboard.writeText(text).then(() => {
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    }).catch(() => {
      // Fallback: open in a prompt
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

  // Map step statuses for status dots
  const stepStatusMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of pipelineSteps) {
      map[s.id] = s.status;
    }
    return map;
  }, [pipelineSteps]);

  // Counts for header
  const errorCount = pipelineSteps.filter(s => s.status === 'error').length;
  const skippedCount = pipelineSteps.filter(s => s.status === 'skipped').length;
  const completeCount = pipelineSteps.filter(s => s.status === 'complete').length;

  // Derive activity text from the active step
  const activity = useMemo(() => {
    const active = pipelineSteps.find(s => s.status === 'active');
    if (!active) return undefined;
    return (active.meta as Record<string, unknown>)?.message as string || `${active.label}...`;
  }, [pipelineSteps]);

  const isIdle = pipelineStatus === 'idle';
  const isRunning = pipelineStatus === 'running';

  return (
    <div className="sb-page">
      <header className="sb-header">
        <button className="sb-back" onClick={onBack}>Back</button>
        <div className="sb-header-center">
          <h1 className="sb-title">Pipeline Debug Report</h1>
          {episode && (
            <span className="sb-header-ep">{episode.title}</span>
          )}
        </div>
        <button
          className={`sb-copy-feedback ${copyState === 'copied' ? 'copied' : ''}`}
          onClick={handleCopyFeedback}
          title="Copy pipeline debug info for an agent or developer"
        >
          {copyState === 'copied' ? 'Copied!' : 'Copy Feedback'}
        </button>
      </header>

      {/* Pipeline overview — always visible, same flow as main screen */}
      {!isIdle && (
        <div className="sb-flow-overview">
          <FlowProgress
            mode="expanded"
            steps={pipelineSteps}
            status={pipelineStatus}
            label="Ad Detection Pipeline"
            activity={activity}
          />
          <div className="sb-flow-stats">
            <span className="sb-stat sb-stat-ok">{completeCount} done</span>
            {errorCount > 0 && <span className="sb-stat sb-stat-error">{errorCount} error{errorCount > 1 ? 's' : ''}</span>}
            {skippedCount > 0 && <span className="sb-stat sb-stat-skip">{skippedCount} skipped</span>}
          </div>
        </div>
      )}

      {/* Idle: no episode selected yet */}
      {isIdle && (
        <div className="sb-error-full">
          <div className="sb-error-icon">?</div>
          <p>No pipeline running. Select an episode on the main screen to start the analysis.</p>
          <button className="sb-retry-btn" onClick={onBack}>
            Go Back
          </button>
        </div>
      )}

      {/* Running: flow is in progress, show the live tracker only */}
      {isRunning && !result && (
        <div className="sb-running-notice">
          <div className="sb-loading-spinner" />
          <p>Pipeline is processing. Step details will appear here as they complete.</p>
        </div>
      )}

      {/* Error with no result */}
      {pipelineStatus === 'error' && !result && (
        <div className="sb-error-full">
          <div className="sb-error-icon">!</div>
          <p>Pipeline failed. Use "Copy Feedback" above to capture debug info for investigation.</p>
          <button className="sb-retry-btn" onClick={onBack}>
            Go Back
          </button>
        </div>
      )}

      {/* Result available (complete or error with partial result) — show full debug report */}
      {result && (
        <div className="sb-report-scroll">
          <StepSection index={0} step={STEPS[0]} stepStatus={stepStatusMap['step_fetch_rss']}>
            <StepFetchRss podcastName={podcastName} podcastId={podcastId} />
          </StepSection>

          <StepSection index={1} step={STEPS[1]} stepStatus={stepStatusMap['step_parse_episodes']}>
            <StepParseEpisodes result={result} />
          </StepSection>

          <StepSection index={2} step={STEPS[2]} stepStatus={stepStatusMap['step_resolve_audio_stream']}>
            <StepResolveAudioStream result={result} />
          </StepSection>

          <StepSection index={3} step={STEPS[3]} stepStatus={stepStatusMap['step_start_audio_streaming']}>
            <StepStreamAudioChunks result={result} />
          </StepSection>

          <StepSection index={4} step={STEPS[4]} stepStatus={stepStatusMap['step_transcribe_chunks']}>
            <StepTranscribeChunks result={result} />
          </StepSection>

          <StepSection index={5} step={STEPS[5]} stepStatus={stepStatusMap['step_mark_ad_locations']} defaultOpen={true}>
            <StepMarkAdLocations result={result} />
          </StepSection>

          <StepSection index={6} step={STEPS[6]} stepStatus={stepStatusMap['step_build_skip_map']}>
            <StepBuildSkipMap result={result} />
          </StepSection>

          <StepSection index={7} step={STEPS[7]} stepStatus={stepStatusMap['step_fetch_html_transcript']}>
            <StepFetchHtmlTranscript result={result} />
          </StepSection>

          <StepSection index={8} step={STEPS[8]} stepStatus={stepStatusMap['step_finalize_playback']} defaultOpen={true}>
            <StepFinalizePlayback result={result} />
          </StepSection>
        </div>
      )}
    </div>
  );
}
