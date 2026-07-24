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

export async function createEvent(input: EventInput): Promise<EventRow> {
  const rows = await query<EventRow>(
    `insert into events (title, starts_at, location)
     values ($1, $2, $3)
     returning ${COLUMNS}`,
    [input.title, input.startsAt, input.location],
  );
  return rows[0];
}

/** Newest first. Single query — no per-row fan-out. */
export async function listEvents(): Promise<EventRow[]> {
  return query<EventRow>(
    `select ${COLUMNS} from events order by created_at desc, id desc`,
  );
}

/** null (not a throw) when the id does not exist — callers map that to notFound(). */
export async function getEvent(id: number): Promise<EventRow | null> {
  if (!Number.isInteger(id)) return null;
  const rows = await query<EventRow>(
    `select ${COLUMNS} from events where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
