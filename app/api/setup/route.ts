import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { SCHEMA_SQL, SEED_EVENTS } from "@/lib/schema";

// Touches the DB → must be dynamic, or `next build` would try to run it without
// DATABASE_URL. The pool in lib/db.ts is lazy for the same reason.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const expected = process.env.SETUP_TOKEN;
  // No token configured → refuse rather than expose an unauthenticated schema apply.
  if (!expected) {
    return NextResponse.json({ ok: false, error: "SETUP_TOKEN is not set" }, { status: 500 });
  }
  if (request.headers.get("x-setup-token") !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let seed = false;
  try {
    const body: unknown = await request.json();
    seed = typeof body === "object" && body !== null && (body as { seed?: unknown }).seed === true;
  } catch {
    // No/!JSON body — treat as {"seed": false} and just apply the schema.
  }

  try {
    await query(SCHEMA_SQL);

    let seeded = 0;
    if (seed) {
      for (const event of SEED_EVENTS) {
        // Idempotent without a unique constraint (the migration adds none):
        // insert only when that title+start is absent, so re-running is a no-op.
        const rows = await query<{ id: number }>(
          `insert into events (title, starts_at, location)
           select $1, $2::timestamptz, $3
           where not exists (
             select 1 from events where title = $1 and starts_at = $2::timestamptz
           )
           returning id`,
          [event.title, event.startsAt, event.location],
        );
        seeded += rows.length;
      }
    }

    return NextResponse.json({ ok: true, schema: "applied", seeded });
  } catch (error) {
    const message = error instanceof Error ? error.message : "setup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
