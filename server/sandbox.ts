#!/usr/bin/env tsx
/**
 * sandbox.ts — Debug harness for ad-detection pipeline.
 *
 * Fully self-contained: no bilko-flow import (the dep can't be resolved
 * outside Replit's bundler). All JSON-repair + LLM adapter logic inlined
 * so we can log raw LLM responses BEFORE parsing — the key missing piece
 * for debugging ad-detection failures.
 *
 * Runs the full 3-step LLM pipeline against ONE podcast episode (the latest)
 * and prints every intermediate artifact:
 *   0. RSS fetch → episode metadata
 *   1. Raw transcript HTML → extracted text
 *   2. The exact prompt sent to "parse-transcript" + raw LLM response
 *   3. The exact prompt sent to "detect-ads"      + raw LLM response
 *   4. The exact prompt sent to "prepare-playback" + raw LLM response
 *   5. Final ad-segment ↔ transcript-text mapping + timeline
 *
 * Usage:
 *   npx tsx server/sandbox.ts                     # defaults to The Indicator (510325)
 *   npx tsx server/sandbox.ts 510289              # Planet Money
 *   npx tsx server/sandbox.ts 510325 3            # 4th episode (0-indexed)
 *
 * Env vars (same as server):
 *   BILKO_LLM_PROVIDER  — openai | claude  (default: openai)
 *   BILKO_LLM_MODEL     — e.g. gpt-4o-mini (default)
 *   BILKO_LLM_API_KEY   — required for real LLM calls
 */

import { XMLParser } from 'fast-xml-parser';

// ─── Colour helpers for terminal ──────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:  '\x1b[36m',
};

