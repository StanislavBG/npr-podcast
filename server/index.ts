import express from 'express';
import cors from 'cors';
import { XMLParser } from 'fast-xml-parser';

const app = express();
app.use(cors());
app.use(express.json());

const PODCASTS: Record<string, { name: string; feedUrl: string }> = {
  '510325': {
    name: 'The Indicator from Planet Money',
    feedUrl: 'https://feeds.npr.org/510325/podcast.xml',
  },
  '510289': {
    name: 'Planet Money',
    feedUrl: 'https://feeds.npr.org/510289/podcast.xml',
  },
  '510318': {
    name: 'Short Wave',
    feedUrl: 'https://feeds.npr.org/510318/podcast.xml',
  },
  '510308': {
    name: 'Hidden Brain',
    feedUrl: 'https://feeds.npr.org/510308/podcast.xml',
  },
  '344098539': {
    name: 'Up First',
    feedUrl: 'https://feeds.npr.org/344098539/podcast.xml',
  },
};

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

// --- Sample fallback episodes (used when RSS fetch fails) ---
function getSampleEpisodes(podcastId: string): Episode[] {
  const samples: Record<string, Episode[]> = {
    '510325': [
      { id: 'sample-1', title: 'Why Egg Prices Are So High', description: 'Bird flu has devastated chicken flocks, driving egg prices to record highs.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '9:32', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-2', title: 'The Rise of Buy Now, Pay Later', description: 'How installment payments are changing the way consumers shop.', pubDate: 'Fri, 07 Feb 2025 20:00:00 GMT', duration: '10:15', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-3', title: 'What Tariffs Actually Do', description: 'A look at how tariffs affect prices, businesses, and trade.', pubDate: 'Thu, 06 Feb 2025 20:00:00 GMT', duration: '8:47', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-4', title: 'The Housing Affordability Crisis', description: 'Why it keeps getting harder to afford a home in America.', pubDate: 'Wed, 05 Feb 2025 20:00:00 GMT', duration: '10:03', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-5', title: 'AI and the Job Market', description: 'How artificial intelligence is reshaping work across industries.', pubDate: 'Tue, 04 Feb 2025 20:00:00 GMT', duration: '9:55', audioUrl: '', link: '', transcriptUrl: null },
    ],
    '510289': [
      { id: 'sample-6', title: 'The Invention of Money', description: 'The story of how money was invented — twice.', pubDate: 'Fri, 07 Feb 2025 20:00:00 GMT', duration: '22:14', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-7', title: 'The Great Inflation', description: 'How Paul Volcker broke the back of inflation in the early 1980s.', pubDate: 'Wed, 05 Feb 2025 20:00:00 GMT', duration: '24:30', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-8', title: 'The Dollar at the Center of the World', description: 'How the US dollar became the global reserve currency.', pubDate: 'Mon, 03 Feb 2025 20:00:00 GMT', duration: '26:10', audioUrl: '', link: '', transcriptUrl: null },
    ],
    '510318': [
      { id: 'sample-9', title: 'Why Do We Dream?', description: 'Scientists are getting closer to understanding why we dream.', pubDate: 'Thu, 06 Feb 2025 20:00:00 GMT', duration: '11:25', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-10', title: 'The Search for Dark Matter', description: 'A look at the elusive substance that makes up most of the universe.', pubDate: 'Tue, 04 Feb 2025 20:00:00 GMT', duration: '12:08', audioUrl: '', link: '', transcriptUrl: null },
    ],
    '510308': [
      { id: 'sample-11', title: 'The Power of Habits', description: 'How habits shape our lives and how to change them.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '50:15', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-12', title: 'Why We Conform', description: 'The hidden forces that push us to go along with the crowd.', pubDate: 'Mon, 03 Feb 2025 20:00:00 GMT', duration: '48:30', audioUrl: '', link: '', transcriptUrl: null },
    ],
    '344098539': [
      { id: 'sample-13', title: 'Up First for February 10, 2025', description: 'The biggest stories of the day.', pubDate: 'Mon, 10 Feb 2025 10:00:00 GMT', duration: '12:45', audioUrl: '', link: '', transcriptUrl: null },
      { id: 'sample-14', title: 'Up First for February 7, 2025', description: 'The top news stories to start your day.', pubDate: 'Fri, 07 Feb 2025 10:00:00 GMT', duration: '11:30', audioUrl: '', link: '', transcriptUrl: null },
    ],
  };
  return samples[podcastId] || [
    { id: 'sample-default', title: 'Sample Episode', description: 'A sample episode for demonstration.', pubDate: 'Mon, 10 Feb 2025 20:00:00 GMT', duration: '10:00', audioUrl: '', link: '', transcriptUrl: null },
  ];
}

// --- RSS Feed Proxy ---
app.get('/api/podcasts', (_req, res) => {
  const list = Object.entries(PODCASTS).map(([id, p]) => ({ id, name: p.name }));
  res.json(list);
});

app.get('/api/podcast/:id/episodes', async (req, res) => {
  const podcast = PODCASTS[req.params.id];
  if (!podcast) {
    res.status(404).json({ error: 'Podcast not found' });
    return;
  }

  try {
    const response = await fetch(podcast.feedUrl, {
      headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
    });
    if (!response.ok) throw new Error(`RSS fetch failed: ${response.status}`);

    const xml = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    const feed = parser.parse(xml);
    const items = feed?.rss?.channel?.item || [];
    const itemList = Array.isArray(items) ? items : [items];

    const episodes: Episode[] = itemList.slice(0, 50).map((item: any, i: number) => {
      const enclosure = item.enclosure || {};
      const audioUrl = enclosure['@_url'] || '';
      // Extract episode ID from link for transcript URL
      const link = item.link || '';
      const idMatch = link.match(/\/(\d{4}\/\d{2}\/\d{2}\/[\w-]+|nx-[\w-]+)/);
      const storyId = idMatch ? idMatch[1] : null;
      // NPR transcript pages follow pattern: /transcripts/{story-id}
      const transcriptUrl = storyId
        ? `https://www.npr.org/transcripts/${storyId}`
        : null;

      return {
        id: `ep-${i}-${Date.now()}`,
        title: item.title || 'Untitled',
        description: (item.description || item['itunes:summary'] || '').replace(
          /<[^>]*>/g,
          ''
        ),
        pubDate: item.pubDate || '',
        duration: item['itunes:duration'] || '',
        audioUrl,
        link,
        transcriptUrl,
      };
    });

    res.json({
      podcastName: podcast.name,
      episodes,
    });
  } catch (err: any) {
    console.error('RSS fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch RSS feed', detail: err.message });
  }
});

// --- Transcript Proxy ---
app.get('/api/transcript', async (req, res) => {
  const url = req.query.url as string;
  if (!url || !url.includes('npr.org')) {
    res.status(400).json({ error: 'Invalid transcript URL' });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
    if (!response.ok) throw new Error(`Transcript fetch failed: ${response.status}`);

    const html = await response.text();
    const transcript = parseTranscript(html);
    res.json(transcript);
  } catch (err: any) {
    console.error('Transcript fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch transcript', detail: err.message });
  }
});

