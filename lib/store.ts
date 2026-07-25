import { query } from "@/lib/db";
import type { EventInput } from "@/lib/validation";

export type EventRow = {
  id: number;
  title: string;
  starts_at: string;
  location: string;
  created_at: string;
};

// Every statement here is parameterized ($1, $2, ...) — user input NEVER lands in
// SQL text. The column list is explicit so an expand-only migration adding a column
// cannot silently change what callers receive.
const COLUMNS = "id, title, starts_at, location, created_at";

// What node-postgres ACTUALLY hands back: timestamptz is parsed into a JS Date, not a
// string. query<T>() is an unchecked assertion, so the row shape has to be normalized
// here for EventRow's declared `string` timestamps to be true at runtime.
type RawEventRow = Omit<EventRow, "starts_at" | "created_at"> & {
  starts_at: Date | string;
  created_at: Date | string;
};

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

export function normalizeEventRow(row: RawEventRow): EventRow {
  return { ...row, starts_at: toIso(row.starts_at), created_at: toIso(row.created_at) };
}

export async function createEvent(input: EventInput): Promise<EventRow> {
  const rows = await query<RawEventRow>(
    `insert into events (title, starts_at, location)
     values ($1, $2, $3)
     returning ${COLUMNS}`,
    [input.title, input.startsAt, input.location],
  );
  return normalizeEventRow(rows[0]);
}

/** Newest first. Single query — no per-row fan-out. */
export async function listEvents(): Promise<EventRow[]> {
  const rows = await query<RawEventRow>(
    `select ${COLUMNS} from events order by created_at desc, id desc`,
  );
  return rows.map(normalizeEventRow);
}

// events.id is `serial` = int4, so an id outside int4 makes Postgres THROW rather than
// return zero rows. Anything unstorable is by definition non-existent, so the range is
// part of the guard: the contract here is row-or-null, never a throw.
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

/** null (not a throw) when the id does not exist — callers map that to notFound(). */
export async function getEvent(id: number): Promise<EventRow | null> {
  if (!Number.isInteger(id) || id < INT4_MIN || id > INT4_MAX) return null;
  const rows = await query<RawEventRow>(
    `select ${COLUMNS} from events where id = $1`,
    [id],
  );
  return rows[0] ? normalizeEventRow(rows[0]) : null;
}

// ── P4 — attendees (RSVPs) ─────────────────────────────────────────────────
//
// EXPAND/CONTRACT. Merging the PR deploys this code; the hosted schema is applied
// separately by POST /api/setup afterwards. So between those two moments this code
// runs against the OLD schema, where `attendees` does not exist yet. Reads must
// degrade (0 / []) and the write must be reported as "not yet applied" — never a 500.

/** Postgres `undefined_table`. */
export const UNDEFINED_TABLE = "42P01";
/** Postgres `foreign_key_violation`. */
export const FOREIGN_KEY_VIOLATION = "23503";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** True when the failure is "relation does not exist" — the pre-/api/setup window. */
export function isUndefinedTable(error: unknown): boolean {
  return errorCode(error) === UNDEFINED_TABLE;
}

/** True when the RSVP referenced an event id that does not exist. */
export function isForeignKeyViolation(error: unknown): boolean {
  return errorCode(error) === FOREIGN_KEY_VIOLATION;
}

/**
 * Record an RSVP. Case-insensitively unique per event (attendees_event_name_uniq), so
 * a repeat RSVP is a silent no-op rather than an error. Returns true when a row was
 * actually inserted. Throws on 42P01 — the WRITE path must surface that as a 503, not
 * pretend the RSVP was stored.
 */
export async function rsvp(eventId: number, name: string): Promise<boolean> {
  if (!Number.isInteger(eventId)) return false;
  const trimmed = name.trim();
  if (trimmed === "") return false;
  const rows = await query<{ id: number }>(
    `insert into attendees (event_id, name)
     values ($1, $2)
     on conflict do nothing
     returning id`,
    [eventId, trimmed],
  );
  return rows.length > 0;
}

/** Single query — no per-row fan-out. 0 on the old schema (see EXPAND/CONTRACT above). */
export async function rsvpCount(eventId: number): Promise<number> {
  if (!Number.isInteger(eventId)) return 0;
  try {
    const rows = await query<{ count: string }>(
      `select count(*)::text as count from attendees where event_id = $1`,
      [eventId],
    );
    return rows[0] ? Number(rows[0].count) : 0;
  } catch (error) {
    if (isUndefinedTable(error)) return 0;
    throw error;
  }
}

// ── P6 — attendee drill-down ───────────────────────────────────────────────
//
// Additive only: nothing above is changed. Same EXPAND/CONTRACT contract as
// rsvpCount — this is a pure read, so 42P01 (attendees not created yet) degrades to
// an empty list rather than a 500.

export type Attendee = {
  name: string;
  /** ISO-8601 string, normalized the same way EventRow timestamps are. */
  createdAt: string;
};

/** attendees.created_at comes back from node-postgres as a Date, not a string. */
type RawAttendeeRow = { name: string; created_at: Date | string };

/**
 * Hard cap on how many attendee rows a single read may return. An event with a very
 * large RSVP history would otherwise make the detail page and the JSON endpoint fetch,
 * serialize and render every row — one event could exhaust response time and memory.
 * The bound lives in SQL (`limit $2`, bound — never interpolated), so the DB never
 * materializes more than this many rows in the first place.
 */
export const ATTENDEE_PAGE_LIMIT = 200;

/**
 * Every attendee of one event, most-recent-first — capped at `limit` rows
 * (ATTENDEE_PAGE_LIMIT by default; the parameter is optional, so existing callers are
 * unchanged). ONE query for the whole list — no per-row fan-out (no lookup inside a
 * loop over the rows). `id desc` breaks ties for rows sharing a created_at so the order
 * is deterministic. [] on the old schema.
 */
export async function listAttendees(
  eventId: number,
  limit: number = ATTENDEE_PAGE_LIMIT,
): Promise<Attendee[]> {
  if (!Number.isInteger(eventId)) return [];
  // A caller asking for more than the cap (or for a nonsense limit) still gets the cap.
  const bounded =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, ATTENDEE_PAGE_LIMIT)
      : ATTENDEE_PAGE_LIMIT;
  try {
    const rows = await query<RawAttendeeRow>(
      `select name, created_at
         from attendees
        where event_id = $1
        order by created_at desc, id desc
        limit $2`,
      [eventId, bounded],
    );
    return rows.map((row) => ({ name: row.name, createdAt: toIso(row.created_at) }));
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}
