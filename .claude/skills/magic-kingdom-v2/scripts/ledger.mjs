#!/usr/bin/env node
// ledger.mjs — DETERMINISTIC gate ledger for MK V2. Enforces the ONE invariant the run
// depends on: a phase is never marked done unless every gate cell is PASS-with-evidence.
// "The agent maintains discipline" becomes a validator that cannot be talked out of it.
//
// The JSON file is the source of truth; `render` produces the human-readable markdown table.
// A cell counts as PASS only when its value begins with "PASS" (convention: "PASS <evidence>",
// e.g. "PASS gh-checks@a1b2c3"). Blank / absent / "FAIL…" / anything else = not a pass.
//
// PRE-MERGE vs POST-MERGE. `merge` and `prodtest` can only pass AFTER the merge, so a merge gate
// that demanded "every cell PASS" would be unsatisfiable — the run would deadlock at D1 forever
// (or someone would pre-fill the cells, which is the false-green this file exists to prevent).
// So eligibility and completion are separate checks: `ready` = every PRE-MERGE gate PASS (what D1
// asks), `done` = every gate PASS incl. merge + prodtest (what D5 asks). Declare the split at
// init with --premerge; without it, `ready` falls back to "all gates except merge/prodtest".
//
// GATES vs COUNTERS. Every GATE must be PASS for a phase to be done. A COUNTER is bookkeeping
// that is never a pass/fail — `refit` is the FIXER budget ("0/2"), so listing it as a gate makes
// `done` unsatisfiable forever (no sane refit value begins with "PASS"). Counters are tracked in
// the same row, shown by `render`, and IGNORED by `done`/`validate`. `init` refuses a known
// counter name inside --gates so the mistake cannot be pasted back in.
//
// Usage:
//   node ledger.mjs init <ledger.json> --phases P1,P4,P5 \
//        --gates rebase,ci,codexreview,prreview,migration,switchon,functest,merge,prodtest \
//        [--premerge rebase,ci,codexreview,prreview,migration,switchon,functest] [--counters refit]
//   node ledger.mjs set  <ledger.json> <phase> <gate|counter> "<value>"   # set l.json P1 ci "PASS gh@a1b2c3"
//   node ledger.mjs get  <ledger.json> [<phase>]                     # dump JSON state (all, or one phase)
//   node ledger.mjs ready <ledger.json> <phase>                      # BACK-GATE 1 (D1): every PRE-MERGE gate PASS?
//   node ledger.mjs done <ledger.json> <phase>                       # mark [x]; exits 1 (refuses) if any gate not PASS
//   node ledger.mjs validate <ledger.json>                           # exit 1 if ANY done phase has a non-PASS cell
//   node ledger.mjs render <ledger.json>                             # markdown table to stdout
//
// Exit: 0 ok · 1 invariant violated / refusal · 2 usage/IO error.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isPass = (v) => typeof v === 'string' && /^PASS\b/.test(v.trim());
function fail(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }
function load(p) {
  if (!existsSync(p)) fail(2, `ledger not found: ${p}`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail(2, 'parse error: ' + e.message); }
}
function save(p, s) { writeFileSync(p, JSON.stringify(s, null, 2) + '\n'); }
function argVal(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }

// Bookkeeping columns that are never pass/fail. Tracked, rendered, ignored by done/validate.
const KNOWN_COUNTERS = new Set(['refit', 'rounds', 'attempts', 'budget']);
const countersOf = (s) => (Array.isArray(s.counters) ? s.counters : []);

// Gates that must pass BEFORE the merge is allowed (D1). Everything except the two that can
// only be true afterwards, unless init declared an explicit --premerge list.
const POST_MERGE = new Set(['merge', 'prodtest']);
const premergeGates = (s) => (Array.isArray(s.premerge) && s.premerge.length
  ? s.premerge
  : s.gates.filter(g => !POST_MERGE.has(g)));

