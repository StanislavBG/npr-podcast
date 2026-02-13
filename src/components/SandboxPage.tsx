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

interface Props {
  onBack: () => void;
}

// ─── Step definitions (mirrors podcastFlow.ts pipeline) ─────────────────────

interface StepDef {
  id: string;
  label: string;
  subtitle: string;
  type: string;
}

const STEPS: StepDef[] = [
  { id: 'fetch-rss',             label: 'Fetch RSS Feed',       subtitle: 'Pull podcast feed',         type: 'http.request' },
  { id: 'parse-episodes',       label: 'Parse Episodes',        subtitle: 'Extract episode metadata',  type: 'http.request' },
  { id: 'fetch-transcript',     label: 'Fetch Transcript',      subtitle: 'Get transcript content',    type: 'http.request' },
  { id: 'llm-parse-transcript', label: 'LLM Parse Transcript',  subtitle: 'Extract structured segments', type: 'ai.generate-text' },
  { id: 'llm-detect-ads',       label: 'LLM Detect Ads',        subtitle: 'Identify ad time ranges',   type: 'ai.generate-text' },
  { id: 'llm-prepare-player',   label: 'LLM Prepare Player',    subtitle: 'Build skip-map + summary',  type: 'ai.summarize' },
];

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
  const { episode, summary } = result;
  return (
    <div className="sb-step-body">
      <h2 className="sb-step-heading">{episode.title}</h2>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Duration</span><span className="sb-kv-v">{formatTime(episode.durationSec)} ({episode.durationSec}s)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Transcript URL</span><span className="sb-kv-v sb-kv-url">{episode.transcriptUrl || '(none)'}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Strategy</span><span className="sb-kv-v">{summary.strategy}</span></div>
      </div>
      <Timeline result={result} />
    </div>
  );
}

