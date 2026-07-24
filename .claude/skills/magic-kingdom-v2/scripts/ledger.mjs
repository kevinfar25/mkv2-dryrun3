#!/usr/bin/env node
// ledger.mjs — DETERMINISTIC gate ledger for MK V2. Enforces the ONE invariant the run
// depends on: a phase is never marked done unless every gate cell is PASS-with-evidence.
// "The agent maintains discipline" becomes a validator that cannot be talked out of it.
//
// The JSON file is the source of truth; `render` produces the human-readable markdown table.
// A cell counts as PASS only when its value begins with "PASS" (convention: "PASS <evidence>",
// e.g. "PASS gh-checks@a1b2c3"). Blank / absent / "FAIL…" / anything else = not a pass.
//
// Usage:
//   node ledger.mjs init <ledger.json> --phases P1,P4,P5 --gates rebase,ci,codexreview,prreview,migration,switchon,functest,merge,prodtest,refit
//   node ledger.mjs set  <ledger.json> <phase> <gate> "<value>"      # e.g. set l.json P1 ci "PASS gh@a1b2c3"
//   node ledger.mjs get  <ledger.json> [<phase>]                     # dump JSON state (all, or one phase)
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

// Reasons a phase is NOT installable: any gate cell that is not PASS. Returns [] when clean.
export function blockingCells(state, phase) {
  const cells = state.phases[phase]?.cells || {};
  return state.gates.filter(g => !isPass(cells[g])).map(g => ({ gate: g, value: cells[g] ?? '(blank)' }));
}

function cmdInit(p) {
  const phases = (argVal('--phases') || '').split(',').filter(Boolean);
  const gates = (argVal('--gates') || '').split(',').filter(Boolean);
  if (!phases.length || !gates.length) fail(2, 'init needs --phases and --gates (comma-separated)');
  const state = { gates, phases: {} };
  for (const ph of phases) state.phases[ph] = { cells: {}, done: false };
  save(p, state);
  process.stdout.write(`initialized ${p}: ${phases.length} phases × ${gates.length} gates\n`);
}

function cmdSet(p, phase, gate, value) {
  const s = load(p);
  if (!s.phases[phase]) fail(2, `unknown phase ${phase}`);
  if (!s.gates.includes(gate)) fail(2, `unknown gate ${gate} (gates: ${s.gates.join(',')})`);
  if (value === undefined) fail(2, 'set needs a value');
  s.phases[phase].cells[gate] = value;
  save(p, s);
  process.stdout.write(`${phase}.${gate} = ${value}${isPass(value) ? '' : '   (NOT a pass)'}\n`);
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
  const head = ['phase', ...s.gates, 'done'];
  const rows = Object.entries(s.phases).map(([ph, v]) =>
    [ph, ...s.gates.map(g => isPass(v.cells[g]) ? '✓' : (v.cells[g] ? '✗' : '·')), v.done ? '[x]' : '[ ]']);
  const line = (a) => '| ' + a.join(' | ') + ' |';
  process.stdout.write(line(head) + '\n' + line(head.map(() => '---')) + '\n' + rows.map(line).join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, path, ...rest] = process.argv;
  switch (cmd) {
    case 'init': cmdInit(path); break;
    case 'set': cmdSet(path, rest[0], rest[1], rest[2]); break;
    case 'get': { const s = load(path); process.stdout.write(JSON.stringify(rest[0] ? s.phases[rest[0]] : s, null, 2) + '\n'); break; }
    case 'done': cmdDone(path, rest[0]); break;
    case 'validate': cmdValidate(path); break;
    case 'render': cmdRender(path); break;
    default: fail(2, 'usage: node ledger.mjs <init|set|get|done|validate|render> <ledger.json> ...');
  }
}
