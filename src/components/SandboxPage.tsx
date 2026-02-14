import { useState, useEffect, useRef } from 'react';
import {
  fetchPodcasts,
  fetchEpisodes,
  sandboxAnalyze,
  parseDuration,
  formatTime,
  type SandboxResult,
  type SandboxAdBlock,
  type SandboxLine,
} from '../services/api';
import { STEP_ORDER, STEP_META } from '../workflows/podcastFlow';

interface Props {
  onBack: () => void;
}

// ─── Step definitions: derived from podcastFlow.ts (single source of truth) ──

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
    step_transcribe_chunks:     'Speech-to-text on audio via OpenAI',
    step_mark_ad_locations:     'LLM classifies segments as content or ad',
    step_build_skip_map:        'Merge adjacent ad segments into skip ranges',
    step_fetch_html_transcript: 'Fetch NPR HTML transcript for cross-reference',
    step_finalize_playback:     'Reconcile + summary + build player config',
  }[id] || '',
}));

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

  // HEAD request succeeded if we have a resolvedUrl or contentType
  const headSucceeded = !!(audio.resolvedUrl || audio.contentType);
  const fileSizeMb = audio.contentLengthBytes > 0
    ? (audio.contentLengthBytes / 1024 / 1024).toFixed(1)
    : audio.downloadSizeMb;
  const tooLarge = audio.contentLengthBytes > 25 * 1024 * 1024; // OpenAI Whisper 25MB limit

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

  const chunkDurationSec = 300; // 5 minutes
  const bytesPerChunk = chunkDurationSec * (128000 / 8); // ~4.7 MB at 128kbps
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
        Audio is fetched in <strong>5-minute chunks</strong> via HTTP Range requests.
        Each chunk is ~{chunkSizeMb} MB — well under Whisper's 25 MB limit.
        A 10-second overlap between chunks catches ad boundaries.
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
    </div>
  );
}

function StepTranscribeChunks({ result }: { result: SandboxResult }) {
  const audio = result.audioDetails;
  const isAudioSource = result.transcriptSource === 'audio-transcription' || result.transcriptSource === 'audio-transcription-chunked';

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
        speech-to-text with <code>verbose_json</code> format to get segment-level timestamps.
        {isAudioSource && (
          <> Audio transcription captures <strong>dynamic ads</strong> inserted by Megaphone
          that never appear in text transcripts.</>
        )}
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Model</span><span className="sb-kv-v">{audio.transcriptionModel}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Response format</span><span className="sb-kv-v">verbose_json (segment timestamps)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Segments returned</span><span className="sb-kv-v">{audio.segmentCount}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Audio duration (STT)</span><span className="sb-kv-v">{audio.audioDurationSec > 0 ? `${formatTime(audio.audioDurationSec)} (${audio.audioDurationSec.toFixed(1)}s)` : '(not reported)'}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines produced</span><span className="sb-kv-v">{result.transcript.lineCount}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Total words</span><span className="sb-kv-v">{result.transcript.totalWords.toLocaleString()}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Transcript source used</span><span className="sb-kv-v">{isAudioSource ? 'Audio transcription (STT)' : result.transcriptSource || 'html'}</span></div>
      </div>
      {isAudioSource ? (
        <div className="sb-qa-ok">
          Audio transcription succeeded — this captures dynamic ads in the audio stream.
        </div>
      ) : (
        <div className="sb-qa-alert">
          Audio transcription did not produce the final transcript. Source used: {result.transcriptSource}
        </div>
      )}
    </div>
  );
}

