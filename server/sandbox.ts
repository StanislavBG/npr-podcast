#!/usr/bin/env tsx
/**
 * sandbox.ts — Debug harness for ad-detection pipeline (v3).
 *
 * PRIMARY APPROACH: Transcribe the actual audio file using speech-to-text.
 * This captures dynamically inserted ads (Megaphone) that never appear in
 * NPR's text transcripts. Falls back to HTML transcript parsing if STT
 * is unavailable.
 *
 *   1. Fetch audio MP3 → transcribe via OpenAI gpt-4o-mini-transcribe
 *   2. Parse into numbered transcript lines
 *   3. Send transcript to LLM: "which line ranges are ad blocks?"
 *   4. Map line ranges → audio timestamps
 *   5. Display full transcript with ad blocks highlighted inline
 *
 * Usage:
 *   npx tsx server/sandbox.ts                     # The Indicator (default)
 *   npx tsx server/sandbox.ts 510289              # Planet Money
 *   npx tsx server/sandbox.ts 510325 3            # 4th episode (0-indexed)
 *   npx tsx server/sandbox.ts 510325 0 --html     # Force HTML transcript (skip STT)
 *
 * Env vars:
 *   OPENAI_API_KEY                    — required for LLM calls
 *   AI_INTEGRATIONS_OPENAI_API_KEY    — Replit's auto-provided key (for STT)
 *   OPENAI_MODEL                      — e.g. gpt-4o-mini (default)
 *   OPENAI_BASE_URL                   — optional base URL override
 */

import { XMLParser } from 'fast-xml-parser';
import { speechToText, ensureCompatibleFormat, openai as sttOpenai } from './replit_integrations/audio/client';

// ─── Terminal colours ───────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  bgRed:   '\x1b[41m',
  white:   '\x1b[37m',
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

function rawBox(label: string, content: string, maxLines = 100) {
  console.log(`${C.blue}┌─ ${label} ─${'─'.repeat(Math.max(0, 73 - label.length))}┐${C.reset}`);
  const lines = content.split('\n');
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    console.log(`${C.dim}│${C.reset} ${lines[i]}`);
  }
  if (lines.length > maxLines) console.log(`${C.dim}│ ... (${lines.length - maxLines} more lines)${C.reset}`);
  console.log(`${C.blue}└${'─'.repeat(77)}┘${C.reset}`);
}

// ─── LLM config (OpenAI) ────────────────────────────────────────────────────

const LLM_MODEL    = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LLM_API_KEY  = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;

// ─── JSON repair ────────────────────────────────────────────────────────────

function repairJSON(raw: string): string {
  let r = raw.replace(/,\s*([}\]])/g, '$1');
  const chars: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < r.length; i++) {
    const ch = r[i];
    if (esc) { chars.push(ch); esc = false; continue; }
    if (ch === '\\' && inStr) { chars.push(ch); esc = true; continue; }
    if (ch === '"') { inStr = !inStr; chars.push(ch); continue; }
    if (inStr && ch.charCodeAt(0) < 0x20) {
      const map: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
      chars.push(map[ch] || '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
      continue;
    }
    chars.push(ch);
  }
  return chars.join('');
}

function extractOutermostJSON(text: string): string | null {
  const objIdx = text.indexOf('{');
  const arrIdx = text.indexOf('[');
  const tries: Array<[string, string]> = [];
  if (objIdx !== -1 && arrIdx !== -1) {
    tries.push(arrIdx < objIdx ? ['[', ']'] : ['{', '}']);
    tries.push(arrIdx < objIdx ? ['{', '}'] : ['[', ']']);
  } else if (objIdx !== -1) tries.push(['{', '}']);
  else if (arrIdx !== -1) tries.push(['[', ']']);

  for (const [open, close] of tries) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) return text.slice(start, i + 1); }
      }
    }
  }
  return null;
}

function parseJSON(raw: string): unknown {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) cleaned = fence[1].trim();
  try { return JSON.parse(cleaned); } catch {}
  const json = extractOutermostJSON(cleaned);
  if (!json) throw new Error('No JSON found in LLM response');
  try { return JSON.parse(json); } catch {}
  try { return JSON.parse(repairJSON(json)); } catch (e) {
    throw new Error(`JSON parse failed: ${e instanceof Error ? e.message : e}`);
  }
}

