import { describe, it, expect, vi, beforeEach } from "vitest";

// Same hermetic pattern as tests/unit/store-attendees.test.ts: lib/db is mocked BY THE
// SPECIFIER the source uses, so no pool is ever constructed and no connection is opened.
const query = vi.fn();
vi.mock("@/lib/db", () => ({
  query,
  withTransaction: vi.fn(),
}));

// The ROUTE modules import "@/lib/store" and "@/lib/validation", and vitest.config.ts
// declares no "@" alias (adding one is a shared-file edit every other phase would have to
// merge around). Registering those specifiers as factories that re-export the REAL modules
// by relative path resolves them without touching the config — and because the resolved file
// is the same one imported below, both sides share a single module instance, so the `query`
// mock above is the database for the routes too.
vi.mock("@/lib/store", async () => await import("../../lib/store"));
vi.mock("@/lib/validation", async () => await import("../../lib/validation"));

const { checkIn, undoCheckIn, countCheckedIn, sessionBelongsToEvent, UNDEFINED_TABLE } =
  await import("../../lib/store");
const checkinRoute = await import("../../app/api/events/[id]/checkin/route");
const rsvpRoute = await import("../../app/api/events/[id]/rsvp/route");

/** What node-postgres actually raises: an Error carrying a `code` string. */
function pgError(code: string): Error {
  return Object.assign(new Error(`relation does not exist (${code})`), { code });
}

type FakeSession = { id: number; event_id: number; title?: string };
type FakeAttendee = {
  event_id: number;
  name: string;
  session_id: number | null;
  checked_in_at: string | null;
};

/**
 * A tiny in-memory stand-in for the three statements this phase writes, wired into the same
 * `query` mock. It exists so the idempotency test is REAL: `coalesce(a.checked_in_at, now())`
 * is emulated faithfully, and now() advances on every call — so a second check-in that moved
 * the timestamp would produce a visibly different value and fail the assertion.
 */
function fakeDb(state: { sessions: FakeSession[]; attendees: FakeAttendee[] }) {
  let tick = 0;
  const now = () => `2026-07-25T12:00:0${tick++}.000Z`;
  const session = (id: unknown, eventId: unknown) =>
    state.sessions.find((s) => s.id === id && s.event_id === eventId);
  const attendee = (eventId: unknown, name: unknown) =>
    state.attendees.find(
      (a) =>
        a.event_id === eventId &&
        a.name.toLowerCase() === String(name).trim().toLowerCase(),
    );

  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    // listSessions — the aggregate read.
    if (/left join attendees/.test(sql)) {
      return state.sessions
        .filter((s) => s.event_id === params[0])
        .map((s) => ({
          id: s.id,
          event_id: s.event_id,
          title: s.title ?? `Session ${s.id}`,
          starts_at: "2026-08-04T17:00:00.000Z",
          room: null,
          attendee_count: "0",
          checked_in_count: "0",
        }));
    }
    // sessionBelongsToEvent.
    if (/select id from sessions where id = \$1 and event_id = \$2/.test(sql)) {
      const found = session(params[0], params[1]);
      return found ? [{ id: found.id }] : [];
    }
    // checkIn — note the coalesce: the timestamp is written ONCE and never moved.
    if (/coalesce\(a\.checked_in_at, now\(\)\)/.test(sql)) {
      const [eventId, sessionId, name] = params;
      if (!session(sessionId, eventId)) return [];
      const row = attendee(eventId, name);
      if (!row) return [];
      row.session_id = sessionId as number;
      row.checked_in_at = row.checked_in_at ?? now();
      return [{ name: row.name, checked_in_at: row.checked_in_at }];
    }
    // undoCheckIn.
    if (/set checked_in_at = null/.test(sql)) {
      const [eventId, sessionId, name] = params;
      if (!session(sessionId, eventId)) return [];
      const row = attendee(eventId, name);
      if (!row || row.session_id !== sessionId) return [];
      row.checked_in_at = null;
      return [{ name: row.name }];
    }
    // countCheckedIn.
    if (/checked_in_at is not null/.test(sql)) {
      const count = state.attendees.filter(
        (a) => a.session_id === params[0] && a.checked_in_at !== null,
      ).length;
      return [{ count: String(count) }];
    }
    // getEvent.
    if (/from events where id = \$1/.test(sql)) {
      return [
        {
          id: params[0],
          title: "Team Offsite Planning",
          starts_at: new Date("2026-08-04T17:00:00.000Z"),
          location: "Valletta HQ",
          created_at: new Date("2026-07-01T00:00:00.000Z"),
        },
      ];
    }
    // rsvp insert (two- or three-column form).
    if (/insert into attendees/.test(sql)) {
      const [eventId, name, sessionId] = params;
      if (attendee(eventId, name)) return []; // attendees_event_name_uniq
      state.attendees.push({
        event_id: eventId as number,
        name: String(name),
        session_id: (sessionId as number | undefined) ?? null,
        checked_in_at: null,
      });
      return [{ id: state.attendees.length }];
    }
    // rsvpCount.
    if (/count\(\*\)::text as count/.test(sql)) {
      return [
        { count: String(state.attendees.filter((a) => a.event_id === params[0]).length) },
      ];
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  });
  return state;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = (value: unknown, method: string) =>
  new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

