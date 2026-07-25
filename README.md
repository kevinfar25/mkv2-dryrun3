# mkv2-dryrun3

Throwaway sandbox to dry-run **Magic Kingdom V2** end-to-end against a **UI-bearing**
Next.js + Postgres app deployed to Vercel — exercising the real Playwright browser gate.

An Event RSVP board: list events, create events, RSVP with a live attendee count, drill
into an event's attendees. Built phase-by-phase by the MK V2 fleet on top of this baseline.

See `CLAUDE.md` for stack, commands, migrations, and the Vercel free-plan deploy flow.

## Worktrees need their own dependencies

`git worktree add` creates a checkout with **no `node_modules`**, and the tooling in this repo is
all local (`npx tsc`, `eslint`, `vitest`, `playwright`). Run `npm ci` inside each worktree.

Do **not** symlink a shared `node_modules` from another checkout. It was tried during the MK V2
dry run and cost real time twice over:

1. `.gitignore` listed `node_modules/` with a trailing slash, which matches a directory but **not a
   symlink of that name** — so `git add -A` in the worktree committed the symlink, and it reached
   `main`. Both spellings are now ignored and a test guards it.
2. Re-pointing that symlink while it already resolved to the target produced a self-referential
   loop, and every local binary died with "too many levels of symbolic links". Recovering meant a
   full reinstall.

One `npm ci` per worktree takes about a minute and has none of these failure modes.
