import { useState, useCallback, useRef, useEffect } from 'react';
import { PodcastSelector } from './components/PodcastSelector';
import { EpisodeList } from './components/EpisodeList';
import { Player } from './components/Player';
import { FlowVisualizer } from './components/FlowVisualizer';
import { SandboxPage } from './components/SandboxPage';
import {
  fetchPodcasts,
  fetchEpisodes,
  fetchTranscriptHtml,
  llmParseTranscript,
  llmDetectAds,
  llmPreparePlayback,
  resolveAudio,
  processAudioChunk,
  detectAdsFromTranscript,
  parseDuration,
  type Podcast,
  type Episode,
  type AudioMeta,
  type ChunkResult,
} from './services/api';
import type { AdDetectionResult, PlaybackConfig } from './services/adDetector';
import {
  createInitialFlowState,
  type FlowState,
  type StepStatus,
} from './workflows/podcastFlow';

function setStep(
  prev: FlowState,
  stepId: string,
  status: StepStatus,
): FlowState {
  return {
    ...prev,
    steps: { ...prev.steps, [stepId]: status },
    currentStep: status === 'running' ? stepId : prev.currentStep,
  };
}

function getInitialPage(): 'app' | 'sandbox' {
  return window.location.pathname === '/sandbox' ? 'sandbox' : 'app';
}