// Reasons a phase is NOT installable: any GATE cell that is not PASS. Returns [] when clean.
// `scope`: 'all' (done/validate) or 'premerge' (the D1 merge gate).
export function blockingCells(state, phase, scope = 'all') {
  const cells = state.phases[phase]?.cells || {};
  const gates = scope === 'premerge' ? premergeGates(state) : state.gates;
  return gates.filter(g => !isPass(cells[g])).map(g => ({ gate: g, value: cells[g] ?? '(blank)' }));
}

function cmdInit(p) {
  const phases = (argVal('--phases') || '').split(',').filter(Boolean);
  const gates = (argVal('--gates') || '').split(',').filter(Boolean);
  const counters = (argVal('--counters') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!phases.length || !gates.length) fail(2, 'init needs --phases and --gates (comma-separated)');
  // A counter listed as a gate makes `done` unsatisfiable — refuse it up front, loudly.
  const misfiled = gates.filter(g => KNOWN_COUNTERS.has(g));
  if (misfiled.length) fail(2,
    `these are COUNTERS, not gates: ${misfiled.join(', ')} — a counter value never begins with "PASS", ` +
    `so listing it in --gates makes \`done\` impossible. Move them: --gates <real gates> --counters ${misfiled.join(',')}`);
  const dup = counters.filter(c => gates.includes(c));
  if (dup.length) fail(2, `name in both --gates and --counters: ${dup.join(', ')}`);
  if (new Set(gates).size !== gates.length) fail(2, 'duplicate gate name in --gates');
  // --premerge is DOCUMENTATION, not a selector. If it were free-form, a drifted or
  // reconstructed init (the jig supervisor rebuilds this ledger after the front handoff) could
  // quietly omit `ci` or `migration` and still get MERGE-ELIGIBLE out of `ready`. So the only
  // accepted value is exactly "all gates minus the post-merge ones".
  const premerge = (argVal('--premerge') || '').split(',').map(s => s.trim()).filter(Boolean);
  const expected = gates.filter(g => !POST_MERGE.has(g));
  if (premerge.length) {
    const same = premerge.length === expected.length && expected.every(g => premerge.includes(g));
    if (!same) fail(2,
      `--premerge must be exactly every gate except ${[...POST_MERGE].join('/')} — expected:\n` +
      `  ${expected.join(',')}\ngot:\n  ${premerge.join(',')}\n` +
      `(a smaller pre-merge set would let \`ready\` green a branch whose gates never ran).`);
  }
  const state = { gates, counters, premerge, phases: {} };
  for (const ph of phases) state.phases[ph] = { cells: {}, done: false };
  save(p, state);
  process.stdout.write(`initialized ${p}: ${phases.length} phases × ${gates.length} gates` +
    `${counters.length ? ` (+ ${counters.length} counter(s): ${counters.join(',')})` : ''}\n`);
}

function cmdSet(p, phase, gate, value) {
  const s = load(p);
  if (!s.phases[phase]) fail(2, `unknown phase ${phase}`);
  const isCounter = countersOf(s).includes(gate);
  if (!s.gates.includes(gate) && !isCounter)
    fail(2, `unknown gate/counter ${gate} (gates: ${s.gates.join(',')}${countersOf(s).length ? ` · counters: ${countersOf(s).join(',')}` : ''})`);
  if (value === undefined) fail(2, 'set needs a value');
  // The convention is "PASS <evidence>". A bare "PASS" carries no evidence and is exactly the
  // shape of a rubber-stamped gate, so refuse it. (This script cannot VERIFY the evidence is
  // real — that stays the supervisor's job under VERIFY-DON'T-TRUST — but it can insist that a
  // job id / SHA / score / query result was written down at all.)
  if (!isCounter && /^PASS\s*$/i.test(String(value).trim())) fail(2,
    `refusing a bare "PASS" for ${phase}.${gate} — record the evidence you verified, e.g. ` +
    `"PASS gh-checks@<sha>", "PASS codex-job <id>", "PASS kevin-pr-review 5/5", "PASS live query: <result>"`);
  s.phases[phase].cells[gate] = value;
  save(p, s);
  process.stdout.write(`${phase}.${gate} = ${value}` +
    `${isCounter ? '   (counter — not gated)' : (isPass(value) ? '' : '   (NOT a pass)')}\n`);
}