beforeEach(() => {
  query.mockReset();
});

describe("store: checkIn / undoCheckIn / countCheckedIn", () => {
  it("checks in idempotently — a second check-in does NOT move the timestamp", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }],
      attendees: [{ event_id: 1, name: "Ada Lovelace", session_id: null, checked_in_at: null }],
    });

    const first = await checkIn(1, 5, "Ada Lovelace");
    const second = await checkIn(1, 5, "ada lovelace"); // case-insensitive, same person

    expect(first?.checkedInAt).toBe("2026-07-25T12:00:00.000Z");
    expect(second?.checkedInAt).toBe(first?.checkedInAt);
    // ...and only ONE arrival is counted, not two.
    await expect(countCheckedIn(5)).resolves.toBe(1);
  });

  it("writes coalesce(checked_in_at, now()) — never a read-then-write", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: null, checked_in_at: null }],
    });
    await checkIn(1, 5, "Ada");
    const [sql, params] = query.mock.calls[0];
    // One statement does the whole job: the timestamp guard, the event/session pairing and
    // the write. Two concurrent scans of the same badge therefore cannot interleave.
    expect(sql).toMatch(/coalesce\(a\.checked_in_at, now\(\)\)/);
    expect(sql).toMatch(/from sessions s/);
    expect(sql).toMatch(/s\.event_id = \$1/);
    // Bound parameters only — no interpolated SQL.
    expect(params).toEqual([1, 5, "Ada"]);
    expect(sql).not.toContain("Ada");
  });

  it("attaches a session-less attendee to the session they arrive at", async () => {
    const state = fakeDb({
      sessions: [{ id: 5, event_id: 1 }],
      attendees: [{ event_id: 1, name: "Grace", session_id: null, checked_in_at: null }],
    });
    await checkIn(1, 5, "Grace");
    // A session-less attendee is LEGAL (nullable by design + the backfill race) — the door
    // scan is what makes their session known. It must not be an error.
    expect(state.attendees[0].session_id).toBe(5);
  });

  it("returns null for a session that belongs to a DIFFERENT event", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }, { id: 9, event_id: 2 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: null, checked_in_at: null }],
    });
    await expect(checkIn(1, 9, "Ada")).resolves.toBeNull();
    await expect(sessionBelongsToEvent(1, 9)).resolves.toBe(false);
    await expect(sessionBelongsToEvent(1, 5)).resolves.toBe(true);
  });

  it("undoCheckIn clears the timestamp", async () => {
    const state = fakeDb({
      sessions: [{ id: 5, event_id: 1 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: null, checked_in_at: null }],
    });
    await checkIn(1, 5, "Ada");
    expect(state.attendees[0].checked_in_at).not.toBeNull();

    await expect(undoCheckIn(1, 5, "Ada")).resolves.toBe(true);
    expect(state.attendees[0].checked_in_at).toBeNull();
    await expect(countCheckedIn(5)).resolves.toBe(0);
  });

  it("undoCheckIn refuses a session that belongs to a different event", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }, { id: 9, event_id: 2 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: 5, checked_in_at: "x" }],
    });
    await expect(undoCheckIn(1, 9, "Ada")).resolves.toBe(false);
  });

  it("countCheckedIn degrades to 0 on the pre-migration schema and never throws", async () => {
    query.mockRejectedValue(pgError(UNDEFINED_TABLE));
    await expect(countCheckedIn(5)).resolves.toBe(0);
    await expect(sessionBelongsToEvent(1, 5)).resolves.toBe(false);
  });

  it("propagates 42P01 from the WRITE paths — a scan must never be silently accepted", async () => {
    query.mockRejectedValue(pgError(UNDEFINED_TABLE));
    await expect(checkIn(1, 5, "Ada")).rejects.toThrow(/42P01/);
    await expect(undoCheckIn(1, 5, "Ada")).rejects.toThrow(/42P01/);
  });

  it("rejects unstorable ids before issuing a query", async () => {
    await expect(checkIn(1.5, 5, "Ada")).resolves.toBeNull();
    await expect(undoCheckIn(1, Number.NaN, "Ada")).resolves.toBe(false);
    await expect(countCheckedIn(2147483648)).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("POST/DELETE /api/events/[id]/checkin", () => {
  it("checks in, then repeats: 200 both times, SAME timestamp, never 409", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: null, checked_in_at: null }],
    });

    const first = await checkinRoute.POST(body({ name: "Ada", sessionId: 5 }, "POST"), ctx("1"));
    const firstBody = await first.json();
    const second = await checkinRoute.POST(body({ name: "Ada", sessionId: 5 }, "POST"), ctx("1"));
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.status).not.toBe(409);
    expect(secondBody.checkedInAt).toBe(firstBody.checkedInAt);
    expect(secondBody.checkedInCount).toBe(1);
  });

  it("404s (not 500) on a session belonging to another event", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }, { id: 9, event_id: 2 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: null, checked_in_at: null }],
    });

    const res = await checkinRoute.POST(body({ name: "Ada", sessionId: 9 }, "POST"), ctx("1"));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe("session not found for this event");
    // No Postgres error code leaks to the client.
    expect(JSON.stringify(json)).not.toMatch(/2\d{4}|4[23]\w\d\d/);
  });

  it("404s for an attendee who never RSVPed", async () => {
    fakeDb({ sessions: [{ id: 5, event_id: 1 }], attendees: [] });
    const res = await checkinRoute.POST(body({ name: "Nobody", sessionId: 5 }, "POST"), ctx("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/attendee not found/);
  });

  it("DELETE clears the timestamp and reports the new count", async () => {
    const state = fakeDb({
      sessions: [{ id: 5, event_id: 1 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: null, checked_in_at: null }],
    });
    await checkinRoute.POST(body({ name: "Ada", sessionId: 5 }, "POST"), ctx("1"));

    const res = await checkinRoute.DELETE(body({ name: "Ada", sessionId: 5 }, "DELETE"), ctx("1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.checkedInAt).toBeNull();
    expect(json.checkedInCount).toBe(0);
    expect(state.attendees[0].checked_in_at).toBeNull();
  });

  it("DELETE 404s on a session belonging to another event", async () => {
    fakeDb({
      sessions: [{ id: 5, event_id: 1 }, { id: 9, event_id: 2 }],
      attendees: [{ event_id: 1, name: "Ada", session_id: 5, checked_in_at: "x" }],
    });
    const res = await checkinRoute.DELETE(body({ name: "Ada", sessionId: 9 }, "DELETE"), ctx("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session not found for this event");
  });

  it("400s on a missing/blank name, an unknown key and invalid JSON", async () => {
    fakeDb({ sessions: [{ id: 5, event_id: 1 }], attendees: [] });

    const blank = await checkinRoute.POST(body({ name: "   ", sessionId: 5 }, "POST"), ctx("1"));
    expect(blank.status).toBe(400);

    const missing = await checkinRoute.POST(body({ name: "Ada" }, "POST"), ctx("1"));
    expect(missing.status).toBe(400);

    const unknown = await checkinRoute.POST(
      body({ name: "Ada", sessionId: 5, extra: 1 }, "POST"),
      ctx("1"),
    );
    expect(unknown.status).toBe(400);

    const bad = await checkinRoute.POST(
      new Request("http://localhost/api", { method: "POST", body: "{oops" }),
      ctx("1"),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid JSON body");
  });

  it("404s an out-of-int4-range event id without querying", async () => {
    const res = await checkinRoute.POST(
      body({ name: "Ada", sessionId: 5 }, "POST"),
      ctx("2147483648"),
    );
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("503s — never 500, never 200 — while the migration is unapplied", async () => {
    query.mockRejectedValue(pgError(UNDEFINED_TABLE));
    const res = await checkinRoute.POST(body({ name: "Ada", sessionId: 5 }, "POST"), ctx("1"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("schema not yet applied");
  });
});

describe("POST /api/events/[id]/rsvp — conditionally required sessionId", () => {
  it("400s when the event HAS sessions and sessionId is omitted", async () => {
    fakeDb({ sessions: [{ id: 5, event_id: 1 }], attendees: [] });
    const res = await rsvpRoute.POST(body({ name: "Ada" }, "POST"), ctx("1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sessionId is required/);
  });

  it("accepts the omission when the event has ZERO sessions (form unchanged)", async () => {
    const state = fakeDb({ sessions: [], attendees: [] });
    const res = await rsvpRoute.POST(body({ name: "Ada" }, "POST"), ctx("1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, created: true, count: 1 });
    expect(state.attendees[0].session_id).toBeNull();
    // The insert for a zero-session event never names session_id — that column does not
    // exist on the hosted schema yet.
    const insert = query.mock.calls.find(([sql]) => /insert into attendees/.test(sql));
    expect(insert?.[0]).not.toMatch(/session_id/);
  });

  it("writes session_id when the event has sessions and one is chosen", async () => {
    const state = fakeDb({ sessions: [{ id: 5, event_id: 1 }], attendees: [] });
    const res = await rsvpRoute.POST(body({ name: "Ada", sessionId: 5 }, "POST"), ctx("1"));
    expect(res.status).toBe(200);
    expect(state.attendees[0].session_id).toBe(5);
  });

  it("404s (not 500) on a session belonging to another event", async () => {
    const state = fakeDb({
      sessions: [{ id: 5, event_id: 1 }, { id: 9, event_id: 2 }],
      attendees: [],
    });
    const res = await rsvpRoute.POST(body({ name: "Ada", sessionId: 9 }, "POST"), ctx("1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session not found for this event");
    // Rejected BEFORE the insert — no foreign-key violation is ever risked.
    expect(state.attendees).toHaveLength(0);
  });

  it("404s a sessionId sent to an event with no sessions at all", async () => {
    fakeDb({ sessions: [], attendees: [] });
    const res = await rsvpRoute.POST(body({ name: "Ada", sessionId: 5 }, "POST"), ctx("1"));
    expect(res.status).toBe(404);
  });

  it("400s a malformed sessionId rather than letting it reach Postgres", async () => {
    fakeDb({ sessions: [{ id: 5, event_id: 1 }], attendees: [] });
    for (const bad of [0, -1, 1.5, 2147483648, "5"]) {
      const res = await rsvpRoute.POST(body({ name: "Ada", sessionId: bad }, "POST"), ctx("1"));
      expect(res.status).toBe(400);
    }
  });
});
