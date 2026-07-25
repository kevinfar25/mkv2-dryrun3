import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getEvent,
  isForeignKeyViolation,
  isUndefinedTable,
  rsvp,
  rsvpCount,
} from "@/lib/store";

// Touches the DB → dynamic, or `next build` would evaluate it without DATABASE_URL.
export const dynamic = "force-dynamic";

// Never trust the client: the body is validated here, not in the form component.
const RsvpBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(120, "name must be 120 characters or fewer"),
  })
  .strict();

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

  let parsed: z.infer<typeof RsvpBody>;
  try {
    const result = RsvpBody.safeParse(await request.json());
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

    // ON CONFLICT DO NOTHING: a repeat RSVP (same event, same name, any case) is a
    // no-op that returns the UNCHANGED count — never a 500.
    const created = await rsvp(eventId, parsed.name);
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
