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
  /** Primary meaning first. */
  meanings: string[];
  /** Every meaning WaniKani accepts (including its extra "whitelist" meanings). */
  acceptedMeanings: string[];
  /** Answers WaniKani explicitly marks wrong (e.g. a near-miss for a different item). */
  blacklist: string[];
  /** e.g. type "onyomi"/"kunyomi" for kanji; accepted = counts as right in reviews. */
  readings: { reading: string; type?: string; primary: boolean; accepted?: boolean }[];
  meaningMnemonic?: string;
  readingMnemonic?: string;
  partsOfSpeech?: string[];
  sentences?: { ja: string; en: string }[];
  level: number;
}

interface RawSubject {
  id: number;
  object: WkSubject['object'];
  data: {
    characters: string | null;
    level: number;
    meanings: { meaning: string; primary: boolean; accepted_answer?: boolean }[];
    auxiliary_meanings?: { meaning: string; type: 'whitelist' | 'blacklist' }[];
    readings?: { reading: string; type?: string; primary: boolean; accepted_answer?: boolean }[];
    meaning_mnemonic?: string;
    reading_mnemonic?: string;
    parts_of_speech?: string[];
    context_sentences?: { ja: string; en: string }[];
    hidden_at: string | null;
  };
}

// WaniKani marks up mnemonics with tags like <radical>…</radical>.
const clean = (s?: string) => s?.replace(/<\/?[a-z]+>/g, '');

export function toSubject(s: RawSubject): WkSubject {
  const aux = s.data.auxiliary_meanings ?? [];
  return {
    id: s.id,
    object: s.object,
    characters: s.data.characters ?? '',
    level: s.data.level,
    meanings: [...s.data.meanings].sort((a, b) => Number(b.primary) - Number(a.primary)).map((m) => m.meaning),
    acceptedMeanings: [
      ...s.data.meanings.filter((m) => m.accepted_answer !== false).map((m) => m.meaning),
      ...aux.filter((m) => m.type === 'whitelist').map((m) => m.meaning),
    ],
    blacklist: aux.filter((m) => m.type === 'blacklist').map((m) => m.meaning),
    readings: (s.data.readings ?? []).map((r) => ({ reading: r.reading, type: r.type, primary: r.primary, accepted: r.accepted_answer !== false })),
    meaningMnemonic: clean(s.data.meaning_mnemonic),
    readingMnemonic: clean(s.data.reading_mnemonic),
    partsOfSpeech: s.data.parts_of_speech,
    sentences: s.data.context_sentences,
  };
}

/** Kanji or vocabulary from WaniKani for the given levels. */
export async function fetchSubjects(token: string, type: 'kanji' | 'vocabulary', levels: number[]): Promise<WkSubject[]> {
  const raw = await getAll<RawSubject>(`${API}/subjects?types=${type}&levels=${levels.join(',')}`, token);
  return raw.filter((s) => s.data.characters && !s.data.hidden_at).map(toSubject);
}

/** Subjects by id (in batches of 1000). */
export async function fetchSubjectsByIds(token: string, ids: number[]): Promise<WkSubject[]> {
  const out: WkSubject[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const raw = await getAll<RawSubject>(`${API}/subjects?ids=${ids.slice(i, i + 1000).join(',')}`, token);
    out.push(...raw.filter((s) => s.data.characters).map(toSubject));
  }
  return out;
}

export interface WkAssignment {
  id: number;
  subjectId: number;
  subjectType: WkSubject['object'];
  srsStage: number;
}

/** Assignments waiting for review right now. */
export async function dueAssignments(token: string): Promise<WkAssignment[]> {
  const raw = await getAll<{ id: number; data: { subject_id: number; subject_type: WkSubject['object']; srs_stage: number } }>(
    `${API}/assignments?immediately_available_for_review=true&hidden=false`,
    token,
  );
  return raw.map((a) => ({ id: a.id, subjectId: a.data.subject_id, subjectType: a.data.subject_type, srsStage: a.data.srs_stage }));
}

export const SRS_NAMES = ['Lesson', 'Apprentice 1', 'Apprentice 2', 'Apprentice 3', 'Apprentice 4', 'Guru 1', 'Guru 2', 'Master', 'Enlightened', 'Burned'];

/**
 * Records a finished review on WaniKani (needs a token with the "reviews:create" permission).
 * Returns the item's new SRS stage.
 */
export async function submitReview(token: string, assignmentId: number, incorrectMeaning: number, incorrectReading: number): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch(`${API}/reviews`, {
      method: 'POST',
      headers: { ...HEADERS(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ review: { assignment_id: assignmentId, incorrect_meaning_answers: incorrectMeaning, incorrect_reading_answers: incorrectReading } }),
    });
  } catch {
    throw new ApiError('Network error talking to WaniKani (offline?)');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError('WaniKani did not let me submit reviews. Make a token with the "reviews:create" permission (see SETUP-GUIDE.md).', res.status);
  }
  if (res.status === 422) throw new ApiError('WaniKani says this item is not available for review right now.', 422);
  if (!res.ok) throw new ApiError(`WaniKani error ${res.status}`, res.status);
  const json = (await res.json()) as { resources_updated?: { assignment?: { data?: { srs_stage?: number } } } };
  return json.resources_updated?.assignment?.data?.srs_stage ?? null;
}

/** The user's current WaniKani level. */
export async function wanikaniLevel(token: string): Promise<number> {
  const user = await get<{ data: { level: number } }>(`${API}/user`, token);
  return user.data.level;
}
