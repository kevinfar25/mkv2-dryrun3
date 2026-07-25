import { NextResponse } from "next/server";
import {
  getEvent,
  isForeignKeyViolation,
  isUndefinedTable,
  listSessions,
  rsvp,
  rsvpCount,
} from "@/lib/store";
// Never trust the client: the body is validated here, not in the form component.
// Shared with the event guards so the NUL rejection cannot drift between the two.
import { rsvpInput, type RsvpInput } from "@/lib/validation";

// Touches the DB → dynamic, or `next build` would evaluate it without DATABASE_URL.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const eventId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  // events.id is a `serial` (int4): an out-of-range id would make Postgres raise 22003
  // (a 500) rather than match no rows, so reject it before it reaches the query.
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > 2147483647) {
    return NextResponse.json({ error: "event not found" }, { status: 404 });
  }

  let parsed: RsvpInput;
  try {
    const result = rsvpInput.safeParse(await request.json());
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues.map((i) => i.message).join("; ") },
        { status: 400 },
      );
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const event = await getEvent(eventId);
    if (!event) {
      return NextResponse.json({ error: "event not found" }, { status: 404 });
    }

    // X2 — sessionId is CONDITIONALLY REQUIRED, and this is the only place that can decide
    // it: the rule depends on how many sessions the event has, which the Zod schema cannot
    // see. listSessions is ONE aggregate query and degrades to [] on the pre-migration
    // schema, so on the live site (no `sessions` table yet) this evaluates to "zero
    // sessions" and the existing single-field form keeps working byte-for-byte.
    const sessions = await listSessions(eventId);
    if (sessions.length > 0 && parsed.sessionId === undefined) {
      // NOT merely optional: accepting the omission here would write a session-less
      // attendee who can never be checked in and whom X4 would undercount.
      return NextResponse.json(
        { error: "sessionId is required for an event with sessions" },
        { status: 400 },
      );
    }
    if (parsed.sessionId !== undefined && !sessions.some((s) => s.id === parsed.sessionId)) {
      // A session of ANOTHER event (or of no event) is a 404 — the same rule as check-in,
      // and never a 500 leaking a foreign-key violation.
      return NextResponse.json(
        { error: "session not found for this event" },
        { status: 404 },
      );
    }

    // ON CONFLICT DO NOTHING: a repeat RSVP (same event, same name, any case) is a
    // no-op that returns the UNCHANGED count — never a 500.
    const created = await rsvp(eventId, parsed.name, parsed.sessionId ?? null);
    const count = await rsvpCount(eventId);
    return NextResponse.json({ ok: true, created, count });
  } catch (error) {
    // EXPAND/CONTRACT: merged code deploys BEFORE POST /api/setup applies the new
    // schema. Until then `attendees` does not exist — that is a known, bounded window,
    // so report it honestly as unavailable rather than as a server fault.
    if (isUndefinedTable(error)) {
      return NextResponse.json({ error: "schema not yet applied" }, { status: 503 });
    }
    // Event deleted between the existence check and the insert.
    if (isForeignKeyViolation(error)) {
      return NextResponse.json({ error: "event not found" }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : "rsvp failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
