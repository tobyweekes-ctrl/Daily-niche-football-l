import { buildIndex, buildKnown, matchAnswer, compact } from './match.js';
import { dateKey, dayIndex, puzzleNumber, promptsForDate } from './daily.js';
import * as store from './storage.js';
import { ANSWER_LOG_URL, ALLOW_DAILY_REPLAY } from './config.js';
import { LEVELS, levelIndex, climbPosition, percentile, scoreBuckets } from './rank.js';
import { SHOTS, playShot } from './shot.js';

// ---------------------------------------------------------------- constants

export const TIERS = [
  { name: 'Tap-in',     points: 10,  bonus: 5,  emoji: '⬜', cls: 't-tapin' },
  { name: 'Solid',      points: 25,  bonus: 7,  emoji: '🟩', cls: 't-solid' },
  { name: 'Good Shout', points: 40,  bonus: 9,  emoji: '🟦', cls: 't-good' },
  { name: 'Proper Fan', points: 60,  bonus: 11, emoji: '🟨', cls: 't-fan' },
  { name: 'Deep Cut',   points: 85,  bonus: 13, emoji: '🟧', cls: 't-deep' },
  { name: 'Hidden Gem', points: 100, bonus: 15, emoji: '💎', cls: 't-gem' },
];
const TIER = Object.fromEntries(TIERS.map((t) => [t.name, t]));
const MISS = { name: 'Miss', points: 0, bonus: 0, emoji: '⬛', cls: 't-miss' };
const UNVERIFIED = { name: 'Not verified', points: 0, bonus: 0, emoji: '❔', cls: 't-unverified' };

const DAILY_MS = 25_000;
const INFINITE_MS = 45_000;
const MAX_DAILY = 700;
const REVEAL_MS = { daily: 3600, infinite: 2800 };

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tierOf = (name) => TIER[name] || (name === UNVERIFIED.name ? UNVERIFIED : MISS);

let bank = [];
let known = new Map(); // every name in the bank by kind, to spot a club typed for a stadium etc.
const byId = new Map();
const indexes = new Map();
const indexFor = (prompt) => {
  if (!indexes.has(prompt.id)) indexes.set(prompt.id, buildIndex(prompt, known));
  return indexes.get(prompt.id);
};
const hiddenGem = (prompt) => prompt.answers.find((a) => a.tier === 'Hidden Gem');

// Open prompts can't list every correct answer, so an unknown answer there is
// "not verified" (0 points, logged for review) rather than marked wrong.
function settle(prompt, res, text) {
  if (res.status === 'miss' && !res.wrongKind && !prompt.closedSet && compact(text).length >= 3) return { status: 'unverified' };
  return res;
}

const KIND_OF_PROMPT = { club: 'a club', stadium: 'a stadium', country: 'a country', person: 'a person', other: 'an answer here' };
/** Why a miss missed, in words. */
function missText(prompt, res, text) {
  const t = `“${text.trim()}”`;
  if (res.wrongKind) return `${t} is ${res.wrongKind}, not ${KIND_OF_PROMPT[prompt.answerType] || 'an answer here'}`;
  return `${t} isn’t in our bank`;
}

/**
 * A wrong answer isn't submitted: say why, log it, and let them go again while
 * the clock runs. An unverified answer is remembered so that, if time runs out,
 * the result is "Not verified" rather than a blank.
 */
function wrongGuess(prompt, res, text, mode, date, holder) {
  logAnswer(mode, date, prompt, res, text);
  holder.tries = (holder.tries || 0) + 1;
  if (res.status === 'unverified') holder.unverified = text.trim();
  store.save();
  const why = res.status === 'unverified'
    ? `“${text.trim()}” isn’t on our list yet — logged for review. Try another!`
    : `${missText(prompt, res, text)} — try again.`;
  setFeedback(why, 'warn');
  shake();
  $('answer').select();
}

/** Keep unverified answers for review and, if configured, send every answer to the log. */
function logAnswer(mode, date, prompt, res, text) {
  const entry = {
    date, mode, promptId: prompt.id, input: String(text || '').trim().slice(0, 80),
    matched: res.status === 'match' ? res.answer.name : '', status: res.status,
  };
  if (res.status === 'unverified') store.update((s) => { s.pending = [...(s.pending || []), entry].slice(-300); });
  if (!ANSWER_LOG_URL) return;
  try {
    fetch(ANSWER_LOG_URL, {
      method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(entry),
    }).catch(() => {});
  } catch { /* logging is best-effort */ }
}

function formatAsOf(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function untilMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === `screen-${name}`);
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- game state