export default function App() {
  const [page, setPage] = useState<'app' | 'sandbox'>(getInitialPage);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [selected, setSelected] = useState('510325');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [ads, setAds] = useState<AdDetectionResult | null>(null);
  const [playback, setPlayback] = useState<PlaybackConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowState>(createInitialFlowState());
  const loaded = useRef<string | null>(null);

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

  const load = useCallback(
    async (id: string) => {
      if (loaded.current === id && episodes.length > 0) return;
      setLoading(true);
      setEpisode(null);
      setAds(null);
      setPlayback(null);
      setError(null);

      let fs = createInitialFlowState();
      fs = setStep(fs, 'step_fetch_rss', 'running');
      setFlow(fs);

      try {
        const data = await fetchEpisodes(id);
        setEpisodes(data.episodes);
        loaded.current = id;

        fs = setStep(fs, 'step_fetch_rss', 'completed');
        fs = setStep(fs, 'step_parse_episodes', 'running');
        setFlow(fs);

        fs = setStep(fs, 'step_parse_episodes', 'completed');
        setFlow(fs);
      } catch {
        fs = setStep(fs, 'step_fetch_rss', 'failed');
        fs = { ...fs, error: 'RSS fetch failed' };
        setFlow(fs);
        setError('Could not load episodes. Check your connection.');
      } finally {
        setLoading(false);
      }
    },
    [episodes.length]
  );

  useEffect(() => {
    load(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Chunk processing refs (persist across renders) ──────────────
  const audioMetaRef = useRef<AudioMeta | null>(null);
  const chunksRef = useRef<Map<number, ChunkResult>>(new Map());
  const processingRef = useRef<Set<number>>(new Set());
  const trailingTextRef = useRef<Map<number, string>>(new Map());
  const detectedAdsRef = useRef<AdDetectionResult | null>(null);

  const processChunk = useCallback(async (
    index: number,
    meta: AudioMeta,
    episodeTitle: string,
  ): Promise<ChunkResult | null> => {
    if (chunksRef.current.has(index) || processingRef.current.has(index)) return chunksRef.current.get(index) || null;
    if (index < 0 || index >= meta.totalChunks) return null;

    processingRef.current.add(index);
    try {
      const prevTrailing = index > 0 ? (trailingTextRef.current.get(index - 1) || '') : '';
      const result = await processAudioChunk({
        resolvedUrl: meta.resolvedUrl,
        chunkIndex: index,
        totalChunks: meta.totalChunks,
        contentLength: meta.contentLength,
        durationSec: meta.durationSec,
        bitrate: meta.bitrate,
        chunkDurationSec: meta.chunkDurationSec,
        overlapSec: 10,
        episodeTitle,
        prevChunkTrailingText: prevTrailing,
      });
      chunksRef.current.set(index, result);
      trailingTextRef.current.set(index, result.trailingText);

      return result;
    } catch (err) {
      console.error(`Chunk ${index} failed:`, err);
      return null;
    } finally {
      processingRef.current.delete(index);
    }
  }, []);

  const pick = useCallback(async (ep: Episode) => {
    setEpisode(ep);
    setAds(null);
    setPlayback(null);

    // Reset chunk state
    audioMetaRef.current = null;
    chunksRef.current = new Map();
    processingRef.current = new Set();
    trailingTextRef.current = new Map();
    detectedAdsRef.current = null;

    const durationSec = parseDuration(ep.duration);
    let html = '';
    let audioChunksSucceeded = false;

    // ── Steps 3-7: Chunked Audio Pipeline ────────────────────────────
    if (ep.audioUrl) {
      // Step 3: Resolve audio stream
      setFlow((prev) => setStep(prev, 'step_resolve_audio_stream', 'running'));

      try {
        const meta = await resolveAudio(ep.audioUrl);
        audioMetaRef.current = meta;

        setFlow((prev) => {
          let fs = setStep(prev, 'step_resolve_audio_stream', 'completed');
          fs = setStep(fs, 'step_start_audio_streaming', 'running');
          return { ...fs, chunkProgress: { currentChunk: 0, totalChunks: meta.totalChunks } };
        });

        // Steps 4+5: Process ALL chunks sequentially (each needs previous trailing text)
        for (let i = 0; i < meta.totalChunks; i++) {
          await processChunk(i, meta, ep.title);
          setFlow((prev) => ({
            ...prev,
            chunkProgress: { currentChunk: i + 1, totalChunks: meta.totalChunks },
          }));
        }

        setFlow((prev) => {
          let fs = setStep(prev, 'step_start_audio_streaming', 'completed');
          fs = setStep(fs, 'step_transcribe_chunks', 'completed');
          return { ...fs, chunkProgress: { currentChunk: meta.totalChunks, totalChunks: meta.totalChunks } };
        });

        // Build HTML from transcribed chunks for the LLM pipeline
        const allText = Array.from(chunksRef.current.values())
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map(c => c.transcript.text)
          .join(' ');

        if (allText.length > 100) {
          html = allText.split(/(?<=[.!?])\s+/).map((s: string) => `<p>${s}</p>`).join('\n');
          audioChunksSucceeded = true;
        }

        // Step 6: Detect ads from the full assembled transcript (separate LLM call)
        setFlow((prev) => setStep(prev, 'step_mark_ad_locations', 'running'));
        try {
          // Gather all segments from all chunks, sorted by time
          const allSegments = Array.from(chunksRef.current.values())
            .sort((a, b) => a.chunkIndex - b.chunkIndex)
            .flatMap(c => c.transcript.segments);

          if (allSegments.length > 0) {
            const adResult = await detectAdsFromTranscript({
              segments: allSegments,
              episodeTitle: ep.title,
              durationSec,
            });

            const adSegments = adResult.adSegments || [];
            const totalAdTime = adSegments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
            const adsResult: AdDetectionResult = {
              segments: adSegments,
              totalAdTime,
              contentDuration: durationSec - totalAdTime,
              strategy: 'full-transcript-llm',
            };
            detectedAdsRef.current = adsResult;
            setAds(adsResult);
          }

          setFlow((prev) => {
            let fs = setStep(prev, 'step_mark_ad_locations', 'completed');
            fs = setStep(fs, 'step_build_skip_map', 'completed');
            return fs;
          });
        } catch (adErr) {
          console.error('Ad detection failed:', adErr);
          setFlow((prev) => {
            let fs = setStep(prev, 'step_mark_ad_locations', 'failed');
            fs = setStep(fs, 'step_build_skip_map', 'skipped');
            return fs;
          });
        }
      } catch (err) {
        console.warn('Audio chunked pipeline failed, falling back to HTML transcript:', err);
        setFlow((prev) => {
          let fs = prev;
          if (fs.steps.step_resolve_audio_stream === 'running') fs = setStep(fs, 'step_resolve_audio_stream', 'failed');
          if (fs.steps.step_start_audio_streaming !== 'completed') fs = setStep(fs, 'step_start_audio_streaming', 'skipped');
          if (fs.steps.step_transcribe_chunks !== 'completed') fs = setStep(fs, 'step_transcribe_chunks', 'skipped');
          if (fs.steps.step_mark_ad_locations !== 'completed') fs = setStep(fs, 'step_mark_ad_locations', 'skipped');
          if (fs.steps.step_build_skip_map !== 'completed') fs = setStep(fs, 'step_build_skip_map', 'skipped');
          return fs;
        });
      }
    } else {
      // No audio URL — skip audio pipeline
      setFlow((prev) => {
        let fs = setStep(prev, 'step_resolve_audio_stream', 'skipped');
        fs = setStep(fs, 'step_start_audio_streaming', 'skipped');
        fs = setStep(fs, 'step_transcribe_chunks', 'skipped');
        fs = setStep(fs, 'step_mark_ad_locations', 'skipped');
        fs = setStep(fs, 'step_build_skip_map', 'skipped');
        return fs;
      });
    }

    // ── Step 8: Fetch HTML Transcript (fallback / cross-reference) ───
    if (!html && ep.transcriptUrl) {
      setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'running'));
      try {
        const result = await fetchTranscriptHtml(ep.transcriptUrl);
        html = result.html;
        setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'completed'));
      } catch {
        setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', 'skipped'));
      }
    } else {
      setFlow((prev) => setStep(prev, 'step_fetch_html_transcript', audioChunksSucceeded ? 'skipped' : 'skipped'));
    }

    // If we have audio transcript, skip to finalize
    if (audioChunksSucceeded) {
      // ── Step 9: Finalize Playback ──────────────────────────────────
      setFlow((prev) => setStep(prev, 'step_finalize_playback', 'running'));
      try {
        // Build a transcript result from the chunked audio text
        const transcript = await llmParseTranscript(html || `<p>${ep.description}</p>`);
        // Use ad segments from the dedicated detect-ads call (set by Step 6 above)
        const currentAds: AdDetectionResult = detectedAdsRef.current || {
          segments: [],
          totalAdTime: 0,
          contentDuration: durationSec,
          strategy: 'full-transcript-llm',
        };

        const config = await llmPreparePlayback(transcript, currentAds, ep.title, ep.description);
        setPlayback(config);
        if (config.skipMap && config.skipMap.length > 0) {
          setAds({
            segments: config.skipMap,
            totalAdTime: config.totalAdTime,
            contentDuration: config.contentDuration,
            strategy: 'llm-verified',
          });
        }
        setFlow((prev) => {
          const fs = setStep(prev, 'step_finalize_playback', 'completed');
          return { ...fs, currentStep: null };
        });
      } catch (err) {
        console.error('LLM prepare-playback failed:', err);
        setFlow((prev) => {
          const fs = setStep(prev, 'step_finalize_playback', 'skipped');
          return { ...fs, currentStep: null };
        });
      }
      return;
    }

    // ── Fallback: HTML-based ad detection (no audio) ─────────────────
    // Step 6: Mark Ad Locations
    setFlow((prev) => setStep(prev, 'step_mark_ad_locations', 'running'));
    let transcript;
    try {
      transcript = await llmParseTranscript(html || `<p>${ep.description}</p>`);
    } catch (err) {
      console.error('LLM parse failed:', err);
      setFlow((prev) => {
        let fs = setStep(prev, 'step_mark_ad_locations', 'failed');
        fs = setStep(fs, 'step_build_skip_map', 'skipped');
        fs = setStep(fs, 'step_finalize_playback', 'skipped');
        return { ...fs, currentStep: null };
      });
      return;
    }

    let adResult: AdDetectionResult;
    try {
      adResult = await llmDetectAds(transcript, durationSec, ep.title);
      setAds(adResult);
      setFlow((prev) => setStep(prev, 'step_mark_ad_locations', 'completed'));
    } catch (err) {
      console.error('LLM ad detection failed:', err);
      setFlow((prev) => {
        let fs = setStep(prev, 'step_mark_ad_locations', 'failed');
        fs = setStep(fs, 'step_build_skip_map', 'skipped');
        fs = setStep(fs, 'step_finalize_playback', 'skipped');
        return { ...fs, currentStep: null };
      });
      return;
    }

    // Step 7: Build Skip Map
    setFlow((prev) => setStep(prev, 'step_build_skip_map', 'running'));
    setFlow((prev) => setStep(prev, 'step_build_skip_map', 'completed'));

    // Step 9: Finalize Playback
    setFlow((prev) => setStep(prev, 'step_finalize_playback', 'running'));
    try {
      const config = await llmPreparePlayback(transcript, adResult, ep.title, ep.description);
      setPlayback(config);
      if (config.skipMap && config.skipMap.length > 0) {
        setAds({
          segments: config.skipMap,
          totalAdTime: config.totalAdTime,
          contentDuration: config.contentDuration,
          strategy: 'llm-verified',
        });
      }
      setFlow((prev) => {
        const fs = setStep(prev, 'step_finalize_playback', 'completed');
        return { ...fs, currentStep: null };
      });
    } catch (err) {
      console.error('LLM prepare-playback failed:', err);
      setFlow((prev) => {
        const fs = setStep(prev, 'step_finalize_playback', 'skipped');
        return { ...fs, currentStep: null };
      });
    }
  }, [processChunk]);

  const goToSandbox = useCallback(() => {
    window.history.pushState(null, '', '/sandbox');
    setPage('sandbox');
  }, []);

  const goToApp = useCallback(() => {
    window.history.pushState(null, '', '/');
    setPage('app');
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => setPage(getInitialPage());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  if (page === 'sandbox') {
    return <SandboxPage onBack={goToApp} />;
  }

  return (
    <div className="phone-frame">
      <div className="phone-notch" />
      <div className="shell">
        <header className="header">
          <h1 className="header-title">NPR Podcasts</h1>
          <button className="header-sandbox-link" onClick={goToSandbox}>
            Enhanced View
          </button>
        </header>

        <PodcastSelector
          podcasts={podcasts}
          selected={selected}
          onSelect={setSelected}
        />

        <main className="content">
          {error && !episodes.length ? (
            <div className="empty">{error}</div>
          ) : (
            <EpisodeList
              episodes={episodes}
              loading={loading}
              selectedId={episode?.id || null}
              onSelect={pick}
            />
          )}

          <FlowVisualizer flowState={flow} />
        </main>

        {/* Player dock pinned to bottom with progress bar at very bottom */}
        {episode && (
          <div className="player-dock">
            <Player episode={episode} adDetection={ads} />
          </div>
        )}
      </div>
    </div>
  );
}
