// Answer matching: normalisation, aliases, surname-only, spelling suggestions.
// Pure functions, no DOM — shared by the game and tests/test.mjs.

// Letters that Unicode NFD does not split into base letter + accent.
const SPECIAL = {
  'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ł': 'l', 'đ': 'd',
  'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŀ': 'l',
};

// Surname particles: "Robin van Persie" also answers to "van Persie".
const PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'da', 'di', 'do', 'dos', 'das', 'del',
  'della', 'le', 'la', 'el', 'al', 'ten', 'ter', 'mac', 'st',
]);

// Tokens dropped everywhere so "Arsenal FC" == "Arsenal", "The Valley" == "Valley".
const NOISE = new Set(['fc', 'the']);
// Extra filler per answer type: "Liberty" == "Liberty Stadium", "Brugge" == "Club Brugge".
const TYPE_NOISE = {
  stadium: new Set(['stadium', 'stadion', 'stadio', 'estadio', 'estadi']),
  club: new Set(['football', 'club']),
};

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalize(str, answerType) {
  let s = String(str ?? '').toLowerCase();
  s = s.replace(/[øæœßłđðþıħŀ]/g, (c) => SPECIAL[c]);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/['’‘`´.]/g, '');           // N'Golo -> ngolo, St. Mary's -> st marys
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  const extra = TYPE_NOISE[answerType];
  let tokens = s.split(' ').filter((t) => t && !NOISE.has(t));
  // Never strip a name down to nothing ("The Stadium" stays "stadium").
  if (extra && tokens.some((t) => !extra.has(t))) tokens = tokens.filter((t) => !extra.has(t));
  return tokens.join(' ');
}

/** Normalised with spaces removed: "Alexander-Arnold" == "Alexander Arnold" == "AlexanderArnold". */
export function compact(str, answerType) {
  return normalize(str, answerType).replace(/ /g, '');
}

/**
 * Edit distance where a swapped pair of neighbouring letters ("Gerrrad",
 * "Hnery") counts as one typo. Bails out once the distance exceeds `max`.
 */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Surname keys for a person's name: last word, plus "van persie"-style compounds. */
export function surnameKeys(name) {
  // Split on spaces only, so "Alexander-Arnold" stays one surname.
  const words = String(name).trim().split(/\s+/).map((w) => compact(w)).filter(Boolean);
  if (words.length < 2) return [];
  const keys = new Set([words[words.length - 1]]);
  for (let i = 1; i < words.length - 1; i++) {
    if (PARTICLES.has(words[i])) { keys.add(words.slice(i).join('')); break; }
  }
  return [...keys];
}

/** Typos allowed when comparing words of this many letters. Short names must be exact. */
export function maxTypos(length) {
  if (length <= 4) return 0;
  if (length <= 6) return 1;
  if (length <= 11) return 2;
  return 3;
}

/**
 * Every name and alias in the whole bank by kind (club, stadium, person, …), so
 * a prompt can tell "a real thing of the wrong kind" (a club typed for a stadium
 * prompt, "Wembley" for a player) from an answer it simply doesn't list yet.
 */
export function buildKnown(prompts, cities = []) {
  const known = new Map();
  // Cities are never answers, but naming one ("Düsseldorf") for a stadium is a
  // real thing of the wrong kind, not a stadium.
  for (const c of cities) {
    const k = compact(c);
    if (!known.has(k)) known.set(k, new Set());
    known.get(k).add('city');
  }
  for (const p of prompts) {
    for (const a of p.answers) {
      for (const s of [a.name, ...(a.aliases ?? [])]) {
        const k = compact(s);
        if (k.length < 4) continue; // acronyms like "SJP" are too collision-prone
        if (!known.has(k)) known.set(k, new Set());
        known.get(k).add(p.answerType);
      }
    }
  }
  return known;
}

/**
 * Pre-compute lookup tables for one prompt.
 * Priority: canonical name > alias > surname. Only ties within a level are ambiguous.
 */
export function buildIndex(prompt, known = new Map()) {
  const type = prompt.answerType;
  const isPerson = type === 'person';
  const levels = { name: new Map(), alias: new Map(), surname: new Map() };
  const keysByAnswer = prompt.answers.map(() => new Set());
  // Full spellings (filler words kept) for typo checks: "Liberty Stadim" vs "libertystadium".
  const fullByAnswer = prompt.answers.map((a) => new Set([a.name, ...(a.aliases ?? [])].map((s) => compact(s)).filter(Boolean)));
  const fullKeys = new Set(fullByAnswer.flatMap((s) => [...s]));
  const add = (level, key, idx) => {
    if (!key) return;
    if (!levels[level].has(key)) levels[level].set(key, new Set());
    levels[level].get(key).add(idx);
    keysByAnswer[idx].add(key);
  };
  // Filler words are optional, but not when dropping them leaves just a city:
  // "Cologne Stadium" must not answer to plain "Cologne".
  const keyOf = (s) => {
    const k = compact(s, type);
    return type === 'stadium' && known.get(k)?.has('city') ? compact(s) : k;
  };
  prompt.answers.forEach((answer, idx) => {
    add('name', keyOf(answer.name), idx);
    for (const alias of answer.aliases ?? []) add('alias', keyOf(alias), idx);
    // "surname": "Park" overrides the automatic last-word guess; false disables it.
    if (isPerson && answer.surname !== false) {
      const keys = typeof answer.surname === 'string' ? [compact(answer.surname)] : surnameKeys(answer.name);
      for (const key of keys) add('surname', key, idx);
    }
  });
  return { prompt, type, levels, keysByAnswer, fullByAnswer, fullKeys, known };
}

const KIND_LABEL = { club: 'a club', stadium: 'a stadium', country: 'a country', person: 'a person', city: 'a city', other: 'a brand' };

/** If the text names something of another kind (and isn't one of this prompt's own spellings), say what it is. */
function wrongKind(index, full) {
  if (index.fullKeys.has(full)) return null;
  const kinds = index.known.get(full);
  if (!kinds || kinds.has(index.type)) return null;
  const kind = ['club', 'stadium', 'country', 'person', 'city', 'other'].find((k) => kinds.has(k));
  return kind ? KIND_LABEL[kind] : null;
}

/**
 * Match free text against a prompt's answer bank.
 * `used` is a Set of answer indexes already given (Infinite mode duplicate blocking).
 * Returns one of:
 *   { status: 'empty' }
 *   { status: 'match', answer, index, via }
 *   { status: 'suggest', answer, index }             // clear misspelling: ask "did you mean…?"
 *   { status: 'ambiguous', candidates: [answer…] }   // don't consume the answer
 *   { status: 'duplicate', answer, index }           // don't consume the answer
 *   { status: 'miss', wrongKind? }                   // wrongKind: e.g. "a club" typed for a stadium
 */
export function matchAnswer(index, input, used = new Set()) {
  const key = compact(input, index.type);
  if (!key) return { status: 'empty' };
  const full = compact(input);
  const answers = index.prompt.answers;

  const resolve = (ids, via) => {
    const all = [...ids];
    const fresh = all.filter((i) => !used.has(i));
    if (fresh.length === 1) return { status: 'match', answer: answers[fresh[0]], index: fresh[0], via };
    if (fresh.length > 1) return { status: 'ambiguous', candidates: fresh.map((i) => answers[i]) };
    return { status: 'duplicate', answer: answers[all[0]], index: all[0] };
  };

  // Filler words are optional on stadium/club prompts, but a club's name must not
  // turn into its stadium: "Arsenal" isn't "Arsenal Stadium".
  if (index.type !== 'person') {
    const kind = wrongKind(index, full);
    if (kind) return { status: 'miss', wrongKind: kind };
  }

  for (const level of ['name', 'alias', 'surname']) {
    // The full spelling too, for names whose filler words are kept ("Estadio Monterrey").
    const hit = index.levels[level].get(key) || index.levels[level].get(full);
    if (hit) return resolve(hit, level);
  }

  const kind = wrongKind(index, full);
  if (kind) return { status: 'miss', wrongKind: kind };

  // Spelling: each comparison may have as many typos as the SHORTER of the two
  // words allows, so a short alias ("Arena") can't swallow a long wrong answer
  // ("Arsenal"). Suggest only when one answer is clearly closest.
  const fits = [];
  const near = new Map();
  index.keysByAnswer.forEach((keys, i) => {
    if (used.has(i)) return;
    let fit = Infinity;
    let close = Infinity;
    const check = (typed, k) => {
      const budget = maxTypos(Math.min(typed.length, k.length));
      const d = levenshtein(typed, k, budget + 1);
      if (d <= budget) fit = Math.min(fit, d);
      if (d <= budget + 1) close = Math.min(close, d);
    };
    for (const k of keys) check(key, k);
    for (const k of index.fullByAnswer[i]) check(full, k);
    if (fit < Infinity) fits.push([fit, i]);
    if (close < Infinity) near.set(i, close);
  });
  if (!fits.length) return { status: 'miss' };
  fits.sort((a, b) => a[0] - b[0]);
  const [d1, best] = fits[0];
  // Clear = nobody else as close, and with 2+ typos nobody else within one more.
  const rivals = [...near].filter(([i, d]) => i !== best && d <= d1 + (d1 >= 2 ? 1 : 0)).map(([i]) => i);
  if (!rivals.length) return { status: 'suggest', answer: answers[best], index: best };
  // Close to more than one answer: ask for more rather than guess or mark wrong.
  return { status: 'ambiguous', candidates: [best, ...rivals].map((i) => answers[i]) };
}
