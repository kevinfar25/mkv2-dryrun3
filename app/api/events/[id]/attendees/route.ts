import { NextResponse } from "next/server";
import { getEvent, isUndefinedTable, listAttendees } from "@/lib/store";

// Reads the DB → dynamic, or `next build` would evaluate it without DATABASE_URL.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Only a plain positive integer is a real id — "abc" or "1e3" is a 404, not a query.
  const eventId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  // events.id is a `serial` (int4): an out-of-range id would make Postgres raise 22003
  // (a 500) rather than match no rows, so reject it before it reaches the query.
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > 2147483647) {
    return NextResponse.json({ error: "event not found" }, { status: 404 });
  }

  try {
    const event = await getEvent(eventId);
    if (!event) {
      return NextResponse.json({ error: "event not found" }, { status: 404 });
    }

    // ONE query for the whole list (lib/store.ts listAttendees) — no per-row fan-out.
    // The body is the LIST itself (most-recent-first), per the phase task.
    const attendees = await listAttendees(eventId);
    return NextResponse.json(attendees);
  } catch (error) {
    // EXPAND/CONTRACT: this is a pure READ, so the pre-/api/setup window (attendees
    // does not exist yet) must degrade to an empty list, never a 500. listAttendees
    // already swallows 42P01; this is the belt-and-braces for the getEvent call above
    // in case `events` itself is missing too.
    if (isUndefinedTable(error)) {
      return NextResponse.json([]);
    }
    const message = error instanceof Error ? error.message : "attendee lookup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