// `game` is the live controller for whichever mode is on screen.
// Persistent progress lives in store (state.daily / state.infinite).
let game = null;
let ticker = 0;
let revealTimer = 0;
let lastSave = 0;

function stopTimers() {
  clearInterval(ticker);
  clearTimeout(revealTimer);
  ticker = 0;
}

function setFeedback(msg, kind = '') {
  const el = $('feedback');
  el.textContent = msg;
  el.dataset.kind = kind;
}

/** A clear misspelling: offer the answer we think they meant. Confirming submits it. */
function offerSuggestion(res, text) {
  game.suggestion = { text: text.trim(), name: res.answer.name };
  const el = $('feedback');
  el.dataset.kind = 'suggest';
  el.innerHTML = `Did you mean <button type="button" class="suggest-btn" id="btn-suggest">${esc(res.answer.name)}</button>? Tap it or press Shoot again.`;
}

function clearSuggestion() {
  if (game) game.suggestion = null;
  if ($('feedback').dataset.kind) setFeedback('');
}

function ambiguousFeedback(text) {
  setFeedback(`More than one answer could fit “${text.trim()}” — add a first name or check the spelling.`, 'warn');
  shake();
}

/** Promotion message when a score crosses into a new level. */
function promoFor(before, after) {
  const i = levelIndex(after);
  if (i <= levelIndex(before)) return '';
  return i === LEVELS.length - 1 ? `Ballon d'Or territory!` : `Promoted to ${LEVELS[i].name}!`;
}

/** Move the ball along the pyramid track (flashing the level name on promotion). */
function renderClimb(score, before = score) {
  const pos = climbPosition(score) * 100;
  const i = levelIndex(score);
  const ball = $('climb-ball');
  ball.classList.toggle('rolling', score !== before);
  ball.style.left = `${pos}%`;
  ball.style.setProperty('--spin', `${Math.round(pos * 14)}deg`);
  $('climb-fill').style.width = `${pos}%`;
  $('climb-level').textContent = LEVELS[i].name;
  const next = LEVELS[i + 1];
  $('climb-next').textContent = next ? `${next.min - score} pts to ${next.name}` : 'Top of the game';
  if (i > levelIndex(before)) {
    const climb = $('climb');
    climb.classList.remove('promoted');
    void climb.offsetWidth;
    climb.classList.add('promoted');
  }
}

function shake() {
  const card = $('answer-form');
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}

function renderClock(ms, totalMs) {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  $('clock').textContent = secs;
  $('screen-game').classList.toggle('danger', ms <= 5000);
  const pct = Math.max(0, Math.min(100, (ms / totalMs) * 100));
  $('timebar-fill').style.width = `${pct}%`;
}

function renderPrompt(prompt) {
  $('prompt-category').textContent = prompt.category;
  const asOf = formatAsOf(prompt.asOf);
  $('prompt-asof').textContent = asOf ? `Correct as of ${asOf}` : '';
  $('prompt-text').textContent = prompt.prompt;
  $('reveal').hidden = true;
  $('prompt-card').classList.remove('revealed');
  $('prompt-card').classList.add('enter');
  setTimeout(() => $('prompt-card').classList.remove('enter'), 400);
  clearSuggestion();
  const input = $('answer');
  input.value = '';
  input.disabled = false;
  $('btn-pass').disabled = false;
  $('btn-submit').textContent = 'Shoot';
  $('paused').hidden = true;
  input.focus({ preventScroll: true });
}

let revealToken = 0;
let skipShot = null;

/** Count "+85" (or "+85 · +13s") up from zero. */
function countUp(el, text) {
  const m = /^\+(\d+)/.exec(text || '');
  if (!m || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = text || ''; return; }
  const target = Number(m[1]);
  const rest = text.slice(m[0].length);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / 450);
    el.textContent = `+${Math.round(target * p)}${rest}`;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const SHOT_LINE = { miss: 'Over the bar!', var: 'VAR check: not on our list yet' };

/**
 * Show the result of an answer. `kind` picks the shot: 'goal' (correct),
 * 'miss' (wrong), 'var' (not verified) or 'none' (passed / out of time).
 * The text lands when the ball does; `onImpact` runs at the same moment.
 */
