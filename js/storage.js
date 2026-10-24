// localStorage persistence. Every access is wrapped: private browsing or
// blocked storage falls back to an in-memory copy so the game still runs.

const KEY = 'deepcut.v1';

const DEFAULTS = () => ({
  seenHelp: false,
  stats: {
    played: 0,
    totalScore: 0,
    best: 0,
    streak: 0,
    maxStreak: 0,
    lastDay: null,       // dayIndex of the last completed daily
    history: {},         // { 'YYYY-MM-DD': score }
  },
  daily: null,           // in-progress or finished daily game for one date
  infinite: null,        // in-progress Infinite run
  infiniteBest: 0,
  infinitePlayed: 0,
  pending: [],          // unverified answers kept for review: { date, mode, promptId, input }
});

let memory = null;

export function load() {
  if (memory) return memory;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { stored = null; }
  const base = DEFAULTS();
  memory = stored && typeof stored === 'object'
    ? { ...base, ...stored, stats: { ...base.stats, ...(stored.stats || {}) } }
    : base;
  return memory;
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* storage unavailable */ }
}

export function update(fn) {
  fn(load());
  save();
}

/** Streak as it stands today: broken if the last completed daily is older than yesterday. */
export function currentStreak(stats, today) {
  if (stats.lastDay == null) return 0;
  return today - stats.lastDay <= 1 ? stats.streak : 0;
}

/** Record a finished daily game. `day` is a dayIndex. */
export function recordDaily(state, dateKeyStr, day, score) {
  const s = state.stats;
  if (s.history[dateKeyStr] != null) return; // already counted
  s.history[dateKeyStr] = score;
  s.played += 1;
  s.totalScore += score;
  s.best = Math.max(s.best, score);
  s.streak = s.lastDay === day - 1 ? s.streak + 1 : 1;
  s.maxStreak = Math.max(s.maxStreak, s.streak);
  s.lastDay = day;
}
