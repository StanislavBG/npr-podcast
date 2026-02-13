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

// ─── Step definitions ────────────────────────────────────────────────────────

interface StepDef {
  id: string;
  label: string;
  subtitle: string;
}

const STEPS: StepDef[] = [
  { id: 'episode',    label: 'Episode',           subtitle: 'What we\'re analyzing' },
  { id: 'raw-html',   label: 'Raw HTML',          subtitle: 'What NPR returned' },
  { id: 'parsed',     label: 'Parsed Lines',      subtitle: 'After HTML parsing' },
  { id: 'qa-diag',    label: 'QA Diagnostics',    subtitle: 'The math doesn\'t add up?' },
  { id: 'sys-prompt', label: 'System Prompt',      subtitle: 'LLM instructions' },
  { id: 'usr-prompt', label: 'User Prompt',        subtitle: 'What we send to the LLM' },
  { id: 'llm-resp',   label: 'LLM Response',       subtitle: 'What the LLM returned' },
  { id: 'ad-blocks',  label: 'Ad Blocks',          subtitle: 'Detected ad segments' },
  { id: 'transcript', label: 'Annotated Transcript', subtitle: 'Full transcript + ad markers' },
  { id: 'skip-map',   label: 'Skip Map',           subtitle: 'Final player JSON' },
];

// ─── Step content renderers ──────────────────────────────────────────────────

function StepEpisode({ result }: { result: SandboxResult }) {
  const { episode, summary } = result;
  return (
    <div className="sb-step-body">
      <h2 className="sb-step-heading">{episode.title}</h2>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Duration</span><span className="sb-kv-v">{formatTime(episode.durationSec)} ({episode.durationSec}s)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Transcript URL</span><span className="sb-kv-v sb-kv-url">{episode.transcriptUrl}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Strategy</span><span className="sb-kv-v">{summary.strategy}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines</span><span className="sb-kv-v">{result.transcript.lineCount}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Words</span><span className="sb-kv-v">{result.transcript.totalWords.toLocaleString()}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad blocks found</span><span className="sb-kv-v">{summary.totalAdBlocks}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad time</span><span className="sb-kv-v">{summary.totalAdTimeSec}s</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Ad word %</span><span className="sb-kv-v">{summary.adWordPercent}%</span></div>
      </div>

      <Timeline result={result} />
    </div>
  );
}

function StepRawHtml({ result }: { result: SandboxResult }) {
  const { rawHtml } = result;
  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>QA Check:</strong> Does the HTML actually contain transcript paragraphs?
        If NPR changed their page structure, the parser won't find &lt;p&gt; tags.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">HTML size</span><span className="sb-kv-v">{(rawHtml.length / 1024).toFixed(1)} KB ({rawHtml.length.toLocaleString()} chars)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">&lt;p&gt; tags found</span><span className="sb-kv-v">{rawHtml.pTagCount}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines parsed</span><span className="sb-kv-v">{result.transcript.lineCount}</span></div>
      </div>
      {rawHtml.pTagCount === 0 && (
        <div className="sb-qa-alert">
          Zero &lt;p&gt; tags found. The transcript HTML may have changed structure,
          or NPR may be blocking the request. Check the snippet below.
        </div>
      )}
      <h3 className="sb-sub-heading">HTML Snippet (first 2KB)</h3>
      <pre className="sb-code-block">{rawHtml.snippet}</pre>
    </div>
  );
}

function StepParsedLines({ result }: { result: SandboxResult }) {
  const { lines } = result.transcript;
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const dur = result.episode.durationSec;

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>QA Check:</strong> Scan these lines as a human. Can you spot any
        "Support for this podcast comes from..." or funding credits? If you can see them
        but the LLM missed them, the problem is in the prompt. If you can't see them,
        the ads are dynamically inserted audio — not in the transcript at all.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Total lines</span><span className="sb-kv-v">{lines.length}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Total words</span><span className="sb-kv-v">{totalWords.toLocaleString()}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Speakers detected</span><span className="sb-kv-v">{new Set(lines.filter(l => l.speaker).map(l => l.speaker)).size}</span></div>
      </div>
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

function StepQaDiagnostics({ result }: { result: SandboxResult }) {
  const { qa, summary } = result;
  const gap = qa.impliedAdTimeSec;
  const gapPercent = qa.audioDurationSec > 0
    ? ((gap / qa.audioDurationSec) * 100).toFixed(1)
    : '0';

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>The core question:</strong> NPR uses Megaphone for dynamic ad insertion.
        The transcript only contains editorial text — ads are injected into the audio
        stream separately. So the transcript will <em>never</em> contain the actual ad copy
        (Geico, Squarespace, etc). Only "funding credits" like "Support for NPR comes from..."
        appear in the text.
      </div>

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
          <span className="sb-qa-val">{formatTime(gap)} ({gap}s = {gapPercent}%)</span>
        </div>
        <div className="sb-qa-row">
          <span className="sb-qa-label">LLM-detected ad time</span>
          <span className="sb-qa-val">{summary.totalAdTimeSec}s</span>
        </div>
      </div>

      <h3 className="sb-sub-heading">Speaker Breakdown</h3>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Lines with speaker</span><span className="sb-kv-v">{qa.linesWithSpeaker}</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines without speaker</span><span className="sb-kv-v">{qa.linesWithoutSpeaker}</span></div>
      </div>

      {gap > 30 && summary.totalAdTimeSec === 0 && (
        <div className="sb-qa-alert">
          There's {gap}s of unaccounted time but zero ad blocks were found in the transcript.
          This strongly suggests the ads are dynamically inserted audio that doesn't
          appear in the transcript text at all. The LLM can only find what's actually
          written in the transcript.
        </div>
      )}

      {gap < 15 && (
        <div className="sb-qa-ok">
          Audio duration closely matches expected speech time. This episode may have
          minimal or no dynamically inserted ads.
        </div>
      )}
    </div>
  );
}

