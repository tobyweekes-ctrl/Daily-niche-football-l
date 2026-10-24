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

// Variety rules: at most MAX_PER_GROUP prompts per category, and per answer
// type for anything but people (so no three club prompts in a day), and no
// two prompts from the same group back to back.
export const MAX_PER_GROUP = 2;

function groupsOf(meta) {
  const g = [`c:${meta.category || ''}`];
  if (meta.answerType && meta.answerType !== 'person') g.push(`t:${meta.answerType}`);
  return g;
}

function pickDay(ids, metaById, lastUsed, day) {
  const rank = new Map(ids.map((id) => [id, hash32(`${day}|${id}`)]));
  const byRank = (a, b) => rank.get(a) - rank.get(b) || (a < b ? -1 : 1);
  const isFresh = (id) => !lastUsed.has(id) || day - lastUsed.get(id) > REPEAT_GAP;
  // Preference order: prompts outside the 30-day window by today's rank, then
  // (only when the bank is too small) the least recently used.
  const fresh = ids.filter(isFresh).sort(byRank);
  const stale = ids.filter((id) => !isFresh(id)).sort((a, b) => lastUsed.get(a) - lastUsed.get(b) || byRank(a, b));
  const candidates = [...fresh, ...stale];

  const chosen = [];
  const counts = new Map();
  const fits = (id) => groupsOf(metaById.get(id)).every((g) => (counts.get(g) || 0) < MAX_PER_GROUP);
  for (const id of candidates) {
    if (chosen.length === PER_DAY) break;
    if (!fits(id)) continue;
    chosen.push(id);
    for (const g of groupsOf(metaById.get(id))) counts.set(g, (counts.get(g) || 0) + 1);
  }
  // Bank too narrow to satisfy the caps: fill in preference order regardless.
  for (const id of candidates) {
    if (chosen.length === PER_DAY) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  return spreadOut(seededShuffle(chosen.sort(byRank), hash32(`order|${day}`)), metaById);
}

/**
 * Reorder so neighbouring prompts don't share a category or (non-person) answer
 * type. Depth-first in the seeded order, so the result stays deterministic; if
 * no clean order exists, the seeded order is kept.
 */
function spreadOut(order, metaById) {
  const groups = new Map(order.map((id) => [id, groupsOf(metaById.get(id))]));
  const clash = (a, b) => groups.get(b).some((g) => groups.get(a).includes(g));
  const out = [];
  const used = new Set();
  const place = () => {
    if (out.length === order.length) return true;
    for (const id of order) {
      if (used.has(id) || (out.length && clash(out[out.length - 1], id))) continue;
      out.push(id); used.add(id);
      if (place()) return true;
      out.pop(); used.delete(id);
    }
    return false;
  };
  return place() ? out : [...order];
}

const cache = new Map();

/**
 * Prompt ids for a date. Replays every day since EPOCH so the 30-day rule
 * holds; ids are ranked by hash(day|id), so the order of questions.json
 * doesn't matter. Dates before EPOCH get a plain seeded pick.
 */
export function promptsForDate(prompts, key) {
  const metaById = new Map();
  for (const p of prompts) if (!metaById.has(p.id)) metaById.set(p.id, { category: p.category, answerType: p.answerType });
  const ids = [...metaById.keys()].sort();
  const target = dayIndex(key);
  const start = dayIndex(EPOCH);
  if (ids.length <= PER_DAY) return spreadOut(seededShuffle(ids, hash32(`order|${target}`)), metaById);
  if (target < start) return pickDay(ids, metaById, new Map(), target);

  const cacheKey = ids.map((id) => `${id}:${groupsOf(metaById.get(id)).join('/')}`).join(',');
  let entry = cache.get(cacheKey);
  if (!entry) { entry = { day: start - 1, lastUsed: new Map(), picks: new Map() }; cache.set(cacheKey, entry); }
  for (let day = entry.day + 1; day <= target; day++) {
    const pick = pickDay(ids, metaById, entry.lastUsed, day);
    for (const id of pick) entry.lastUsed.set(id, day);
    entry.picks.set(day, pick);
    entry.day = day;
  }
  return entry.picks.get(target);
}
