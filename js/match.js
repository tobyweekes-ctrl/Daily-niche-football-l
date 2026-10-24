// Answer matching: normalisation, aliases, surname-only, typo tolerance.
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

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalize(str) {
  let s = String(str ?? '').toLowerCase();
  s = s.replace(/[øæœßłđðþıħŀ]/g, (c) => SPECIAL[c]);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/['’‘`´.]/g, '');           // N'Golo -> ngolo, St. Mary's -> st marys
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = s.split(' ').filter((t) => t && !NOISE.has(t));
  return tokens.join(' ');
}

/** Normalised with spaces removed: "Alexander-Arnold" == "Alexander Arnold" == "AlexanderArnold". */
export function compact(str) {
  return normalize(str).replace(/ /g, '');
}

/** Classic Levenshtein, bailing out early once the distance exceeds `max`. */
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Surname keys for a person's name: last word, plus "van persie"-style compounds. */
export function surnameKeys(name) {
  // Split on spaces only, so "Alexander-Arnold" stays one surname.
  const words = String(name).trim().split(/\s+/).map(compact).filter(Boolean);
  if (words.length < 2) return [];
  const keys = new Set([words[words.length - 1]]);
  for (let i = 1; i < words.length - 1; i++) {
    if (PARTICLES.has(words[i])) { keys.add(words.slice(i).join('')); break; }
  }
  return [...keys];
}

export const FUZZY_MIN_LENGTH = 7; // "names over 6 characters"
export const FUZZY_MAX_DISTANCE = 2;

/**
 * Pre-compute lookup tables for one prompt.
 * Priority: canonical name > alias > surname. Only ties within a level are ambiguous.
 */
export function buildIndex(prompt) {
  const isPerson = prompt.answerType === 'person';
  const levels = { name: new Map(), alias: new Map(), surname: new Map() };
  const add = (level, key, idx) => {
    if (!key) return;
    if (!levels[level].has(key)) levels[level].set(key, new Set());
    levels[level].get(key).add(idx);
  };
  prompt.answers.forEach((answer, idx) => {
    add('name', compact(answer.name), idx);
    for (const alias of answer.aliases ?? []) add('alias', compact(alias), idx);
    // "surname": "Park" overrides the automatic last-word guess; false disables it.
    if (isPerson && answer.surname !== false) {
      const keys = typeof answer.surname === 'string' ? [compact(answer.surname)] : surnameKeys(answer.name);
      for (const key of keys) add('surname', key, idx);
    }
  });
  // Fuzzy candidates: every key long enough to be typo-tolerant.
  const fuzzy = [];
  for (const level of Object.values(levels)) {
    for (const [key, set] of level) {
      if (key.length >= FUZZY_MIN_LENGTH) fuzzy.push([key, set]);
    }
  }
  return { prompt, levels, fuzzy };
}

/**
 * Match free text against a prompt's answer bank.
 * `used` is a Set of answer indexes already given (Infinite mode duplicate blocking).
 * Returns one of:
 *   { status: 'empty' }
 *   { status: 'match', answer, index, via }
 *   { status: 'ambiguous', candidates: [answer…] }   // don't consume the answer
 *   { status: 'duplicate', answer, index }           // don't consume the answer
 *   { status: 'miss' }
 */
export function matchAnswer(index, input, used = new Set()) {
  const key = compact(input);
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

  if (key.length >= FUZZY_MIN_LENGTH) {
    let best = FUZZY_MAX_DISTANCE + 1;
    let ids = new Set();
    for (const [candidate, set] of index.fuzzy) {
      const d = levenshtein(key, candidate, FUZZY_MAX_DISTANCE);
      if (d < best) { best = d; ids = new Set(set); }
      else if (d === best) for (const i of set) ids.add(i);
    }
    if (best <= FUZZY_MAX_DISTANCE) return resolve(ids, 'fuzzy');
  }
  return { status: 'miss' };
}