function showReveal({ tier, title, sub, extra, promo = '', kind = 'none', onImpact, line }) {
  clearSuggestion();
  const token = ++revealToken;
  const t = tierOf(tier);
  const badge = $('reveal-tier');
  badge.className = `tier-badge big ${t.cls}`;
  badge.textContent = t === MISS ? (title || 'Miss') : t.name;
  $('reveal-name').textContent = t === MISS || t === UNVERIFIED ? (sub || '') : title;
  const shot = SHOTS[t.name];
  $('reveal-line').textContent = line ?? (kind === 'goal' && shot ? shot.line : SHOT_LINE[kind] || '');
  $('reveal-points').textContent = '';
  $('reveal-promo').textContent = promo ? `⬆ ${promo}` : '';
  $('reveal-promo').hidden = !promo;
  const text = $('reveal-text');
  text.classList.remove('landed');
  text.classList.add('pending');
  $('shot').dataset.kind = kind;
  $('reveal').hidden = false;
  $('prompt-card').classList.add('revealed');
  $('btn-submit').textContent = 'Next ›';
  $('btn-pass').disabled = true;
  if (game) game.revealReady = false;
  skipShot = playShot(
    { ball: $('shot-ball'), net: $('shot-net'), meter: $('shot-meter'), panel: $('shot') },
    {
      kind,
      yards: shot ? shot.yards : 18,
      onImpact: () => {
        if (token !== revealToken) return;
        text.classList.remove('pending');
        text.classList.add('landed');
        countUp($('reveal-points'), extra);
        if (game) game.revealReady = true;
        if (promo && navigator.vibrate) navigator.vibrate(40);
        if (onImpact) onImpact();
      },
    },
  );
}

// ---------------------------------------------------------------- daily

function dailyState() {
  const today = dateKey();
  const state = store.load();
  if (!state.daily || state.daily.date !== today) {
    state.daily = { date: today, ids: promptsForDate(bank, today), index: 0, results: [], deadline: null, done: false };
    store.save();
  }
  return state.daily;
}

function startDaily() {
  const d = dailyState();
  if (d.done) { showDailyResults(); return; }
  stopTimers();
  game = { mode: 'daily', phase: 'answer', prompt: null };
  showScreen('game');
  $('sb-left-label').textContent = 'Prompt';
  nextDailyPrompt();
}

function nextDailyPrompt() {
  const d = store.load().daily;
  if (d.index >= d.ids.length) { finishDaily(); return; }
  const prompt = byId.get(d.ids[d.index]);
  if (!prompt) { // removed from questions.json since the game began
    d.results.push({ id: d.ids[d.index], input: '', name: null, tier: null, points: 0, note: 'unavailable' });
    d.index += 1;
    store.save();
    nextDailyPrompt();
    return;
  }
  game.prompt = prompt;
  game.phase = 'answer';
  $('sb-left').textContent = `${d.index + 1}/${d.ids.length}`;
  const score = d.results.reduce((s, r) => s + r.points, 0);
  $('sb-score').textContent = score;
  renderClimb(score);
  renderPrompt(prompt);
  if (!d.deadline) { d.deadline = Date.now() + DAILY_MS; store.save(); }
  ticker = setInterval(tickDaily, 100);
  tickDaily();
}

function tickDaily() {
  if (!game || game.mode !== 'daily' || game.phase !== 'answer') return;
  const d = store.load().daily;
  const left = d.deadline - Date.now();
  renderClock(left, DAILY_MS);
  if (left <= 0) {
    // On the buzzer: whatever is typed counts if it clearly names an answer.
    const res = matchAnswer(indexFor(game.prompt), $('answer').value);
    if (res.status === 'match') recordDaily(res, $('answer').value);
    else if (res.status === 'suggest') recordDaily({ ...res, status: 'match' }, $('answer').value);
    else if (d.unverified) recordDaily({ status: 'unverified' }, d.unverified);
    else recordDaily({ status: 'timeout' }, $('answer').value);
  }
}

function submitDaily(text) {
  const res = matchAnswer(indexFor(game.prompt), text);
  if (res.status === 'empty') { shake(); return; }
  if (res.status === 'ambiguous') { ambiguousFeedback(text); return; }
  if (res.status === 'suggest') { offerSuggestion(res, text); return; }
  const settled = settle(game.prompt, res, text);
  if (settled.status === 'match') recordDaily(settled, text);
  else { const d = store.load().daily; wrongGuess(game.prompt, settled, text, 'daily', d.date, d); }
}

