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
/** Postgres `undefined_column`. */
export const UNDEFINED_COLUMN = "42703";
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

/**
 * True when the failure is "column does not exist" — the window between deploying code that
 * selects a NEW column and applying the migration that adds it. In this repo that window is
 * unavoidable and always in this order: the atomic runner lives INSIDE the deployed app, so
 * the code carrying a migration is serving traffic before the migration can be applied.
 */
export function isUndefinedColumn(error: unknown): boolean {
  return errorCode(error) === UNDEFINED_COLUMN;
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
  /**
   * X1 — the RSVP moment, read as `coalesce(rsvped_at, created_at)` so it is correct against
   * BOTH schemas: equal to createdAt before the migration is applied, and the accurate
   * rsvped_at afterwards. `createdAt` is KEPT because the page, the tests and the ordering
   * still use it — this addition is additive, not a replacement.
   */
  rsvpedAt: string;
  /** X1 — null until the migration is applied and a session-aware RSVP (X2) writes it. */
  sessionId: number | null;
  /** X1 — null means "not yet arrived". */
  checkedInAt: string | null;
};

/**
 * attendees.created_at comes back from node-postgres as a Date, not a string. The X1 columns
 * are optional HERE on purpose: this same shape has to describe a row read from the OLD schema,
 * where session_id / checked_in_at / rsvped_at do not exist yet.
 */
type RawAttendeeRow = {
  name: string;
  created_at: Date | string;
  rsvped_at?: Date | string | null;
  session_id?: number | null;
  checked_in_at?: Date | string | null;
};

const toIsoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : toIso(value);

function normalizeAttendeeRow(row: RawAttendeeRow): Attendee {
  const createdAt = toIso(row.created_at);
  return {
    name: row.name,
    createdAt,
    // Belt and braces: the DB already coalesces, and the fallback query below does not select
    // rsvped_at at all — either way the RSVP moment is never null.
    rsvpedAt: toIsoOrNull(row.rsvped_at) ?? createdAt,
    sessionId: typeof row.session_id === "number" ? row.session_id : null,
    checkedInAt: toIsoOrNull(row.checked_in_at),
  };
}

/** Explicit column lists — the second one is the shape the CURRENT hosted schema has. */
const ATTENDEE_COLUMNS =
  "name, created_at, session_id, checked_in_at, coalesce(rsvped_at, created_at) as rsvped_at";
const ATTENDEE_COLUMNS_PRE_X1 = "name, created_at";

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
  const read = (columns: string) =>
    query<RawAttendeeRow>(
      `select ${columns}
         from attendees
        where event_id = $1
        order by created_at desc, id desc
        limit $2`,
      [eventId, bounded],
    );
  try {
    return (await read(ATTENDEE_COLUMNS)).map(normalizeAttendeeRow);
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    // 42703: this build is deployed but its migration is not applied yet — the event page
    // calls this on EVERY request, so falling back to the old column list is the difference
    // between a degraded read and a 500 on the live site. If even that fails, degrade to [].
    if (isUndefinedColumn(error)) {
      try {
        return (await read(ATTENDEE_COLUMNS_PRE_X1)).map(normalizeAttendeeRow);
      } catch (fallbackError) {
        if (isUndefinedTable(fallbackError) || isUndefinedColumn(fallbackError)) return [];
        throw fallbackError;
      }
    }
    throw error;
  }
}

// ── X1 — sessions ──────────────────────────────────────────────────────────
//
// The PUBLIC shape X2 and X3 build on. Additive: nothing above changes.
//
// EXPAND/CONTRACT, and here it is not theoretical: this code is deployed BEFORE
// 20260727010000_sessions_checkin.sql can be applied (the runner lives inside the deployed
// app), so on the live site this WILL run against a database with no `sessions` table at all.
// Every read degrades to an EMPTY LIST rather than throwing — an unhandled 42P01 here takes
// the event page down.

/** One session of one event, with its attendance counts already aggregated. */
export type SessionSummary = {
  id: number;
  eventId: number;
  title: string;
  /** ISO-8601, normalized like every other timestamp in this module. */
  startsAt: string;
  /** null when no room was recorded. */
  room: string | null;
  /** Attendees whose session_id points at this session. */
  attendeeCount: number;
  /** Of those, the ones with a non-null checked_in_at. */
  checkedInCount: number;
};

type RawSessionRow = {
  id: number;
  event_id: number;
  title: string;
  starts_at: Date | string;
  room: string | null;
  /** count(*)::text — bigint would otherwise arrive as a string anyway. */
  attendee_count: string | number;
  checked_in_count: string | number;
};

/**
 * Every session of one event, earliest first, with `title` as the stable tiebreak for two
 * sessions starting at the same moment (X3's schedule asserts that order), and `id` last so
 * even a duplicate title cannot reorder between requests.
 *
 * ONE aggregate query for the whole list — no per-row count fan-out. [] when the id is not a
 * storable int4, and [] on the pre-migration schema (missing table OR missing column).
 */
export async function listSessions(eventId: number): Promise<SessionSummary[]> {
  if (!Number.isInteger(eventId) || eventId < INT4_MIN || eventId > INT4_MAX) return [];
  try {
    const rows = await query<RawSessionRow>(
      `select s.id,
              s.event_id,
              s.title,
              s.starts_at,
              s.room,
              count(a.id)::text as attendee_count,
              count(a.checked_in_at)::text as checked_in_count
         from sessions s
         left join attendees a on a.session_id = s.id
        where s.event_id = $1
        group by s.id, s.event_id, s.title, s.starts_at, s.room
        order by s.starts_at asc, s.title asc, s.id asc`,
      [eventId],
    );
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      title: row.title,
      startsAt: toIso(row.starts_at),
      room: row.room ?? null,
      attendeeCount: Number(row.attendee_count),
      checkedInCount: Number(row.checked_in_count),
    }));
  } catch (error) {
    if (isUndefinedTable(error) || isUndefinedColumn(error)) return [];
    throw error;
  }
}
