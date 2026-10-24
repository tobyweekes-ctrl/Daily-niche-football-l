// Run with: node tests/test.mjs
// Validates questions.json and unit-tests matching and daily selection.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { normalize, compact, levenshtein, buildIndex, matchAnswer } from '../js/match.js';
import { promptsForDate, dayIndex, puzzleNumber, EPOCH, PER_DAY, REPEAT_GAP } from '../js/daily.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let warnings = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const warn = (msg) => { warnings++; console.log(`  warn ${msg}`); };

// ------------------------------------------------------------- question bank

console.log('questions.json');
const data = JSON.parse(readFileSync(join(root, 'questions.json'), 'utf8'));
const prompts = Array.isArray(data) ? data : data.prompts;
const TIERS = ['Tap-in', 'Solid', 'Good Shout', 'Proper Fan', 'Deep Cut', 'Hidden Gem'];
const TYPES = ['person', 'club', 'country', 'stadium', 'other'];

test('has prompts with unique ids', () => {
  assert.ok(prompts.length >= PER_DAY, `need at least ${PER_DAY} prompts`);
  const ids = prompts.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate prompt id');
});

for (const p of prompts) {
  test(`${p.id}`, () => {
    for (const field of ['id', 'prompt', 'category', 'asOf', 'answerType']) assert.ok(p[field], `missing ${field}`);
    assert.match(p.asOf, /^\d{4}-\d{2}-\d{2}$/, 'asOf must be YYYY-MM-DD');
    assert.ok(TYPES.includes(p.answerType), `answerType must be one of ${TYPES.join(', ')}`);
    assert.ok(Array.isArray(p.answers) && p.answers.length, 'no answers');
    const bad = p.answers.filter((a) => !TIERS.includes(a.tier));
    assert.equal(bad.length, 0, `invalid tier on: ${bad.map((a) => a.name).join(', ')}`);
    const gems = p.answers.filter((a) => a.tier === 'Hidden Gem');
    assert.equal(gems.length, 1, `needs exactly one Hidden Gem, found ${gems.length}`);
    const names = p.answers.map((a) => compact(a.name));
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.equal(dupes.length, 0, `duplicate answer: ${dupes.join(', ')}`);

    // Every answer must be reachable by typing its own name.
    const index = buildIndex(p);
    for (const [i, a] of p.answers.entries()) {
      const res = matchAnswer(index, a.name);
      assert.ok(res.status === 'match' && res.index === i, `"${a.name}" doesn't match itself (${res.status})`);
    }
    // An alias equal to another answer's name is shadowed — usually a data slip.
    for (const a of p.answers) {
      for (const alias of a.aliases || []) {
        const other = p.answers.find((b) => b !== a && compact(b.name) === compact(alias));
        if (other) warn(`${p.id}: alias "${alias}" of ${a.name} is also the name of ${other.name}`);
      }
    }
  });
  if (p.answers.length < 50 && !p.closedSet) warn(`${p.id}: ${p.answers.length} answers (aim for 50+)`);
}

// ------------------------------------------------------------- matching

console.log('matching');
const sample = {
  id: 't', answerType: 'person', answers: [
    { name: 'Martin Ødegaard', tier: 'Solid' },
    { name: 'Gary Neville', tier: 'Solid' },
    { name: 'Phil Neville', tier: 'Proper Fan' },
    { name: 'Robin van Persie', aliases: ['RVP'], tier: 'Good Shout' },
    { name: "N'Golo Kanté", tier: 'Solid' },
    { name: 'Trent Alexander-Arnold', aliases: ['TAA'], tier: 'Solid' },
    { name: 'Park Ji-sung', aliases: ['Ji-sung Park'], tier: 'Good Shout', surname: 'Park' },
    { name: 'Cristiano Ronaldo', aliases: ['Ronaldo', 'CR7'], tier: 'Tap-in' },
    { name: 'Ronaldo Nazário', aliases: ['Ronaldo', 'R9'], tier: 'Solid' },
    { name: 'Wes Brown', tier: 'Deep Cut' },
  ],
};
const clubs = {
  id: 'c', answerType: 'club', answers: [
    { name: 'Manchester United', aliases: ['Man Utd', 'Man United', 'MUFC'], tier: 'Tap-in' },
    { name: 'Brighton & Hove Albion', aliases: ['Brighton'], tier: 'Good Shout' },
  ],
};
const si = buildIndex(sample);
const ci = buildIndex(clubs);
const name = (r) => (r.status === 'match' ? r.answer.name : r.status);