function recordDaily(res, text) {
  clearInterval(ticker);
  const d = store.load().daily;
  const prompt = game.prompt;
  const matched = res.status === 'match';
  const tier = matched ? res.answer.tier : res.status === 'unverified' ? UNVERIFIED.name : null;
  const points = matched ? tierOf(tier).points : 0;
  if (res.status !== 'unverified') logAnswer('daily', d.date, prompt, res, text); // wrong tries were logged as they happened
  const before = d.results.reduce((s, r) => s + r.points, 0);
  d.results.push({ id: prompt.id, input: text.trim(), name: matched ? res.answer.name : null, tier, points, tries: d.tries || 0 });
  d.tries = 0;
  d.unverified = null;
  d.index += 1;
  d.deadline = null;
  store.save();
  $('sb-score').textContent = before + points;
  game.phase = 'reveal';
  const promo = promoFor(before, before + points);
  if (matched) {
    showReveal({ tier, title: res.answer.name, extra: `+${points}`, promo, kind: 'goal', onImpact: () => renderClimb(before + points, before) });
  } else if (res.status === 'unverified') {
    showReveal({ tier, sub: `“${text.trim()}” isn’t on our list yet — logged for review`, extra: '+0', kind: 'var' });
  } else {
    const label = res.status === 'pass' ? 'Passed' : 'Time’s up';
    showReveal({ tier: null, title: label, sub: 'No score this time', extra: '+0', kind: res.status === 'pass' ? 'none' : 'miss', line: res.status === 'pass' ? '' : 'The whistle went before the shot' });
  }
  renderClock(0, DAILY_MS);
  revealTimer = setTimeout(advance, REVEAL_MS.daily + (promo ? 800 : 0));
}

/**
 * Testing only (ALLOW_DAILY_REPLAY): play today's daily again, or a different
 * set picked by the same variety rules for a random future date. Stats only
 * ever count the first completed game of a date.
 */
function replayDaily(differentSet) {
  const state = store.load();
  const today = dateKey();
  let ids = promptsForDate(bank, today);
  if (differentSet) {
    const d = new Date();
    d.setDate(d.getDate() + 1 + Math.floor(Math.random() * 365));
    ids = promptsForDate(bank, dateKey(d));
  }
  state.daily = { date: today, ids, index: 0, results: [], deadline: null, done: false, replay: true };
  store.save();
  startDaily();
}

function finishDaily() {
  stopTimers();
  const state = store.load();
  const d = state.daily;
  if (!d.done) {
    d.done = true;
    const score = d.results.reduce((s, r) => s + r.points, 0);
    store.recordDaily(state, d.date, dayIndex(d.date), score);
    store.save();
  }
  game = null;
  showDailyResults();
}

function shareText(d) {
  const score = d.results.reduce((s, r) => s + r.points, 0);
  const row = d.results.map((r) => tierOf(r.tier).emoji).join('');
  const url = `${location.origin}${location.pathname}`;
  const beat = Math.min(99, Math.floor(percentile(score) * 100));
  return `Deep Cut #${puzzleNumber(d.date)} · ${score}/${MAX_DAILY}\n${row}\n⚽ ${LEVELS[levelIndex(score)].name} · better than ${beat}% of players\n${url}`;
}

async function share(text) {
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); return; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('Copied to clipboard'); } catch { toast('Copy failed — select the text manually'); }
  ta.remove();
}

function resultRows(results) {
  return results.map((r) => {
    const prompt = byId.get(r.id);
    if (!prompt) return '';
    const t = tierOf(r.tier);
    const gem = hiddenGem(prompt);
    const yours = r.name
      ? `<span class="tier-badge ${t.cls}">${esc(t.name)}</span> ${esc(r.name)} <b>+${r.points}</b>`
      : t === UNVERIFIED
      ? `<span class="tier-badge t-unverified">Not verified</span> ${esc(r.input)} <i>· logged for review</i>`
      : `<span class="tier-badge t-miss">Miss</span> ${r.input ? `<s>${esc(r.input)}</s>` : '<i>no answer</i>'}`;
    const tries = r.tries ? ` <small class="rl-tries">· ${r.tries} wrong ${r.tries === 1 ? 'try' : 'tries'}</small>` : '';
    return `<li>
      <p class="rl-prompt">${esc(prompt.prompt)}</p>
      <p class="rl-yours">${yours}${tries}</p>
      ${gem ? `<p class="rl-gem"><span aria-hidden="true">💎</span> Hidden Gem: <b>${esc(gem.name)}</b></p>` : ''}
    </li>`;
  }).join('');
}

