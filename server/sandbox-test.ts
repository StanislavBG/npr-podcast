#!/usr/bin/env tsx
/**
 * sandbox-test.ts — Offline test harness for the sandbox ad-detection pipeline.
 *
 * Runs the SAME parsing + annotation logic as sandbox.ts but with:
 *   - Embedded sample NPR transcript HTML (no network needed)
 *   - Simulated LLM ad-detection output (no API key needed)
 *
 * This lets you verify the pipeline end-to-end without external dependencies.
 *
 * Usage:
 *   npx tsx server/sandbox-test.ts
 */

// ─── Terminal colours (copied from sandbox.ts) ──────────────────────────────
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

// ─── Types (same as sandbox.ts) ─────────────────────────────────────────────

interface TranscriptLine {
  lineNum: number;
  speaker: string;
  text: string;
  wordCount: number;
  cumulativeWords: number;
}

interface AdBlock {
  startLine: number;
  endLine: number;
  reason: string;
  textPreview: string;
  startWord: number;
  endWord: number;
  startTimeSec: number;
  endTimeSec: number;
}

// ─── Utility (same as sandbox.ts) ───────────────────────────────────────────

function fmt(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Transcript HTML parser (same logic as sandbox.ts) ──────────────────────

function parseTranscriptHtml(html: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const pBlocks = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];

  let cumulative = 0;
  let lineNum = 0;

  for (const block of pBlocks) {
    const text = block
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text.length < 3) continue;

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

    lines.push({ lineNum, speaker, text: content, wordCount: wc, cumulativeWords: cumulative });
  }

  return lines;
}

// ─── Timestamp mapper (same logic as sandbox.ts) ────────────────────────────

function mapBlocksToTimestamps(blocks: AdBlock[], lines: TranscriptLine[], audioDurationSec: number): AdBlock[] {
  if (lines.length === 0 || audioDurationSec === 0) return blocks;

  const totalWords = lines[lines.length - 1].cumulativeWords;
  const lineMap = new Map<number, TranscriptLine>();
  for (const l of lines) lineMap.set(l.lineNum, l);

  for (const b of blocks) {
    const startLine = lineMap.get(b.startLine);
    const endLine = lineMap.get(b.endLine);
    if (!startLine || !endLine) continue;

    b.startWord = startLine.cumulativeWords - startLine.wordCount;
    b.endWord = endLine.cumulativeWords;
    b.startTimeSec = (b.startWord / totalWords) * audioDurationSec;
    b.endTimeSec = (b.endWord / totalWords) * audioDurationSec;
  }

  return blocks;
}

// ─── Display functions (same as sandbox.ts) ─────────────────────────────────

function printFullTranscript(lines: TranscriptLine[]) {
  section('FULL TRANSCRIPT (numbered lines)');
  for (const l of lines) {
    const spk = l.speaker ? `${C.bold}${l.speaker}:${C.reset} ` : '';
    console.log(`  ${C.dim}${String(l.lineNum).padStart(3)}${C.reset} ${spk}${l.text}`);
  }
  console.log(`\n  ${C.dim}Total: ${lines.length} lines, ${lines[lines.length - 1]?.cumulativeWords || 0} words${C.reset}`);
}

function buildNumberedTranscriptText(lines: TranscriptLine[]): string {
  return lines.map(l => {
    const spk = l.speaker ? `${l.speaker}: ` : '';
    return `[${l.lineNum}] ${spk}${l.text}`;
  }).join('\n');
}

