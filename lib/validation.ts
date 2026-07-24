import { z } from "zod";

// Server-side validation for event input. API routes must run every request body
// through parseEventInput and answer 400 on failure — never trust the client.
export const eventInput = z.object({
  title: z.string().trim().min(1, "title is required").max(120, "title must be 120 characters or fewer"),
  startsAt: z.iso.datetime({ offset: true, message: "startsAt must be an ISO 8601 datetime" }),
  location: z
    .string()
    .trim()
    .min(1, "location is required")
    .max(160, "location must be 160 characters or fewer"),
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
