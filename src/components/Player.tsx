import { useRef, useState, useEffect, useCallback } from 'react';
import type { Episode } from '../services/api';
import { getAudioProxyUrl, formatTime } from '../services/api';
import { isInAdSegment, getNextContentTime, type AdDetectionResult } from '../services/adDetector';

interface Props {
  episode: Episode;
  adDetection: AdDetectionResult | null;
}

export function Player({ episode, adDetection }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [skippedAd, setSkippedAd] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const src = episode.audioUrl ? getAudioProxyUrl(episode.audioUrl) : '';

  // Auto-skip ads
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

  return (
    <div className="player">
      {src && <audio ref={audioRef} src={src} preload="metadata" />}

      {!src && (
        <div className="no-audio">No audio available for this episode</div>
      )}

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
          {/* Ad segments highlighted on the track */}
          {adDetection && dur > 0 && adDetection.segments.map((seg, i) => {
            const left = (seg.startTime / dur) * 100;
            const width = ((seg.endTime - seg.startTime) / dur) * 100;
            return (
              <div
                key={i}
                className="timeline-ad"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${seg.type} (${Math.round(seg.startTime)}s\u2013${Math.round(seg.endTime)}s) \u2014 ${Math.round(seg.confidence * 100)}% confidence`}
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

      {/* Title row + controls */}
      <div className="player-row">
        <div className="player-info">
          <div className="now">{episode.title}</div>
          {skippedAd && <div className="skip-notification">{skippedAd}</div>}
        </div>
        <div className="controls">
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
      </div>
    </div>
  );
}
