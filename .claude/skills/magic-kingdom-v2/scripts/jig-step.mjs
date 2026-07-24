#!/usr/bin/env node
// jig-step.mjs — DETERMINISTIC git/gh mechanics for the re-fit jig. These steps have exactly
// one correct sequence; scripting them removes the freeform choreography (and its mistakes:
// forgetting --force-with-lease, checking CI on the pre-rebase SHA, eyeballing the migration
// diff). Judgment stays with the AI: interpreting a NOVEL ci failure, deciding to FIXER, etc.
// This script only reports mechanical ground truth with clean exit codes.
//
// Run it in the branch's worktree/checkout (or pass --cwd <dir>).
//
//   node jig-step.mjs rebase <branch>                 # fetch origin; rebase <branch> onto origin/main
//   node jig-step.mjs push   <branch>                 # push --force-with-lease origin <branch>
//   node jig-step.mjs ci-wait <branch> [--timeout-min 25] [--interval-sec 20]
//        # resolves the PR head SHA, polls `gh pr checks` until all conclude, reports per-check
//   node jig-step.mjs migration-diff <branch> <path>  # files under <path> that differ vs origin/main
//
// Output: JSON to stdout. Exit: 0 ok/green · 1 conflict|red|dirty · 2 usage/IO · 4 ci timeout.

import { execFileSync } from 'node:child_process';

function fail(code, msg) { process.stderr.write(msg + '\n'); process.exit(code); }
function argVal(flag, def) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : def; }
const CWD = argVal('--cwd', process.cwd());
function git(args) { return execFileSync('git', args, { cwd: CWD, encoding: 'utf8' }); }
function gitTry(args) { try { return { ok: true, out: git(args) }; } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; } }
function gh(args) { return execFileSync('gh', args, { cwd: CWD, encoding: 'utf8' }); }
function out(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }; // synchronous block

const [, , cmd, branch, ...rest] = process.argv;
if (!cmd) fail(2, 'usage: node jig-step.mjs <rebase|push|ci-wait|migration-diff> <branch> ...');

if (cmd === 'rebase') {
  if (!branch) fail(2, 'rebase needs <branch>');
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) fail(1, 'working tree not clean — commit/stash before rebase:\n' + dirty);
  git(['fetch', 'origin', '--prune']);
  const before = git(['rev-parse', 'HEAD']).trim();
  const r = gitTry(['rebase', 'origin/main']);
  if (!r.ok) {
    const conflicts = gitTry(['diff', '--name-only', '--diff-filter=U']).out.trim();
    gitTry(['rebase', '--abort']);
    out({ step: 'rebase', branch, ok: false, conflicts: conflicts.split('\n').filter(Boolean) });
    process.exit(1);
  }
  const after = git(['rev-parse', 'HEAD']).trim();
  out({ step: 'rebase', branch, ok: true, changed: before !== after, before, after, base: git(['rev-parse', 'origin/main']).trim() });
}

else if (cmd === 'push') {
  if (!branch) fail(2, 'push needs <branch>');
  const r = gitTry(['push', '--force-with-lease', 'origin', branch]);
  if (!r.ok) { out({ step: 'push', branch, ok: false, detail: r.out.trim().slice(-400) }); process.exit(1); }
  out({ step: 'push', branch, ok: true, head: git(['rev-parse', 'HEAD']).trim() });
}

else if (cmd === 'ci-wait') {
  if (!branch) fail(2, 'ci-wait needs <branch>');
  const timeoutMs = Number(argVal('--timeout-min', '25')) * 60_000;
  const intervalMs = Number(argVal('--interval-sec', '20')) * 1000;
  // Head SHA the checks must belong to (post-rebase, post-push). Report it so the AI can VERIFY.
  const head = JSON.parse(gh(['pr', 'view', branch, '--json', 'headRefOid'])).headRefOid;
  const deadline = Date.now() + timeoutMs;
  let checks = [];
  while (Date.now() < deadline) {
    // gh pr checks exits non-zero when any check is failing/pending — capture regardless.
    let raw;
    try { raw = gh(['pr', 'checks', branch, '--json', 'name,state,bucket,link']); }
    catch (e) { raw = e.stdout || '[]'; }
    checks = JSON.parse(raw || '[]');
    const pending = checks.filter(c => c.bucket === 'pending' || c.state === 'IN_PROGRESS' || c.state === 'QUEUED');
    if (checks.length && !pending.length) {
      const failed = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel' || /FAIL|ERROR|TIMED_OUT/i.test(c.state));
      out({ step: 'ci-wait', branch, head, green: failed.length === 0, checks: checks.map(c => ({ name: c.name, state: c.state, bucket: c.bucket })) });
      process.exit(failed.length ? 1 : 0);
    }
    sleep(intervalMs);
  }
  out({ step: 'ci-wait', branch, head, green: false, timedOut: true, checks: checks.map(c => ({ name: c.name, state: c.state, bucket: c.bucket })) });
  process.exit(4);
}

else if (cmd === 'migration-diff') {
  if (!branch) fail(2, 'migration-diff needs <branch>');
  const path = rest[0];
  if (!path) fail(2, 'migration-diff needs <path>');
  git(['fetch', 'origin', '--prune']);
  const files = git(['diff', '--name-only', `origin/main...${branch}`, '--', path]).split('\n').map(s => s.trim()).filter(Boolean);
  out({ step: 'migration-diff', branch, path, hasMigration: files.length > 0, files });
  // exit 0 always — presence/absence is data, not pass/fail (the gate decides).
}

else fail(2, `unknown command: ${cmd}`);