/** The pyramid, bottom to top, with the ball climbing to the level reached. */
function ladderSection(score) {
  const reached = levelIndex(score);
  const rows = LEVELS.map((level, i) => {
    const cls = i < reached ? 'reached' : i === reached ? 'reached here' : '';
    const ball = i === reached ? '<span class="ladder-ball" aria-hidden="true"></span>' : '';
    return `<li class="${cls}" style="--d:${(i * 0.22).toFixed(2)}s;--inset:${i * 9}px"><span>${esc(level.name)}</span><small>${level.min}+</small>${ball}</li>`;
  }).reverse().join('');
  return `<ol class="ladder" aria-label="You reached ${esc(LEVELS[reached].name)}" style="--end:${(reached * 0.22 + 0.3).toFixed(2)}s">${rows}</ol>`;
}

const pctText = (share) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

/** Where this score sits against a modelled field of players (see js/rank.js). */
function worldSection(score) {
  const pct = percentile(score);
  const beat = Math.min(99, Math.floor(pct * 100));
  const top = Math.max(1, Math.ceil((1 - pct) * 100));
  const buckets = scoreBuckets(50);
  const max = Math.max(...buckets.map((b) => b.share));
  const yours = buckets.findIndex((b) => score >= b.from && score <= b.to);
  const bars = buckets.map((b, i) => {
    const tip = `${b.from}–${b.to} pts · ${pctText(b.share)} of players${i === yours ? ' · you' : ''}`;
    const edge = i < 2 ? ' left' : i > buckets.length - 3 ? ' right' : '';
    return `<button type="button" class="bar${i === yours ? ' you' : ''}${edge}" data-tip="${tip}" aria-label="${tip}"><i style="height:${Math.max(2, (b.share / max) * 100)}%"></i></button>`;
  }).join('');
  const rows = buckets.map((b) => `<tr><td>${b.from}–${b.to}</td><td>${pctText(b.share)}</td></tr>`).join('');
  return `
    <h3 class="section-title">You vs the world</h3>
    <div class="world">
      <p class="world-head">${pct >= 0.5 ? `<b>Top ${top}%</b> better than ${beat}% of players` : `<b>Better than ${beat}%</b> of players`}</p>
      <div class="hist" aria-hidden="false">${bars}</div>
      <div class="hist-axis" aria-hidden="true"><span>0</span><span>350</span><span>700</span></div>
      <table class="sr-only"><caption>Estimated share of players by score</caption><tr><th>Points</th><th>Players</th></tr>${rows}</table>
      <p class="small muted">Estimated from a model of how casual, regular and expert players score — not live results.</p>
    </div>`;
}

function showDailyResults() {
  stopTimers();
  const d = store.load().daily;
  const score = d.results.reduce((s, r) => s + r.points, 0);
  const gems = d.results.filter((r) => r.tier === 'Hidden Gem').length;
  const verdict = score >= 500 ? 'Absolute scenes.' : score >= 350 ? 'Proper fan behaviour.' : score >= 200 ? 'Decent shift.' : 'Tough day at the office.';
  $('results').innerHTML = `
    <p class="eyebrow">Deep Cut #${puzzleNumber(d.date)} · Full time</p>
    <p class="big-score"><span>${score}</span><small>/${MAX_DAILY}</small></p>
    <p class="verdict">${verdict}${gems ? ` ${gems} Hidden Gem${gems > 1 ? 's' : ''}!` : ''}</p>
    <p class="reached-line">You reached <b>${esc(LEVELS[levelIndex(score)].name)}</b></p>
    ${ladderSection(score)}
    ${worldSection(score)}
    <p class="emoji-row" aria-label="Your tiers">${d.results.map((r) => tierOf(r.tier).emoji).join('')}</p>
    <button class="btn primary wide" id="btn-share" type="button">Share result</button>
    <h3 class="section-title">The answers</h3>
    <ol class="result-list">${resultRows(d.results)}</ol>
    <p class="muted center">Next Deep Cut in <b class="countdown">${untilMidnight()}</b></p>
    <div class="btn-row">
      <button class="btn" type="button" data-go="home">Home</button>
      <button class="btn primary" type="button" data-go="infinite">Play Infinite</button>
    </div>
    ${ALLOW_DAILY_REPLAY ? `<div class="test-tools">
      <p class="small muted">Testing tools (switch off in js/config.js). Replays don’t change your stats.</p>
      <div class="btn-row">
        <button class="btn ghost" type="button" data-go="replay-daily">Replay today</button>
        <button class="btn ghost" type="button" data-go="random-daily">Try another set</button>
      </div>
    </div>` : ''}`;
  $('btn-share').addEventListener('click', () => share(shareText(d)));
  showScreen('results');
}

// ---------------------------------------------------------------- infinite

