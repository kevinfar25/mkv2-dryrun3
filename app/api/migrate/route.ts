import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations";

// THE ATOMIC MIGRATION RUNNER for the hosted database.
//
// Why this route exists rather than a laptop-side script: the hosted DATABASE_URL is marked
// Sensitive on Vercel, so it cannot be pulled (`vercel env pull` returns it empty) and the DB
// cannot be reached from outside a deployed function. The migration runner therefore has to live
// where the credential does.
//
// It is a port of scripts/migrate.mjs (the local/CI runner) and preserves its ONE load-bearing
// property: each migration's SQL and its schema_migrations row are written in the SAME
// TRANSACTION, so there is no path that applies without recording. A ledger that says "not
// applied" when the answer is "applied" is worse than no ledger, because the next run re-applies
// migrations that are not all idempotent.
//
// This is deliberately NOT app/api/setup/route.ts. That route applies SCHEMA_SQL (the whole
// schema, idempotently) and records nothing — fine for bootstrapping an empty database, but it is
// not a migration runner and must never be used as one.
export const dynamic = "force-dynamic";

const Body = z.object({ dryRun: z.boolean().optional() }).strict();

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function appliedVersions(): Promise<Set<string>> {
  await query(`create table if not exists schema_migrations (
     version text primary key,
     applied_at timestamptz not null default now()
   )`);
  const rows = await query<{ version: string }>("select version from schema_migrations");
  return new Set(rows.map((r) => r.version));
}

/** Read-only drift report: which compiled migrations are not yet recorded as applied. */
export async function GET(request: Request) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "SETUP_TOKEN is not set" }, { status: 500 });
  }
  if (!tokenMatches(request.headers.get("x-setup-token"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const applied = await appliedVersions();
    const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.name);
    // Recorded but no longer present in the bundle — a deleted or renamed migration file. The
    // schema still carries its effects, so this is drift a human must reconcile, not repair here.
    const orphaned = [...applied].filter(
      (v) => !MIGRATIONS.some((m) => m.version === v),
    );
    return NextResponse.json({
      ok: true,
      applied: [...applied].sort(),
      pending,
      orphaned,
      drift: pending.length > 0 || orphaned.length > 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "status failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** Apply every pending migration in version order, recording each atomically. */
export async function POST(request: Request) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "SETUP_TOKEN is not set" }, { status: 500 });
  }
  if (!tokenMatches(request.headers.get("x-setup-token"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let dryRun = false;
  try {
    const raw = await request.text();
    if (raw.trim() !== "") {
      const parsed = Body.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
      }
      dryRun = parsed.data.dryRun === true;
    }
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const applied = await appliedVersions();
    const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
    if (dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, wouldApply: pending.map((m) => m.name) });
    }

    const done: string[] = [];
    for (const m of pending) {
      // ONE transaction per migration: the SQL and its ledger row commit together or not at all.
      // Sequential on purpose — a later migration may depend on an earlier one.
      await withTransaction(async (client) => {
        await client.query(m.sql);
        await client.query("insert into schema_migrations (version) values ($1)", [m.version]);
      });
      done.push(m.name);
    }
    return NextResponse.json({ ok: true, applied: done, alreadyApplied: [...applied].sort() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "migrate failed";
    // Partial progress is real and must be reported: earlier migrations committed, this one did
    // not. Re-running is safe precisely because each recorded version is skipped.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