function banner(text: string) {
  const line = '═'.repeat(78);
  console.log(`\n${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  console.log(`${C.cyan}${line}${C.reset}\n`);
}

function section(text: string) {
  console.log(`\n${C.yellow}── ${text} ${'─'.repeat(Math.max(0, 72 - text.length))}${C.reset}\n`);
}

function promptBox(label: string, content: string) {
  console.log(`${C.magenta}┌─ PROMPT: ${label} ─${'─'.repeat(Math.max(0, 64 - label.length))}┐${C.reset}`);
  for (const line of content.split('\n')) {
    console.log(`${C.dim}│${C.reset} ${line}`);
  }
  console.log(`${C.magenta}└${'─'.repeat(77)}┘${C.reset}`);
}

function rawResponseBox(label: string, content: string) {
  console.log(`${C.blue}┌─ RAW LLM RESPONSE: ${label} ─${'─'.repeat(Math.max(0, 54 - label.length))}┐${C.reset}`);
  const lines = content.split('\n');
  const maxLines = 80;
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    console.log(`${C.dim}│${C.reset} ${lines[i]}`);
  }
  if (lines.length > maxLines) {
    console.log(`${C.dim}│ ... (${lines.length - maxLines} more lines)${C.reset}`);
  }
  console.log(`${C.blue}└${'─'.repeat(77)}┘${C.reset}`);
}

// ─── LLM config ──────────────────────────────────────────────────────────────

type LLMProvider = 'openai' | 'claude';

const LLM_PROVIDER = (process.env.BILKO_LLM_PROVIDER || 'openai') as LLMProvider;
const LLM_MODEL    = process.env.BILKO_LLM_MODEL || 'gpt-4o-mini';
const LLM_API_KEY  = process.env.BILKO_LLM_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.BILKO_LLM_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;

// ─── Inlined JSON repair (from bilko-flow cleanLLMResponse + repairJSON) ────

function repairJSON(raw: string): string {
  let result = raw;
  // Fix trailing commas before closing brackets
  result = result.replace(/,\s*([}\]])/g, '$1');
  // Escape control chars inside strings
  result = escapeControlCharsInStrings(result);
  return result;
}

function escapeControlCharsInStrings(json: string): string {
  const chars: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) { chars.push(ch); escaped = false; continue; }
    if (ch === '\\' && inString) { chars.push(ch); escaped = true; continue; }
    if (ch === '"') { inString = !inString; chars.push(ch); continue; }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        switch (ch) {
          case '\n': chars.push('\\n'); break;
          case '\r': chars.push('\\r'); break;
          case '\t': chars.push('\\t'); break;
          case '\b': chars.push('\\b'); break;
          case '\f': chars.push('\\f'); break;
          default:   chars.push('\\u' + code.toString(16).padStart(4, '0')); break;
        }
        continue;
      }
    }
    chars.push(ch);
  }
  return chars.join('');
}

function extractOutermostJSON(text: string): string | null {
  const objIdx = text.indexOf('{');
  const arrIdx = text.indexOf('[');
  const candidates: Array<[string, string]> = [];
  if (objIdx !== -1 && arrIdx !== -1) {
    if (arrIdx < objIdx) candidates.push(['[', ']'], ['{', '}']);
    else candidates.push(['{', '}'], ['[', ']']);
  } else if (objIdx !== -1) candidates.push(['{', '}']);
  else if (arrIdx !== -1) candidates.push(['[', ']']);

  for (const [open, close] of candidates) {
    const startIdx = text.indexOf(open);
    if (startIdx === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
      }
    }
  }
  return null;
}

function cleanLLMResponse(raw: string): unknown {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try { return JSON.parse(cleaned); } catch { /* continue */ }

  const jsonStr = extractOutermostJSON(cleaned);
  if (!jsonStr) throw new Error('No JSON object or array found in LLM response');

  try { return JSON.parse(jsonStr); } catch { /* continue */ }

  const repaired = repairJSON(jsonStr);
  try { return JSON.parse(repaired); } catch (err) {
    throw new Error(`Failed to parse LLM response as JSON: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ─── Inlined LLM adapters ───────────────────────────────────────────────────

interface LLMCallResult {
  rawText: string;
  parsed: unknown;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

async function callLLM(opts: {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}): Promise<LLMCallResult> {
  if (LLM_PROVIDER === 'claude') {
    return callClaude(opts);
  }
  return callOpenAI(opts);
}

async function callClaude(opts: {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}): Promise<LLMCallResult> {
  const body = {
    model: LLM_MODEL,
    max_tokens: opts.maxTokens,
    system: opts.systemPrompt,
    messages: [{ role: 'user', content: opts.userPrompt }],
    temperature: opts.temperature,
  };
  const res = await fetch(LLM_BASE_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': LLM_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error ${res.status}: ${text}`);
  }
  const data = await res.json() as any;
  const rawText = data.content?.[0]?.text || '';
  return {
    rawText,
    parsed: cleanLLMResponse(rawText),
    usage: {
      promptTokens: data.usage?.input_tokens,
      completionTokens: data.usage?.output_tokens,
      totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };
}

async function callOpenAI(opts: {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}): Promise<LLMCallResult> {
  const messages = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userPrompt },
  ];
  const body = {
    model: LLM_MODEL,
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    response_format: { type: 'json_object' },
  };
  const baseUrl = LLM_BASE_URL
    ? (LLM_BASE_URL.endsWith('/chat/completions') ? LLM_BASE_URL : `${LLM_BASE_URL}/chat/completions`)
    : 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }
  const data = await res.json() as any;
  const rawText = data.choices?.[0]?.message?.content || '';
  return {
    rawText,
    parsed: cleanLLMResponse(rawText),
    usage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
  };
}

// ─── Podcast catalogue ──────────────────────────────────────────────────────

const PODCASTS: Record<string, { name: string; feedUrl: string }> = {
  '510325': { name: 'The Indicator from Planet Money', feedUrl: 'https://feeds.npr.org/510325/podcast.xml' },
  '510289': { name: 'Planet Money',                    feedUrl: 'https://feeds.npr.org/510289/podcast.xml' },
  '510318': { name: 'Short Wave',                      feedUrl: 'https://feeds.npr.org/510318/podcast.xml' },
  '510308': { name: 'Hidden Brain',                    feedUrl: 'https://feeds.npr.org/510308/podcast.xml' },
  '344098539': { name: 'Up First',                     feedUrl: 'https://feeds.npr.org/344098539/podcast.xml' },
};

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface Episode {
  id: string;
  title: string;
  description: string;
  pubDate: string;
  duration: string;
  audioUrl: string;
  link: string;
  transcriptUrl: string | null;
}

interface LLMTranscriptSegment {
  speaker: string;
  text: string;
  isAd: boolean;
  adType: string | null;
}

interface LLMTranscriptResult {
  segments: LLMTranscriptSegment[];
  fullText: string;
  adMentions: Array<{ segmentIndex: number; reason: string }>;
  estimatedContentWords: number;
}

interface LLMAdSegment {
  startTime: number;
  endTime: number;
  type: 'pre-roll' | 'mid-roll' | 'post-roll' | 'sponsor-mention';
  confidence: number;
  reason: string;
}

interface LLMAdDetectionResult {
  segments: LLMAdSegment[];
  totalAdTime: number;
  contentDuration: number;
  strategy: string;
}

interface LLMPlaybackConfig {
  summary: string;
  topics: string[];
  skipMap: LLMAdSegment[];
  contentDuration: number;
  totalAdTime: number;
  recommendation: string;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function parseDurationToSeconds(dur: string): number {
  if (!dur) return 0;
  const parts = dur.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Step 0: Fetch RSS + pick episode ───────────────────────────────────────

async function fetchLatestEpisode(podcastId: string, episodeIndex: number): Promise<{ podcast: string; episode: Episode }> {
  const podcast = PODCASTS[podcastId];
  if (!podcast) throw new Error(`Unknown podcast ID ${podcastId}. Valid: ${Object.keys(PODCASTS).join(', ')}`);

  section(`Fetching RSS: ${podcast.name}`);
  const res = await fetch(podcast.feedUrl, { headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const feed = parser.parse(xml);
  const items = feed?.rss?.channel?.item || [];
  const itemList = Array.isArray(items) ? items : [items];

  if (episodeIndex >= itemList.length) throw new Error(`Episode index ${episodeIndex} out of range (${itemList.length} available)`);

  const item = itemList[episodeIndex];
  const enclosure = item.enclosure || {};
  const audioUrl = enclosure['@_url'] || '';
  const link = item.link || '';
  const idMatch = link.match(/\/(\d{4}\/\d{2}\/\d{2}\/[\w-]+|nx-[\w-]+)/);
  const storyId = idMatch ? idMatch[1] : null;
  const transcriptUrl = storyId ? `https://www.npr.org/transcripts/${storyId}` : null;

  const episode: Episode = {
    id: `sandbox-${Date.now()}`,
    title: item.title || 'Untitled',
    description: (item.description || item['itunes:summary'] || '').replace(/<[^>]*>/g, ''),
    pubDate: item.pubDate || '',
    duration: item['itunes:duration'] || '',
    audioUrl,
    link,
    transcriptUrl,
  };

  console.log(`${C.green}Podcast:${C.reset}      ${podcast.name}`);
  console.log(`${C.green}Episode:${C.reset}      ${episode.title}`);
  console.log(`${C.green}Published:${C.reset}    ${episode.pubDate}`);
  console.log(`${C.green}Duration:${C.reset}     ${episode.duration} (${parseDurationToSeconds(episode.duration)}s)`);
  console.log(`${C.green}Audio URL:${C.reset}    ${episode.audioUrl ? episode.audioUrl.slice(0, 80) + '...' : '(none)'}`);
  console.log(`${C.green}Transcript:${C.reset}   ${episode.transcriptUrl || '(none)'}`);
  console.log(`${C.green}Link:${C.reset}         ${episode.link}`);

  return { podcast: podcast.name, episode };
}

// ─── Step 1: Fetch transcript HTML ──────────────────────────────────────────

async function fetchTranscriptHtml(url: string): Promise<string> {
  section('Fetching transcript HTML');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status}`);
  const html = await res.text();
  console.log(`${C.green}HTML length:${C.reset}  ${html.length} characters`);

  // Show a plain-text preview
  const plainText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log(`${C.green}Plain text:${C.reset}   ${plainText.length} characters`);
  console.log(`\n${C.dim}--- First 2000 chars of plain text ---${C.reset}`);
  console.log(plainText.slice(0, 2000));
  console.log(`${C.dim}--- (truncated) ---${C.reset}`);

  return html;
}

// ─── Step 2: LLM Parse Transcript ──────────────────────────────────────────

async function llmParseTranscript(html: string): Promise<LLMTranscriptResult> {
  const truncatedHtml = html.slice(0, 60000);

  const systemPrompt = `You are a podcast transcript parser. You receive raw HTML from an NPR transcript page and extract structured data. Return ONLY valid JSON.`;

  const userPrompt = `Parse this NPR podcast transcript HTML into structured segments.

For each paragraph of spoken content, extract:
- speaker: the speaker name (uppercase, e.g. "DARIAN WOODS") or empty string if unknown
- text: the spoken text content
- isAd: true if this segment is an ad read, sponsor mention, funding credit, or NPR promotional content
- adType: if isAd is true, one of "sponsor_read", "funding_credit", "npr_promo", "show_promo", or null

Also identify all ad mentions with:
- segmentIndex: index into the segments array
- reason: why this was flagged as ad content (e.g. "contains sponsor mention for Squarespace", "NPR funding credit")

Count the number of words in editorial (non-ad) content as estimatedContentWords.

Return JSON matching this schema:
{
  "segments": [{ "speaker": string, "text": string, "isAd": boolean, "adType": string|null }],
  "fullText": string,
  "adMentions": [{ "segmentIndex": number, "reason": string }],
  "estimatedContentWords": number
}

HTML:
${truncatedHtml}`;

  section('STEP 2: LLM Parse Transcript');

  promptBox('System', systemPrompt);
  console.log('');
  // Show the user prompt WITHOUT the huge HTML blob
  const promptPreview = userPrompt.slice(0, userPrompt.indexOf('\nHTML:\n') + 6) + `<... ${truncatedHtml.length} chars of HTML ...>`;
  promptBox('User (prompt only, HTML omitted)', promptPreview);

  if (!LLM_API_KEY) {
    console.log(`\n${C.red}NO LLM KEY — using fallback parser${C.reset}`);
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    return {
      segments: [{ speaker: '', text, isAd: false, adType: null }],
      fullText: text,
      adMentions: [],
      estimatedContentWords: text.split(/\s+/).length,
    };
  }

  console.log(`\n${C.blue}Calling LLM (${LLM_PROVIDER}/${LLM_MODEL})...${C.reset}`);
  const { rawText, parsed, usage } = await callLLM({
    systemPrompt,
    userPrompt,
    temperature: 0,
    maxTokens: 4096,
  });

  console.log(`${C.green}Tokens:${C.reset} prompt=${usage?.promptTokens} completion=${usage?.completionTokens} total=${usage?.totalTokens}`);
  rawResponseBox('parse-transcript', rawText);

  return parsed as LLMTranscriptResult;
}

function printTranscriptResult(result: LLMTranscriptResult) {
  section('Parse Transcript — Parsed Result');

  console.log(`${C.green}Segments:${C.reset}     ${result.segments.length}`);
  console.log(`${C.green}Full text:${C.reset}    ${result.fullText?.length ?? 0} chars`);
  console.log(`${C.green}Word count:${C.reset}   ${result.estimatedContentWords}`);
  console.log(`${C.green}Ad mentions:${C.reset}  ${result.adMentions.length}`);

  console.log(`\n${C.bold}All Segments:${C.reset}`);
  for (let i = 0; i < result.segments.length; i++) {
    const seg = result.segments[i];
    const adTag = seg.isAd ? `${C.red} [AD: ${seg.adType}]${C.reset}` : '';
    const preview = seg.text.slice(0, 120) + (seg.text.length > 120 ? '...' : '');
    console.log(`  ${C.dim}[${i}]${C.reset} ${C.bold}${seg.speaker || '(no speaker)'}:${C.reset}${adTag} ${preview}`);
  }

  if (result.adMentions.length > 0) {
    console.log(`\n${C.bold}Ad Mentions flagged by LLM:${C.reset}`);
    for (const m of result.adMentions) {
      const seg = result.segments[m.segmentIndex];
      console.log(`  ${C.red}Segment #${m.segmentIndex}:${C.reset} ${m.reason}`);
      if (seg) console.log(`    ${C.dim}Text: ${seg.text.slice(0, 150)}${C.reset}`);
    }
  }
}

// ─── Step 3: LLM Detect Ads ────────────────────────────────────────────────

async function llmDetectAds(
  transcript: LLMTranscriptResult,
  audioDurationSeconds: number,
  episodeTitle: string,
): Promise<LLMAdDetectionResult> {
  const systemPrompt = `You are an ad detection engine for NPR podcasts. You analyze transcript structure and audio metadata to identify dynamically inserted ad segments. Return ONLY valid JSON.`;

  const userPrompt = `Analyze this podcast episode and identify all ad segments with precise time estimates.

Episode: "${episodeTitle}"
Total audio duration: ${audioDurationSeconds} seconds
Transcript editorial word count: ${transcript.estimatedContentWords}
Number of transcript segments: ${transcript.segments.length}
Number of ad mentions found in transcript: ${transcript.adMentions.length}
Ad mentions: ${JSON.stringify(transcript.adMentions.slice(0, 20))}

Key context:
- NPR podcasts use Megaphone for dynamic ad insertion
- The transcript contains ONLY editorial content (no ad copy)
- The difference between audio duration and expected speech duration (at ~155 words/minute) indicates total ad time
- NPR typically places ads as: pre-roll (beginning), mid-roll (middle), post-roll (end credits/funding)
- Sponsor reads within editorial content are different from inserted ads
- Ad mentions in the transcript (funding credits, sponsor reads) indicate editorial ad content that IS in the transcript

For each detected ad segment, provide:
- startTime/endTime in seconds
- type: "pre-roll", "mid-roll", "post-roll", or "sponsor-mention"
- confidence: 0.0-1.0
- reason: explanation of why this was identified as an ad

Return JSON:
{
  "segments": [{ "startTime": number, "endTime": number, "type": string, "confidence": number, "reason": string }],
  "totalAdTime": number,
  "contentDuration": number,
  "strategy": "llm-transcript-analysis"
}`;

  section('STEP 3: LLM Detect Ads');

  // Show the math the LLM will work from
  const expectedSpeechDuration = (transcript.estimatedContentWords / 155) * 60;
  console.log(`${C.bold}Duration analysis (what the LLM sees):${C.reset}`);
  console.log(`  Audio duration:           ${audioDurationSeconds}s (${formatTime(audioDurationSeconds)})`);
  console.log(`  Editorial words:          ${transcript.estimatedContentWords}`);
  console.log(`  Expected speech @155wpm:  ${expectedSpeechDuration.toFixed(0)}s (${formatTime(expectedSpeechDuration)})`);
  console.log(`  Gap (likely ad time):     ${(audioDurationSeconds - expectedSpeechDuration).toFixed(0)}s (${formatTime(audioDurationSeconds - expectedSpeechDuration)})`);
  if (audioDurationSeconds - expectedSpeechDuration < 0) {
    console.log(`  ${C.red}** NEGATIVE GAP: transcript has MORE words than audio duration allows at 155wpm!${C.reset}`);
    console.log(`  ${C.red}   This means the LLM has no "gap" signal for injected ads.${C.reset}`);
  }
  console.log('');

  promptBox('System', systemPrompt);
  console.log('');
  promptBox('User', userPrompt);

  if (!LLM_API_KEY) {
    console.log(`\n${C.red}NO LLM KEY — using heuristic fallback${C.reset}`);
    const segments: LLMAdSegment[] = [];
    if (audioDurationSeconds > 120) {
      segments.push({ startTime: 0, endTime: 30, type: 'pre-roll', confidence: 0.5, reason: 'heuristic fallback' });
    }
    if (audioDurationSeconds > 300) {
      const mid = audioDurationSeconds * 0.48;
      segments.push({ startTime: mid, endTime: mid + 60, type: 'mid-roll', confidence: 0.4, reason: 'heuristic fallback' });
    }
    const totalAdTime = segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    return { segments, totalAdTime, contentDuration: audioDurationSeconds - totalAdTime, strategy: 'heuristic-fallback-no-key' };
  }

  console.log(`\n${C.blue}Calling LLM (${LLM_PROVIDER}/${LLM_MODEL})...${C.reset}`);
  const { rawText, parsed, usage } = await callLLM({
    systemPrompt,
    userPrompt,
    temperature: 0,
    maxTokens: 4096,
  });

  console.log(`${C.green}Tokens:${C.reset} prompt=${usage?.promptTokens} completion=${usage?.completionTokens} total=${usage?.totalTokens}`);
  rawResponseBox('detect-ads', rawText);

  return parsed as LLMAdDetectionResult;
}

function printAdDetectionResult(result: LLMAdDetectionResult) {
  section('Detect Ads — Parsed Result');

  console.log(`${C.green}Strategy:${C.reset}        ${result.strategy}`);
  console.log(`${C.green}Total ad time:${C.reset}   ${result.totalAdTime}s (${formatTime(result.totalAdTime)})`);
  console.log(`${C.green}Content dur:${C.reset}     ${result.contentDuration}s (${formatTime(result.contentDuration)})`);
  console.log(`${C.green}Ad segments:${C.reset}     ${result.segments.length}`);

  if (result.segments.length === 0) {
    console.log(`\n${C.red}  ** NO AD SEGMENTS DETECTED — this is likely the failure point **${C.reset}`);
  }

  console.log(`\n${C.bold}Ad Segments:${C.reset}`);
  for (let i = 0; i < result.segments.length; i++) {
    const seg = result.segments[i];
    console.log(`  ${C.red}[${i}] ${seg.type}${C.reset}  ${formatTime(seg.startTime)} → ${formatTime(seg.endTime)}  (${(seg.endTime - seg.startTime).toFixed(0)}s)  conf=${seg.confidence}`);
    console.log(`      ${C.dim}${seg.reason}${C.reset}`);
  }
}

// ─── Step 4: LLM Prepare Playback ──────────────────────────────────────────

async function llmPreparePlayback(
  transcript: LLMTranscriptResult,
  adDetection: LLMAdDetectionResult,
  episodeTitle: string,
  episodeDescription: string,
): Promise<LLMPlaybackConfig> {
  const systemPrompt = `You are a podcast playback assistant. You create concise episode summaries and finalize skip configurations. Return ONLY valid JSON.`;

  const userPrompt = `Prepare a playback configuration for this podcast episode.

Episode: "${episodeTitle}"
Description: "${episodeDescription}"
Content duration: ${adDetection.contentDuration}s
Total ad time: ${adDetection.totalAdTime}s
Detected ad segments: ${JSON.stringify(adDetection.segments)}

Transcript content (first 3000 chars):
${(transcript.fullText || '').slice(0, 3000)}

Produce:
1. A 1-2 sentence summary of what this episode is about
2. 3-5 topic tags
3. The final skipMap (confirmed ad segments to auto-skip) — you may adjust confidence or remove false positives
4. A one-line recommendation for the listener

Return JSON:
{
  "summary": string,
  "topics": [string],
  "skipMap": [{ "startTime": number, "endTime": number, "type": string, "confidence": number, "reason": string }],
  "contentDuration": number,
  "totalAdTime": number,
  "recommendation": string
}`;

  section('STEP 4: LLM Prepare Playback');

  promptBox('System', systemPrompt);
  console.log('');
  promptBox('User (first 2000 chars)', userPrompt.slice(0, 2000) + (userPrompt.length > 2000 ? '\n... (truncated)' : ''));

  if (!LLM_API_KEY) {
    console.log(`\n${C.red}NO LLM KEY — using fallback${C.reset}`);
    return {
      summary: episodeDescription || 'No summary available.',
      topics: [],
      skipMap: adDetection.segments,
      contentDuration: adDetection.contentDuration,
      totalAdTime: adDetection.totalAdTime,
      recommendation: 'Auto-skip enabled for detected ad segments.',
    };
  }

  console.log(`\n${C.blue}Calling LLM (${LLM_PROVIDER}/${LLM_MODEL})...${C.reset}`);
  const { rawText, parsed, usage } = await callLLM({
    systemPrompt,
    userPrompt,
    temperature: 0.3,
    maxTokens: 2048,
  });

  console.log(`${C.green}Tokens:${C.reset} prompt=${usage?.promptTokens} completion=${usage?.completionTokens} total=${usage?.totalTokens}`);
  rawResponseBox('prepare-playback', rawText);

  return parsed as LLMPlaybackConfig;
}

function printPlaybackConfig(config: LLMPlaybackConfig) {
  section('Prepare Playback — Parsed Result');

  console.log(`${C.green}Summary:${C.reset}       ${config.summary}`);
  console.log(`${C.green}Topics:${C.reset}        ${config.topics.join(', ')}`);
  console.log(`${C.green}Content dur:${C.reset}   ${config.contentDuration}s (${formatTime(config.contentDuration)})`);
  console.log(`${C.green}Total ad time:${C.reset} ${config.totalAdTime}s (${formatTime(config.totalAdTime)})`);
  console.log(`${C.green}Recommend:${C.reset}     ${config.recommendation}`);

  console.log(`\n${C.bold}Final Skip Map:${C.reset}`);
  if (config.skipMap.length === 0) {
    console.log(`  ${C.red}(empty — no ads will be skipped)${C.reset}`);
  }
  for (let i = 0; i < config.skipMap.length; i++) {
    const seg = config.skipMap[i];
    console.log(`  ${C.red}[${i}] ${seg.type}${C.reset}  ${formatTime(seg.startTime)} → ${formatTime(seg.endTime)}  (${(seg.endTime - seg.startTime).toFixed(0)}s)  conf=${seg.confidence}`);
    console.log(`      ${C.dim}${seg.reason}${C.reset}`);
  }
}

// ─── Step 5: Map ad segments to transcript text ─────────────────────────────

function printAdToTextMapping(
  transcript: LLMTranscriptResult,
  adDetection: LLMAdDetectionResult,
  audioDurationSeconds: number,
) {
  banner('AD SEGMENT <-> TRANSCRIPT TEXT MAPPING');

  const totalWords = transcript.estimatedContentWords;
  const wordsPerSecond = totalWords / audioDurationSeconds;

  console.log(`${C.bold}Mapping parameters:${C.reset}`);
  console.log(`  Total transcript words:  ${totalWords}`);
  console.log(`  Audio duration:          ${audioDurationSeconds}s`);
  console.log(`  Approx words/second:     ${wordsPerSecond.toFixed(2)}`);
  console.log(`  Total segments:          ${transcript.segments.length}`);
  console.log('');

  if (adDetection.segments.length === 0) {
    console.log(`${C.red}  No ad segments to map — detection returned empty.${C.reset}`);
    console.log(`${C.red}  This is the core problem: the LLM is not producing ad time ranges.${C.reset}`);
    console.log('');
  }

  // Build a cumulative word-count array per segment so we can map time -> segment
  const segWordCounts: number[] = [];
  for (const seg of transcript.segments) {
    segWordCounts.push(seg.text.split(/\s+/).filter(Boolean).length);
  }

  // For each ad segment, show what transcript text would be playing around that time
  for (const ad of adDetection.segments) {
    console.log(`${C.red}${C.bold}▌ ${ad.type.toUpperCase()} — ${formatTime(ad.startTime)} → ${formatTime(ad.endTime)} (${(ad.endTime - ad.startTime).toFixed(0)}s)${C.reset}`);
    console.log(`  ${C.dim}Reason: ${ad.reason}${C.reset}`);
    console.log(`  ${C.dim}Confidence: ${ad.confidence}${C.reset}`);

    // Map startTime and endTime to approximate word positions
    const startWord = Math.floor(ad.startTime * wordsPerSecond);
    const endWord = Math.floor(ad.endTime * wordsPerSecond);

    // Find which segments these word positions fall in
    let wordPos = 0;
    let startSegIdx = -1;
    let endSegIdx = -1;
    for (let i = 0; i < segWordCounts.length; i++) {
      if (startSegIdx === -1 && wordPos + segWordCounts[i] > startWord) startSegIdx = i;
      if (endSegIdx === -1 && wordPos + segWordCounts[i] > endWord) endSegIdx = i;
      wordPos += segWordCounts[i];
    }
    if (startSegIdx === -1) startSegIdx = transcript.segments.length - 1;
    if (endSegIdx === -1) endSegIdx = transcript.segments.length - 1;

    console.log(`  ${C.yellow}Maps to approx words ${startWord}-${endWord} (segments #${startSegIdx}-#${endSegIdx})${C.reset}`);

    // Show surrounding transcript text
    const contextStart = Math.max(0, startSegIdx - 1);
    const contextEnd = Math.min(transcript.segments.length - 1, endSegIdx + 1);

    for (let i = contextStart; i <= contextEnd; i++) {
      const seg = transcript.segments[i];
      const isInAdRange = i >= startSegIdx && i <= endSegIdx;
      const marker = isInAdRange ? `${C.red}>>` : `${C.dim}  `;
      const adFlag = seg.isAd ? ` ${C.red}[TRANSCRIPT-AD: ${seg.adType}]${C.reset}` : '';
      const text = seg.text.slice(0, 200) + (seg.text.length > 200 ? '...' : '');
      console.log(`  ${marker} [${i}] ${seg.speaker || '?'}:${C.reset}${adFlag} ${text}`);
    }
    console.log('');
  }

  // Timeline visualization
  section('Timeline Visualization');

  const barWidth = 76;
  const bar = Array(barWidth).fill('░');

  for (const ad of adDetection.segments) {
    const startPos = Math.floor((ad.startTime / audioDurationSeconds) * barWidth);
    const endPos = Math.min(barWidth - 1, Math.floor((ad.endTime / audioDurationSeconds) * barWidth));
    for (let i = startPos; i <= endPos; i++) bar[i] = '█';
  }

  console.log(`  ${C.dim}0:00${' '.repeat(barWidth - 8)}${formatTime(audioDurationSeconds)}${C.reset}`);
  console.log(`  ${C.green}${bar.join('')}${C.reset}`);
  console.log(`  ${C.dim}░ = content  ${C.reset}${C.red}█ = detected ad${C.reset}`);

  // Transcript ad-mentions (editorial ads IN the transcript)
  if (transcript.adMentions.length > 0) {
    console.log(`\n${C.bold}Transcript ad-mentions (editorial, NOT dynamically injected):${C.reset}`);
    for (const m of transcript.adMentions) {
      const seg = transcript.segments[m.segmentIndex];
      if (seg) {
        console.log(`  ${C.yellow}Segment #${m.segmentIndex}${C.reset} ${seg.speaker || '?'}: ${seg.text.slice(0, 150)}...`);
        console.log(`    ${C.dim}Reason: ${m.reason}${C.reset}`);
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const podcastId = process.argv[2] || '510325';
  const episodeIndex = parseInt(process.argv[3] || '0', 10);

  banner('NPR Ad Detection Sandbox');

  console.log(`${C.bold}Configuration:${C.reset}`);
  console.log(`  LLM Provider:  ${LLM_PROVIDER}`);
  console.log(`  LLM Model:     ${LLM_MODEL}`);
  console.log(`  LLM Key:       ${LLM_API_KEY ? '***set***' : `${C.red}NOT SET (fallback mode)${C.reset}`}`);
  console.log(`  Base URL:      ${LLM_BASE_URL || '(default)'}`);
  console.log(`  Podcast ID:    ${podcastId}`);
  console.log(`  Episode Index: ${episodeIndex}`);
  console.log('');

  // Step 0: Fetch episode
  const { episode } = await fetchLatestEpisode(podcastId, episodeIndex);
  const audioDurationSeconds = parseDurationToSeconds(episode.duration);

  if (!episode.transcriptUrl) {
    console.log(`\n${C.red}ERROR: No transcript URL found for this episode.${C.reset}`);
    console.log(`The story ID could not be extracted from the episode link: ${episode.link}`);
    console.log('Try a different episode index with: npx tsx server/sandbox.ts <podcastId> <index>');
    process.exit(1);
  }

  // Step 1: Fetch transcript HTML
  const html = await fetchTranscriptHtml(episode.transcriptUrl);

  // Step 2: LLM Parse Transcript
  const transcriptResult = await llmParseTranscript(html);
  printTranscriptResult(transcriptResult);

  // Step 3: LLM Detect Ads
  const adResult = await llmDetectAds(transcriptResult, audioDurationSeconds, episode.title);
  printAdDetectionResult(adResult);

  // Step 4: LLM Prepare Playback
  const playbackConfig = await llmPreparePlayback(
    transcriptResult,
    adResult,
    episode.title,
    episode.description,
  );
  printPlaybackConfig(playbackConfig);

  // Step 5: Map ad segments to transcript text
  printAdToTextMapping(transcriptResult, adResult, audioDurationSeconds);

  // Final JSON dump
  banner('FULL DEBUG JSON DUMP');

  const fullDump = {
    episode: {
      title: episode.title,
      pubDate: episode.pubDate,
      duration: episode.duration,
      durationSeconds: audioDurationSeconds,
      transcriptUrl: episode.transcriptUrl,
      audioUrl: episode.audioUrl,
    },
    transcriptResult: {
      segmentCount: transcriptResult.segments.length,
      wordCount: transcriptResult.estimatedContentWords,
      adMentionCount: transcriptResult.adMentions.length,
      adMentions: transcriptResult.adMentions,
      segments: transcriptResult.segments.map((s, i) => ({
        index: i,
        speaker: s.speaker,
        wordCount: s.text.split(/\s+/).filter(Boolean).length,
        isAd: s.isAd,
        adType: s.adType,
        textPreview: s.text.slice(0, 100),
      })),
    },
    adDetection: adResult,
    playbackConfig: {
      summary: playbackConfig.summary,
      topics: playbackConfig.topics,
      skipMap: playbackConfig.skipMap,
      contentDuration: playbackConfig.contentDuration,
      totalAdTime: playbackConfig.totalAdTime,
    },
  };
  console.log(JSON.stringify(fullDump, null, 2));

  banner('SANDBOX COMPLETE');
}

main().catch((err) => {
  console.error(`\n${C.red}SANDBOX FATAL ERROR:${C.reset}`, err);
  process.exit(1);
});
