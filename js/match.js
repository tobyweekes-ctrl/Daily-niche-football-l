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

/** Typos allowed for a typed answer of this many letters. Short names must be exact. */
export function maxTypos(length) {
  if (length <= 4) return 0;
  if (length <= 6) return 1;
  if (length <= 11) return 2;
  return 3;
}

/**
 * Pre-compute lookup tables for one prompt.
 * Priority: canonical name > alias > surname. Only ties within a level are ambiguous.
 */
export function buildIndex(prompt) {
  const type = prompt.answerType;
  const isPerson = type === 'person';
  const levels = { name: new Map(), alias: new Map(), surname: new Map() };
  const keysByAnswer = prompt.answers.map(() => new Set());
  // Full spellings (filler words kept) for typo checks: "Liberty Stadim" vs "libertystadium".
  const fullByAnswer = prompt.answers.map((a) => new Set([a.name, ...(a.aliases ?? [])].map((s) => compact(s)).filter(Boolean)));
  const add = (level, key, idx) => {
    if (!key) return;
    if (!levels[level].has(key)) levels[level].set(key, new Set());
    levels[level].get(key).add(idx);
    keysByAnswer[idx].add(key);
  };
  prompt.answers.forEach((answer, idx) => {
    add('name', compact(answer.name, type), idx);
    for (const alias of answer.aliases ?? []) add('alias', compact(alias, type), idx);
    // "surname": "Park" overrides the automatic last-word guess; false disables it.
    if (isPerson && answer.surname !== false) {
      const keys = typeof answer.surname === 'string' ? [compact(answer.surname)] : surnameKeys(answer.name);
      for (const key of keys) add('surname', key, idx);
    }
  });
  return { prompt, type, levels, keysByAnswer, fullByAnswer };
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
 *   { status: 'miss' }
 */
export function matchAnswer(index, input, used = new Set()) {
  const key = compact(input, index.type);
  if (!key) return { status: 'empty' };
  const answers = index.prompt.answers;

  const resolve = (ids, via) => {
    const all = [...ids];
    const fresh = all.filter((i) => !used.has(i));
    if (fresh.length === 1) return { status: 'match', answer: answers[fresh[0]], index: fresh[0], via };
    if (fresh.length > 1) return { status: 'ambiguous', candidates: fresh.map((i) => answers[i]) };
    return { status: 'duplicate', answer: answers[all[0]], index: all[0] };
  };

  for (const level of ['name', 'alias', 'surname']) {
    const hit = index.levels[level].get(key);
    if (hit) return resolve(hit, level);
  }

  // Spelling: find each unused answer's closest key. Suggest only when one
  // answer is clearly closest, so we never guess between two players.
  const full = compact(input);
  const allowed = maxTypos(key.length);
  const allowedFull = maxTypos(full.length);
  if (!allowed && !allowedFull) return { status: 'miss' };
  const scored = [];
  index.keysByAnswer.forEach((keys, i) => {
    if (used.has(i)) return;
    let best = Infinity;
    for (const k of keys) best = Math.min(best, levenshtein(key, k, allowed + 1));
    for (const k of index.fullByAnswer[i]) best = Math.min(best, levenshtein(full, k, allowedFull + 1));
    if (best <= Math.max(allowed, allowedFull) + 1) scored.push([best, i]);
  });
  // Typo budget comes from the text as typed, filler words included.
  const budget = Math.max(allowed, allowedFull);
  scored.sort((a, b) => a[0] - b[0]);
  const [first, second] = scored;
  if (!first || first[0] > budget || !budget) return { status: 'miss' };
  // Clear = nobody else as close, and with 2+ typos nobody else within one more.
  const margin = second ? second[0] - first[0] : Infinity;
  if (margin >= (first[0] >= 2 ? 2 : 1)) return { status: 'suggest', answer: answers[first[1]], index: first[1] };
  // Close to more than one answer: ask for more rather than guess or mark wrong.
  const near = scored.filter(([d]) => d <= first[0] + 1).map(([, i]) => answers[i]);
  return { status: 'ambiguous', candidates: near };
}
