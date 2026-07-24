#!/usr/bin/env node
// migration-safety.mjs — DETERMINISTIC static pre-screen for the MIGRATION SAFETY GATE.
//
// This does NOT replace the gate's judgment (expand/contract reasoning against the LIVE prod
// schema, the staging dry-run, the LIVE prod-object check). It is the mechanical HALF: catch
// the unambiguously destructive patterns and version-prefix collisions BEFORE a human/AI
// looks, so a clearly-unsafe migration fails loudly and cheaply. A PASS here is necessary,
// not sufficient — the AI still runs the full gate. A FAIL here blocks, full stop.
//
// Usage:  node migration-safety.mjs <file1.sql> [file2.sql ...] [--registry <prefixes.txt>]
//   --registry : optional newline-list of already-applied version prefixes (collision check)
//
// Output: JSON report to stdout. Exit: 0 clean · 1 violation(s) · 2 usage/IO error.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

function fail(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }

// Destructive / contract patterns. Expand-only migrations must avoid every one of these on a
// LIVE object. (Comments are stripped before matching to avoid flagging "-- drop later".)
const RULES = [
  { rule: 'DROP object', re: /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|SCHEMA|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|POLICY|TRIGGER|FUNCTION)\b/i },
  { rule: 'ALTER ... DROP', re: /\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i },
  { rule: 'RENAME (breaks old code)', re: /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i },
  { rule: 'ALTER COLUMN TYPE (narrowing risk)', re: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i },
  { rule: 'SET NOT NULL on existing column', re: /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i },
  { rule: 'ADD COLUMN NOT NULL without DEFAULT', re: /\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i },
  { rule: 'TRUNCATE', re: /\bTRUNCATE\b/i },
  { rule: 'unguarded DELETE', re: /^\s*DELETE\s+FROM\b/im },
  { rule: 'unguarded UPDATE', re: /^\s*UPDATE\s+\S+\s+SET\b/im },
];

// Strip -- line comments and /* */ block comments (rough; good enough for a screen).
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}
function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

// Version prefix = leading digits of the filename before the first underscore.
function prefixOf(file) { const m = basename(file).match(/^(\d+)/); return m ? m[1] : null; }

function scan(file) {
  if (!existsSync(file)) fail(2, `sql file not found: ${file}`);
  const raw = readFileSync(file, 'utf8');
  const sql = stripComments(raw);
  const violations = [];
  for (const { rule, re } of RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(sql)) !== null) {
      violations.push({ rule, line: lineOf(sql, m.index), text: m[0].replace(/\s+/g, ' ').trim().slice(0, 80) });
      if (!g.global) break;
    }
  }
  return { file, prefix: prefixOf(file), violations };
}

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const regIdx = process.argv.indexOf('--registry');
if (!files.length) fail(2, 'usage: node migration-safety.mjs <file.sql...> [--registry prefixes.txt]');

let registry = [];
if (regIdx > -1) {
  const rp = process.argv[regIdx + 1];
  if (!rp || !existsSync(rp)) fail(2, `--registry file not found: ${rp}`);
  registry = readFileSync(rp, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
}

const reports = files.map(scan);

// Version-prefix collisions: among the given files AND against the registry.
const seen = new Map();
for (const r of reports) {
  if (!r.prefix) { r.violations.push({ rule: 'filename has no numeric version prefix', line: 0, text: basename(r.file) }); continue; }
  if (registry.includes(r.prefix)) r.violations.push({ rule: `version prefix ${r.prefix} already applied (registry)`, line: 0, text: '' });
  if (seen.has(r.prefix)) r.violations.push({ rule: `version prefix ${r.prefix} collides with ${basename(seen.get(r.prefix))}`, line: 0, text: '' });
  else seen.set(r.prefix, r.file);
}

const total = reports.reduce((n, r) => n + r.violations.length, 0);
process.stdout.write(JSON.stringify({ clean: total === 0, reports }, null, 2) + '\n');
if (total) { process.stderr.write(`\n${total} violation(s) — NOT expand-only-safe; the migration gate must not pass on the static screen alone.\n`); process.exit(1); }
process.stdout.write('static screen clean — proceed to the full migration gate (staging dry-run + LIVE prod-schema check).\n');
