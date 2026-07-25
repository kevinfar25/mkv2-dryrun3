import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { SCHEMA_SQL, SEED_EVENTS, SEED_SESSIONS } from "@/lib/schema";

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
  // are 400 rather than a silent 200. The body READ is inside the try too: if the request
  // stream fails mid-read, request.text() rejects and that is a bad request, not a 500.
  let seed = false;
  try {
    const raw = await request.text();
    if (raw.trim() !== "") {
      const parsed = SetupBody.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return NextResponse.json({ ok: false, error: "invalid body" }, { status: 400 });
      }
      seed = parsed.data.seed === true;
    }
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  try {
    // ONE transaction, ONE lock, taken as the FIRST statement — it covers the schema
    // apply as well as the seed. `CREATE TABLE IF NOT EXISTS` is not concurrency-safe:
    // two first-ever calls against an empty DB can both pass the existence check and one
    // then fails with a duplicate-object error on the system catalog. Holding the advisory
    // lock across the whole bootstrap serializes that; the second caller blocks until the
    // first commits, then sees the table (and the seeded rows) and does nothing.
    const seeded = await withTransaction(async (client) => {
      await client.query("select pg_advisory_xact_lock($1::bigint)", [
        SEED_LOCK_KEY.toString(),
      ]);

      await client.query(SCHEMA_SQL);

      if (!seed) return 0;

      // The not-exists check below is check-then-insert, so two concurrent seed calls
      // could both see "no row" and both insert (there is deliberately no unique
      // constraint on events — real events may share a title+time). The lock above is
      // what makes this safe.
      // It matches the FULL seed identity — title AND starts_at AND location — the same
      // predicate the session loop below uses. On title+starts_at alone, an unrelated event
      // sharing a seed event's title and timestamp but not its location would suppress the
      // real seed event, and the session loop would then find no full-identity match and
      // seed no sessions at all, breaking fresh-bootstrap parity.
      let inserted = 0;
      for (const event of SEED_EVENTS) {
        const res = await client.query(
          `insert into events (title, starts_at, location)
           select $1, $2::timestamptz, $3
           where not exists (
             select 1 from events
              where title = $1 and starts_at = $2::timestamptz and location = $3
           )
           returning id`,
          [event.title, event.startsAt, event.location],
        );
        inserted += res.rowCount ?? 0;
      }

      // X1 — the demo sessions, for FRESH-BOOTSTRAP PARITY ONLY. The hosted database gets
      // these from the migration itself (20260727010000), which is the only path that records
      // a version; this route records nothing and is not used by this run. Leaving it
      // events-only would make a from-scratch database disagree with a migrated one.
      // Keyed on the seed event's FULL identity — title AND starts_at AND location, all bound,
      // never the title alone: events carries no unique constraint on title (see the comment
      // above), so a title-only match would hand these fixed demo dates and rooms to a real,
      // unrelated event that merely shares the name. starts_at is compared as a timestamptz.
      // Plus the case-insensitive session title, so it is idempotent and a no-op when the seed
      // event does not exist — the same predicate as the migration's fixture. Inside the SAME
      // advisory-locked transaction as the events above.
      for (const session of SEED_SESSIONS) {
        const res = await client.query(
          `insert into sessions (event_id, title, starts_at, room)
           select e.id, $4, $5::timestamptz, $6::text
             from events e
            where e.title = $1
              and e.starts_at = $2::timestamptz
              and e.location = $3
              and not exists (
                select 1 from sessions s
                 where s.event_id = e.id and lower(s.title) = lower($4)
              )
           on conflict do nothing
           returning id`,
          [
            session.eventTitle,
            session.eventStartsAt,
            session.eventLocation,
            session.title,
            session.startsAt,
            session.room,
          ],
        );
        inserted += res.rowCount ?? 0;
      }
      return inserted;
    });

    return NextResponse.json({ ok: true, schema: "applied", seeded });
  } catch (error) {
    const message = error instanceof Error ? error.message : "setup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
