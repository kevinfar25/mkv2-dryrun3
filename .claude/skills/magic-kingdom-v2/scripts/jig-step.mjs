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
//   node jig-step.mjs ci-wait <branch> [--timeout-min 25] [--interval-sec 20] [--require a,b,c]
//        # Polls checks that are BOUND TO THE PR's CURRENT HEAD SHA and reports per-check.
//        # This is the anti-stale-green step: `gh pr checks` reports a PR's checks without
//        # telling you WHICH COMMIT they ran on, so straight after a force-push the previous
//        # run's already-concluded checks look like an all-green PR. So we ask the commit
//        # instead — `repos/:owner/:repo/commits/<head>/{check-runs,status}` — and additionally
//        # (a) refuse to call an EMPTY check set green (workflows may not have registered yet),
//        # (b) re-read the head SHA each poll and abort if it moved under us,
//        # (c) with --require, refuse green unless every named required check is PRESENT and
//        #     successful on that SHA (use the CI check names detected in SKILL.md Step 2).
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

// Positional args must be read with the FLAGS REMOVED. Taking them by raw index meant
// `migration-diff <branch> --cwd <dir>` bound the path to the literal string "--cwd": the diff
// then matched nothing and the step reported `hasMigration:false` with exit 0. That is a false
// negative on the migration safety gate — the back gate concludes the branch carries no schema
// change and skips the screen entirely. Flags may appear anywhere, so strip them first.
const FLAGS_WITH_VALUE = new Set(['--cwd', '--timeout-min', '--interval-sec', '--require']);
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) { i++; continue; }     // skip the flag AND its value
    if (a.startsWith('--')) continue;                    // unknown/boolean flag
    out.push(a);
  }
  return out;
}
const [cmd, branch, ...rest] = positionals(process.argv.slice(2));
if (!cmd) fail(2, 'usage: node jig-step.mjs <rebase|push|ci-wait|migration-diff> <branch> ...');

// The jig runs one branch at a time in its own worktree, and `git rebase`/`git push` act on
// whatever is CHECKED OUT — not on the name you passed. Run from the wrong worktree and you
// rebase someone else's branch while reporting success for this one (then `push <branch>`
// pushes an untouched ref and ci-wait inspects a stale-green PR). So: assert them equal.
function assertOnBranch(branch) {
  const cur = git(['branch', '--show-current']).trim();
  if (cur !== branch) fail(2,
    `wrong checkout: ${CWD} is on '${cur || '(detached HEAD)'}' but the command targets '${branch}'. ` +
    `Run this in that branch's worktree (or pass --cwd <its worktree>).`);
  return cur;
}

if (cmd === 'rebase') {
  if (!branch) fail(2, 'rebase needs <branch>');
  assertOnBranch(branch);
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
  assertOnBranch(branch);   // otherwise the reported `head` is a different branch's HEAD
  const r = gitTry(['push', '--force-with-lease', 'origin', branch]);
  if (!r.ok) { out({ step: 'push', branch, ok: false, detail: r.out.trim().slice(-400) }); process.exit(1); }
  out({ step: 'push', branch, ok: true, head: git(['rev-parse', 'HEAD']).trim() });
}

else if (cmd === 'ci-wait') {
  if (!branch) fail(2, 'ci-wait needs <branch>');
  const timeoutMs = Number(argVal('--timeout-min', '25')) * 60_000;
  const intervalMs = Number(argVal('--interval-sec', '20')) * 1000;
  const required = (argVal('--require', '') || '').split(',').map(s => s.trim()).filter(Boolean);

  const headOf = () => {
    let raw;
    try { raw = gh(['pr', 'view', branch, '--json', 'headRefOid']); }
    catch (e) { fail(2, `cannot resolve a PR for ${branch}: ` + ((e.stderr || e.stdout || '').trim().slice(-300))); }
    return JSON.parse(raw).headRefOid;
  };
  // Head SHA the checks MUST belong to (post-rebase, post-push).
  const head = headOf();

  // Checks bound to THIS commit: modern check-runs + legacy commit statuses. Normalized to
  // {name, status:'completed'|'pending', conclusion}. An API hiccup returns null (≠ empty).
  const checksFor = (sha) => {
    const rows = [];
    try {
      const cr = JSON.parse(gh(['api', `repos/:owner/:repo/commits/${sha}/check-runs?per_page=100`]));
      for (const c of cr.check_runs || [])
        rows.push({ name: c.name, status: c.status, conclusion: c.conclusion, kind: 'check-run' });
    } catch (e) { return null; }
    try {
      const st = JSON.parse(gh(['api', `repos/:owner/:repo/commits/${sha}/status?per_page=100`]));
      // The COMBINED endpoint already reports the latest status per context, but an external
      // provider that posts a context twice (failed attempt → successful retry) must never leave
      // the stale failure in play. Keep the newest per context explicitly.
      const latest = new Map();
      for (const s of st.statuses || []) {
        const prev = latest.get(s.context);
        if (!prev || new Date(s.created_at || 0) >= new Date(prev.created_at || 0)) latest.set(s.context, s);
      }
      for (const s of latest.values())
        rows.push({
          name: s.context,
          status: s.state === 'pending' ? 'queued' : 'completed',
          conclusion: s.state === 'pending' ? null : (s.state === 'success' ? 'success' : 'failure'),
          kind: 'status',
        });
    } catch { /* legacy statuses are optional */ }
    return rows;
  };

  const OK = new Set(['success', 'neutral', 'skipped']);
  const deadline = Date.now() + timeoutMs;
  let checks = [], lastReason = 'no checks reported yet for this SHA';

  while (Date.now() < deadline) {
    // (b) the SHA must not move under us — a moved head invalidates everything below.
    const nowHead = headOf();
    if (nowHead !== head) {
      out({ step: 'ci-wait', branch, head, headChanged: nowHead, green: false, reason: 'PR head moved during the wait — re-run ci-wait against the new SHA' });
      process.exit(1);
    }

    const rows = checksFor(head);
    if (rows === null) { lastReason = 'check-runs API call failed'; sleep(intervalMs); continue; }
    checks = rows;

    const pending = rows.filter(c => c.status !== 'completed');
    // (a) an EMPTY set is NOT green — workflows may not have registered yet.
    if (!rows.length) { lastReason = 'no checks bound to this SHA yet'; sleep(intervalMs); continue; }
    if (pending.length) { lastReason = `pending: ${pending.map(c => c.name).join(', ')}`; sleep(intervalMs); continue; }

    const failed = rows.filter(c => !OK.has(c.conclusion));
    // (c) every named required check must be PRESENT on this SHA *and* conclude exactly
    // `success`. `neutral`/`skipped` are tolerated for incidental checks but NEVER for a
    // required one: a skipped required job means the gate did not run, and on this kind of repo
    // the required checks are the only automated barrier in front of a production deploy.
    const requiredEvidence = required.map(r => ({
      name: r,
      conclusions: rows.filter(c => c.name === r).map(c => c.conclusion),
    }));
    const requiredNotSuccess = requiredEvidence.filter(e => !e.conclusions.includes('success'));
    const green = !failed.length && !requiredNotSuccess.length;
    out({
      step: 'ci-wait', branch, head, green,
      failed: failed.map(c => ({ name: c.name, conclusion: c.conclusion })),
      requiredNotSuccess,          // absent, skipped, neutral or failed required checks
      requiredEvidence,
      checks: rows.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    });
    process.exit(green ? 0 : 1);
  }

  out({ step: 'ci-wait', branch, head, green: false, timedOut: true, reason: lastReason, checks });
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
