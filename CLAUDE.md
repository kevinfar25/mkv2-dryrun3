# CLAUDE.md — mkv2-dryrun3 (throwaway MK V2 dry-run sandbox)

A deliberately small, **UI-bearing** Next.js app used to exercise the Magic Kingdom V2
pipeline end-to-end — including the **real browser (Playwright) gate** that the API-only
`mkv2-dryrun2` could not. It is NOT a real product; it exists so the fleet → jig →
full-auto-deploy gates have a faithful, deployed-to-Vercel target to run against.

## What it is

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript strict, `pg` for Postgres,
  Zod for validation. Vitest for unit tests; **Playwright** for browser E2E.
- **App:** an Event RSVP board — list events, create an event, RSVP with a live attendee
  count, drill into an event's attendee list. Real pages + forms so the functional-test
  gates drive a real browser, not curl.
- **DB access** goes through `lib/db.ts` `query<T>()` — a **lazy** pool (never construct at
  import: an eager pool breaks `next build`, where `DATABASE_URL` is absent). SSL on for
  hosted (Neon/Vercel), off for localhost.

## Commands (from repo root)

```bash
npm ci
npm run typecheck        # tsc --noEmit
npm test                 # vitest run  (unit tests in tests/**)
npm run build            # next build
npm run check:migrations # migration-filename hygiene (db/migrations)
npm run migrate          # apply pending SQL to $DATABASE_URL
npm run seed             # migrate + apply db/seed.sql if present
PORT=<p> npm run dev     # dev server; there is NO secret-manager wrapping
npm run test:e2e         # Playwright (BASE_URL to drive a hosted URL; else local :3100)
```

There is no `doppler`/`infisical`/`vault` wrapping — `npm run dev` is already the
non-injecting dev command. There are **no external-write env keys** to neutralize.

## Migrations

- **Path:** `db/migrations/`, named `YYYYMMDD[HHMMSS]_snake_case.sql` (CI enforces the
  format + no duplicate version prefix via `scripts/check-migrations.mjs`).
- Applied-versions registry: `schema_migrations` (created by `scripts/migrate.mjs`).
- **Expand-only / expand-contract:** merging code and applying SQL are separate steps, so
  new code must run on the old schema and old code on the new — no `DROP`/`RENAME`/
  type-narrow on live objects in the same migration.

## Deploy & CI

- **Merging a PR to `main` IS the deploy** (this is a sandbox; Vercel auto-deploys `main`
  to production). `main` is protected by the `protect-main` ruleset: PRs required,
  non-fast-forward, no deletion, and two **required status checks matched by name** —
  `typecheck · test · build` and `migration hygiene` (`.github/workflows/ci.yml`).
- **Vercel:** project `kevinfar-gmailcoms-projects/mkv2-dryrun3`, GitHub-connected,
  auto-deploys `main`. **Free plan** → per-branch **preview URLs are auth-walled and
  cannot be bypassed**, so the drivable Playwright surface is the **production URL**
  (`https://mkv2-dryrun3.vercel.app`). On a paid plan both preview + prod are drivable.
- **`DATABASE_URL` is Sensitive** (Neon integration) → `vercel env pull` returns it EMPTY;
  the real value exists only at runtime. Run migrate/seed via the token-guarded
  `POST /api/setup` (header `x-setup-token: $SETUP_TOKEN`, body `{"seed":true}`) from the
  deployed function — never expect to migrate a hosted DB from your laptop.

## Testing surface (for the MK V2 functional gates)

- Browser-driving is **real Playwright**. Locally it serves `npm run start` on port 3100
  (not 3000 — that's often taken; reusing it silently drives the wrong app). Against the
  hosted deploy, set `BASE_URL=https://mkv2-dryrun3.vercel.app`.
- Prod is an **owned sandbox** (no live customer), so back-gate D4 may run the FULL
  write-bearing functional pass on the production URL — not just read-only smoke.