// --- Audio Proxy (to bypass CORS and tracking redirects) ---
app.get('/api/audio', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'Missing audio URL' });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NPR-Podcast-Player/1.0' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);

    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');

    const body = response.body;
    if (body) {
      const reader = body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err: any) {
    console.error('Audio proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch audio', detail: err.message });
  }
});

// --- Transcript Parser ---
function parseTranscript(html: string): {
  segments: Array<{ speaker: string; text: string }>;
  fullText: string;
  adMarkers: Array<{ type: string; pattern: string }>;
} {
  const segments: Array<{ speaker: string; text: string }> = [];
  const adMarkers: Array<{ type: string; pattern: string }> = [];

  // Extract transcript text from NPR transcript pages
  // NPR transcripts are in <p> tags within the transcript article body
  const paragraphs: string[] = [];

  // Try to extract from storytext or transcript divs
  const storyMatch = html.match(
    /class="storytext[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const transcriptMatch = html.match(
    /class="transcript[^"]*"[^>]*>([\s\S]*?)<\/article>/i
  );
  const bodyMatch = html.match(
    /<article[^>]*>([\s\S]*?)<\/article>/i
  );

  const content = storyMatch?.[1] || transcriptMatch?.[1] || bodyMatch?.[1] || '';

  // Extract paragraphs
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(content)) !== null) {
    const text = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (text) paragraphs.push(text);
  }

  // Parse speaker:text patterns
  for (const para of paragraphs) {
    // NPR transcripts often use "SPEAKER NAME: text" pattern
    const speakerMatch = para.match(/^([A-Z][A-Z\s.'-]+):(.*)/);
    if (speakerMatch) {
      segments.push({
        speaker: speakerMatch[1].trim(),
        text: speakerMatch[2].trim(),
      });
    } else {
      segments.push({ speaker: '', text: para });
    }
  }

  // Detect ad/sponsor patterns in transcript
  const adPatterns = [
    /\b(support|supported|sponsor|sponsored)\s+(by|for|comes?\s+from)\b/i,
    /\bnpr\.org\b/i,
    /\bthis is npr\b/i,
    /\bthis message comes from\b/i,
    /\bsupport for (this|the) (podcast|show|program)\b/i,
    /\bfunding for\b/i,
    /\bnpr\+?\s*(plus)?\b.*\bsponsor.?free\b/i,
  ];

  for (let i = 0; i < segments.length; i++) {
    for (const pattern of adPatterns) {
      if (pattern.test(segments[i].text)) {
        adMarkers.push({
          type: 'sponsor_mention',
          pattern: `segment_${i}`,
        });
        break;
      }
    }
  }

  return {
    segments,
    fullText: paragraphs.join('\n\n'),
    adMarkers,
  };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`NPR Podcast server running on http://localhost:${PORT}`);
});
