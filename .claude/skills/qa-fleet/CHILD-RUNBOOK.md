# QA Pipeline Child Runbook (per-group worktree instance)

You are an autonomous QA-fix instance running ONE group in your OWN git worktree.
The orchestrator launched you via `claude --dangerously-skip-permissions -w <worktree>`,
so you are ALREADY inside your worktree checkout. Follow these steps EXACTLY and
autonomously (do not pause for approval — branch + commit + push branch + open PR is
pre-authorized; NEVER merge, NEVER push to main, NEVER move Kanban cards).

The orchestrator gives you these PARAMS in the launch prompt:
- `MAINREPO` = /Users/kevinfarrugia/Documents/Github/goose  (the primary checkout)
- `GROUP`    = e.g. g1
- `WORKTREE` = e.g. reopen-g1   (you are in MAINREPO/.claude/worktrees/<WORKTREE>)
- `DBNAME`   = e.g. goose_g1
- `PORT`     = e.g. 3025
- `BRANCH`   = e.g. fix/reopen-g1-profile
- `SPEC`     = absolute path to your group's spec, under MAINREPO/reports/
- `SKIP_BUILD` = 0 (implement gap groups) or 1 (verify-only groups) — given per group

## 0. Confirm location
`pwd` must end in `/.claude/worktrees/<WORKTREE>`. `git rev-parse --abbrev-ref HEAD`
should show your worktree branch (claude -w made one). Rename/checkout to `BRANCH`:
`git checkout -B "$BRANCH"`.

## 1. Create the worktree .env.local (worktrees do NOT inherit it; dotenv is FIRST-WINS)
Copy the base env, then REPLACE (not append) the data var so it points at YOUR Docker DB,
and BLANK the external-side-effect keys:
```
cp "$MAINREPO/.env.local" ./.env.local
# Replace DATABASE_URL with your isolated Docker prod-copy DB:
#   postgresql://postgres:localqa@127.0.0.1:55432/<DBNAME>
# Use a tool that REPLACES the existing line (sed -i ''), do not append a 2nd line.
# BLANK these (set to empty), do not delete:  SERVICETITAN_APP_KEY=   RESEND_API_KEY=
```
Leave `NEXT_PUBLIC_SUPABASE_*` pointed at prod (JS client only needs to construct; no writes).
Verify: `grep -E '^DATABASE_URL=' .env.local` shows 127.0.0.1:55432/<DBNAME> exactly once.

**⚠️ `.env.local` is OVERRIDDEN by a secret-manager-wrapped dev command.** This repo wraps
`npm run dev` in `doppler run --`, which injects the **prod** `DATABASE_URL` (and real
`RESEND`/`SERVICETITAN` keys) into the process env *before* Next.js reads `.env.local` —
and Next.js won't override an already-set var. So `npm run dev` and any doppler-wrapped
`run.sh` connect to **PROD**, and your blanked keys are re-injected. Your `.env.local`
sandbox only takes effect under the **non-wrapped** command (`npm run dev:nodoppler`, or
`PORT=<PORT> next dev`). Boot ONLY with the non-wrapped command, and before ANY write in
verification, prove the live server is on your Docker DB (health/debug route or a one-row
query showing host `127.0.0.1:55432`, not the supabase pooler). If you can't prove local,
STOP — do not write. (A real run leaked XP grants / practice sessions to prod test accounts
this way.)

## 2. Patch playwright.config.ts to use YOUR PORT (worktree-local; REVERT before commit)
Make `webServer.command`, `webServer.url`, and `use.baseURL` read `process.env.PORT`
(default to YOUR `PORT`). Example: command `PORT=${process.env.PORT||<PORT>} npm run dev`,
url/baseURL `http://localhost:${process.env.PORT||<PORT>}`. This is the documented
:3005 reuseExistingServer trap — if PORT doesn't propagate, the suite silently latches
onto a stray :3005 server and tests the WRONG code. NEVER kill a port you didn't start.

## 3. Run the pipeline (YOUR worktree's own run.sh — cwd discipline matters)
From the worktree root:
```
STAGE_TIMEOUT=3600 SKIP_BUILD=<0|1> SPEC="$SPEC" WIZARD=0 STREAM=0 \
  PORT=<PORT> BASE_URL=http://localhost:<PORT> ./.claude/pipeline/run.sh
```
Confirm the `root:` banner printed at startup matches YOUR worktree path (not MAINREPO).
Stage 0 implements the spec (only if SKIP_BUILD=0); Stages 1→2 test; Stage 3 runs only if
Stage 2 sets stage3_required. Artifacts land in YOUR `reports/run-<ts>/`.

## 4. Review the diff AND verify on the REAL screen (do NOT trust "tests passed" alone)
`git diff` for your group. Then boot YOUR server with the NON-doppler command:
`PORT=<PORT> npm run dev:nodoppler` (NEVER `npm run dev` — that is doppler-wrapped and hits
PROD, see §1). Immediately prove the server is on your Docker DB (e.g. a health/debug route
or one-row query showing `127.0.0.1:55432/<DBNAME>`) BEFORE any write-action. Then, once
`/login` responds, with the dev cookie `dev_user_id` (rep `00000000-0000-0000-0000-000000000001`,
or manager `...0002` for manager screens) take a Playwright element screenshot at each
ticket's repro path and assert the defect is gone. For data/calc tickets, load the real
screen as the row's actual owner and assert the rendered value. Run the full suite once:
`PORT=<PORT> npx playwright test`. A `.mjs` Playwright probe MUST live inside the worktree
tree (not /tmp) or `import 'playwright'` fails.
Confirm your dev server's cwd is YOUR worktree before trusting results:
`lsof -a -d cwd -p $(lsof -ti TCP:<PORT> -sTCP:LISTEN)`.

## 5. Acceptance report — write to MAINREPO/reports/ (so the orchestrator collects it)
Write `"$MAINREPO/reports/acceptance_<GROUP>_<tickets>.md"` using the template in
MAINREPO/.claude/skills/qa-fleet/ACCEPTANCE-TEMPLATE.md — one section per ticket: Before/After,
exact test-it-yourself URL + login, single-sentence pass condition, a sanity
"still-works" check, and the spec filename + suite count. Resolve REAL URLs/creds
(prod heygoose.com + role account, or the local dev cookie) — no placeholders.

## 6. PR (only if verification PASSED and there IS a diff)
- FIRST revert the playwright.config.ts PORT patch (step 2) so it is NOT in the PR.
- Stage ONLY intended files (component/page/route/new tests). NEVER stage reports/, .env*,
  or the playwright.config patch.
- Commit. End the message with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `git push -u origin "$BRANCH"` then `gh pr create` (base main). PR body: per-ticket
  root cause + fix + verification evidence; end with `🤖 Generated with Claude Code`.
- DO NOT merge.

## 7. If verification FAILED or there is NO diff
- No diff (already fixed + adequately tested): do NOT open a PR. Acceptance report records
  "verified fixed, no code change needed — recommend Open→Fixed (verify on prod/preview)".
- Failed: do NOT open a PR. Leave the branch, record what failed in the acceptance report.

## 8. Report back
Print a final summary line: `GROUP=<g> RESULT=<pr-opened #N | verified-no-diff | failed>
PR=<url|none> ACCEPTANCE=<path> NOTES=<one line>`. Then stop.
