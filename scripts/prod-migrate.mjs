#!/usr/bin/env node
// prod-migrate.mjs — THE atomic prod-apply command for this sandbox.
//
// Mirrors tradegamesfinal's `npm run migrate:status` / `migrate:apply` split, so a dry run of MK V2
// exercises the real shape of its migration gate:
//
//   npm run prod:migrate:status    # READ-ONLY drift report; exit 1 on drift, 0 when current
//   npm run prod:migrate:dry       # what WOULD be applied; writes nothing
//   npm run prod:migrate:apply     # apply pending + record, atomically per migration
//
// The hosted DATABASE_URL is Sensitive and unreachable from a laptop, so the actual apply happens
// inside the deployed function (app/api/migrate/route.ts). This is the client for it. Apply and
// record commit in the same transaction there — there is no path that applies without recording.
//
// NEVER apply schema to the hosted DB any other way. In particular POST /api/setup is NOT a
// migration runner: it applies the whole SCHEMA_SQL idempotently and records nothing, so using it
// leaves the ledger claiming migrations are pending that are in fact live.
//
// Config: BASE_URL (default the production deployment) and SETUP_TOKEN, or --token <t>.

import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

const BASE = val('--base', process.env.BASE_URL || 'https://mkv2-dryrun3.vercel.app').replace(/\/$/, '');

function resolveToken() {
  const fromFlag = val('--token', null);
  if (fromFlag) return fromFlag;
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  // The run keeps it here so the supervisor does not have to pass it around.
  for (const p of ['.mkv2-run/SETUP_TOKEN.txt', '.setup-token']) {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8').trim();
      const m = raw.match(/([0-9a-f]{32,})/i);
      if (m) return m[1];
    }
  }
  return null;
}

const token = resolveToken();
if (!token) {
  process.stderr.write('no SETUP_TOKEN — pass --token <t>, set SETUP_TOKEN, or put it in .mkv2-run/SETUP_TOKEN.txt\n');
  process.exit(2);
}

const mode = has('--status') ? 'status' : has('--dry-run') ? 'dry' : has('--apply') ? 'apply' : null;
if (!mode) {
  process.stderr.write('usage: node scripts/prod-migrate.mjs <--status|--dry-run|--apply> [--base <url>] [--token <t>]\n');
  process.exit(2);
}

const url = `${BASE}/api/migrate`;
const headers = { 'x-setup-token': token, 'content-type': 'application/json' };

let res, body;
try {
  res = mode === 'status'
    ? await fetch(url, { headers })
    : await fetch(url, { method: 'POST', headers, body: JSON.stringify({ dryRun: mode === 'dry' }) });
  body = await res.json();
} catch (e) {
  process.stderr.write(`request to ${url} failed: ${e.message}\n`);
  process.exit(2);
}

process.stdout.write(JSON.stringify(body, null, 2) + '\n');

if (!res.ok || body.ok !== true) {
  process.stderr.write(`\n${mode} FAILED (HTTP ${res.status}) — schema NOT advanced.\n`);
  process.exit(1);
}

if (mode === 'status') {
  // Exit 1 on drift, matching migrate:status in tradegamesfinal — this is what a drift check keys on.
  if (body.drift) {
    process.stderr.write(`\nDRIFT: ${body.pending.length} pending, ${body.orphaned.length} orphaned.\n`);
    process.exit(1);
  }
  process.stderr.write(`\nledger current — ${body.applied.length} migration(s) applied, none pending.\n`);
  process.exit(0);
}

if (mode === 'dry') {
  process.stderr.write(`\ndry run — would apply ${body.wouldApply.length}: ${body.wouldApply.join(', ') || '(none)'}\n`);
  process.exit(0);
}

process.stderr.write(`\napplied + recorded ${body.applied.length} migration(s): ${body.applied.join(', ') || '(none pending)'}\n`);
