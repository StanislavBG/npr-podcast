import { useRef, useState, useEffect, useCallback } from 'react';
import type { Episode } from '../services/api';
import { getAudioProxyUrl, formatTime } from '../services/api';
import { isInAdSegment, getNextContentTime, type AdDetectionResult } from '../services/adDetector';

interface ScanProgressInfo {
  totalChunks: number;
  completedChunks: Set<number>;
}

interface Props {
  episode: Episode;
  adDetection: AdDetectionResult | null;
  scanProgress?: ScanProgressInfo;
  pipelineStatus?: 'idle' | 'running' | 'complete' | 'error';
  autoPlay?: boolean;
  /** When provided, Player reuses this external <audio> element instead of rendering its own. */
  audioRef?: React.RefObject<HTMLAudioElement | null>;
}

export function Player({ episode, adDetection, scanProgress, pipelineStatus, autoPlay, audioRef: externalAudioRef }: Props) {
  const internalAudioRef = useRef<HTMLAudioElement>(null);
  const audioRef = externalAudioRef || internalAudioRef;
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [skippedAd, setSkippedAd] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [autoSkip, setAutoSkip] = useState(true);

  const src = episode.audioUrl ? getAudioProxyUrl(episode.audioUrl) : '';

  // Auto-skip ads (respects toggle)
  useEffect(() => {
    if (!adDetection || !audioRef.current) return;
    const audio = audioRef.current;
    const onTime = () => {
      setTime(audio.currentTime);
      if (!autoSkip) return; // skip disabled by toggle
      const seg = isInAdSegment(audio.currentTime, adDetection.segments);
      if (seg) {
        audio.currentTime = getNextContentTime(audio.currentTime, adDetection.segments);
        setSkippedAd(`Skipped ${seg.type}${seg.reason ? ': ' + seg.reason.slice(0, 40) : ''}`);
        setTimeout(() => setSkippedAd(null), 2500);
      }
    };
    audio.addEventListener('timeupdate', onTime);
    return () => audio.removeEventListener('timeupdate', onTime);
  }, [adDetection, autoSkip]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    setAudioError(null);
    const h = {
      loadedmetadata: () => {
        setDur(a.duration);
        if (autoPlay) a.play().catch(() => { /* browser may block autoplay */ });
      },
      timeupdate: () => setTime(a.currentTime),
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      error: () => {
        const e = a.error;
        setAudioError(e ? `Audio failed to load (${e.message || 'unknown error'})` : 'Audio failed to load');
      },
    };
    (Object.keys(h) as (keyof typeof h)[]).forEach((e) => a.addEventListener(e, h[e]));
    // Sync initial state if audio already has metadata (e.g., persistent audio
    // element shared across pages — loadedmetadata already fired before mount)
    if (a.readyState >= 1 && a.duration > 0 && isFinite(a.duration)) {
      setDur(a.duration);
      setTime(a.currentTime);
      setPlaying(!a.paused);
    }
    return () => {
      (Object.keys(h) as (keyof typeof h)[]).forEach((e) => a.removeEventListener(e, h[e]));
    };
  }, [episode, autoPlay]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    playing ? a.pause() : a.play();
  }, [playing]);

  // Seek to position from a client X coordinate
  const seekToX = useCallback(
    (clientX: number) => {
      const a = audioRef.current;
      const track = trackRef.current;
      if (!a || !track || !dur) return;
      const r = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      a.currentTime = ratio * dur;
      setTime(ratio * dur);
    },
    [dur],
  );

  // Drag-to-scrub handlers for the timeline
  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setDragging(true);
      seekToX(e.clientX);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [seekToX],
  );

  const onTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      seekToX(e.clientX);
    },
    [dragging, seekToX],
  );

  const onTrackPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const skip = useCallback(
    (s: number) => {
      const a = audioRef.current;
      if (a) a.currentTime = Math.max(0, Math.min(a.currentTime + s, dur));
    },
    [dur],
  );

  const pct = dur > 0 ? (time / dur) * 100 : 0;
  const adCount = adDetection?.segments.length ?? 0;
  const totalAdTimeSec = adDetection?.totalAdTime ?? 0;

  // Check if currently inside an ad segment
  const currentAd = adDetection ? isInAdSegment(time, adDetection.segments) : null;

  return (
    <div className="player">
      {!externalAudioRef && src && <audio ref={internalAudioRef} src={src} preload="metadata" />}

      {!src && (
        <div className="no-audio">No audio available for this episode</div>
      )}
      {audioError && (
        <div className="no-audio">{audioError}</div>
      )}

      {/* Episode title + ad info row */}
      <div className="player-info">
        <div className="now">{episode.title}</div>
        {skippedAd && <div className="skip-notification">{skippedAd}</div>}
        {currentAd && !autoSkip && (
          <div className="ad-playing-indicator">AD PLAYING</div>
        )}
      </div>

      {/* Video-style timeline above controls */}
      <div className="video-timeline">
        <div
          className={`timeline-track${dragging ? ' dragging' : ''}`}
          ref={trackRef}
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          onPointerCancel={onTrackPointerUp}
        >
          {/* Scan progress: show which chunks have been scanned */}
          {scanProgress && scanProgress.totalChunks > 0 && dur > 0 && (
            Array.from({ length: scanProgress.totalChunks }, (_, i) => {
              const chunkLeft = (i / scanProgress.totalChunks) * 100;
              const chunkWidth = (1 / scanProgress.totalChunks) * 100;
              const isScanned = scanProgress.completedChunks.has(i);
              return (
                <div
                  key={`scan-${i}`}
                  className={`timeline-scan ${isScanned ? 'scanned' : 'pending'}`}
                  style={{ left: `${chunkLeft}%`, width: `${chunkWidth}%` }}
                  title={`Chunk ${i + 1}/${scanProgress.totalChunks}: ${isScanned ? 'scanned' : 'scanning...'}`}
                />
              );
            })
          )}
          {/* Ad segments highlighted on the track */}
          {adDetection && dur > 0 && adDetection.segments.map((seg, i) => {
            const left = (seg.startTime / dur) * 100;
            const width = ((seg.endTime - seg.startTime) / dur) * 100;
            return (
              <div
                key={i}
                className="timeline-ad"
                style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
                title={`Ad ${i + 1}: ${formatTime(seg.startTime)}\u2013${formatTime(seg.endTime)} (${Math.round(seg.endTime - seg.startTime)}s)${seg.reason ? ' \u2014 ' + seg.reason : ''}`}
              />
            );
          })}
          {/* Progress fill */}
          <div className="timeline-progress" style={{ width: `${pct}%` }} />
          {/* Scrubber thumb */}
          <div className="timeline-thumb" style={{ left: `${pct}%` }} />
        </div>
        <div className="times">
          <span>{formatTime(time)}</span>
          <span>{formatTime(dur)}</span>
        </div>
      </div>

      {/* Controls centered below */}
      <div className="controls controls-centered">
        <button className="ctl" onClick={() => skip(-15)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <button className="play" onClick={toggle}>
          {playing ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          )}
        </button>
        <button className="ctl" onClick={() => skip(15)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
        </button>
      </div>

      {/* Ad skip toggle + info bar */}
      {adDetection && adCount > 0 && (
        <div className="ad-bar">
          <span className="ad-bar-info">
            {adCount} ad{adCount !== 1 ? 's' : ''} detected ({Math.round(totalAdTimeSec)}s)
          </span>
          <button
            className={`ad-skip-toggle ${autoSkip ? 'on' : 'off'}`}
            onClick={() => setAutoSkip(prev => !prev)}
            title={autoSkip ? 'Auto-skip is ON — ads will be skipped automatically' : 'Auto-skip is OFF — ads will play through'}
          >
            <span className="ad-skip-toggle-label">Auto-Skip</span>
            <span className="ad-skip-toggle-switch">
              <span className="ad-skip-toggle-knob" />
            </span>
          </button>
        </div>
      )}
      {/* Scan progress indicator */}
      {pipelineStatus === 'running' && scanProgress && scanProgress.totalChunks > 0 && (
        <div className="scan-status">
          Scanning {scanProgress.completedChunks.size}/{scanProgress.totalChunks} chunks
        </div>
      )}
    </div>
  );
}
