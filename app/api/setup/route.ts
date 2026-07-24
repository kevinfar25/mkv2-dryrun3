import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query, withTransaction } from "@/lib/db";
import { SCHEMA_SQL, SEED_EVENTS } from "@/lib/schema";

// Touches the DB → must be dynamic, or `next build` would try to run it without
// DATABASE_URL. The pool in lib/db.ts is lazy for the same reason.
export const dynamic = "force-dynamic";

// Fixed key for the seed advisory lock. Any constant works as long as this route is the
// only holder — it just has to be the SAME constant in every concurrent seed call.
const SEED_LOCK_KEY = 728_140_193_001n;

const SetupBody = z.object({ seed: z.boolean().optional() }).strict();

/** Length-checked constant-time compare — timingSafeEqual throws on unequal lengths. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.SETUP_TOKEN;
  // No token configured → refuse rather than expose an unauthenticated schema apply.
  if (!expected) {
    return NextResponse.json({ ok: false, error: "SETUP_TOKEN is not set" }, { status: 500 });
  }
  if (!tokenMatches(request.headers.get("x-setup-token"), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // A missing/empty body is a valid "no seed" call — the orchestrator posts both ways.
  // Anything that IS sent must be a valid object: malformed JSON, `[]`, {"seed":"true"}
  // are 400 rather than a silent 200.
  const raw = await request.text();
  let seed = false;
  if (raw.trim() !== "") {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = SetupBody.safeParse(parsedJson);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
    }
    seed = parsed.data.seed === true;
  }

  try {
    await query(SCHEMA_SQL);

    let seeded = 0;
    if (seed) {
      // The not-exists check below is check-then-insert, so two concurrent seed calls
      // could both see "no row" and both insert (there is deliberately no unique
      // constraint on events — real events may share a title+time). A transaction-scoped
      // advisory lock serializes seeders: the second call blocks until the first commits,
      // then its not-exists check sees the committed rows and inserts nothing.
      seeded = await withTransaction(async (client) => {
        await client.query("select pg_advisory_xact_lock($1::bigint)", [
          SEED_LOCK_KEY.toString(),
        ]);
        let inserted = 0;
        for (const event of SEED_EVENTS) {
          const res = await client.query(
            `insert into events (title, starts_at, location)
             select $1, $2::timestamptz, $3
             where not exists (
               select 1 from events where title = $1 and starts_at = $2::timestamptz
             )
             returning id`,
            [event.title, event.startsAt, event.location],
          );
          inserted += res.rowCount ?? 0;
        }
        return inserted;
      });
    }

    return NextResponse.json({ ok: true, schema: "applied", seeded });
  } catch (error) {
    const message = error instanceof Error ? error.message : "setup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
