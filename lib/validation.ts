import { z } from "zod";

// Postgres `text` cannot hold a NUL byte — an INSERT carrying one dies with
// `invalid byte sequence for encoding "UTF8": 0x00`. .trim() does not strip it, so
// without this check a NUL passes validation and only fails at INSERT: a 500 where the
// contract promises a 400. Only U+0000 is rejected; all other unicode is storable.
const noNulByte = (value: string) => !value.includes("\u0000");
const NUL_MESSAGE = "must not contain a NUL character";

// ISO 8601 permits UTC offsets out to +/-23:59 and a year 0000; timestamptz accepts
// neither (offsets cap at +/-15:59, and the calendar Postgres implements has no year
// zero). Same reasoning as the NUL check: reject here, or the INSERT throws.
const STORABLE_TIMESTAMPTZ = /^(?!0000)\d{4}-.*(?:Z|[+-](?:0\d|1[0-5]):\d{2})$/;

// Server-side validation for event input. API routes must run every request body
// through parseEventInput and answer 400 on failure — never trust the client.
export const eventInput = z.object({
  title: z
    .string()
    .trim()
    .min(1, "title is required")
    .max(120, "title must be 120 characters or fewer")
    .refine(noNulByte, `title ${NUL_MESSAGE}`),
  startsAt: z.iso
    .datetime({ offset: true, message: "startsAt must be an ISO 8601 datetime" })
    .refine(
      (value) => STORABLE_TIMESTAMPTZ.test(value),
      "startsAt must be year 0001 or later with a UTC offset within +/-15:59",
    ),
  location: z
    .string()
    .trim()
    .min(1, "location is required")
    .max(160, "location must be 160 characters or fewer")
    .refine(noNulByte, `location ${NUL_MESSAGE}`),
});

export type EventInput = z.infer<typeof eventInput>;

// The attendee-name rule, extracted so the RSVP body and the X2 check-in body cannot
// drift apart: one definition, same trim/length/NUL guarantees on every write path.
const attendeeName = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(120, "name must be 120 characters or fewer")
  .refine(noNulByte, `name ${NUL_MESSAGE}`);

// sessions.id is a `serial` (int4). An id outside that range makes Postgres raise 22003
// — a 500 where the contract promises a 4xx — so the range is part of the schema, exactly
// as the route-level id guard is for events.
const SESSION_ID_MAX = 2147483647;
const sessionId = z
  .number()
  .int("sessionId must be an integer")
  .min(1, "sessionId must be a positive integer")
  .max(SESSION_ID_MAX, "sessionId must be a positive integer");

// Server-side validation for RSVP input, sharing the event guards above so the RSVP
// route cannot drift back into 500ing on a NUL byte. .strict(): an unknown key is a 400.
//
// X2: `sessionId` is OPTIONAL HERE and CONDITIONALLY REQUIRED at the route. The rule
// ("required once the event has any session, accepted-as-absent only when it has none")
// depends on the event's session count, which is a database fact this schema cannot see.
// The schema pins the SHAPE; app/api/events/[id]/rsvp/route.ts enforces the condition.
export const rsvpInput = z
  .object({
    name: attendeeName,
    sessionId: sessionId.optional(),
  })
  .strict();

export type RsvpInput = z.infer<typeof rsvpInput>;

// X2 — check-in body: the attendee, and the session they are arriving at. Both POST
// (arrive) and DELETE (undo — the badge was scanned by mistake) take this same shape, so
// the two halves of the endpoint cannot validate differently. .strict() like rsvpInput.
export const checkInInput = z
  .object({
    name: attendeeName,
    sessionId,
  })
  .strict();

export type CheckInInput = z.infer<typeof checkInInput>;

export type ParseResult =
  | { ok: true; data: EventInput }
  | { ok: false; errors: string[] };

/** Validate an untrusted body. Returns flat, client-safe messages on failure. */
export function parseEventInput(raw: unknown): ParseResult {
  const result = eventInput.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    ),
  };
}