// BACK-GATE 1 (D1): is this branch eligible to MERGE? Every pre-merge gate PASS. Deliberately
// does NOT require `merge`/`prodtest` — those are recorded after D3/D4, and demanding them here
// is the deadlock this command exists to remove.
function cmdReady(p, phase) {
  const s = load(p);
  if (!s.phases[phase]) fail(2, `unknown phase ${phase}`);
  const blk = blockingCells(s, phase, 'premerge');
  if (blk.length) {
    process.stderr.write(`NOT READY TO MERGE: ${phase} — non-PASS pre-merge gate(s):\n`);
    for (const b of blk) process.stderr.write(`  - ${b.gate}: ${b.value}\n`);
    process.exit(1);
  }
  process.stdout.write(`${phase} is MERGE-ELIGIBLE (all ${premergeGates(s).length} pre-merge gates PASS; ` +
    `still owed after merge: ${s.gates.filter(g => !premergeGates(s).includes(g)).join(', ') || 'none'})\n`);
}

function cmdDone(p, phase) {
  const s = load(p);
  if (!s.phases[phase]) fail(2, `unknown phase ${phase}`);
  const blk = blockingCells(s, phase);
  if (blk.length) {
    process.stderr.write(`REFUSED: ${phase} cannot be marked done — non-PASS gate(s):\n`);
    for (const b of blk) process.stderr.write(`  - ${b.gate}: ${b.value}\n`);
    process.exit(1);
  }
  s.phases[phase].done = true;
  save(p, s);
  process.stdout.write(`${phase} marked done (all ${s.gates.length} gates PASS)\n`);
}

function cmdValidate(p) {
  const s = load(p);
  let bad = 0;
  for (const ph of Object.keys(s.phases)) {
    if (!s.phases[ph].done) continue;
    const blk = blockingCells(s, ph);
    if (blk.length) {
      bad++;
      process.stderr.write(`INVALID: ${ph} is done but has non-PASS cells: ${blk.map(b => `${b.gate}=${b.value}`).join(', ')}\n`);
    }
  }
  if (bad) process.exit(1);
  process.stdout.write(`OK: ${Object.values(s.phases).filter(x => x.done).length} done phase(s), all cells PASS\n`);
}

function cmdRender(p) {
  const s = load(p);
  const cnt = countersOf(s);
  const head = ['phase', ...s.gates, ...cnt, 'done'];
  const rows = Object.entries(s.phases).map(([ph, v]) => [
    ph,
    ...s.gates.map(g => isPass(v.cells[g]) ? '✓' : (v.cells[g] ? '✗' : '·')),
    ...cnt.map(c => v.cells[c] ?? '·'),          // counters print raw — they are not pass/fail
    v.done ? '[x]' : '[ ]',
  ]);
  const line = (a) => '| ' + a.join(' | ') + ' |';
  process.stdout.write(line(head) + '\n' + line(head.map(() => '---')) + '\n' + rows.map(line).join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, path, ...rest] = process.argv;
  switch (cmd) {
    case 'init': cmdInit(path); break;
    case 'set': cmdSet(path, rest[0], rest[1], rest[2]); break;
    case 'get': { const s = load(path); process.stdout.write(JSON.stringify(rest[0] ? s.phases[rest[0]] : s, null, 2) + '\n'); break; }
    case 'ready': cmdReady(path, rest[0]); break;
    case 'done': cmdDone(path, rest[0]); break;
    case 'validate': cmdValidate(path); break;
    case 'render': cmdRender(path); break;
    default: fail(2, 'usage: node ledger.mjs <init|set|get|ready|done|validate|render> <ledger.json> ...');
  }
}
