// The football pyramid you climb as you score, and an estimate of how a daily
// score compares with everyone else's. Pure functions, shared with tests.

/** Levels by daily score. `min` is the points needed to reach the level. */
export const LEVELS = [
  { name: 'Sunday League', min: 0 },
  { name: 'Non-League', min: 50 },
  { name: 'League Two', min: 100 },
  { name: 'League One', min: 150 },
  { name: 'Championship', min: 200 },
  { name: 'Premier League', min: 270 },
  { name: 'Champions League', min: 350 },
  { name: "Ballon d'Or", min: 450 },
];
const TOP = 700;

export function levelIndex(score) {
  let i = 0;
  while (i + 1 < LEVELS.length && score >= LEVELS[i + 1].min) i++;
  return i;
}

/** 0–1 position along the climb, each level taking an equal slice. */
export function climbPosition(score) {
  const i = levelIndex(score);
  const lo = LEVELS[i].min;
  const hi = i + 1 < LEVELS.length ? LEVELS[i + 1].min : TOP;
  const within = Math.min(1, Math.max(0, (score - lo) / (hi - lo)));
  return (i + within) / LEVELS.length;
}

/**
 * How players do on one prompt: the chance of each outcome by points, for three
 * kinds of player. We have no live results, so this is a model, and mixing
 * player types matters: a strong player finds rare answers on most prompts,
 * which a single "average player" would never show. Tune it here; once the
 * answer log has data these shares can be measured instead.
 */
const POINTS = [0, 10, 25, 40, 60, 85, 100]; // miss, Tap-in … Hidden Gem
export const PLAYER_TYPES = [
  { name: 'casual',  share: 0.40, odds: [0.45, 0.30, 0.14, 0.07, 0.03, 0.01, 0.00] },
  { name: 'regular', share: 0.40, odds: [0.25, 0.25, 0.22, 0.15, 0.08, 0.04, 0.01] },
  { name: 'expert',  share: 0.20, odds: [0.12, 0.12, 0.20, 0.22, 0.17, 0.12, 0.05] },
];

const STEP = 5; // every tier's points are a multiple of 5

/** Probability of each total over `prompts` prompts for one player type, indexed by score / 5. */
function convolve(odds, prompts) {
  let dist = [1];
  for (let n = 0; n < prompts; n++) {
    const next = new Array(dist.length + 100 / STEP).fill(0);
    dist.forEach((p, i) => {
      if (p) POINTS.forEach((points, k) => { next[i + points / STEP] += p * odds[k]; });
    });
    dist = next;
  }
  return dist;
}

/** Probability of each total score across all players, indexed by score / 5. */
export function scoreDistribution(prompts = 7, types = PLAYER_TYPES) {
  const out = new Array(prompts * 100 / STEP + 1).fill(0);
  for (const type of types) convolve(type.odds, prompts).forEach((p, i) => { out[i] += p * type.share; });
  return out;
}

let cached = null;
const distribution = () => (cached ??= scoreDistribution());

/** Share of players (0–1) estimated to score below you; ties count half. */
export function percentile(score) {
  const dist = distribution();
  const at = Math.round(score / STEP);
  let below = 0;
  for (let i = 0; i < Math.min(at, dist.length); i++) below += dist[i];
  return below + (dist[at] || 0) / 2;
}

/** Histogram of the model in `width`-point buckets: [{ from, to, share }]. */
export function scoreBuckets(width = 50) {
  const dist = distribution();
  const buckets = [];
  for (let from = 0; from < TOP; from += width) {
    let share = 0;
    for (let s = from; s < from + width && s <= TOP; s += STEP) share += dist[s / STEP] || 0;
    buckets.push({ from, to: Math.min(from + width - STEP, TOP), share });
  }
  // 700 itself sits in the last bucket.
  buckets[buckets.length - 1].share += dist[TOP / STEP] || 0;
  buckets[buckets.length - 1].to = TOP;
  return buckets;
}