function StepSystemPrompt({ result }: { result: SandboxResult }) {
  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>QA Check:</strong> Does the system prompt correctly describe what to look for?
        Are the patterns listed comprehensive? Should we add more patterns or change the instructions?
      </div>
      <pre className="sb-code-block sb-prompt-text">{result.prompts.system}</pre>
    </div>
  );
}

function StepUserPrompt({ result }: { result: SandboxResult }) {
  const lineCount = (result.prompts.user.match(/\n/g) || []).length + 1;
  const charCount = result.prompts.user.length;
  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>QA Check:</strong> Is the full transcript included? Is anything truncated?
        The LLM can only detect ads in lines it can see.
      </div>
      <div className="sb-kv-grid">
        <div className="sb-kv"><span className="sb-kv-k">Prompt size</span><span className="sb-kv-v">{(charCount / 1024).toFixed(1)} KB ({charCount.toLocaleString()} chars)</span></div>
        <div className="sb-kv"><span className="sb-kv-k">Lines in prompt</span><span className="sb-kv-v">{lineCount}</span></div>
      </div>
      <pre className="sb-code-block sb-prompt-text">{result.prompts.user}</pre>
    </div>
  );
}

function StepLlmResponse({ result }: { result: SandboxResult }) {
  let parsed: any = null;
  try { parsed = JSON.parse(result.llmResponse); } catch { /* not JSON */ }

  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>QA Check:</strong> Did the LLM return valid JSON? Did it find any adBlocks?
        If the array is empty, the LLM didn't see anything that matched the ad patterns
        in the transcript text.
      </div>
      {parsed && (
        <div className="sb-kv-grid">
          <div className="sb-kv">
            <span className="sb-kv-k">adBlocks returned</span>
            <span className="sb-kv-v">{parsed.adBlocks?.length ?? 'N/A'}</span>
          </div>
        </div>
      )}
      {parsed && parsed.adBlocks?.length === 0 && (
        <div className="sb-qa-alert">
          The LLM returned zero ad blocks. Either the transcript genuinely contains no
          ad-like content (all ads are dynamic audio injection), or the prompt needs tuning.
        </div>
      )}
      <pre className="sb-code-block sb-json-text">{result.llmResponse}</pre>
    </div>
  );
}

function StepAdBlocks({ result }: { result: SandboxResult }) {
  const { adBlocks, episode } = result;
  return (
    <div className="sb-step-body">
      {adBlocks.length === 0 ? (
        <>
          <div className="sb-qa-alert">
            No ad blocks detected. This is the key finding for QA.
            Check the "QA Diagnostics" step to see if there's unaccounted time
            in the audio that suggests dynamic ad insertion.
          </div>
          <div className="sb-qa-callout">
            <strong>Why this happens:</strong> NPR uses Megaphone to dynamically
            insert ads into the audio stream. These ads are NOT part of the editorial
            transcript. The transcript only contains what the hosts/guests actually said,
            plus occasional "funding credits" like "Support for NPR comes from...".
          </div>
        </>
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
    </div>
  );
}

function StepAnnotatedTranscript({ result }: { result: SandboxResult }) {
  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>QA Check:</strong> Read through the transcript. Lines highlighted in red
        are detected ad blocks. Can you spot any ad-like content the LLM missed?
        Look for: "Support for...", "This message comes from...", sponsor names, promo codes.
      </div>
      <TranscriptViewer
        lines={result.transcript.lines}
        adBlocks={result.adBlocks}
        durationSec={result.episode.durationSec}
      />
    </div>
  );
}

function StepSkipMap({ result }: { result: SandboxResult }) {
  return (
    <div className="sb-step-body">
      <div className="sb-qa-callout">
        <strong>Final output:</strong> This JSON is what the audio player uses to auto-skip.
        Each entry defines a time range to skip, a confidence score, and the reason.
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
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-fetch single podcast + episode and analyze on mount
  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        // 1. Fetch podcasts
        setStatus('Loading podcasts...');
        let podcasts;
        try {
          podcasts = await fetchPodcasts();
        } catch {
          podcasts = [{ id: '510325', name: 'The Indicator from Planet Money' }];
        }
        if (cancelled) return;

        // Pick first podcast
        const podcastId = podcasts[0].id;
        setStatus(`Loading episodes for ${podcasts[0].name}...`);

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

        setStatus(`Analyzing: ${ep.title}...`);

        // 3. Run analysis
        const res = await sandboxAnalyze(
          ep.transcriptUrl!,
          ep.title,
          parseDuration(ep.duration),
          ep.podcastTranscripts,
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
              <h2 className="sb-step-title">{current.label}</h2>
              <p className="sb-step-subtitle">{current.subtitle}</p>
            </div>

            {step === 0 && <StepEpisode result={result} />}
            {step === 1 && <StepRawHtml result={result} />}
            {step === 2 && <StepParsedLines result={result} />}
            {step === 3 && <StepQaDiagnostics result={result} />}
            {step === 4 && <StepSystemPrompt result={result} />}
            {step === 5 && <StepUserPrompt result={result} />}
            {step === 6 && <StepLlmResponse result={result} />}
            {step === 7 && <StepAdBlocks result={result} />}
            {step === 8 && <StepAnnotatedTranscript result={result} />}
            {step === 9 && <StepSkipMap result={result} />}
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
