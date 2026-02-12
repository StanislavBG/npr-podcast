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
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);

  const src = getAudioProxyUrl(episode.audioUrl);

  // Always skip ads. No toggle. It just works.
  useEffect(() => {
    if (!adDetection || !audioRef.current) return;
    const audio = audioRef.current;
    const onTime = () => {
      setTime(audio.currentTime);
      if (isInAdSegment(audio.currentTime, adDetection.segments)) {
        audio.currentTime = getNextContentTime(audio.currentTime, adDetection.segments);
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

  const pct = dur > 0 ? (time / dur) * 100 : 0;

  return (
    <div className="player">
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className="now">{episode.title}</div>

      <div className="bar" onClick={seek} onTouchStart={seek}>
        <div className="fill" style={{ width: `${pct}%` }} />
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