test('normalize strips accents, case, punctuation, spacing', () => {
  assert.equal(normalize('  ØDEGAARD  '), 'odegaard');
  assert.equal(normalize("N'Golo   Kanté"), 'ngolo kante');
  assert.equal(normalize('Arsenal F.C.'), 'arsenal');
  assert.equal(compact('Alexander-Arnold'), compact('alexander arnold'));
});
test('accent-insensitive full names', () => {
  assert.equal(name(matchAnswer(si, 'martin odegaard')), 'Martin Ødegaard');
  assert.equal(name(matchAnswer(si, 'NGOLO KANTE')), "N'Golo Kanté");
});
test('aliases', () => {
  for (const a of ['Man Utd', 'man united', 'MUFC', 'manchester united fc']) assert.equal(name(matchAnswer(ci, a)), 'Manchester United');
  assert.equal(name(matchAnswer(ci, 'Brighton and Hove Albion')), 'Brighton & Hove Albion');
  assert.equal(name(matchAnswer(si, 'rvp')), 'Robin van Persie');
});
test('unambiguous surname only', () => {
  assert.equal(name(matchAnswer(si, 'Odegaard')), 'Martin Ødegaard');
  assert.equal(name(matchAnswer(si, 'van persie')), 'Robin van Persie');
  assert.equal(name(matchAnswer(si, 'Persie')), 'Robin van Persie');
  assert.equal(name(matchAnswer(si, 'Park')), 'Park Ji-sung');
  assert.equal(name(matchAnswer(si, 'Brown')), 'Wes Brown');
});
test('surname-only is not offered for clubs', () => {
  assert.equal(matchAnswer(ci, 'United').status, 'miss');
});
test('ambiguous surname asks for more', () => {
  const r = matchAnswer(si, 'Neville');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map((a) => a.name).sort(), ['Gary Neville', 'Phil Neville']);
  assert.equal(matchAnswer(si, 'Ronaldo').status, 'ambiguous');
  assert.equal(name(matchAnswer(si, 'phil neville')), 'Phil Neville');
});
test('typos: distance ≤ 2 only for names over 6 characters', () => {
  assert.equal(name(matchAnswer(si, 'Odegard')), 'Martin Ødegaard');
  assert.equal(name(matchAnswer(si, 'Gary Nevile')), 'Gary Neville');
  assert.equal(name(matchAnswer(si, 'Alexandr Arnld')), 'Trent Alexander-Arnold');
  assert.equal(matchAnswer(si, 'Brwn').status, 'miss');       // short: exact only
  assert.equal(matchAnswer(si, 'Odegxxxd').status, 'miss');    // distance 3
  assert.equal(matchAnswer(si, 'Nevlle').status, 'miss');      // 6 chars: no fuzz
  assert.equal(matchAnswer(si, 'Nevvile').status, 'ambiguous'); // fuzzy tie
});
test('duplicates blocked, ambiguity resolved by what is left', () => {
  const gary = si.prompt.answers.findIndex((a) => a.name === 'Gary Neville');
  assert.equal(matchAnswer(si, 'Gary Neville', new Set([gary])).status, 'duplicate');
  assert.equal(name(matchAnswer(si, 'Neville', new Set([gary]))), 'Phil Neville');
});
test('empty and wrong input', () => {
  assert.equal(matchAnswer(si, '   ').status, 'empty');
  assert.equal(matchAnswer(si, 'Lionel Messi').status, 'miss');
});
test('levenshtein', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.ok(levenshtein('abcdefgh', 'zzzzzzzz', 2) > 2);
});

// ------------------------------------------------------------- daily selection

console.log('daily selection');
const addDays = (key, n) => new Date(Date.UTC(...key.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) + n * 864e5).toISOString().slice(0, 10);

test('deterministic and 7 distinct prompts', () => {
  const a = promptsForDate(prompts, '2026-11-05');
  const b = promptsForDate(JSON.parse(JSON.stringify(prompts)).reverse(), '2026-11-05');
  assert.deepEqual(a, b, 'order of questions.json must not matter');
  assert.equal(a.length, PER_DAY);
  assert.equal(new Set(a).size, PER_DAY);
});
test('puzzle numbering', () => {
  assert.equal(puzzleNumber(EPOCH), 1);
  assert.equal(puzzleNumber(addDays(EPOCH, 9)), 10);
});
test(`no repeats within ${REPEAT_GAP} days when the bank is big enough`, () => {
  const big = Array.from({ length: PER_DAY * (REPEAT_GAP + 2) }, (_, i) => ({ id: `p${i}` }));
  const last = new Map();
  for (let d = 0; d < 200; d++) {
    const key = addDays(EPOCH, d);
    for (const id of promptsForDate(big, key)) {
      if (last.has(id)) assert.ok(dayIndex(key) - last.get(id) > REPEAT_GAP, `${id} repeated after ${dayIndex(key) - last.get(id)} days`);
      last.set(id, dayIndex(key));
    }
  }
});
test('small bank: spreads prompts as evenly as possible', () => {
  const seen = new Map();
  for (let d = 0; d < 60; d++) {
    const key = addDays(EPOCH, d);
    for (const id of promptsForDate(prompts, key)) {
      const prev = seen.get(id);
      if (prev != null) assert.ok(dayIndex(key) - prev >= Math.floor(prompts.length / PER_DAY), `${id} back after ${dayIndex(key) - prev} days`);
      seen.set(id, dayIndex(key));
    }
  }
});

console.log(`\n${failures ? `${failures} failed` : 'all passed'}${warnings ? `, ${warnings} warnings` : ''}`);
process.exit(failures ? 1 : 0);