function StepMarkAdLocations({ result }: { result: SandboxResult }) {
  const { adBlocks, episode, summary } = result;
  let parsed: any = null;
  try { parsed = JSON.parse(result.llmResponse); } catch { /* not JSON */ }

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        Numbered transcript lines are sent to the LLM. It identifies contiguous line ranges
        that are ads, sponsor reads, funding credits, or promos.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Ad blocks found</span><span className="sb-kv-v">{summary.totalAdBlocks}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad time</span><span className="sb-kv-v">{summary.totalAdTimeSec}s</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad word %</span><span className="sb-kv-v">{summary.adWordPercent}%</span></div>
      </div>

      {adBlocks.length === 0 ? (
        <div className="sb-qa-alert">
          No ad blocks detected. The transcript may not contain any ad-like content,
          or ads are dynamically inserted into the audio stream only.
        </div>
      ) : (
        <>
          <Timeline result={result} />
          <div className="sb-ad-list">
            {adBlocks.map((b, i) => (
              <AdBlockCard key={i} block={b} index={i} durationSec={episode.durationSec} />
            ))}
          </div>
        </>
      )}

      {/* Annotated transcript */}
      <h3 className="sb-sub-heading">Annotated Transcript</h3>
      <div className="sb-qa-callout">
        Lines highlighted in red are detected ad blocks. Scan for any the LLM may have missed.
      </div>
      <TranscriptViewer
        lines={result.transcript.lines}
        adBlocks={result.adBlocks}
        durationSec={result.episode.durationSec}
      />

      {/* LLM response detail */}
      <h3 className="sb-sub-heading">System Prompt</h3>
      <pre className="sb-code-block sb-prompt-text">{result.prompts.system}</pre>

      <h3 className="sb-sub-heading">User Prompt</h3>
      <pre className="sb-code-block sb-prompt-text">{result.prompts.user}</pre>

      <h3 className="sb-sub-heading">Raw LLM Response</h3>
      {parsed && parsed.adBlocks?.length === 0 && (
        <div className="sb-qa-alert">
          The LLM returned zero ad blocks.
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

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>Pure computation</strong> — no external calls. Adjacent ad segments are merged,
        padding is added (0.5s before, 0.3s after), and line ranges are mapped to timestamps
        using proportional word position.
      </div>

      <h3 className="sb-sub-heading">Timestamp Mapping</h3>
      <div className="sb-qa-math">
        <div className="sb-qa-row">
          <span className="sb-qa-label">Total transcript words</span>
          <span className="sb-qa-val">{totalWords.toLocaleString()}</span>
        </div>
        <div className="sb-qa-row">
          <span className="sb-qa-label">Audio duration</span>
          <span className="sb-qa-val">{formatTime(dur)} ({dur}s)</span>
        </div>
        <div className="sb-qa-row">
          <span className="sb-qa-label">Mapping formula</span>
          <span className="sb-qa-val">timeSec = (cumulativeWords / totalWords) * duration</span>
        </div>
      </div>

      {adBlocks.length > 0 && (
        <>
          <h3 className="sb-sub-heading">Ad Block Mappings</h3>
          <div className="sb-ad-list">
            {adBlocks.map((b, i) => (
              <div key={i} className="sb-ad-card">
                <div className="sb-ad-card-header">
                  <span className="sb-ad-badge">AD {i + 1}</span>
                  <span className="sb-ad-lines">Lines {b.startLine}--{b.endLine}</span>
                  <span className="sb-ad-time">Words {b.startWord}--{b.endWord}</span>
                </div>
                <div className="sb-qa-math" style={{ marginTop: '0.5rem' }}>
                  <div className="sb-qa-row">
                    <span className="sb-qa-label">Start</span>
                    <span className="sb-qa-val">{b.startWord}/{totalWords} words = {formatTime(b.startTimeSec)} ({b.startTimeSec.toFixed(1)}s)</span>
                  </div>
                  <div className="sb-qa-row">
                    <span className="sb-qa-label">End</span>
                    <span className="sb-qa-val">{b.endWord}/{totalWords} words = {formatTime(b.endTimeSec)} ({b.endTimeSec.toFixed(1)}s)</span>
                  </div>
                  <div className="sb-qa-row sb-qa-highlight">
                    <span className="sb-qa-label">Duration</span>
                    <span className="sb-qa-val">{(b.endTimeSec - b.startTimeSec).toFixed(1)}s</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <Timeline result={result} />
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

      {/* QA: Duration vs speech math */}
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

      {/* Parsed lines */}
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

  return (
    <div className="sb-timeline">
      <div className="sb-timeline-labels">
        <span>0:00</span>
        <span>{formatTime(dur)}</span>
      </div>
      <div className="sb-timeline-bar">
        {cells.map((isAd, i) => (
          <div key={i} className={`sb-timeline-cell ${isAd ? 'ad' : ''}`} />
        ))}
      </div>
      <div className="sb-timeline-legend">
        <span><span className="sb-legend-dot content" /> content</span>
        <span><span className="sb-legend-dot ad" /> ad block</span>
      </div>
    </div>
  );
}

function AdBlockCard({ block, index, durationSec }: { block: SandboxAdBlock; index: number; durationSec: number }) {
  const duration = block.endTimeSec - block.startTimeSec;
  const words = block.endWord - block.startWord;
  const pctOfEpisode = durationSec > 0 ? ((duration / durationSec) * 100).toFixed(1) : '0';

  return (
    <div className="sb-ad-card">
      <div className="sb-ad-card-header">
        <span className="sb-ad-badge">AD {index + 1}</span>
        <span className="sb-ad-lines">Lines {block.startLine}--{block.endLine}</span>
        <span className="sb-ad-time">
          {formatTime(block.startTimeSec)} -- {formatTime(block.endTimeSec)}
        </span>
        <span className="sb-ad-dur">{duration.toFixed(0)}s ({pctOfEpisode}%), ~{words} words</span>
      </div>
      <div className="sb-ad-card-reason">{block.reason}</div>
      <div className="sb-ad-card-preview">"{block.textPreview}"</div>
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
          AD BLOCK (lines {block.startLine}--{block.endLine}){' '}
          {formatTime(block.startTimeSec)} -- {formatTime(block.endTimeSec)}
          {' -- '}{block.reason}
        </div>
      );
    }

    elements.push(
      <div key={l.lineNum} className={`sb-line ${isAd ? 'is-ad' : ''}`}>
        <span className="sb-line-time">{formatTime(approxTime)}</span>
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

function StepSection({ index, step, children, defaultOpen = true }: {
  index: number;
  step: StepDef;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`sb-section ${open ? 'open' : 'collapsed'}`}>
      <button className="sb-section-header" onClick={() => setOpen(o => !o)}>
        <span className="sb-step-badge">Step {index + 1}</span>
        <span className="sb-step-type">{step.type}</span>
        <h2 className="sb-step-title">{step.label}</h2>
        <span className="sb-section-toggle">{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      <p className="sb-step-subtitle">{step.subtitle}</p>
      {open && children}
    </section>
  );
}

// ─── Main SandboxPage ────────────────────────────────────────────────────────

export function SandboxPage({ onBack }: Props) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('Loading podcasts...');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [podcastInfo, setPodcastInfo] = useState<{ name: string; id: string }>({ name: '', id: '' });

  // Auto-fetch single podcast + episode and analyze on mount
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setStatus('Fetching RSS feed...');
        let podcasts;
        try {
          podcasts = await fetchPodcasts();
        } catch {
          podcasts = [{ id: '510325', name: 'The Indicator from Planet Money' }];
        }
        if (cancelled) return;

        const podcastId = podcasts[0].id;
        setPodcastInfo({ name: podcasts[0].name, id: podcastId });
        setStatus(`Parsing episodes for ${podcasts[0].name}...`);

        const data = await fetchEpisodes(podcastId);
        if (cancelled) return;

        const ep = data.episodes.find(e =>
          e.transcriptUrl ||
          e.audioUrl ||
          (e.podcastTranscripts && e.podcastTranscripts.length > 0)
        );
        if (!ep) {
          setError('No episodes with transcripts found.');
          setLoading(false);
          return;
        }

        setStatus(`Analyzing: ${ep.title}...`);

        const res = await sandboxAnalyze(
          ep.transcriptUrl || '',
          ep.title,
          parseDuration(ep.duration),
          ep.podcastTranscripts,
          ep.audioUrl || undefined,
        );
        if (cancelled) return;

        setResult(res);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Analysis failed');
          setLoading(false);
        }
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="sb-page">
      <header className="sb-header">
        <button className="sb-back" onClick={onBack}>Back</button>
        <div className="sb-header-center">
          <h1 className="sb-title">Pipeline Report</h1>
          {result && (
            <span className="sb-header-ep">{result.episode.title}</span>
          )}
        </div>
      </header>

      {loading && (
        <div className="sb-loading-full">
          <div className="sb-loading-spinner" />
          <span className="sb-loading-status">{status}</span>
        </div>
      )}

      {error && !loading && (
        <div className="sb-error-full">
          <div className="sb-error-icon">!</div>
          <p>{error}</p>
          <button className="sb-retry-btn" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      )}

      {result && !loading && (
        <div className="sb-report-scroll">
          <StepSection index={0} step={STEPS[0]}>
            <StepFetchRss podcastName={podcastInfo.name} podcastId={podcastInfo.id} />
          </StepSection>

          <StepSection index={1} step={STEPS[1]}>
            <StepParseEpisodes result={result} />
          </StepSection>

          <StepSection index={2} step={STEPS[2]}>
            <StepResolveAudioStream result={result} />
          </StepSection>

          <StepSection index={3} step={STEPS[3]}>
            <StepStreamAudioChunks result={result} />
          </StepSection>

          <StepSection index={4} step={STEPS[4]}>
            <StepTranscribeChunks result={result} />
          </StepSection>

          <StepSection index={5} step={STEPS[5]}>
            <StepMarkAdLocations result={result} />
          </StepSection>

          <StepSection index={6} step={STEPS[6]}>
            <StepBuildSkipMap result={result} />
          </StepSection>

          <StepSection index={7} step={STEPS[7]}>
            <StepFetchHtmlTranscript result={result} />
          </StepSection>

          <StepSection index={8} step={STEPS[8]}>
            <StepFinalizePlayback result={result} />
          </StepSection>
        </div>
      )}
    </div>
  );
}