function StepFetchTranscript({ result }: { result: SandboxResult }) {
  const { rawHtml, transcript, qa } = result;
  const source = result.transcriptSource || 'html';
  const sourceLabels: Record<string, string> = {
    'audio-transcription': 'Audio Transcription (speech-to-text)',
    'srt': 'SRT subtitle file',
    'vtt': 'VTT subtitle file',
    'json': 'JSON transcript',
    'html': 'HTML page scraping',
  };

  const { lines } = transcript;
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = result.episode.durationSec;

  return (
    <div className="sb-step-body">
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

      {source === 'audio-transcription' && (
        <div className="sb-qa-ok">
          Audio transcription captures dynamic ads injected into the audio stream
          that don't appear in text transcripts.
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

function StepLlmParseTranscript({ result }: { result: SandboxResult }) {
  const { lines } = result.transcript;
  const speakers = new Set(lines.filter(l => l.speaker).map(l => l.speaker));

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>LLM extracts structured segments</strong> with speaker attribution
        from the raw transcript content.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Total lines</span><span className="sb-kv-v">{lines.length}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines with speaker</span><span className="sb-kv-v">{result.qa.linesWithSpeaker}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines without speaker</span><span className="sb-kv-v">{result.qa.linesWithoutSpeaker}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Unique speakers</span><span className="sb-kv-v">{speakers.size}</span></div>
      </div>

      {speakers.size > 0 && (
        <>
          <h3 className="sb-sub-heading">Speakers</h3>
          <div className="sb-kv-grid">
            {[...speakers].map(s => (
              <div key={s} className="sb-kv">
                <span className="sb-kv-k">{s}</span>
                <span className="sb-kv-v">{lines.filter(l => l.speaker === s).length} lines</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="sb-sub-heading">System Prompt</h3>
      <pre className="sb-code-block sb-prompt-text">{result.prompts.system}</pre>
    </div>
  );
}

function StepLlmDetectAds({ result }: { result: SandboxResult }) {
  const { adBlocks, episode, summary } = result;
  let parsed: any = null;
  try { parsed = JSON.parse(result.llmResponse); } catch { /* not JSON */ }

  return (
    <div className="sb-step-body">
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Ad blocks found</span><span className="sb-kv-v">{summary.totalAdBlocks}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad time</span><span className="sb-kv-v">{summary.totalAdTimeSec}s</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad word %</span><span className="sb-kv-v">{summary.adWordPercent}%</span></div>
        <div className="sb-kv"><span className="sb-kv-k">LLM-detected ad time</span><span className="sb-kv-v">{summary.totalAdTimeSec}s</span></div>
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

function StepLlmPreparePlayer({ result }: { result: SandboxResult }) {
  const { summary } = result;
  return (
    <div className="sb-step-body">
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

// ─── Main SandboxPage ────────────────────────────────────────────────────────

export function SandboxPage({ onBack }: Props) {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('Loading podcasts...');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [podcastInfo, setPodcastInfo] = useState<{ name: string; id: string }>({ name: '', id: '' });
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-fetch single podcast + episode and analyze on mount
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // 1. Fetch podcasts
        setStatus('Fetching RSS feed...');
        let podcasts;
        try {
          podcasts = await fetchPodcasts();
        } catch {
          podcasts = [{ id: '510325', name: 'The Indicator from Planet Money' }];
        }
        if (cancelled) return;

        // Pick first podcast
        const podcastId = podcasts[0].id;
        setPodcastInfo({ name: podcasts[0].name, id: podcastId });
        setStatus(`Parsing episodes for ${podcasts[0].name}...`);

        // 2. Fetch episodes
        const data = await fetchEpisodes(podcastId);
        if (cancelled) return;

        // Pick first episode with transcript
        const ep = data.episodes.find(e => e.transcriptUrl || (e.podcastTranscripts && e.podcastTranscripts.length > 0));
        if (!ep) {
          setError('No episodes with transcripts found.');
          setLoading(false);
          return;
        }

        setStatus(`Fetching transcript: ${ep.title}...`);

        // 3. Run analysis (prefer audio transcription when audioUrl available)
        const res = await sandboxAnalyze(
          ep.transcriptUrl!,
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

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setStep(s => Math.min(s + 1, STEPS.length - 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setStep(s => Math.max(s - 1, 0));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Scroll content to top when step changes
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [step]);

  const goLeft = () => setStep(s => Math.max(s - 1, 0));
  const goRight = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const current = STEPS[step];

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="sb-page">
      {/* Header */}
      <header className="sb-header">
        <button className="sb-back" onClick={onBack}>Back</button>
        <div className="sb-header-center">
          <h1 className="sb-title">Ad Detection QA</h1>
          {result && (
            <span className="sb-header-ep">{result.episode.title}</span>
          )}
        </div>
        {result && (
          <span className="sb-step-counter">{step + 1}/{STEPS.length}</span>
        )}
      </header>

      {/* Loading state */}
      {loading && (
        <div className="sb-loading-full">
          <div className="sb-loading-spinner" />
          <span className="sb-loading-status">{status}</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="sb-error-full">
          <div className="sb-error-icon">!</div>
          <p>{error}</p>
          <button className="sb-retry-btn" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      )}

      {/* Step carousel */}
      {result && !loading && (
        <>
          {/* Step nav pills */}
          <nav className="sb-step-nav">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                className={`sb-step-pill ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                onClick={() => setStep(i)}
              >
                <span className="sb-pill-num">{i + 1}</span>
                <span className="sb-pill-label">{s.label}</span>
              </button>
            ))}
          </nav>

          {/* Step content */}
          <div className="sb-step-content" ref={contentRef}>
            <div className="sb-step-header">
              <span className="sb-step-badge">Step {step + 1}</span>
              <span className="sb-step-type">{current.type}</span>
              <h2 className="sb-step-title">{current.label}</h2>
              <p className="sb-step-subtitle">{current.subtitle}</p>
            </div>

            {step === 0 && <StepFetchRss podcastName={podcastInfo.name} podcastId={podcastInfo.id} />}
            {step === 1 && <StepParseEpisodes result={result} />}
            {step === 2 && <StepFetchTranscript result={result} />}
            {step === 3 && <StepLlmParseTranscript result={result} />}
            {step === 4 && <StepLlmDetectAds result={result} />}
            {step === 5 && <StepLlmPreparePlayer result={result} />}
          </div>

          {/* Bottom nav */}
          <footer className="sb-step-footer">
            <button
              className="sb-nav-btn sb-nav-prev"
              onClick={goLeft}
              disabled={step === 0}
            >
              Prev
            </button>
            <div className="sb-step-dots">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`sb-dot ${i === step ? 'active' : ''}`}
                  onClick={() => setStep(i)}
                />
              ))}
            </div>
            <button
              className="sb-nav-btn sb-nav-next"
              onClick={goRight}
              disabled={step === STEPS.length - 1}
            >
              Next
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
