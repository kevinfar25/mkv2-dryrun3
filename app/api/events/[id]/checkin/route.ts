import { NextResponse } from "next/server";
import {
  checkIn,
  countCheckedIn,
  isForeignKeyViolation,
  isUndefinedColumn,
  isUndefinedTable,
  sessionBelongsToEvent,
  undoCheckIn,
} from "@/lib/store";
// Never trust the client: the body is validated here, not in the form component.
// Shared with the RSVP guards so the name rules cannot drift between the two.
import { checkInInput, type CheckInInput } from "@/lib/validation";

// Touches the DB → dynamic, or `next build` would evaluate it without DATABASE_URL.
export const dynamic = "force-dynamic";

// events.id is a `serial` (int4): an out-of-range id would make Postgres raise 22003
// (a 500) rather than match no rows, so reject it before it reaches the query. Same guard
// as app/api/events/[id]/rsvp/route.ts.
function parseEventId(id: string): number | null {
  const eventId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > 2147483647) return null;
  return eventId;
}

type Body = { ok: true; data: CheckInInput } | { ok: false; response: NextResponse };

async function readBody(request: Request): Promise<Body> {
  try {
    const result = checkInInput.safeParse(await request.json());
    if (!result.success) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: result.error.issues.map((i) => i.message).join("; ") },
          { status: 400 },
        ),
      };
    }
    return { ok: true, data: result.data };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }),
    };
  }
}

/**
 * Nothing matched the write. That is ALWAYS a 404 — a session that belongs to another
 * event must never surface as a 500 with a Postgres error code in it — but which 404 is
 * worth being honest about, so this asks (only on the failure path) which of the two it was.
 */
async function notFound(eventId: number, sessionId: number, inSession: boolean) {
  const belongs = await sessionBelongsToEvent(eventId, sessionId);
  if (!belongs) {
    return NextResponse.json(
      { error: "session not found for this event" },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { error: inSession ? "attendee not found in that session" : "attendee not found" },
    { status: 404 },
  );
}

/**
 * EXPAND/CONTRACT: this build is deployed BEFORE 20260727010000_sessions_checkin.sql can be
 * applied (the runner lives inside the deployed app), so on the live site `sessions` and
 * `attendees.checked_in_at` genuinely do not exist yet. That is a known, bounded window:
 * report it as unavailable rather than as a server fault — and NEVER as a 200, because a
 * write path must not pretend a badge scan was recorded.
 */
function mapWriteError(error: unknown) {
  if (isUndefinedTable(error) || isUndefinedColumn(error)) {
    return NextResponse.json({ error: "schema not yet applied" }, { status: 503 });
  }
  // The session was deleted between the update and the lookup above.
  if (isForeignKeyViolation(error)) {
    return NextResponse.json(
      { error: "session not found for this event" },
      { status: 404 },
    );
  }
  const message = error instanceof Error ? error.message : "check-in failed";
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Mark an attendee as arrived. Idempotent: a second scan returns 200 with the SAME timestamp. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const eventId = parseEventId(id);
  if (eventId === null) {
    return NextResponse.json({ error: "event not found" }, { status: 404 });
  }

  const body = await readBody(request);
  if (!body.ok) return body.response;
  const { name, sessionId } = body.data;

  try {
    const result = await checkIn(eventId, sessionId, name);
    if (!result) return await notFound(eventId, sessionId, false);
    const checkedInCount = await countCheckedIn(sessionId);
    return NextResponse.json({
      ok: true,
      name: result.name,
      sessionId,
      checkedInAt: result.checkedInAt,
      checkedInCount,
    });
  } catch (error) {
    return mapWriteError(error);
  }
}

/** Undo a check-in — the wrong badge was scanned. Clears checked_in_at. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const eventId = parseEventId(id);
  if (eventId === null) {
    return NextResponse.json({ error: "event not found" }, { status: 404 });
  }

  const body = await readBody(request);
  if (!body.ok) return body.response;
  const { name, sessionId } = body.data;

  try {
    const cleared = await undoCheckIn(eventId, sessionId, name);
    if (!cleared) return await notFound(eventId, sessionId, true);
    const checkedInCount = await countCheckedIn(sessionId);
    return NextResponse.json({
      ok: true,
      name,
      sessionId,
      checkedInAt: null,
      checkedInCount,
    });
  } catch (error) {
    return mapWriteError(error);
  }
}
