import { NextResponse } from "next/server";
import { createEvent, listEvents } from "@/lib/store";
import { parseEventInput } from "@/lib/validation";

// Reads/writes the DB → must be dynamic. `next build` has no DATABASE_URL and the pool
// in lib/db.ts is lazy for the same reason.
export const dynamic = "force-dynamic";

/** Newest first — the ordering is store-side (single query, no per-row fan-out). */
export async function GET() {
  const events = await listEvents();
  return NextResponse.json({ events });
}

export async function POST(request: Request) {
  // A malformed body is a client error, not a 500 — read + parse inside the try.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Never trust the client: everything goes through the Zod schema, and the parsed
  // (trimmed, typed) value — not `raw` — is what reaches the parameterized insert.
  const parsed = parseEventInput(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid input", errors: parsed.errors }, { status: 400 });
  }

  const event = await createEvent(parsed.data);
  return NextResponse.json({ event }, { status: 201 });
}
