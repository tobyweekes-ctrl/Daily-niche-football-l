// Deterministic daily selection: every player gets the same 7 prompts for a
// given date with no server. Pure functions, shared with tests/test.mjs.

export const EPOCH = '2026-10-24';   // Deep Cut #1. Never change once live.
export const PER_DAY = 7;
export const REPEAT_GAP = 30;        // a prompt may not reappear within this many days

/** Local calendar date as YYYY-MM-DD (the puzzle flips at the player's midnight). */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days since 1970-01-01 for a YYYY-MM-DD key (timezone-free). */
export function dayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function puzzleNumber(key) {
  return dayIndex(key) - dayIndex(EPOCH) + 1;
}

/** 32-bit FNV-1a string hash. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seed) {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickDay(ids, lastUsed, day) {
  const rank = new Map(ids.map((id) => [id, hash32(`${day}|${id}`)]));
  const byRank = (a, b) => rank.get(a) - rank.get(b) || (a < b ? -1 : 1);
  const fresh = ids.filter((id) => !lastUsed.has(id) || day - lastUsed.get(id) > REPEAT_GAP);
  let chosen;
  if (fresh.length >= PER_DAY) {
    chosen = fresh.sort(byRank).slice(0, PER_DAY);
  } else {
    // Bank too small to honour the gap: top up with the least recently used.
    const freshSet = new Set(fresh);
    const stale = ids.filter((id) => !freshSet.has(id))
      .sort((a, b) => lastUsed.get(a) - lastUsed.get(b) || byRank(a, b));
    chosen = [...fresh, ...stale.slice(0, PER_DAY - fresh.length)];
  }
  return seededShuffle(chosen.sort(byRank), hash32(`order|${day}`));
}

const cache = new Map();

/**
 * Prompt ids for a date. Replays every day since EPOCH so the 30-day rule
 * holds; ids are ranked by hash(day|id), so the order of questions.json
 * doesn't matter. Dates before EPOCH get a plain seeded pick.
 */
export function promptsForDate(prompts, key) {
  const ids = [...new Set(prompts.map((p) => p.id))].sort();
  const target = dayIndex(key);
  const start = dayIndex(EPOCH);
  if (ids.length <= PER_DAY) return seededShuffle(ids, hash32(`order|${target}`));
  if (target < start) return pickDay(ids, new Map(), target);

  const cacheKey = ids.join(',');
  let entry = cache.get(cacheKey);
  if (!entry) { entry = { day: start - 1, lastUsed: new Map(), picks: new Map() }; cache.set(cacheKey, entry); }
  for (let day = entry.day + 1; day <= target; day++) {
    const pick = pickDay(ids, entry.lastUsed, day);
    for (const id of pick) entry.lastUsed.set(id, day);
    entry.picks.set(day, pick);
    entry.day = day;
  }
  return entry.picks.get(target);
}