function printAnnotatedTranscript(lines: TranscriptLine[], blocks: AdBlock[], audioDurationSec: number) {
  banner('ANNOTATED TRANSCRIPT');

  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;

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

  // Skip map JSON
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

// ─── Sample data ────────────────────────────────────────────────────────────
// Realistic NPR "The Indicator" transcript HTML (shortened but representative)

const SAMPLE_EPISODE = {
  title: 'Why Egg Prices Are So High',
  pubDate: 'Tue, 11 Feb 2025 18:38:00 -0500',
  duration: '8:22',
  durationSec: 502,
  transcriptUrl: '(embedded sample)',
  audioUrl: 'https://play.podtrac.com/npr-510325/example.mp3',
};

const SAMPLE_TRANSCRIPT_HTML = `
<div class="transcript">
  <p><b>DARIAN WOODS, HOST:</b> This is THE INDICATOR FROM PLANET MONEY. I'm Darian Woods.</p>
  <p><b>WAILIN WONG, HOST:</b> And I'm Wailin Wong. If you've been to the grocery store lately, you may have noticed something painful in the egg aisle.</p>
  <p><b>DARIAN WOODS:</b> Eggs have gotten really expensive. Like, we're talking six, seven dollars for a dozen eggs at some stores. And it's not just a minor uptick - prices have roughly doubled compared to a year ago.</p>
  <p><b>WAILIN WONG:</b> Today on the show, we crack open the economics of the egg market. Why are prices so high, who benefits, and when might we see some relief?</p>

  <p><b>DARIAN WOODS:</b> Support for this podcast and the following message come from Google Cloud. Whatever satisfies your curiosity, from food to fashion to flowers, Google Cloud helps the companies behind those answers build, transform, and grow. Explore solutions at cloud.google.com.</p>

  <p><b>WAILIN WONG:</b> This message comes from NPR sponsor Capital One. With the Capital One Venture Card, you earn unlimited double miles on every purchase, every day. What's in your wallet? Terms apply. See capitalone.com for details.</p>

  <p><b>DARIAN WOODS:</b> OK, so let's talk about eggs. The main culprit behind the high prices is avian influenza, also known as bird flu.</p>
  <p><b>WAILIN WONG:</b> Bird flu has been devastating poultry flocks across the country. The USDA reports that more than 100 million birds have been affected since the outbreak began in early 2022.</p>
  <p><b>DARIAN WOODS:</b> And when you lose that many egg-laying hens, the supply drops dramatically. Basic economics tells us that when supply goes down and demand stays the same, prices go up.</p>
  <p><b>WAILIN WONG:</b> But it's not just about the birds that have been lost. There's also a rebuilding period. It takes about five months for a chick to grow into an egg-laying hen. So even after the outbreaks are contained, it takes time for supply to recover.</p>
  <p><b>DARIAN WOODS:</b> Professor Maro Ibarburu at the Egg Industry Center at Iowa State University says the industry is rebuilding, but slowly.</p>
  <p><b>MARO IBARBURU:</b> We see that the flock is recovering, but we still have fewer hens than we had before the outbreak. And the demand has not decreased.</p>
  <p><b>WAILIN WONG:</b> And there's another factor at play here - the cost of production has gone up too. Feed prices, energy costs, transportation - all of those have increased.</p>
  <p><b>DARIAN WOODS:</b> Some consumer advocates have also pointed to potential price gouging by major egg producers. The largest egg company in the US, Cal-Maine Foods, reported record profits even as consumers struggled with high prices.</p>
  <p><b>WAILIN WONG:</b> Cal-Maine has pushed back on those accusations, saying their prices reflect market conditions and increased costs. But several state attorneys general have launched investigations into egg pricing.</p>
  <p><b>DARIAN WOODS:</b> So when might we see some relief? Professor Ibarburu says it depends on bird flu.</p>
  <p><b>MARO IBARBURU:</b> If we don't have new major outbreaks, we could see prices start to come down in the second half of this year. But it's really hard to predict because the virus is unpredictable.</p>

  <p><b>DARIAN WOODS:</b> Support for NPR and the following message come from the Annie E. Casey Foundation, developing solutions to strengthen families and communities. More information is available at aecf.org.</p>

  <p><b>WAILIN WONG:</b> In the meantime, some consumers are finding creative solutions. Backyard chicken coops have seen a surge in popularity. Some stores are putting purchase limits on eggs.</p>
  <p><b>DARIAN WOODS:</b> And interestingly, egg substitutes and plant-based alternatives have seen a bump in sales too. Companies like JUST Egg have reported increased demand.</p>
  <p><b>WAILIN WONG:</b> So the egg crisis is a story about supply shocks, market power, and how one little virus can scramble the entire economy.</p>
  <p><b>DARIAN WOODS:</b> Pun intended.</p>
  <p><b>WAILIN WONG:</b> Always. This episode was produced by Corey Bridges with engineering by Robert Rodriguez. It was fact-checked by Sierra Juarez. Kate Concannon edits the show. THE INDICATOR is a production of NPR.</p>
</div>
`;

// Simulated LLM response — what the model would return for this transcript.
// These are the OBVIOUS ad/sponsor blocks a human would immediately spot.
const SIMULATED_AD_BLOCKS = [
  {
    startLine: 5,
    endLine: 5,
    reason: 'Sponsor read for Google Cloud',
  },
  {
    startLine: 6,
    endLine: 6,
    reason: 'Sponsor read for Capital One',
  },
  {
    startLine: 19,
    endLine: 19,
    reason: 'NPR funding credit — Annie E. Casey Foundation',
  },
];

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  banner('NPR Ad Detection Sandbox — OFFLINE TEST');

  console.log(`${C.bold}Configuration:${C.reset}`);
  console.log(`  Mode:          ${C.green}OFFLINE TEST${C.reset} (embedded sample data, no network/API needed)`);
  console.log(`  OpenAI Model:  (simulated — no real LLM call)`);
  console.log(`  Podcast:       The Indicator from Planet Money`);
  console.log(`  Episode:       ${SAMPLE_EPISODE.title}`);
  console.log('');
  console.log(`${C.bold}Approach:${C.reset} Read full transcript → LLM finds ad blocks by LINE NUMBER → map to timestamps`);

  // Step 0: Episode metadata (embedded)
  section('Episode Metadata (embedded sample)');
  console.log(`${C.green}Podcast:${C.reset}    The Indicator from Planet Money`);
  console.log(`${C.green}Episode:${C.reset}    ${SAMPLE_EPISODE.title}`);
  console.log(`${C.green}Published:${C.reset}  ${SAMPLE_EPISODE.pubDate}`);
  console.log(`${C.green}Duration:${C.reset}   ${SAMPLE_EPISODE.duration} (${SAMPLE_EPISODE.durationSec}s)`);
  console.log(`${C.green}Transcript:${C.reset} ${SAMPLE_EPISODE.transcriptUrl}`);

  // Step 1: Parse the embedded HTML
  section('Step 1: Parse transcript HTML → numbered lines');
  const lines = parseTranscriptHtml(SAMPLE_TRANSCRIPT_HTML);
  const totalWords = lines.length > 0 ? lines[lines.length - 1].cumulativeWords : 0;
  console.log(`${C.green}HTML size:${C.reset}  ${SAMPLE_TRANSCRIPT_HTML.length} chars`);
  console.log(`${C.green}Parsed:${C.reset}     ${lines.length} lines, ${totalWords} words`);

  // Step 2: Print the FULL numbered transcript
  printFullTranscript(lines);

  // Step 3: Show the LLM prompts (exactly what sandbox.ts would send)
  section('Step 3: LLM — Detect ad blocks in transcript');
  const numberedText = buildNumberedTranscriptText(lines);
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

  promptBox('System', systemPrompt);
  console.log('');

  const transcriptPreview = numberedText.split('\n').slice(0, 8).join('\n') + `\n... (${lines.length} lines total)`;
  promptBox('User (preview)', `Here is the full transcript of "${SAMPLE_EPISODE.title}" with numbered lines.\nFind all ad blocks — contiguous ranges of lines that are ads/sponsors/funding credits.\n\nTRANSCRIPT:\n${transcriptPreview}\n\nReturn JSON:\n{\n  "adBlocks": [\n    { "startLine": number, "endLine": number, "reason": "short explanation" }\n  ]\n}`);

  // Step 3b: Simulated LLM response
  console.log(`\n${C.blue}[SIMULATED] LLM response (no real API call):${C.reset}`);
  const simulatedResponse = JSON.stringify({ adBlocks: SIMULATED_AD_BLOCKS }, null, 2);
  rawBox('SIMULATED LLM RESPONSE', simulatedResponse);

  // Build AdBlock objects from simulated response
  let adBlocks: AdBlock[] = SIMULATED_AD_BLOCKS.map(b => ({
    startLine: b.startLine,
    endLine: b.endLine,
    reason: b.reason,
    textPreview: lines
      .filter(l => l.lineNum >= b.startLine && l.lineNum <= b.endLine)
      .map(l => l.text)
      .join(' ')
      .slice(0, 200),
    startWord: 0,
    endWord: 0,
    startTimeSec: 0,
    endTimeSec: 0,
  }));

  // Step 4: Map line ranges → timestamps
  section('Step 4: Map ad-block line ranges → audio timestamps');
  adBlocks = mapBlocksToTimestamps(adBlocks, lines, SAMPLE_EPISODE.durationSec);
  for (const b of adBlocks) {
    console.log(`  Lines ${b.startLine}-${b.endLine} → words ${b.startWord}-${b.endWord} → ${fmt(b.startTimeSec)} - ${fmt(b.endTimeSec)}`);
  }

  // Annotated transcript
  printAnnotatedTranscript(lines, adBlocks, SAMPLE_EPISODE.durationSec);

  // Results + skip map
  printResults(adBlocks, lines, SAMPLE_EPISODE.durationSec);

  // Full debug JSON
  section('Full Debug JSON');
  const dump = {
    episode: {
      title: SAMPLE_EPISODE.title,
      pubDate: SAMPLE_EPISODE.pubDate,
      duration: SAMPLE_EPISODE.duration,
      durationSec: SAMPLE_EPISODE.durationSec,
      transcriptUrl: SAMPLE_EPISODE.transcriptUrl,
    },
    transcript: {
      lineCount: lines.length,
      totalWords,
      lines: lines.map(l => ({
        line: l.lineNum, speaker: l.speaker,
        words: l.wordCount, cumWords: l.cumulativeWords,
        text: l.text.slice(0, 120),
      })),
    },
    adBlocks: adBlocks.map(b => ({
      lines: `${b.startLine}-${b.endLine}`,
      words: `${b.startWord}-${b.endWord}`,
      time: `${fmt(b.startTimeSec)}-${fmt(b.endTimeSec)}`,
      timeSec: { start: Math.round(b.startTimeSec), end: Math.round(b.endTimeSec) },
      reason: b.reason,
      textPreview: b.textPreview,
    })),
    skipMap: adBlocks.map(b => ({
      startTime: Math.round(b.startTimeSec),
      endTime: Math.round(b.endTimeSec),
      type: 'mid-roll',
      confidence: 0.9,
      reason: b.reason,
    })),
  };
  console.log(JSON.stringify(dump, null, 2));

  banner('SANDBOX TEST COMPLETE');
}

main();
