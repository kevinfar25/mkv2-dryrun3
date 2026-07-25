import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isUndefinedColumn, isUndefinedTable } from "@/lib/store";
import { formatShowUpRate, showUpRatePercent } from "@/lib/format";

// Reads the DB → must be dynamic. `next build` has no DATABASE_URL and the pool in
// lib/db.ts is lazy for the same reason: nothing here may construct a pool or a client at
// module scope, so query() is only ever called from inside the handler.
export const dynamic = "force-dynamic";

const UNAVAILABLE = { error: "attendance report is temporarily unavailable" };

type EventReport = {
  id: number;
  title: string;
  sessionCount: number;
  attendeeCount: number;
  checkedInCount: number;
  showUpRate: number;
  showUpRateLabel: string;
};

type BusiestSession = {
  id: number;
  eventId: number;
  title: string;
  attendeeCount: number;
};

type AttendanceReport = {
  events: EventReport[];
  totals: {
    events: number;
    sessions: number;
    attendees: number;
    checkedIn: number;
    showUpRate: number;
    showUpRateLabel: string;
  };
  busiestSession: BusiestSession | null;
};

// ── OLD-SCHEMA SAFETY ──────────────────────────────────────────────────────
//
// This was written when 20260727010000_sessions_checkin.sql had NOT yet been applied: the
// atomic runner lives inside the deployed app, so a build can serve traffic against a
// database that lacks `sessions` and attendees.session_id / attendees.checked_in_at. That
// migration is now applied (as is the 20260727020000 reconciliation), so the degraded path
// is no longer the live one — but it is KEPT, deliberately, because the deploy-order
// inversion is permanent here: any future expand migration reopens exactly this window, and
// lib/store.ts's listSessions / listAttendees guard themselves the same way. Each
// read below is therefore wrapped INDIVIDUALLY and degrades to a well-formed ZERO value on
// 42P01 (missing table) / 42703 (missing column), exactly as lib/store.ts's listSessions
// and listAttendees already do. A missing sessions table must not cost us the attendee
// counts, and a missing checked_in_at must not cost us the attendee counts either.
// Any OTHER database error (unreachable DB, …) propagates to the single catch in GET and
// becomes a 503 with a static message — never a raw 500, never a leaked Postgres code.

// ── ATTENDEE BUCKETING ─────────────────────────────────────────────────────
//
// attendees.session_id is NULLABLE BY DESIGN and session-less attendees are LEGAL, not a
// bug. Two distinct sources of them: RSVPs written by a build older than X2 (those have
// since been attributed to their event's legacy session by the 20260727020000
// reconciliation), and — permanently — attendees of an event created AFTER 20260727010000
// applied, which has no session for them to belong to at all. The second case is live in
// production today, so this is not a transitional concern that the reconciliation retired.
// So the two aggregates below count different things on purpose:
//   · per-EVENT counts group attendees by event_id — session-less attendees ARE included,
//     both in each event's attendeeCount/checkedInCount and in the totals;
//   · per-SESSION counts join a.session_id = s.id — session-less attendees belong to no
//     session and are naturally excluded there.
// That is why the event counts are NOT derived by summing the session counts: doing so
// would silently drop every session-less attendee from the board totals.

// ── ROUND TRIPS ────────────────────────────────────────────────────────────
//
// THREE fixed queries, regardless of how many events exist — no per-event fan-out / N+1.
// They are separate (rather than one join of events × attendees × sessions) because such a
// join multiplies rows and inflates every count, and because separate statements are what
// lets one degrade to zeros while the others stay correct. They run concurrently, so three
// statements cost one round trip's latency.

type CountRow = { event_id: number; total: string | number; checked_in: string | number };

