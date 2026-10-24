// Suggest tiers from what players actually type, and list unverified answers.
//
//   node tools/retier.mjs <answers.csv | Apps Script URL> [--min 50] [--write]
//
// Input is the answer log from backend/ (CSV exported from the sheet, or the
// web-app URL, which returns JSON). Only Daily answers are counted: Infinite
// lets people retry, which would skew the shares.
//
// Without --write it only prints a report. With --write it updates tiers in
// questions.json. Answers nobody has given yet keep their tier. Hidden Gems
// are never changed automatically: they are
// hand-picked, but the report warns when one has become too common.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compact } from '../js/match.js';

// Share of all Daily answers to a prompt that named this answer.
const THRESHOLDS = [
  ['Tap-in', 0.20],
  ['Solid', 0.08],
  ['Good Shout', 0.03],
  ['Proper Fan', 0.01],
  ['Deep Cut', 0],
];
const GEM_WARN_SHARE = 0.01;

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const min = Number(args[args.indexOf('--min') + 1]) || 50;
const write = args.includes('--write');
if (!source) {
  console.error('usage: node tools/retier.mjs <answers.csv | url> [--min 50] [--write]');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const raw = source.startsWith('http')
  ? await (await fetch(source)).json()
  : parseCsv(readFileSync(source, 'utf8'));
const [header, ...body] = raw;
const col = Object.fromEntries(header.map((h, i) => [String(h).trim(), i]));
const entries = body
  .map((r) => ({
    mode: String(r[col.mode] ?? ''),
    promptId: String(r[col.promptId] ?? ''),
    input: String(r[col.input] ?? '').replace(/^'/, ''),
    matched: String(r[col.matched] ?? ''),
    status: String(r[col.status] ?? ''),
  }))
  .filter((e) => e.mode === 'daily' && e.promptId && e.status !== 'pass' && !(e.status === 'timeout' && !e.input));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bankPath = join(root, 'questions.json');
const bank = JSON.parse(readFileSync(bankPath, 'utf8'));
let changes = 0;

for (const prompt of bank.prompts) {
  const mine = entries.filter((e) => e.promptId === prompt.id);
  console.log(`\n${prompt.id} — ${mine.length} daily answers`);
  if (!mine.length) continue;

  // Unverified (and, for closed sets, missed) answers people keep typing.
  const unknown = new Map();
  for (const e of mine.filter((e) => e.status === 'unverified' || e.status === 'miss')) {
    const key = compact(e.input);
    if (!key) continue;
    const u = unknown.get(key) || { text: e.input, count: 0, status: e.status };
    u.count++;
    unknown.set(key, u);
  }
  const top = [...unknown.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  if (top.length) console.log(`  not on the list: ${top.map((u) => `${u.text} (${u.count}${u.status === 'miss' ? ', marked wrong' : ''})`).join(', ')}`);

  if (mine.length < min) { console.log(`  fewer than ${min} answers — tiers left alone`); continue; }
  const counts = new Map();
  for (const e of mine) if (e.status === 'match') counts.set(e.matched, (counts.get(e.matched) || 0) + 1);
  for (const answer of prompt.answers) {
    const share = (counts.get(answer.name) || 0) / mine.length;
    if (answer.tier === 'Hidden Gem') {
      if (share >= GEM_WARN_SHARE) console.log(`  ! Hidden Gem ${answer.name} was given by ${(share * 100).toFixed(1)}% — consider picking a rarer one`);
      continue;
    }
    // Nobody naming it is weak evidence in a small sample, so leave those alone.
    if (!counts.get(answer.name)) continue;
    const suggested = THRESHOLDS.find(([, floor]) => share >= floor)[0];
    if (suggested !== answer.tier) {
      console.log(`  ${answer.name}: ${answer.tier} → ${suggested} (${(share * 100).toFixed(1)}%)`);
      if (write) { answer.tier = suggested; changes++; }
    }
  }
}

if (write && changes) {
  // Same layout as the hand-edited file: one answer per line.
  const out = JSON.stringify(bank, null, 2).replace(
    /\{\n\s+"name"[\s\S]*?\n\s+\}(?=,?\n)/g,
    (block) => JSON.stringify(JSON.parse(block)).replace(/":/g, '": ').replace(/,"/g, ', "'),
  );
  writeFileSync(bankPath, `${out}\n`);
  console.log(`\nUpdated ${changes} tiers in questions.json. Run node tests/test.mjs to check.`);
} else if (write) {
  console.log('\nNo tier changes needed.');
}
