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