// ─── LLM call (OpenAI) ──────────────────────────────────────────────────────

interface LLMResult { rawText: string; parsed: unknown; tokens?: { prompt: number; completion: number } }

async function callLLM(system: string, user: string, temp = 0, maxTokens = 4096): Promise<LLMResult> {
  const baseUrl = LLM_BASE_URL
    ? (LLM_BASE_URL.endsWith('/chat/completions') ? LLM_BASE_URL : `${LLM_BASE_URL}/chat/completions`)
    : 'https://api.openai.com/v1/chat/completions';
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens, temperature: temp,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const d = await res.json() as any;
  const raw = d.choices?.[0]?.message?.content || '';
  return { rawText: raw, parsed: parseJSON(raw), tokens: { prompt: d.usage?.prompt_tokens, completion: d.usage?.completion_tokens } };
}

// ─── Podcast catalogue ──────────────────────────────────────────────────────

const PODCASTS: Record<string, { name: string; feedUrl: string }> = {
  '510325':    { name: 'The Indicator from Planet Money', feedUrl: 'https://feeds.npr.org/510325/podcast.xml' },
  '510289':    { name: 'Planet Money',                    feedUrl: 'https://feeds.npr.org/510289/podcast.xml' },
  '510318':    { name: 'Short Wave',                      feedUrl: 'https://feeds.npr.org/510318/podcast.xml' },
  '510308':    { name: 'Hidden Brain',                    feedUrl: 'https://feeds.npr.org/510308/podcast.xml' },
  '344098539': { name: 'Up First',                        feedUrl: 'https://feeds.npr.org/344098539/podcast.xml' },
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface Episode {
  title: string; description: string; pubDate: string;
  duration: string; audioUrl: string; link: string; transcriptUrl: string | null;
}

/** A single line of the transcript with metadata */
interface TranscriptLine {
  lineNum: number;      // 1-based
  speaker: string;      // e.g. "DARIAN WOODS" or ""
  text: string;         // the spoken text
  wordCount: number;
  cumulativeWords: number;  // running total up to end of this line
}

/** An ad block found in the transcript */
interface AdBlock {
  startLine: number;    // 1-based inclusive
  endLine: number;      // 1-based inclusive
  reason: string;
  textPreview: string;
  // Computed after detection:
  startWord: number;
  endWord: number;
  startTimeSec: number;
  endTimeSec: number;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function parseDuration(dur: string): number {
  if (!dur) return 0;
  const p = dur.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Step 0: Fetch RSS → pick episode ───────────────────────────────────────

async function fetchEpisode(podcastId: string, idx: number): Promise<Episode> {
  const pod = PODCASTS[podcastId];
  if (!pod) throw new Error(`Unknown podcast ID ${podcastId}. Valid: ${Object.keys(PODCASTS).join(', ')}`);

  section(`Fetching RSS: ${pod.name}`);
  const res = await fetch(pod.feedUrl, { headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

  const xml = await res.text();
  const feed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml);
  const items = [feed?.rss?.channel?.item || []].flat();
  if (idx >= items.length) throw new Error(`Episode index ${idx} out of range (${items.length} available)`);

  const item = items[idx];
  const link = item.link || '';
  const idMatch = link.match(/\/(\d{4}\/\d{2}\/\d{2}\/[\w-]+|nx-[\w-]+)/);
  const storyId = idMatch ? idMatch[1] : null;

  const ep: Episode = {
    title: item.title || 'Untitled',
    description: (item.description || item['itunes:summary'] || '').replace(/<[^>]*>/g, ''),
    pubDate: item.pubDate || '',
    duration: item['itunes:duration'] || '',
    audioUrl: (item.enclosure || {})['@_url'] || '',
    link,
    transcriptUrl: storyId ? `https://www.npr.org/transcripts/${storyId}` : null,
  };

  console.log(`${C.green}Podcast:${C.reset}    ${pod.name}`);
  console.log(`${C.green}Episode:${C.reset}    ${ep.title}`);
  console.log(`${C.green}Published:${C.reset}  ${ep.pubDate}`);
  console.log(`${C.green}Duration:${C.reset}   ${ep.duration} (${parseDuration(ep.duration)}s)`);
  console.log(`${C.green}Transcript:${C.reset} ${ep.transcriptUrl || '(none)'}`);
  console.log(`${C.green}Audio:${C.reset}      ${ep.audioUrl ? ep.audioUrl.slice(0, 80) + '...' : '(none)'}`);
  return ep;
}

// ─── Step 1: Fetch transcript HTML → numbered lines ─────────────────────────

/**
 * Extract the transcript-specific section from NPR HTML pages.
 * NPR transcript pages embed the actual transcript inside specific containers.
 * This function tries multiple strategies to isolate the transcript from page chrome.
 */
function extractTranscriptSection(html: string): string {
  // Strategy 1: Look for known transcript container patterns
  const containerPatterns = [
    /<div[^>]*\bclass="[^"]*\btranscript\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*\bclass="[^"]*\b(?:footer|related|sidebar)\b)/i,
    /<div[^>]*\bclass="[^"]*\bstorytext\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<(?:div|section)[^>]*\bid=["'](?:transcript|storytext)["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
  ];

  for (const pattern of containerPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const section = match[1];
      const pCount = (section.match(/<p[^>]*>/gi) || []).length;
      if (pCount >= 5) return section;
    }
  }

  // Strategy 2: Find the largest cluster of <p> tags containing speaker patterns
  const speakerPattern = /<p[^>]*>[\s\S]*?(?:<b>|<strong>)[A-Z][A-Z\s'.,-]+:[\s\S]*?<\/p>/gi;
  const speakerParagraphs = html.match(speakerPattern) || [];

  if (speakerParagraphs.length >= 3) {
    const firstIdx = html.indexOf(speakerParagraphs[0]);
    const lastParagraph = speakerParagraphs[speakerParagraphs.length - 1];
    const lastIdx = html.lastIndexOf(lastParagraph) + lastParagraph.length;
    if (firstIdx !== -1 && lastIdx > firstIdx) return html.slice(firstIdx, lastIdx);
  }

  // Strategy 3: No container found — return full HTML
  return html;
}

/**
 * Clean HTML entity references and tags from a text block.
 */
function cleanHtmlText(block: string): string {
  return block
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect if a text line is page chrome (navigation, metadata, JS) rather than transcript content.
 */
function isPageChrome(text: string): boolean {
  if (text.length < 10) return true;
  if (/^(?:var |function |window\.|document\.|if\s*\(|for\s*\()/.test(text)) return true;
  if (text.includes('createElement') || text.includes('getElementsBy') || text.includes('addEventListener')) return true;
  if (text.includes('"@type"') || text.includes('"@context"') || text.includes('ImageObject')) return true;
  if (/^(?:Skip to|Keyboard shortcuts|Open Navigation|Close Navigation|Expand\/collapse)/i.test(text)) return true;
  if (/^(?:Home|News|Music|Culture|Podcasts & Shows|Search|Newsletters|NPR Shop)\s*$/i.test(text)) return true;
  if (/^(?:About NPR|Diversity|Support|Careers|Press|Ethics)\s*$/i.test(text)) return true;
  if (/^(?:LISTEN & FOLLOW|NPR App|Apple Podcasts|Spotify|Amazon Music|iHeart Radio|YouTube Music)\s*$/i.test(text)) return true;
  if (/^(?:Sponsor Message|Become an NPR sponsor)\s*$/i.test(text)) return true;
  const urlCount = (text.match(/https?:\/\//g) || []).length;
  if (urlCount > 2) return true;
  if (text.length > 2000) return true;
  if (/\bhide caption\b/i.test(text)) return true;
  if (/\(Photo by [^)]+\)/i.test(text) && text.length < 300) return true;
  return false;
}

function parseTranscriptHtml(html: string): TranscriptLine[] {
  // First, try to extract just the transcript section from the full page
  const transcriptSection = extractTranscriptSection(html);

  const lines: TranscriptLine[] = [];
  const pBlocks = transcriptSection.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];

  let cumulative = 0;
  let lineNum = 0;

  for (const block of pBlocks) {
    const text = cleanHtmlText(block);

    if (!text || text.length < 3) continue;

    // Filter out page chrome
    if (isPageChrome(text)) continue;

    // Detect speaker: "SPEAKER NAME:" at the start
    let speaker = '';
    let content = text;
    const speakerMatch = text.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
    if (speakerMatch) {
      speaker = speakerMatch[1].trim();
      content = text.slice(speakerMatch[0].length).trim();
    }

    if (!content) continue;

    lineNum++;
    const wc = content.split(/\s+/).filter(Boolean).length;
    cumulative += wc;

    lines.push({
      lineNum,
      speaker,
      text: content,
      wordCount: wc,
      cumulativeWords: cumulative,
    });
  }

  return lines;
}

/**
 * Validate that parsed transcript lines look like an actual podcast transcript.
 */
function validateTranscript(lines: TranscriptLine[], durationSec: number): {
  isValid: boolean;
  reason: string;
} {
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  const expectedMinWords = durationSec > 0 ? Math.floor((durationSec / 60) * 155 * 0.3) : 100;
  const avgWordsPerLine = lines.length > 0 ? totalWords / lines.length : 0;

  if (lines.length < 5) {
    return { isValid: false, reason: `Only ${lines.length} lines parsed — too few for a real transcript` };
  }
  if (totalWords < expectedMinWords) {
    return { isValid: false, reason: `Only ${totalWords} words (expected ≥${expectedMinWords} for ${Math.round(durationSec / 60)}min episode)` };
  }
  if (lines.length > 5 && avgWordsPerLine > 500) {
    return { isValid: false, reason: `Avg ${Math.round(avgWordsPerLine)} words/line — likely page content, not transcript` };
  }
  return { isValid: true, reason: 'Transcript looks valid' };
}

async function transcribeAudio(audioUrl: string): Promise<{ lines: TranscriptLine[]; text: string }> {
  section('Transcribing audio (speech-to-text)');
  console.log(`${C.green}Audio URL:${C.reset} ${audioUrl.slice(0, 80)}...`);

  // Step 1: Download audio
  const audioRes = await fetch(audioUrl, {
    headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
    redirect: 'follow',
  });
  if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);

  const arrayBuf = await audioRes.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuf);
  console.log(`${C.green}Audio size:${C.reset} ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // Step 2: Ensure compatible format
  const { buffer, format } = await ensureCompatibleFormat(audioBuffer);

  // Step 3: Transcribe with verbose_json for timestamps
  let fullText = '';
  let segments: Array<{ start: number; end: number; text: string }> = [];

  try {
    const { toFile } = await import('openai');
    const file = await toFile(buffer, `audio.${format}`);
    const verboseResult = await sttOpenai.audio.transcriptions.create({
      file,
      model: 'gpt-4o-mini-transcribe',
      response_format: 'verbose_json',
    }) as any;

    fullText = verboseResult.text || '';
    segments = (verboseResult.segments || []).map((s: any) => ({
      start: s.start || 0,
      end: s.end || 0,
      text: (s.text || '').trim(),
    }));
    console.log(`${C.green}Segments:${C.reset}  ${segments.length} (verbose_json)`);
  } catch (err: any) {
    console.log(`${C.yellow}verbose_json failed (${err.message}), trying plain text...${C.reset}`);
    fullText = await speechToText(buffer, format);
  }

  console.log(`${C.green}Text:${C.reset}      ${fullText.length} chars, ${fullText.split(/\s+/).length} words`);

  // Step 4: Convert to TranscriptLine format
  const lines: TranscriptLine[] = [];
  let cumulative = 0;
  let lineNum = 0;

  if (segments.length > 0) {
    for (const seg of segments) {
      if (!seg.text) continue;
      let speaker = '';
      let content = seg.text;
      const speakerMatch = content.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        content = content.slice(speakerMatch[0].length).trim();
      }
      if (!content) continue;
      lineNum++;
      const wc = content.split(/\s+/).filter(Boolean).length;
      cumulative += wc;
      lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
    }
  } else {
    const sentences = fullText.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    for (const sentence of sentences) {
      let speaker = '';
      let content = sentence.trim();
      const speakerMatch = content.match(/^([A-Z][A-Z\s'.,-]+):\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        content = content.slice(speakerMatch[0].length).trim();
      }
      if (!content) continue;
      lineNum++;
      const wc = content.split(/\s+/).filter(Boolean).length;
      cumulative += wc;
      lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
    }
  }

  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  console.log(`${C.green}Parsed:${C.reset}    ${lines.length} lines, ${totalWords} words`);

  return { lines, text: fullText };
}

async function fetchAndParseTranscript(url: string, durationSec: number): Promise<{ html: string; lines: TranscriptLine[] }> {
  section('Fetching transcript HTML');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
  });
  if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status}`);
  const html = await res.text();
  console.log(`${C.green}HTML size:${C.reset} ${html.length} chars`);

  const allPTags = (html.match(/<p[^>]*>/gi) || []).length;
  console.log(`${C.green}Total <p> tags on page:${C.reset} ${allPTags}`);

  const lines = parseTranscriptHtml(html);
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  console.log(`${C.green}Parsed:${C.reset}    ${lines.length} lines, ${totalWords} words`);

  // Validate transcript quality
  const validation = validateTranscript(lines, durationSec);
  if (validation.isValid) {
    console.log(`${C.green}Validation:${C.reset} ${C.green}PASS${C.reset} — ${validation.reason}`);
  } else {
    console.log(`${C.red}Validation:${C.reset} ${C.red}FAIL${C.reset} — ${validation.reason}`);
    console.log(`${C.yellow}The transcript page may not contain actual spoken dialogue.${C.reset}`);
    console.log(`${C.yellow}This can happen if the episode is too new (transcripts take 10-48 hours to publish).${C.reset}`);
  }

  return { html, lines };
}

// ─── Step 2: Show the FULL transcript (numbered) ────────────────────────────

function printFullTranscript(lines: TranscriptLine[]) {
  section('FULL TRANSCRIPT (numbered lines)');
  for (const l of lines) {
    const spk = l.speaker ? `${C.bold}${l.speaker}:${C.reset} ` : '';
    console.log(`  ${C.dim}${String(l.lineNum).padStart(3)}${C.reset} ${spk}${l.text}`);
  }
  console.log(`\n  ${C.dim}Total: ${lines.length} lines, ${lines[lines.length - 1]?.cumulativeWords || 0} words${C.reset}`);
}

// ─── Step 3: LLM — find ad blocks in the transcript text ───────────────────

function buildNumberedTranscriptText(lines: TranscriptLine[]): string {
  return lines.map(l => {
    const spk = l.speaker ? `${l.speaker}: ` : '';
    return `[${l.lineNum}] ${spk}${l.text}`;
  }).join('\n');
}

async function detectAdBlocks(lines: TranscriptLine[], episodeTitle: string): Promise<AdBlock[]> {
  section('STEP 3: LLM — Detect ad blocks in transcript');

  const numberedText = buildNumberedTranscriptText(lines);
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

  // For long transcripts, we may need to chunk. But most NPR episodes
  // are 8-25min = ~1200-4000 words = well within context limits.
  console.log(`${C.green}Transcript:${C.reset} ${lines.length} lines, ${totalWords} words, ${numberedText.length} chars`);

  const systemPrompt = `You are an ad-block detector for podcast transcripts. You read the full transcript and identify contiguous blocks of lines that are advertisements, sponsor reads, funding credits, or promotional content — NOT editorial content.

IMPORTANT: You are looking for OBVIOUS ad blocks. These are contiguous runs of lines where the content is clearly commercial/promotional. Typical patterns:
- "Support for this podcast comes from..."
- "This message comes from..."
- Sponsor descriptions with calls-to-action ("visit example.com", "use promo code...")
- NPR funding credits ("Support for NPR comes from...")
- Show promos ("Coming up on..." for a different show)

These ad blocks are typically 1-5 lines long and there are at most a few per episode (one every 10-15 minutes of content). They are VERY obvious — a human would spot them instantly.

Do NOT flag: regular editorial discussion about economics/business/companies, interview content, the host's own commentary, or transitions between topics.

Return ONLY valid JSON.`;

  const userPrompt = `Here is the full transcript of "${episodeTitle}" with numbered lines.
Find all ad blocks — contiguous ranges of lines that are ads/sponsors/funding credits.

For each block, return the start and end line numbers (inclusive) and a short reason.

TRANSCRIPT:
${numberedText}

Return JSON:
{
  "adBlocks": [
    { "startLine": number, "endLine": number, "reason": "short explanation" }
  ]
}`;

  promptBox('System', systemPrompt);
  console.log('');
  // Show the user prompt with a preview of the transcript portion
  const previewCutoff = userPrompt.indexOf('\nTRANSCRIPT:\n') + 13;
  const transcriptPreview = numberedText.split('\n').slice(0, 10).join('\n') + `\n... (${lines.length} lines total)`;
  promptBox('User', userPrompt.slice(0, previewCutoff) + transcriptPreview + '\n\n' + userPrompt.slice(userPrompt.indexOf('\nReturn JSON:')));

  if (!LLM_API_KEY) {
    console.log(`\n${C.red}NO LLM KEY — cannot detect ad blocks. Set OPENAI_API_KEY.${C.reset}`);
    return [];
  }

  console.log(`\n${C.blue}Calling OpenAI (${LLM_MODEL})...${C.reset}`);
  const { rawText, parsed, tokens } = await callLLM(systemPrompt, userPrompt, 0, 2048);
  console.log(`${C.green}Tokens:${C.reset} prompt=${tokens?.prompt} completion=${tokens?.completion}`);
  rawBox('RAW LLM RESPONSE', rawText);

  const result = parsed as { adBlocks: Array<{ startLine: number; endLine: number; reason: string }> };
  return (result.adBlocks || []).map(b => ({
    startLine: b.startLine,
    endLine: b.endLine,
    reason: b.reason,
    textPreview: lines.filter(l => l.lineNum >= b.startLine && l.lineNum <= b.endLine).map(l => l.text).join(' ').slice(0, 200),
    startWord: 0,
    endWord: 0,
    startTimeSec: 0,
    endTimeSec: 0,
  }));
}

// ─── Step 4: Map ad blocks → timestamps ─────────────────────────────────────

function mapBlocksToTimestamps(blocks: AdBlock[], lines: TranscriptLine[], audioDurationSec: number): AdBlock[] {
  if (lines.length === 0 || audioDurationSec === 0) return blocks;

  const totalWords = lines[lines.length - 1].cumulativeWords;
  // Simple proportional mapping: word position / total words * duration
  // This assumes roughly constant speech rate across the episode.

  const lineMap = new Map<number, TranscriptLine>();
  for (const l of lines) lineMap.set(l.lineNum, l);

  for (const b of blocks) {
    const startLine = lineMap.get(b.startLine);
    const endLine = lineMap.get(b.endLine);
    if (!startLine || !endLine) continue;

    // Word position at start of the ad block
    b.startWord = startLine.cumulativeWords - startLine.wordCount;
    // Word position at end of the ad block
    b.endWord = endLine.cumulativeWords;

    b.startTimeSec = (b.startWord / totalWords) * audioDurationSec;
    b.endTimeSec = (b.endWord / totalWords) * audioDurationSec;
  }

  return blocks;
}

// ─── Print annotated transcript + results ────────────────────────────────────

function printAnnotatedTranscript(lines: TranscriptLine[], blocks: AdBlock[], audioDurationSec: number) {
  banner('ANNOTATED TRANSCRIPT');

  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

  // Build a set of line numbers that are inside ad blocks
  const adLineSet = new Set<number>();
  const adLineToBlock = new Map<number, AdBlock>();
  for (const b of blocks) {
    for (let i = b.startLine; i <= b.endLine; i++) {
      adLineSet.add(i);
      adLineToBlock.set(i, b);
    }
  }

  let lastWasAd = false;
  for (const l of lines) {
    const isAd = adLineSet.has(l.lineNum);
    const approxTime = (l.cumulativeWords / totalWords) * audioDurationSec;

    // Print block header when entering an ad block
    if (isAd && !lastWasAd) {
      const block = adLineToBlock.get(l.lineNum)!;
      console.log(`${C.bgRed}${C.white}${C.bold} ▼ AD BLOCK (lines ${block.startLine}-${block.endLine}) ${fmt(block.startTimeSec)} → ${fmt(block.endTimeSec)} — ${block.reason} ${C.reset}`);
    }

    const timeStr = `${C.dim}[${fmt(approxTime)}]${C.reset}`;
    const lineNo = `${C.dim}${String(l.lineNum).padStart(3)}${C.reset}`;
    const spk = l.speaker ? `${C.bold}${l.speaker}:${C.reset} ` : '';

    if (isAd) {
      console.log(`  ${timeStr} ${lineNo} ${C.red}██ ${spk}${l.text}${C.reset}`);
    } else {
      console.log(`  ${timeStr} ${lineNo}    ${spk}${l.text}`);
    }

    if (lastWasAd && !isAd) {
      console.log(`${C.bgRed}${C.white}${C.bold} ▲ END AD BLOCK ${C.reset}`);
    }
    lastWasAd = isAd;
  }
  if (lastWasAd) {
    console.log(`${C.bgRed}${C.white}${C.bold} ▲ END AD BLOCK ${C.reset}`);
  }
}

function printResults(blocks: AdBlock[], lines: TranscriptLine[], audioDurationSec: number) {
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

  section('AD DETECTION RESULTS');

  if (blocks.length === 0) {
    console.log(`${C.red}No ad blocks detected.${C.reset}`);
    console.log(`Either the transcript has no ads, or the LLM missed them.`);
    return;
  }

  console.log(`${C.green}Found ${blocks.length} ad block(s):${C.reset}\n`);

  let totalAdWords = 0;
  for (const b of blocks) {
    const adWords = b.endWord - b.startWord;
    totalAdWords += adWords;
    const duration = b.endTimeSec - b.startTimeSec;
    console.log(`  ${C.red}${C.bold}▌ Lines ${b.startLine}-${b.endLine}${C.reset}  ${fmt(b.startTimeSec)} → ${fmt(b.endTimeSec)}  (${duration.toFixed(0)}s, ~${adWords} words)`);
    console.log(`    ${C.dim}Reason: ${b.reason}${C.reset}`);
    console.log(`    ${C.dim}Text: "${b.textPreview}"${C.reset}`);
    console.log('');
  }

  const totalAdTimeSec = blocks.reduce((s, b) => s + (b.endTimeSec - b.startTimeSec), 0);
  console.log(`${C.bold}Summary:${C.reset}`);
  console.log(`  Total ad time:     ~${totalAdTimeSec.toFixed(0)}s (${fmt(totalAdTimeSec)})`);
  console.log(`  Content time:      ~${(audioDurationSec - totalAdTimeSec).toFixed(0)}s (${fmt(audioDurationSec - totalAdTimeSec)})`);
  console.log(`  Ad words:          ${totalAdWords} / ${totalWords} (${((totalAdWords / totalWords) * 100).toFixed(1)}%)`);

  // Timeline bar
  section('Timeline');
  const W = 76;
  const bar = Array(W).fill('░');
  for (const b of blocks) {
    const s = Math.floor((b.startTimeSec / audioDurationSec) * W);
    const e = Math.min(W - 1, Math.floor((b.endTimeSec / audioDurationSec) * W));
    for (let i = s; i <= e; i++) bar[i] = '█';
  }
  console.log(`  ${C.dim}0:00${' '.repeat(W - 8)}${fmt(audioDurationSec)}${C.reset}`);
  console.log(`  ${C.green}${bar.join('')}${C.reset}`);
  console.log(`  ${C.dim}░ = content  ${C.reset}${C.red}█ = ad block${C.reset}`);

  // Skip map JSON (what the player needs)
  section('Skip Map (for Player)');
  const skipMap = blocks.map(b => ({
    startTime: Math.round(b.startTimeSec),
    endTime: Math.round(b.endTimeSec),
    type: 'mid-roll' as const,
    confidence: 0.9,
    reason: b.reason,
  }));
  console.log(JSON.stringify(skipMap, null, 2));
}

// ─── Full debug JSON dump ───────────────────────────────────────────────────

function printDebugDump(ep: Episode, lines: TranscriptLine[], blocks: AdBlock[], audioDurationSec: number) {
  section('Full Debug JSON');
  const dump = {
    episode: {
      title: ep.title, pubDate: ep.pubDate, duration: ep.duration,
      durationSec: audioDurationSec, transcriptUrl: ep.transcriptUrl,
    },
    transcript: {
      lineCount: lines.length,
      totalWords: lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0,
      lines: lines.map(l => ({
        line: l.lineNum, speaker: l.speaker,
        words: l.wordCount, cumWords: l.cumulativeWords,
        text: l.text.slice(0, 120),
      })),
    },
    adBlocks: blocks.map(b => ({
      lines: `${b.startLine}-${b.endLine}`,
      words: `${b.startWord}-${b.endWord}`,
      time: `${fmt(b.startTimeSec)}-${fmt(b.endTimeSec)}`,
      timeSec: { start: Math.round(b.startTimeSec), end: Math.round(b.endTimeSec) },
      reason: b.reason,
      textPreview: b.textPreview,
    })),
    skipMap: blocks.map(b => ({
      startTime: Math.round(b.startTimeSec),
      endTime: Math.round(b.endTimeSec),
      type: 'mid-roll',
      confidence: 0.9,
      reason: b.reason,
    })),
  };
  console.log(JSON.stringify(dump, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const podcastId = process.argv[2] || '510325';
  const episodeIndex = parseInt(process.argv[3] || '0', 10);
  const forceHtml = process.argv.includes('--html');

  banner('NPR Ad Detection Sandbox v3');

  const sttKeyAvailable = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);

  console.log(`${C.bold}Configuration:${C.reset}`);
  console.log(`  OpenAI Model:  ${LLM_MODEL}`);
  console.log(`  LLM Key:       ${LLM_API_KEY ? '***set***' : `${C.red}NOT SET${C.reset}`}`);
  console.log(`  STT Key:       ${sttKeyAvailable ? '***set***' : `${C.red}NOT SET${C.reset}`}`);
  console.log(`  Podcast ID:    ${podcastId}`);
  console.log(`  Episode Index: ${episodeIndex}`);
  console.log(`  Mode:          ${forceHtml ? 'HTML transcript (forced)' : 'Audio transcription (preferred)'}`);
  console.log('');
  console.log(`${C.bold}Approach:${C.reset} ${forceHtml ? 'Parse HTML transcript' : 'Transcribe audio file (captures dynamic ads)'} → LLM finds ad blocks → map to timestamps`);

  // Step 0: Fetch episode metadata
  const episode = await fetchEpisode(podcastId, episodeIndex);
  const audioDurationSec = parseDuration(episode.duration);

  // Step 1: Get transcript — prefer audio transcription unless --html flag
  let lines: TranscriptLine[] = [];
  let transcriptSource = '';

  if (!forceHtml && episode.audioUrl && sttKeyAvailable) {
    // Try audio transcription first
    try {
      const result = await transcribeAudio(episode.audioUrl);
      lines = result.lines;
      transcriptSource = 'audio-transcription';
    } catch (err: any) {
      console.log(`\n${C.yellow}Audio transcription failed: ${err.message}${C.reset}`);
      console.log(`${C.yellow}Falling back to HTML transcript...${C.reset}`);
    }
  }

  if (lines.length === 0) {
    // Fall back to HTML transcript
    if (!episode.transcriptUrl) {
      console.log(`\n${C.red}ERROR: No transcript URL and audio transcription unavailable.${C.reset}`);
      console.log(`Link: ${episode.link}`);
      process.exit(1);
    }
    const result = await fetchAndParseTranscript(episode.transcriptUrl, audioDurationSec);
    lines = result.lines;
    transcriptSource = 'html';
  }

  if (lines.length === 0) {
    console.log(`\n${C.red}ERROR: Parsed 0 lines from transcript.${C.reset}`);
    process.exit(1);
  }

  console.log(`\n${C.green}Transcript source:${C.reset} ${transcriptSource}`);

  // Step 2: Print the FULL transcript (this is your starting point for debugging)
  printFullTranscript(lines);

  // Step 3: LLM detects ad blocks by reading the transcript text
  let adBlocks = await detectAdBlocks(lines, episode.title);

  // Step 4: Map ad-block line ranges to audio timestamps
  adBlocks = mapBlocksToTimestamps(adBlocks, lines, audioDurationSec);

  // Print annotated transcript with ad blocks highlighted
  printAnnotatedTranscript(lines, adBlocks, audioDurationSec);

  // Print results + skip map
  printResults(adBlocks, lines, audioDurationSec);

  // Full JSON dump
  printDebugDump(episode, lines, adBlocks, audioDurationSec);

  banner('SANDBOX COMPLETE');
}

main().catch((err) => {
  console.error(`\n${C.red}SANDBOX FATAL ERROR:${C.reset}`, err);
  process.exit(1);
});