function shuffled(ids, avoidFirst) {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (avoidFirst && out.length > 1 && out[0] === avoidFirst) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

function startInfinite({ fresh = false } = {}) {
  stopTimers();
  const state = store.load();
  const existing = state.infinite;
  if (fresh || !existing) {
    state.infinite = {
      deck: shuffled(bank.map((p) => p.id)), pos: 0, remaining: INFINITE_MS,
      score: 0, results: [], used: {},
    };
    store.save();
  }
  game = { mode: 'infinite', phase: 'answer', prompt: null, last: 0 };
  showScreen('game');
  $('sb-left-label').textContent = 'Answered';
  showInfinitePrompt({ paused: !fresh && !!existing });
}

function showInfinitePrompt({ paused = false } = {}) {
  const run = store.load().infinite;
  if (run.pos >= run.deck.length) {
    run.deck = shuffled(bank.map((p) => p.id), run.deck[run.deck.length - 1]);
    run.pos = 0;
  }
  let prompt = byId.get(run.deck[run.pos]);
  while (!prompt && run.pos < run.deck.length - 1) { run.pos += 1; prompt = byId.get(run.deck[run.pos]); }
  if (!prompt) { run.deck = shuffled(bank.map((p) => p.id)); run.pos = 0; prompt = byId.get(run.deck[0]); }
  store.save();
  game.prompt = prompt;
  game.phase = 'answer';
  $('sb-left').textContent = run.results.filter((r) => r.points > 0).length;
  $('sb-score').textContent = run.score;
  renderClimb(run.score);
  renderPrompt(prompt);
  renderClock(run.remaining, INFINITE_MS);
  if (paused) { pauseInfinite(); return; }
  game.last = Date.now();
  ticker = setInterval(tickInfinite, 100);
}

function pauseInfinite() {
  // Shown after a refresh: hide the prompt until the player is ready.
  game.phase = 'paused';
  $('paused').hidden = false;
  $('answer').disabled = true;
  $('btn-pass').disabled = true;
}

function resumeInfinite() {
  $('paused').hidden = true;
  $('answer').disabled = false;
  $('btn-pass').disabled = false;
  $('answer').focus({ preventScroll: true });
  game.phase = 'answer';
  game.last = Date.now();
  ticker = setInterval(tickInfinite, 100);
}

function tickInfinite() {
  if (!game || game.mode !== 'infinite' || game.phase !== 'answer') return;
  const run = store.load().infinite;
  const now = Date.now();
  run.remaining -= now - game.last;
  game.last = now;
  renderClock(run.remaining, INFINITE_MS);
  if (now - lastSave > 1000) { lastSave = now; store.save(); }
  if (run.remaining <= 0) { run.remaining = 0; finishInfinite(); }
}

function submitInfinite(text) {
  const run = store.load().infinite;
  const prompt = game.prompt;
  const used = new Set(run.used[prompt.id] || []);
  const res = matchAnswer(indexFor(prompt), text, used);
  if (res.status === 'empty') { shake(); return; }
  if (res.status === 'ambiguous') { ambiguousFeedback(text); return; }
  if (res.status === 'suggest') { offerSuggestion(res, text); return; }
  if (res.status === 'duplicate') {
    setFeedback(`You’ve already used ${res.answer.name} for this one — try another.`, 'warn');
    shake();
    return;
  }
  const settled = settle(prompt, res, text);
  // Wrong: not submitted, the clock keeps running, go again.
  if (settled.status !== 'match') { wrongGuess(prompt, settled, text, 'infinite', dateKey(), run); return; }
  // Settle the clock up to this instant, then pause it for the reveal.
  tickInfinite();
  if (!game || game.phase !== 'answer') return;
  clearInterval(ticker);
  game.phase = 'reveal';
  logAnswer('infinite', dateKey(), prompt, settled, text);
  const t = tierOf(res.answer.tier);
  run.score += t.points;
  run.remaining += t.bonus * 1000;
  run.used[prompt.id] = [...used, res.index];
  run.results.push({ id: prompt.id, input: text.trim(), name: res.answer.name, tier: t.name, points: t.points, tries: run.tries || 0 });
  run.tries = 0;
  run.unverified = null;
  const before = run.score - t.points;
  const after = run.score;
  showReveal({ tier: t.name, title: res.answer.name, extra: `+${t.points} · +${t.bonus}s`, promo: promoFor(before, after), kind: 'goal', onImpact: () => renderClimb(after, before) });
  run.pos += 1;
  store.save();
  $('sb-score').textContent = run.score;
  $('sb-left').textContent = run.results.filter((r) => r.points > 0).length;
  renderClock(run.remaining, INFINITE_MS);
  revealTimer = setTimeout(advance, REVEAL_MS.infinite);
}

function passInfinite() {
  // Passing is free but the clock keeps running.
  const run = store.load().infinite;
  run.results.push({ id: game.prompt.id, input: run.unverified || '', name: null, tier: run.unverified ? UNVERIFIED.name : null, points: 0, tries: run.tries || 0 });
  run.tries = 0;
  run.unverified = null;
  run.pos += 1;
  store.save();
  clearInterval(ticker);
  showInfinitePrompt();
}

function finishInfinite() {
  stopTimers();
  const state = store.load();
  const run = state.infinite;
  game = null;
  if (!run) { showHome(); return; }
  const isBest = run.score > state.infiniteBest;
  state.infiniteBest = Math.max(state.infiniteBest, run.score);
  state.infinitePlayed += 1;
  state.infinite = null;
  store.save();
  const hits = run.results.filter((r) => r.points > 0);
  $('results').innerHTML = `
    <p class="eyebrow">Infinite · Final whistle</p>
    <p class="big-score"><span>${run.score}</span><small>pts</small></p>
    <p class="verdict">${hits.length} correct answer${hits.length === 1 ? '' : 's'}${isBest && run.score > 0 ? ' · New personal best!' : ` · Best ${state.infiniteBest}`}</p>
    <p class="emoji-row" aria-label="Your tiers">${run.results.map((r) => tierOf(r.tier).emoji).join('') || '⬛'}</p>
    <div class="btn-row">
      <button class="btn" type="button" data-go="home">Home</button>
      <button class="btn primary" type="button" data-go="infinite-new">Go again</button>
    </div>
    <p class="reached-line">You reached <b>${esc(LEVELS[levelIndex(run.score)].name)}</b></p>
    ${ladderSection(run.score)}
    <h3 class="section-title">Your run</h3>
    <ol class="result-list">${resultRows(run.results)}</ol>`;
  showScreen('results');
}

// ---------------------------------------------------------------- shared game input

function advance() {
  if (!game || game.phase !== 'reveal') return;
  // First tap during the shot skips to the result; the next moves on.
  if (!game.revealReady && skipShot) { skipShot(); return; }
  clearTimeout(revealTimer);
  if (game.mode === 'daily') nextDailyPrompt();
  else showInfinitePrompt();
}

function onSubmit(e) {
  e.preventDefault();
  if (!game) return;
  if (game.phase === 'reveal') { advance(); return; }
  if (game.phase !== 'answer') return;
  let text = $('answer').value;
  // Shoot again on the same text (or tap the name) accepts the suggestion.
  if (game.suggestion && text.trim() === game.suggestion.text) text = game.suggestion.name;
  if (game.mode === 'daily') submitDaily(text);
  else submitInfinite(text);
}

function onPass() {
  if (!game || game.phase !== 'answer') return;
  if (game.mode === 'daily') recordDaily({ status: 'pass' }, '');
  else passInfinite();
}

// ---------------------------------------------------------------- home & stats

function showHome() {
  stopTimers();
  game = null;
  const state = store.load();
  const today = dateKey();
  const d = state.daily && state.daily.date === today ? state.daily : null;
  $('daily-number').textContent = `#${puzzleNumber(today)}`;
  const btn = $('btn-daily');
  if (d && d.done) {
    const score = d.results.reduce((s, r) => s + r.points, 0);
    $('daily-blurb').innerHTML = `Today: <b>${score}/${MAX_DAILY}</b> <span class="emoji-inline">${d.results.map((r) => tierOf(r.tier).emoji).join('')}</span>`;
    btn.textContent = 'See results';
  } else if (d && (d.results.length || d.deadline)) {
    $('daily-blurb').textContent = `In progress — prompt ${d.index + 1} of ${d.ids.length}. The clock didn’t stop for you.`;
    btn.textContent = 'Resume';
  } else {
    $('daily-blurb').textContent = '7 prompts · 25 seconds each · the same for everyone today';
    btn.textContent = 'Kick off';
  }
  $('daily-next').innerHTML = d && d.done ? `Next Deep Cut in <b class="countdown">${untilMidnight()}</b>` : '';
  $('infinite-best').textContent = `Best ${state.infiniteBest}`;
  $('btn-infinite').textContent = state.infinite ? 'Resume run' : 'Start';
  renderMiniStats();
  showScreen('home');
}

function statsSummary() {
  const state = store.load();
  const s = state.stats;
  return [
    ['Played', s.played],
    ['Average', s.played ? Math.round(s.totalScore / s.played) : 0],
    ['Best', s.best],
    ['Streak', store.currentStreak(s, dayIndex(dateKey()))],
  ];
}

function renderMiniStats() {
  $('mini-stats').innerHTML = statsSummary().map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function openStats() {
  const state = store.load();
  const s = state.stats;
  const recent = Object.entries(s.history).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 7);
  $('stats-body').innerHTML = `
    <dl class="stat-grid">
      ${statsSummary().map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
      <div><dt>Max streak</dt><dd>${s.maxStreak}</dd></div>
      <div><dt>Infinite best</dt><dd>${state.infiniteBest}</dd></div>
    </dl>
    ${(state.pending || []).length ? `<p class="small muted">${state.pending.length} unverified answer${state.pending.length === 1 ? '' : 's'} saved on this device. <button class="link-btn" id="btn-copy-pending" type="button">Copy for review</button></p>` : ''}
    ${recent.length ? `<h3 class="section-title">Recent dailies</h3>
    <ul class="recent">${recent.map(([day, score]) => `<li><span>#${puzzleNumber(day)}</span><span class="bar"><i style="width:${(score / MAX_DAILY) * 100}%"></i></span><b>${score}</b></li>`).join('')}</ul>` : '<p class="muted">Play today’s Deep Cut to start your stats.</p>'}`;
  const copy = $('btn-copy-pending');
  if (copy) {
    copy.addEventListener('click', () => share(state.pending.map((e) => `${e.promptId}\t${e.input}`).join('\n')));
  }
  $('modal-stats').showModal();
}

function openHelp() {
  $('modal-help').showModal();
}

// ---------------------------------------------------------------- boot

function wire() {
  $('answer-form').addEventListener('submit', onSubmit);
  $('btn-pass').addEventListener('click', onPass);
  $('btn-resume').addEventListener('click', resumeInfinite);
  $('reveal').addEventListener('click', advance);
  $('btn-daily').addEventListener('click', startDaily);
  $('btn-infinite').addEventListener('click', () => startInfinite());
  $('btn-home').addEventListener('click', () => {
    if (game && game.mode === 'infinite' && game.phase === 'answer') { tickInfinite(); store.save(); }
    showHome();
  });
  $('btn-help').addEventListener('click', openHelp);
  $('btn-stats').addEventListener('click', openStats);
  $('answer').addEventListener('input', clearSuggestion);
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      const where = go.dataset.go;
      if (where === 'home') showHome();
      if (where === 'infinite') startInfinite();
      if (where === 'infinite-new') startInfinite({ fresh: true });
      if (where === 'replay-daily' || where === 'random-daily') replayDaily(where === 'random-daily');
    }
    if (e.target.closest('#btn-suggest') && game && game.suggestion) {
      $('answer').value = game.suggestion.name;
      onSubmit(new Event('submit'));
      return;
    }
    const close = e.target.closest('[data-close]');
    if (close) close.closest('dialog').close();
  });
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop tap
  }
  $('modal-help').addEventListener('close', () => {
    store.update((s) => { s.seenHelp = true; });
    if (game && game.phase === 'answer') $('answer').focus({ preventScroll: true });
  });
  window.addEventListener('pagehide', () => {
    if (game && game.mode === 'infinite' && game.phase === 'answer') tickInfinite();
    store.save();
  });
  setInterval(() => {
    for (const el of document.querySelectorAll('.countdown')) el.textContent = untilMidnight();
    // Roll over to the new day's puzzle if the home screen is left open past midnight.
    if (document.body.dataset.screen === 'home' && $('daily-number').textContent !== `#${puzzleNumber(dateKey())}`) showHome();
  }, 1000);
}

async function boot() {
  wire();
  let data;
  try {
    const res = await fetch('questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    bank = (Array.isArray(data) ? data : data.prompts || []).filter((p) => p && p.id && Array.isArray(p.answers) && p.answers.length);
    if (!bank.length) throw new Error('questions.json has no prompts');
  } catch (err) {
    $('error-detail').textContent = String(err.message || err);
    showScreen('error');
    return;
  }
  for (const p of bank) byId.set(p.id, p);
  known = buildKnown(bank, Array.isArray(data.cities) ? data.cities : []); // cities: never answers, see questions.json
  $('help-logging').hidden = !ANSWER_LOG_URL;

  const state = store.load();
  const d = state.daily;
  // Resume whatever was on screen before the refresh.
  if (d && d.date === dateKey() && !d.done && (d.results.length || d.deadline)) startDaily();
  else if (state.infinite) startInfinite();
  else showHome();
  if (!state.seenHelp) openHelp();
}

boot();