/** bigint arrives from node-postgres as a string; ::text + Number() is the house style. */
const toCount = (value: string | number | null | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

type EventRow = { id: number; title: string };

/** Newest first, matching listEvents(). [] on the old schema — the empty report. */
async function readEvents(): Promise<EventRow[]> {
  try {
    return await query<EventRow>(
      `select id, title from events order by created_at desc, id desc`,
    );
  } catch (error) {
    if (isUndefinedTable(error) || isUndefinedColumn(error)) return [];
    throw error;
  }
}

/** Attendees per EVENT (session-less rows included). Empty map on the old schema. */
async function readAttendeeCounts(): Promise<Map<number, { total: number; checkedIn: number }>> {
  const counts = new Map<number, { total: number; checkedIn: number }>();
  let rows: CountRow[];
  try {
    rows = await query<CountRow>(
      `select event_id,
              count(*)::text as total,
              count(checked_in_at)::text as checked_in
         from attendees
        group by event_id`,
    );
  } catch (error) {
    if (isUndefinedTable(error)) return counts;
    // 42703: attendees exists but checked_in_at does not yet. The attendee counts are still
    // real and must survive — only the check-in half degrades to 0.
    if (isUndefinedColumn(error)) {
      try {
        rows = await query<CountRow>(
          `select event_id, count(*)::text as total, '0'::text as checked_in
             from attendees
            group by event_id`,
        );
      } catch (fallbackError) {
        if (isUndefinedTable(fallbackError) || isUndefinedColumn(fallbackError)) return counts;
        throw fallbackError;
      }
    } else {
      throw error;
    }
  }
  for (const row of rows) {
    counts.set(row.event_id, {
      total: toCount(row.total),
      checkedIn: toCount(row.checked_in),
    });
  }
  return counts;
}

type SessionRow = {
  id: number;
  event_id: number;
  title: string;
  starts_at: Date | string | null;
  attendee_count: string | number;
};

/**
 * Every session with its own attendee count. One statement for the whole board: the
 * per-event session count and the busiest session are both derived from these rows in
 * memory, so adding events never adds queries. [] on the old schema (no sessions table,
 * or no attendees.session_id to join on).
 */
async function readSessions(): Promise<SessionRow[]> {
  const joined = `select s.id,
                         s.event_id,
                         s.title,
                         s.starts_at,
                         count(a.id)::text as attendee_count
                    from sessions s
                    left join attendees a on a.session_id = s.id
                   group by s.id, s.event_id, s.title, s.starts_at
                   order by count(a.id) desc, s.starts_at asc, s.id asc`;
  // Fallback for a database that has sessions but no attendees table / no session_id
  // column: the sessions themselves still count, they just have nobody in them yet.
  const unjoined = `select s.id, s.event_id, s.title, s.starts_at, '0'::text as attendee_count
                      from sessions s
                     order by s.starts_at asc, s.id asc`;
  try {
    return await query<SessionRow>(joined);
  } catch (error) {
    if (!isUndefinedTable(error) && !isUndefinedColumn(error)) throw error;
    try {
      return await query<SessionRow>(unjoined);
    } catch (fallbackError) {
      if (isUndefinedTable(fallbackError) || isUndefinedColumn(fallbackError)) return [];
      throw fallbackError;
    }
  }
}

/** Comparable millis for the tiebreak; an unparseable/absent timestamp sorts LAST. */
function startsAtMillis(value: Date | string | null): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Busiest session: highest attendeeCount, then EARLIEST starts_at, then LOWEST id — all
 * three levels, deterministic. The SQL already orders this way; the reduce repeats it in
 * memory so the answer does not depend on the row order the driver happens to hand back.
 * null ONLY when there are no sessions at all — a board with sessions but zero attendees
 * still names a winner, with attendeeCount 0.
 */
function pickBusiest(rows: SessionRow[]): BusiestSession | null {
  let best: SessionRow | null = null;
  let bestCount = -1;
  let bestStart = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const count = toCount(row.attendee_count);
    const start = startsAtMillis(row.starts_at);
    const wins =
      best === null ||
      count > bestCount ||
      (count === bestCount &&
        (start < bestStart || (start === bestStart && row.id < best.id)));
    if (wins) {
      best = row;
      bestCount = count;
      bestStart = start;
    }
  }
  if (best === null) return null;
  return {
    id: best.id,
    eventId: best.event_id,
    title: best.title,
    attendeeCount: toCount(best.attendee_count),
  };
}

export async function GET() {
  let report: AttendanceReport;
  try {
    // Concurrent, but a FIXED three statements — the count does not grow with the board.
    const [events, attendeeCounts, sessions] = await Promise.all([
      readEvents(),
      readAttendeeCounts(),
      readSessions(),
    ]);

    const sessionCounts = new Map<number, number>();
    for (const session of sessions) {
      sessionCounts.set(session.event_id, (sessionCounts.get(session.event_id) ?? 0) + 1);
    }

    let totalAttendees = 0;
    let totalCheckedIn = 0;
    let totalSessions = 0;

    // The SQL already ordered events newest-first; this maps in place and never re-sorts.
    const eventReports: EventReport[] = events.map((event) => {
      const counts = attendeeCounts.get(event.id) ?? { total: 0, checkedIn: 0 };
      const sessionCount = sessionCounts.get(event.id) ?? 0;
      const attendance = { attendees: counts.total, checkedIn: counts.checkedIn };
      totalAttendees += counts.total;
      totalCheckedIn += counts.checkedIn;
      totalSessions += sessionCount;
      return {
        id: event.id,
        title: event.title,
        sessionCount,
        attendeeCount: counts.total,
        checkedInCount: counts.checkedIn,
        showUpRate: showUpRatePercent(attendance),
        showUpRateLabel: formatShowUpRate(attendance),
      };
    });

    const boardAttendance = { attendees: totalAttendees, checkedIn: totalCheckedIn };
    report = {
      events: eventReports,
      totals: {
        events: eventReports.length,
        sessions: totalSessions,
        attendees: totalAttendees,
        checkedIn: totalCheckedIn,
        showUpRate: showUpRatePercent(boardAttendance),
        showUpRateLabel: formatShowUpRate(boardAttendance),
      },
      busiestSession: pickBusiest(sessions),
    };
  } catch (error) {
    // Only a NON-degradable failure reaches here (the 42P01/42703 paths above already
    // returned zeros). Logged in full; the client gets a static message with no PG code.
    console.error("GET /api/attendance failed", error);
    return NextResponse.json(UNAVAILABLE, { status: 503 });
  }

  // An empty board is a normal 200: zeros, [] and a null busiest session.
  return NextResponse.json(report);
}
