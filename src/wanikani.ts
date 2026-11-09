// WaniKani API v2 client (originally from the Japanese Journey app).
export interface WkSnapshot {
  fetchedAt: number;
  username: string;
  level: number;
  maxLevel: number;
  /** Count of assignments per SRS stage 0..9 (0 = lesson, 9 = burned). */
  stageCounts: number[];
  lessonsAvailable: number;
  reviewsAvailable: number;
  nextReviewsAt: string | null;
  /** Reviews scheduled per upcoming hour, from /summary (index 0 = next hour bucket). */
  upcoming: number[];
}

const API = 'https://api.wanikani.com/v2';
const HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Wanikani-Revision': '20170710',
});

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function get<T>(url: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS(token) });
  } catch {
    throw new ApiError('Network error talking to WaniKani (offline?)');
  }
  if (res.status === 401) throw new ApiError('WaniKani rejected the token (401). Check it in Settings.', 401);
  if (res.status === 429) throw new ApiError('WaniKani rate limit hit (429). Try again in a minute.', 429);
  if (!res.ok) throw new ApiError(`WaniKani error ${res.status}`, res.status);
  return res.json() as Promise<T>;
}

interface Collection<T> {
  data: T[];
  pages: { next_url: string | null };
}

async function getAll<T>(url: string, token: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url;
  while (next) {
    const page: Collection<T> = await get<Collection<T>>(next, token);
    out.push(...page.data);
    next = page.pages.next_url;
  }
  return out;
}

/** Pulls everything the game needs. ~4 requests, well inside WaniKani's 60/min limit. */
export async function fetchWaniKani(token: string): Promise<WkSnapshot> {
  const [user, summary, assignments] = await Promise.all([
    get<{ data: { username: string; level: number; subscription: { max_level_granted: number } } }>(`${API}/user`, token),
    get<{
      data: {
        lessons: { available_at: string; subject_ids: number[] }[];
        reviews: { available_at: string; subject_ids: number[] }[];
        next_reviews_at: string | null;
      };
    }>(`${API}/summary`, token),
    // Only the SRS stage is needed; started assignments only, hidden ones excluded.
    getAll<{ data: { srs_stage: number } }>(`${API}/assignments?hidden=false`, token),
  ]);

  const stageCounts = new Array(10).fill(0) as number[];
  for (const a of assignments) {
    const s = a.data.srs_stage;
    if (s >= 0 && s <= 9) stageCounts[s]++;
  }

  const now = Date.now();
  const [current, ...later] = summary.data.reviews;
  const reviewsAvailable = current && Date.parse(current.available_at) <= now ? current.subject_ids.length : 0;
  const lessonsAvailable = summary.data.lessons[0]?.subject_ids.length ?? 0;

  return {
    fetchedAt: now,
    username: user.data.username,
    level: user.data.level,
    maxLevel: 60,
    stageCounts,
    lessonsAvailable,
    reviewsAvailable,
    nextReviewsAt: summary.data.next_reviews_at,
    upcoming: later.slice(0, 24).map((b) => b.subject_ids.length),
  };
}

export interface WkSubject {
  id: number;
  object: 'kanji' | 'vocabulary' | 'radical' | 'kana_vocabulary';
  characters: string;
  meanings: string[];
  /** e.g. "onyomi: ご", "kunyomi: かた.る", or plain readings for vocabulary. */
  readings: { reading: string; type?: string; primary: boolean }[];
  meaningMnemonic?: string;
  readingMnemonic?: string;
  partsOfSpeech?: string[];
  sentences?: { ja: string; en: string }[];
  level: number;
}

/** Kanji or vocabulary from WaniKani for the given levels. */
export async function fetchSubjects(token: string, type: 'kanji' | 'vocabulary', levels: number[]): Promise<WkSubject[]> {
  const raw = await getAll<{
    id: number;
    object: WkSubject['object'];
    data: {
      characters: string | null;
      level: number;
      meanings: { meaning: string; primary: boolean }[];
      readings?: { reading: string; type?: string; primary: boolean }[];
      meaning_mnemonic?: string;
      reading_mnemonic?: string;
      parts_of_speech?: string[];
      context_sentences?: { ja: string; en: string }[];
      hidden_at: string | null;
    };
  }>(`${API}/subjects?types=${type}&levels=${levels.join(',')}`, token);
  // WaniKani marks up mnemonics with tags like <radical>…</radical>.
  const clean = (s?: string) => s?.replace(/<\/?[a-z]+>/g, '');
  return raw
    .filter((s) => s.data.characters && !s.data.hidden_at)
    .map((s) => ({
      id: s.id,
      object: s.object,
      characters: s.data.characters!,
      level: s.data.level,
      meanings: [...s.data.meanings].sort((a, b) => Number(b.primary) - Number(a.primary)).map((m) => m.meaning),
      readings: s.data.readings ?? [],
      meaningMnemonic: clean(s.data.meaning_mnemonic),
      readingMnemonic: clean(s.data.reading_mnemonic),
      partsOfSpeech: s.data.parts_of_speech,
      sentences: s.data.context_sentences,
    }));
}

/** The user's current WaniKani level. */
export async function wanikaniLevel(token: string): Promise<number> {
  const user = await get<{ data: { level: number } }>(`${API}/user`, token);
  return user.data.level;
}
