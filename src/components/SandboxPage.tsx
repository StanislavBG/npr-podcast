import { useState, useCallback, useEffect } from 'react';
import {
  fetchPodcasts,
  fetchEpisodes,
  sandboxAnalyze,
  parseDuration,
  formatTime,
  type Podcast,
  type Episode,
  type SandboxResult,
  type SandboxAdBlock,
  type SandboxLine,
} from '../services/api';

interface Props {
  onBack: () => void;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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

function AdBlockCard({ block, index }: { block: SandboxAdBlock; index: number }) {
  const duration = block.endTimeSec - block.startTimeSec;
  const words = block.endWord - block.startWord;

  return (
    <div className="sb-ad-card">
      <div className="sb-ad-card-header">
        <span className="sb-ad-badge">AD {index + 1}</span>
        <span className="sb-ad-lines">Lines {block.startLine}–{block.endLine}</span>
        <span className="sb-ad-time">
          {formatTime(block.startTimeSec)} → {formatTime(block.endTimeSec)}
        </span>
        <span className="sb-ad-dur">{duration.toFixed(0)}s, ~{words} words</span>
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

  // Build lookup sets
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
    const approxTime = durationSec > 0
      ? (l.cumulativeWords / totalWords) * durationSec
      : 0;

    // Banner when entering an ad block
    if (isAd && !lastWasAd) {
      const block = adLineToBlock.get(l.lineNum)!;
      elements.push(
        <div key={`ad-start-${l.lineNum}`} className="sb-ad-banner start">
          AD BLOCK (lines {block.startLine}–{block.endLine}){' '}
          {formatTime(block.startTimeSec)} → {formatTime(block.endTimeSec)}
          {' — '}{block.reason}
        </div>
      );
    }

    elements.push(
      <div
        key={l.lineNum}
        className={`sb-line ${isAd ? 'is-ad' : ''}`}
      >
        <span className="sb-line-time">{formatTime(approxTime)}</span>
        <span className="sb-line-num">{l.lineNum}</span>
        {isAd && <span className="sb-line-ad-mark" />}
        <span className="sb-line-text">
          {l.speaker && <strong>{l.speaker}: </strong>}
          {l.text}
        </span>
      </div>
    );

    // Banner when leaving an ad block
    if (lastWasAd && !isAd) {
      elements.push(
        <div key={`ad-end-${l.lineNum}`} className="sb-ad-banner end">
          END AD BLOCK
        </div>
      );
    }
    lastWasAd = isAd;
  }
  // Close any trailing ad block
  if (lastWasAd) {
    elements.push(
      <div key="ad-end-final" className="sb-ad-banner end">
        END AD BLOCK
      </div>
    );
  }

  return <div className="sb-transcript">{elements}</div>;
}

function PromptViewer({ label, content }: { label: string; content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="sb-prompt-box">
      <button className="sb-prompt-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre className="sb-prompt-content">{content}</pre>}
    </div>
  );
}

// ─── Main SandboxPage ────────────────────────────────────────────────────────

export function SandboxPage({ onBack }: Props) {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [podcastId, setPodcastId] = useState('510325');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodeId, setEpisodeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SandboxResult | null>(null);

  // Load podcasts on mount
  useEffect(() => {
    fetchPodcasts()
      .then(setPodcasts)
      .catch(() =>
        setPodcasts([
          { id: '510325', name: 'The Indicator from Planet Money' },
          { id: '510289', name: 'Planet Money' },
          { id: '510318', name: 'Short Wave' },
          { id: '510308', name: 'Hidden Brain' },
          { id: '344098539', name: 'Up First' },
        ])
      );
  }, []);

  // Load episodes when podcast changes
  useEffect(() => {
    setEpisodes([]);
    setEpisodeId('');
    setResult(null);
    fetchEpisodes(podcastId)
      .then(data => {
        setEpisodes(data.episodes);
        // Auto-select first episode with transcript
        const first = data.episodes.find(e => e.transcriptUrl);
        if (first) setEpisodeId(first.id);
      })
      .catch(() => {});
  }, [podcastId]);

  const selectedEpisode = episodes.find(e => e.id === episodeId) || null;

  const analyze = useCallback(async () => {
    if (!selectedEpisode?.transcriptUrl) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await sandboxAnalyze(
        selectedEpisode.transcriptUrl,
        selectedEpisode.title,
        parseDuration(selectedEpisode.duration),
      );
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [selectedEpisode]);

  return (
    <div className="sb-page">
      {/* Header */}
      <header className="sb-header">
        <button className="sb-back" onClick={onBack}>← Back</button>
        <h1 className="sb-title">Ad Detection Sandbox</h1>
      </header>

      {/* Controls */}
      <div className="sb-controls">
        <div className="sb-field">
          <label className="sb-label">Podcast</label>
          <select
            className="sb-select"
            value={podcastId}
            onChange={e => setPodcastId(e.target.value)}
          >
            {podcasts.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="sb-field">
          <label className="sb-label">Episode</label>
          <select
            className="sb-select"
            value={episodeId}
            onChange={e => setEpisodeId(e.target.value)}
            disabled={episodes.length === 0}
          >
            {episodes.length === 0 && <option value="">Loading...</option>}
            {episodes.map(ep => (
              <option key={ep.id} value={ep.id} disabled={!ep.transcriptUrl}>
                {ep.title}{!ep.transcriptUrl ? ' (no transcript)' : ''} — {ep.duration}
              </option>
            ))}
          </select>
        </div>

        <button
          className="sb-analyze-btn"
          onClick={analyze}
          disabled={loading || !selectedEpisode?.transcriptUrl}
        >
          {loading ? 'Analyzing...' : 'Analyze'}
        </button>
      </div>

      {error && <div className="sb-error">{error}</div>}

      {loading && (
        <div className="sb-loading">
          <div className="dot" />
          <span>Fetching transcript and running ad detection...</span>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="sb-results">
          {/* Summary stats */}
          <section className="sb-section">
            <h2 className="sb-section-title">Summary</h2>
            <div className="sb-stats">
              <div className="sb-stat">
                <span className="sb-stat-val">{result.transcript.lineCount}</span>
                <span className="sb-stat-label">lines</span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-val">{result.transcript.totalWords}</span>
                <span className="sb-stat-label">words</span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-val">{result.summary.totalAdBlocks}</span>
                <span className="sb-stat-label">ad blocks</span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-val">{result.summary.totalAdTimeSec}s</span>
                <span className="sb-stat-label">ad time</span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-val">{result.summary.adWordPercent}%</span>
                <span className="sb-stat-label">ad words</span>
              </div>
              <div className="sb-stat">
                <span className="sb-stat-val">{result.summary.strategy}</span>
                <span className="sb-stat-label">strategy</span>
              </div>
            </div>
          </section>

          {/* Timeline */}
          <section className="sb-section">
            <h2 className="sb-section-title">Timeline</h2>
            <Timeline result={result} />
          </section>

          {/* Ad blocks detail */}
          <section className="sb-section">
            <h2 className="sb-section-title">
              Ad Blocks ({result.adBlocks.length})
            </h2>
            {result.adBlocks.length === 0 ? (
              <p className="sb-muted">No ad blocks detected.</p>
            ) : (
              result.adBlocks.map((b, i) => (
                <AdBlockCard key={i} block={b} index={i} />
              ))
            )}
          </section>

          {/* Annotated transcript */}
          <section className="sb-section">
            <h2 className="sb-section-title">Annotated Transcript</h2>
            <TranscriptViewer
              lines={result.transcript.lines}
              adBlocks={result.adBlocks}
              durationSec={result.episode.durationSec}
            />
          </section>

          {/* LLM Prompts */}
          <section className="sb-section">
            <h2 className="sb-section-title">LLM Prompts & Response</h2>
            <PromptViewer label="System Prompt" content={result.prompts.system} />
            <PromptViewer label="User Prompt (full transcript)" content={result.prompts.user} />
            <PromptViewer label="LLM Response" content={result.llmResponse} />
          </section>

          {/* Skip map */}
          <section className="sb-section">
            <h2 className="sb-section-title">Skip Map (Player JSON)</h2>
            <pre className="sb-json">{JSON.stringify(result.skipMap, null, 2)}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
