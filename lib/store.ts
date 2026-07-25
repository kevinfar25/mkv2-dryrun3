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
