import { useRef, useState, useEffect, useCallback } from 'react';
import type { Episode } from '../services/api';
import { getAudioProxyUrl, formatTime } from '../services/api';
import { isInAdSegment, getNextContentTime, type AdDetectionResult } from '../services/adDetector';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

interface Props {
  episode: Episode;
  adDetection: AdDetectionResult | null;
}

export function Player({ episode, adDetection }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [skippedAd, setSkippedAd] = useState<string | null>(null);

  const src = episode.audioUrl ? getAudioProxyUrl(episode.audioUrl) : '';

  // Auto-skip ads — always on, no toggle needed
  useEffect(() => {
    if (!adDetection || !audioRef.current) return;
    const audio = audioRef.current;
    const onTime = () => {
      setTime(audio.currentTime);
      const seg = isInAdSegment(audio.currentTime, adDetection.segments);
      if (seg) {
        audio.currentTime = getNextContentTime(audio.currentTime, adDetection.segments);
        setSkippedAd(`Skipped ${seg.type}`);
        setTimeout(() => setSkippedAd(null), 2000);
      }
    };
    audio.addEventListener('timeupdate', onTime);
    return () => audio.removeEventListener('timeupdate', onTime);
  }, [adDetection]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const h = {
      loadedmetadata: () => setDur(a.duration),
      timeupdate: () => setTime(a.currentTime),
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
    };
    (Object.keys(h) as (keyof typeof h)[]).forEach((e) => a.addEventListener(e, h[e]));
    return () => {
      (Object.keys(h) as (keyof typeof h)[]).forEach((e) => a.removeEventListener(e, h[e]));
    };
  }, [episode]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    playing ? a.pause() : a.play();
  }, [playing]);

  const seek = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const a = audioRef.current;
      if (!a || !dur) return;
      const r = e.currentTarget.getBoundingClientRect();
      const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
      a.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur;
    },
    [dur]
  );

  const skip = useCallback(
    (s: number) => {
      const a = audioRef.current;
      if (a) a.currentTime = Math.max(0, Math.min(a.currentTime + s, dur));
    },
    [dur]
  );

  const [copied, setCopied] = useState(false);

  const copyLink = useCallback(() => {
    if (!episode.link) return;
    navigator.clipboard.writeText(episode.link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [episode.link]);

  // Reset copied state when episode changes
  useEffect(() => {
    setCopied(false);
  }, [episode.id]);

  const pct = dur > 0 ? (time / dur) * 100 : 0;

  return (
    <div className="player">
      {src && <audio ref={audioRef} src={src} preload="metadata" />}

      {!src && (
        <div className="no-audio">No audio available for this episode</div>
      )}

      <div className="now">{episode.title}</div>
      {episode.description && (
        <div className="desc">{episode.description}</div>
      )}

      {episode.link && (
        <div className="episode-link-row">
          <a
            className="episode-link"
            href={episode.link}
            target="_blank"
            rel="noopener noreferrer"
            title={episode.link}
          >
            <LinkIcon />
            <span className="episode-link-text">{episode.link.replace(/^https?:\/\/(www\.)?/, '')}</span>
          </a>
          <button className="copy-btn" onClick={copyLink} title="Copy link">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}

      {skippedAd && <div className="skip-notification">{skippedAd}</div>}

      <div className="bar" onClick={seek} onTouchStart={seek}>
        <div className="fill" style={{ width: `${pct}%` }} />
        {/* Ad segment markers on the progress bar */}
        {adDetection && dur > 0 && adDetection.segments.map((seg, i) => {
          const left = (seg.startTime / dur) * 100;
          const width = ((seg.endTime - seg.startTime) / dur) * 100;
          return (
            <div
              key={i}
              className="ad-marker"
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${seg.type} (${Math.round(seg.startTime)}s\u2013${Math.round(seg.endTime)}s) \u2014 ${Math.round(seg.confidence * 100)}% confidence`}
            />
          );
        })}
      </div>
      <div className="times">
        <span>{formatTime(time)}</span>
        <span>{formatTime(dur)}</span>
      </div>

      <div className="controls">
        <button className="ctl" onClick={() => skip(-15)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <button className="play" onClick={toggle}>
          {playing ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          )}
        </button>
        <button className="ctl" onClick={() => skip(15)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
        </button>
      </div>
    </div>
  );
}
