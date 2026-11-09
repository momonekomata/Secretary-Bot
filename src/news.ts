export interface NewsItem {
  title: string;
  source: string;
  link: string;
  published: string;
}

export interface NewsLocale {
  /** e.g. "en-US" or "th" */
  language: string;
  /** e.g. "US" or "TH" */
  country: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : '';
};

/** Parses a Google News RSS feed. */
export function parseRss(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const raw = m[1];
    const source = tag(raw, 'source');
    let title = tag(raw, 'title');
    // Google News appends " - Source" to titles.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    items.push({ title, source, link: tag(raw, 'link'), published: tag(raw, 'pubDate') });
    if (items.length >= limit) break;
  }
  return items;
}

export function newsUrl(topic: string | null, locale: NewsLocale): string {
  const lang = locale.language;
  const q = `hl=${encodeURIComponent(lang)}&gl=${encodeURIComponent(locale.country)}&ceid=${encodeURIComponent(`${locale.country}:${lang.split('-')[0]}`)}`;
  return topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(`${topic} when:2d`)}&${q}`
    : `https://news.google.com/rss?${q}`;
}

/** Latest headlines for a topic (or top stories when `topic` is null) from Google News. */
export async function fetchNews(topic: string | null, locale: NewsLocale, limit = 6): Promise<NewsItem[]> {
  const res = await fetch(newsUrl(topic, locale), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecretaryBot/1.0)' } });
  if (!res.ok) throw new Error(`Google News returned ${res.status}`);
  return parseRss(await res.text(), limit);
}

export function formatNews(topic: string, items: NewsItem[]): string {
  if (!items.length) return `${topic}: no recent headlines found.`;
  return `${topic}:\n${items.map((i) => `• ${i.title} (${i.source || 'unknown source'}, ${i.published})`).join('\n')}`;
}
