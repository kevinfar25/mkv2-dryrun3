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
  type-narrow on live objects in the same migration. Every hard constraint (a `NOT NULL` on
  a column the running build does not populate, dropping a superseded column) is a **later
  contract migration**, never part of the expand.
- **The atomic runner is the only sanctioned way to apply to the hosted DB:**

  ```bash
  npm run prod:migrate:status   # read-only drift report (exit 1 on drift)
  npm run prod:migrate:dry      # what an apply WOULD do, without applying
  npm run prod:migrate:apply    # applies SQL + writes the schema_migrations row in ONE transaction
  ```

  `scripts/prod-migrate.mjs` → `POST /api/migrate`, applying pending migrations in version
  order, each atomically. Migrations reach the deployed bundle through the **generated**
  `lib/migrations.ts` (`npm run gen:migrations`) — a serverless bundle excludes files nobody
  imports, so reading `db/migrations/` at runtime does not work in production.
- ⛔ **`POST /api/setup` is NOT a migration runner.** It applies all of `SCHEMA_SQL` and
  records **nothing**, so the registry then reports live migrations as still pending and the
  next apply re-runs them. It is for first-time schema creation and seeding only. `psql -f`
  cannot reach this database at all.
- ⚠ **Apply necessarily follows deploy here.** The runner lives inside the deployed app
  (because `DATABASE_URL` is Sensitive), so a migration can only be applied *after* the code
  carrying it is deployed. That inverts the usual "expand before merge" ordering — and it
  makes expand/contract stricter, not looser: a migration here is **guaranteed** to be applied
  while the previous build is still serving traffic.

## Deploy & CI

- **Merging a PR to `main` IS the deploy** (this is a sandbox; Vercel auto-deploys `main`
  to production). `main` is protected by the `protect-main` ruleset: PRs required,
  non-fast-forward, no deletion, and three **required status checks matched by name** —
  `typecheck · test · build`, `migration hygiene` and `lint` (`.github/workflows/ci.yml`).
  Renaming a CI job silently detaches it from the ruleset, so don't.
- The ruleset is **strict** (`strict_required_status_checks_policy: true`) and
  `allow_update_branch` is **false**. So every merge puts every other open PR `BEHIND`, and
  auto-merge will *not* resync it — it arms and then waits on a condition nothing satisfies,
  which reads like slow CI rather than a stall. Only `gh pr update-branch <n>` unblocks it,
  and that restarts the full CI run. Walk a batch through one PR at a time.
- `npm run test:e2e` (Playwright) exists but **CI does not run it** — the browser gate lives
  in the MK V2 jig, not in the required checks. A later change can break e2e with CI green.
- **Vercel:** project `kevinfar-gmailcoms-projects/mkv2-dryrun3`, GitHub-connected,
  auto-deploys `main`. **Free plan** → per-branch **preview URLs are auth-walled and
  cannot be bypassed**, so the drivable Playwright surface is the **production URL**
  (`https://mkv2-dryrun3.vercel.app`). On a paid plan both preview + prod are drivable.
- **`DATABASE_URL` is Sensitive** (Neon integration) → `vercel env pull` returns it EMPTY;
  the real value exists only at runtime. Apply **migrations** with
  `npm run prod:migrate:apply` (see Migrations above). Seed / create the schema from scratch
  with the token-guarded `POST /api/setup` (header `x-setup-token: $SETUP_TOKEN`, body
  `{"seed":true}`) — **seeding only, it records no migration versions** — from the
  deployed function — never expect to migrate a hosted DB from your laptop.

## Testing surface (for the MK V2 functional gates)

- Browser-driving is **real Playwright**. Locally it serves `npm run start` on port 3100
  (not 3000 — that's often taken; reusing it silently drives the wrong app). Against the
  hosted deploy, set `BASE_URL=https://mkv2-dryrun3.vercel.app`.
- Prod is an **owned sandbox** (no live customer), so back-gate D4 may run the FULL
  write-bearing functional pass on the production URL — not just read-only smoke.
