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
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [adSkipEnabled, setAdSkipEnabled] = useState(true);
  const [skippedAd, setSkippedAd] = useState<string | null>(null);
  const [adsSkipped, setAdsSkipped] = useState(0);

  const audioUrl = getAudioProxyUrl(episode.audioUrl);

  // Auto-skip ads
  useEffect(() => {
    if (!adSkipEnabled || !adDetection || !audioRef.current) return;

    const audio = audioRef.current;
    const handleTimeUpdate = () => {
      const time = audio.currentTime;
      setCurrentTime(time);

      const adSegment = isInAdSegment(time, adDetection.segments);
      if (adSegment) {
        const skipTo = getNextContentTime(time, adDetection.segments);
        audio.currentTime = skipTo;
        setAdsSkipped((n) => n + 1);
        setSkippedAd(`Skipped ${adSegment.type}`);
        setTimeout(() => setSkippedAd(null), 2000);
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    return () => audio.removeEventListener('timeupdate', handleTimeUpdate);
  }, [adSkipEnabled, adDetection]);

  // Track duration
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onLoaded = () => setDuration(audio.duration);
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, [episode]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.pause();
    else audio.play();
  }, [isPlaying]);

  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * duration;
  }, [duration]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.currentTime + seconds, duration));
  }, [duration]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="player">
      <audio ref={audioRef} src={audioUrl} preload="metadata" />

      <div className="player-info">
        <h3 className="player-title">{episode.title}</h3>
        {adDetection && (
          <div className="ad-info">
            <span className={`ad-skip-toggle ${adSkipEnabled ? 'enabled' : ''}`}>
              <button onClick={() => setAdSkipEnabled(!adSkipEnabled)}>
                {adSkipEnabled ? 'Ad-Skip ON' : 'Ad-Skip OFF'}
              </button>
            </span>
            <span className="ad-stats">
              {adDetection.segments.length} ad segments detected
              ({Math.round(adDetection.totalAdTime)}s)
              {' \u00B7 '}Strategy: {adDetection.strategy}
            </span>
            {adsSkipped > 0 && (
              <span className="ads-skipped">{adsSkipped} ads skipped</span>
            )}
          </div>
        )}
      </div>

      {skippedAd && <div className="skip-notification">{skippedAd}</div>}

      <div className="player-controls">
        <button className="control-btn" onClick={() => skip(-15)}>
          -15s
        </button>
        <button className="control-btn play-btn" onClick={togglePlay}>
          {isPlaying ? '\u23F8' : '\u25B6'}
        </button>
        <button className="control-btn" onClick={() => skip(15)}>
          +15s
        </button>
      </div>

      <div className="progress-container" onClick={seek}>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
          {/* Render ad segment markers */}
          {adDetection &&
            duration > 0 &&
            adDetection.segments.map((seg, i) => {
              const left = (seg.startTime / duration) * 100;
              const width = ((seg.endTime - seg.startTime) / duration) * 100;
              return (
                <div
                  key={i}
                  className="ad-marker"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${seg.type} (${Math.round(seg.startTime)}s - ${Math.round(seg.endTime)}s) — ${Math.round(seg.confidence * 100)}% confidence`}
                />
              );
            })}
        </div>
        <div className="time-display">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
