/** Romaji → hiragana (IME style), and katakana → hiragana, for grading reading answers. */

const TABLE: Record<string, string> = {
  // three letters
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', sha: 'しゃ', shu: 'しゅ', sho: 'しょ', she: 'しぇ', shi: 'し', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', che: 'ちぇ', chi: 'ち', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ', cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ',
  tsu: 'つ', nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ', hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ', mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ', zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ', pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ', dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
  xtu: 'っ', ltu: 'っ', xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ', dzu: 'づ',
  // two letters
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ', ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の', ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ', ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ', ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ', la: 'ら', li: 'り', lu: 'る', le: 'れ', lo: 'ろ', wa: 'わ', wo: 'を', we: 'うぇ', wi: 'うぃ',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご', za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ', da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ', pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ', ja: 'じゃ', ju: 'じゅ', je: 'じぇ', jo: 'じょ',
  fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ', nn: 'ん', "n'": 'ん',
  xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ',
  // one letter
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お', '-': 'ー',
};

const VOWELS = 'aeiouy';

export function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Converts romaji to hiragana; anything it can't convert is left as is. */
export function romajiToHiragana(input: string): string {
  const s = input.toLowerCase().replace(/\s+/g, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // Double consonant → small tsu (but "nn" is ん).
    if (c === s[i + 1] && /[bcdfghjkmpqrstvwxyz]/.test(c)) {
      out += 'っ';
      i++;
      continue;
    }
    let matched = false;
    for (const len of [3, 2, 1]) {
      const chunk = s.slice(i, i + len);
      // "nna" is ん + な, not "nn" + "a".
      if (TABLE[chunk] && !(chunk === 'nn' && i + 2 < s.length && VOWELS.includes(s[i + 2]))) {
        out += TABLE[chunk];
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // A lone n before a consonant or at the end is ん.
    if (c === 'n' && (i + 1 >= s.length || !VOWELS.includes(s[i + 1]))) {
      out += 'ん';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Normalises a reading answer to hiragana. */
export function toHiragana(answer: string): string {
  const trimmed = answer.trim();
  return katakanaToHiragana(/[a-z]/i.test(trimmed) ? romajiToHiragana(trimmed) : trimmed).replace(/\s+/g, '');
}

/** Every hiragana a typed reading could mean ("kinyoubi" is きにょうび or きんようび). */
export function readingCandidates(answer: string): string[] {
  const out = new Set([toHiragana(answer)]);
  if (/[a-z]/i.test(answer)) out.add(toHiragana(answer.replace(/n(?=y)/gi, "n'")));
  return [...out];
}

export const isKana = (s: string) => /^[぀-ヿー\s]+$/.test(s.trim());
