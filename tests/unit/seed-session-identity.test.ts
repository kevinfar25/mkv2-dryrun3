import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { SCHEMA_SQL, SEED_EVENTS, SEED_SESSIONS } from "../../lib/schema";

// events has NO unique constraint on title (real events may legitimately share one), so the demo
// session fixture must be keyed on the seed event's FULL identity — title AND starts_at AND
// location — and not on the display title alone. A title-only predicate would attach the
// fixture's fixed dates and rooms to somebody's unrelated "Team Offsite Planning": an
// irreversible, mis-scoped write on first apply.
//
// This test does not grep for a substring. It PARSES the predicate out of the SQL (both the
// migration's join and the route's where clause), reconstructs it as a JS matcher, and runs that
// matcher against real event rows — a genuine seed event and same-titled impostors. Hermetic:
// reads files and mocks lib/db, never opens a database connection.

const MIGRATION_PATH = join(
  process.cwd(),
  "db",
  "migrations",
  "20260727010000_sessions_checkin.sql",
);

type Condition = {
  /** Column on `events`. */
  eventCol: string;
  /** Column on the fixture side — a VALUES column name, or a bind parameter like "$2". */
  fixtureCol: string;
  /** True when the fixture side carries an explicit ::timestamptz cast. */
  timestamp: boolean;
};

type EventRow = { title: string; starts_at: string; location: string };

/** Split on top-level commas, ignoring commas inside single-quoted literals. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

function unquote(literal: string): string | null {
  const trimmed = literal.trim();
  if (trimmed === "null") return null;
  const m = /^'(.*)'(?:::\w+)?$/s.exec(trimmed);
  if (!m) throw new Error(`not a SQL literal: ${literal}`);
  return m[1].replace(/''/g, "'");
}

/**
 * Turn one `x = y` comparison into a Condition, in whichever order it is written, with either
 * side optionally cast. Throws on anything it does not recognize so a rewritten predicate fails
 * loudly here instead of silently passing.
 */
function parseCondition(raw: string, fixturePrefix: string | null): Condition {
  const side = String.raw`(?:${fixturePrefix ? `${fixturePrefix}\\.\\w+` : String.raw`\$\d+`}|e\.\w+)(?:::\w+)?`;
  const m = new RegExp(String.raw`^\s*(${side})\s*=\s*(${side})\s*$`).exec(raw);
  if (!m) throw new Error(`unparsed condition: ${raw}`);
  const parts = [m[1], m[2]].map((p) => {
    const [expr, cast] = p.split("::");
    return { expr: expr.trim(), cast: cast?.trim() ?? null };
  });
  const event = parts.find((p) => p.expr.startsWith("e."));
  const fixture = parts.find((p) => p !== event);
  if (!event || !fixture) throw new Error(`condition compares no event column: ${raw}`);
  return {
    eventCol: event.expr.slice(2),
    fixtureCol: fixture.expr.replace(`${fixturePrefix}.`, ""),
    timestamp: fixture.cast === "timestamptz" || event.cast === "timestamptz",
  };
}

/**
 * Evaluate the parsed predicate for one fixture row against one event row. Conditions on the
 * `sessions` sub-select are not part of the join, so every condition here is an identity
 * condition and ALL of them must hold.
 */
function matches(
  conditions: Condition[],
  fixture: Record<string, string | null>,
  event: EventRow,
): boolean {
  return conditions.every((c) => {
    const left = event[c.eventCol as keyof EventRow];
    const right = fixture[c.fixtureCol];
    if (left === undefined) throw new Error(`unknown events column: ${c.eventCol}`);
    if (right === undefined) throw new Error(`unknown fixture column: ${c.fixtureCol}`);
    if (right === null) return false; // `= null` is never true in SQL
    // A ::timestamptz comparison is a point-in-time comparison, not a text comparison.
    if (c.timestamp) return Date.parse(left) === Date.parse(right);
    return left === right;
  });
}

/** The demo-fixture insert, isolated from the legacy General Admission backfill above it. */
function fixtureStatement(sql: string): string {
  const start = sql.indexOf("-- DEMO FIXTURE");
  expect(start).toBeGreaterThan(-1);
  const rest = sql.slice(start);
  const end = rest.indexOf("on conflict do nothing;");
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

function parseFixture(sql: string) {
  const statement = fixtureStatement(sql);

  const columnsMatch = /\)\s*as v\s*\(([^)]*)\)/.exec(statement);
  if (!columnsMatch) throw new Error("no `as v (...)` column list in the fixture");
  const columns = columnsMatch[1].split(",").map((c) => c.trim());

  const rowsBlock = statement.slice(
    statement.indexOf("values") + "values".length,
    columnsMatch.index + 1,
  );
  const rows = [...rowsBlock.matchAll(/\(([^()]*)\)/g)].map((m) => {
    const cells = splitTopLevel(m[1]);
    expect(cells).toHaveLength(columns.length);
    return Object.fromEntries(columns.map((c, i) => [c, unquote(cells[i])]));
  });

  const onIdx = /\n\s*on\s/.exec(statement)?.index;
  const whereIdx = /\n\s*where\s/.exec(statement)?.index;
  if (onIdx === undefined || whereIdx === undefined || whereIdx < onIdx) {
    throw new Error("could not locate the join's ON clause");
  }
  const onClause = statement
    .slice(onIdx, whereIdx)
    .replace(/\n\s*on\s/, " ")
    .trim();
  const conditions = onClause.split(/\band\b/).map((c) => parseCondition(c, "v"));

  return { statement, columns, rows, conditions };
}

/** The genuine seed events, and impostors that share only the title. */
const SEED_EVENT_ROWS: EventRow[] = SEED_EVENTS.map((e) => ({
  title: e.title,
  starts_at: e.startsAt,
  location: e.location,
}));

const IMPOSTORS: { why: string; row: EventRow }[] = [
  {
    why: "same title, different date and place (a real unrelated event)",
    row: {
      title: "Team Offsite Planning",
      starts_at: "2027-01-09T09:00:00.000Z",
      location: "Birkirkara Office",
    },
  },
  {
    why: "same title and location, different date",
    row: {
      title: "Team Offsite Planning",
      starts_at: "2026-09-04T17:00:00.000Z",
      location: "Valletta HQ — Room 2",
    },
  },
  {
    why: "same title and date, different location",
    row: {
      title: "Team Offsite Planning",
      starts_at: "2026-08-04T17:00:00.000Z",
      location: "Gozo Annex",
    },
  },
  {
    why: "same title, blank location",
    row: { title: "Open Source Meetup", starts_at: "2026-08-11T18:30:00.000Z", location: "" },
  },
];

describe("the X1 demo-session fixture predicate (migration)", () => {
  // Assert it on BOTH representations: the .sql file CI's hygiene check reads and the SCHEMA_SQL
  // copy the deployed function applies. They are pinned byte-equivalent elsewhere; if that pin
  // ever loosens, the predicate still cannot regress in only one of them.
  const sources: [string, string][] = [
    ["SCHEMA_SQL", SCHEMA_SQL],
    ["db/migrations/20260727010000_sessions_checkin.sql", readFileSync(MIGRATION_PATH, "utf8")],
  ];

  for (const [label, sql] of sources) {
    describe(label, () => {
      const { columns, rows, conditions } = parseFixture(sql);

      it("joins on the seed event's title AND starts_at AND location, nothing less", () => {
        // The parse itself rejects an unrecognizable comparison, so this is the whole predicate.
        expect(new Set(conditions.map((c) => c.eventCol))).toEqual(
          new Set(["title", "starts_at", "location"]),
        );
        expect(conditions).toHaveLength(3);
        // Every identity value comes from the VALUES list, not from a bare literal spliced in.
        for (const c of conditions) expect(columns).toContain(c.fixtureCol);
      });

      it("compares starts_at as a timestamptz, not as text", () => {
        const startsAt = conditions.find((c) => c.eventCol === "starts_at");
        expect(startsAt?.timestamp).toBe(true);
        // Proof it is point-in-time: the same instant written in a different zone still matches.
        const row = rows.find((r) => r.event_title === "Team Offsite Planning");
        if (!row) throw new Error("no Team Offsite Planning fixture row");
        expect(
          matches(conditions, row, {
            title: "Team Offsite Planning",
            starts_at: "2026-08-04T19:00:00.000+02:00",
            location: "Valletta HQ — Room 2",
          }),
        ).toBe(true);
      });

      it("matches the real seed events — the fixture still lands where it should", () => {
        for (const seed of SEED_EVENT_ROWS.filter((e) => e.title !== "Quarterly Demo Day")) {
          const matched = rows.filter((r) => matches(conditions, r, seed));
          expect(matched.length).toBeGreaterThan(0);
        }
        // Counts from THIS statement only: Team Offsite Planning three (two at the same
        // starts_at), Open Source Meetup one, Quarterly Demo Day none. ⚠ Zero DEMO sessions is
        // not zero sessions — the legacy backfill above is unconditional over events, so
        // Quarterly Demo Day still ends up with exactly one, "General Admission". See the
        // dedicated legacy-backfill test below; X3's zero-session surface is an event created
        // AFTER this migration applied, never this one.
        const counts = SEED_EVENT_ROWS.map(
          (seed) => rows.filter((r) => matches(conditions, r, seed)).length,
        );
        expect(counts).toEqual([3, 1, 0]);
      });

      it("gives a same-titled NON-seed event ZERO sessions", () => {
        for (const { why, row } of IMPOSTORS) {
          const matched = rows.filter((r) => matches(conditions, r, row));
          expect(matched, why).toEqual([]);
        }
      });

      it("carries the seed identity values verbatim from SEED_EVENTS", () => {
        for (const row of rows) {
          const seed = SEED_EVENTS.find((e) => e.title === row.event_title);
          if (!seed) throw new Error(`fixture references unknown event ${row.event_title}`);
          const identity = conditions
            .filter((c) => c.eventCol !== "title")
            .map((c) => row[c.fixtureCol]);
          expect(identity).toContain(seed.startsAt);
          expect(identity).toContain(seed.location);
        }
      });
    });
  }
});

// The legacy General Admission backfill is what makes "zero DEMO sessions" different from "zero
// sessions". It is deliberately unconditional over `events` — that is the fix for the
// first-attendee gap, and the reconciliation pass depends on every pre-existing event having a
// General Admission session to attribute to. So it MUST NOT grow a predicate that excludes an
// event (an attendee filter, a title exclusion). This test pins that, and pins the consequence:
// Quarterly Demo Day ends up with exactly one session, so X3's zero-session surface has to be an
// event created after this migration applied.
describe("the X1 legacy General Admission backfill", () => {
  const sources: [string, string][] = [
    ["SCHEMA_SQL", SCHEMA_SQL],
    ["db/migrations/20260727010000_sessions_checkin.sql", readFileSync(MIGRATION_PATH, "utf8")],
  ];

  for (const [label, sql] of sources) {
    describe(label, () => {
      const start = sql.indexOf("-- LEGACY BACKFILL");
      const insertAt = sql.indexOf("insert into sessions", start);
      const end = sql.indexOf("on conflict do nothing;", insertAt);
      const statement = sql.slice(insertAt, end);

      it("is present and selects straight from events", () => {
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(insertAt);
        expect(statement).toMatch(/from\s+events\s+e/);
        expect(statement).toContain("'General Admission'");
      });

      it("is gated ONLY on the idempotency guard — never on attendees or a title exclusion", () => {
        // The single `where not exists (...)` is the idempotency guard on sessions. Anything else
        // in the predicate would leave some event without a General Admission session.
        const where = statement.slice(statement.indexOf(" where "));
        expect(where.match(/not exists/g)).toHaveLength(1);
        expect(where).toMatch(/from\s+sessions\s+s/);
        expect(where).not.toMatch(/attendees/);
        expect(where).not.toMatch(/e\.title/);
        expect(where).not.toMatch(/Quarterly Demo Day/);
        // No extra TOP-LEVEL conjunct: with the subquery's parenthesised body removed, the
        // outer predicate is just `where not exists (…)` and nothing else.
        const outer = where.slice(0, where.indexOf("(") + 1) + where.slice(where.lastIndexOf(")"));
        expect(outer.replace(/\s+/g, " ").trim()).toBe("where not exists ()");
      });

      it("therefore gives EVERY pre-existing event a session, Quarterly Demo Day included", () => {
        const demoDay = SEED_EVENT_ROWS.find((e) => e.title === "Quarterly Demo Day");
        expect(demoDay, "Quarterly Demo Day is still a seed event").toBeTruthy();
        // It gets zero rows from the demo fixture...
        const { rows, conditions } = parseFixture(sql);
        const fromFixture = rows.filter((r) => matches(conditions, r, demoDay!));
        expect(fromFixture).toEqual([]);
        // ...and exactly one from this unconditional backfill. Zero demo sessions, one session.
        expect(statement).not.toMatch(/limit\s+\d/);
      });
    });
  }
});

describe("the X1 demo-session fixture predicate (POST /api/setup)", () => {
  /** Run the route against a fake client and return the SQL+params of every query it issued. */
  async function capture(): Promise<[string, unknown[]][]> {
    const calls: [string, unknown[]][] = [];
    vi.resetModules();
    // Both mocks are keyed on the SPECIFIER the route imports, as tests/unit/store-sessions.test.ts
    // does: vitest.config.ts declares no "@/" alias, and adding one there would be a shared-file
    // edit every other phase has to merge around. lib/schema has nothing to fake, so its mock is
    // the real module re-exported through a relative path.
    vi.doMock("@/lib/schema", () => import("../../lib/schema"));
    vi.doMock("@/lib/db", () => ({
      query: vi.fn(),
      withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string, params: unknown[] = []) => {
            calls.push([sql, params]);
            return { rowCount: 0, rows: [] };
          },
        }),
    }));
    const { POST } = await import("../../app/api/setup/route");
    const previous = process.env.SETUP_TOKEN;
    process.env.SETUP_TOKEN = "test-token";
    try {
      const res = await POST(
        new Request("http://localhost/api/setup", {
          method: "POST",
          headers: { "x-setup-token": "test-token" },
          body: JSON.stringify({ seed: true }),
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.SETUP_TOKEN;
      else process.env.SETUP_TOKEN = previous;
    }
    return calls;
  }

  it("uses the SAME identity-scoped predicate, with the values bound", async () => {
    const calls = await capture();
    // The parameterized seed inserts only — not the SCHEMA_SQL apply, which also contains an
    // `insert into sessions` (the migration fixture) but is issued with no bound parameters.
    const sessionInserts = calls.filter(
      ([sql, params]) => /insert into sessions/.test(sql) && params.length > 0,
    );
    // One per SEED_SESSIONS entry — the fresh-bootstrap mirror of the migration fixture.
    expect(sessionInserts).toHaveLength(SEED_SESSIONS.length);

    for (const [index, [sql, params]] of sessionInserts.entries()) {
      const seed = SEED_SESSIONS[index];
      // Isolate `where ... and not exists`: the sub-select's own conditions are not identity.
      const where = sql.slice(sql.indexOf("where "), sql.indexOf("and not exists"));
      const conditions = where
        .replace("where ", "")
        .split(/\band\b/)
        .map((c) => parseCondition(c, null));

      expect(new Set(conditions.map((c) => c.eventCol))).toEqual(
        new Set(["title", "starts_at", "location"]),
      );
      expect(conditions).toHaveLength(3);
      expect(conditions.find((c) => c.eventCol === "starts_at")?.timestamp).toBe(true);

      // Resolve each $n against the bound parameters and evaluate the real predicate. Nothing is
      // interpolated into the SQL: the identity values only ever arrive as parameters.
      const bound = Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p as string | null]));
      expect(bound.$1).toBe(seed.eventTitle);
      for (const value of [seed.eventTitle, seed.eventStartsAt, seed.eventLocation]) {
        expect(sql).not.toContain(value);
      }

      const seedEvent = SEED_EVENT_ROWS.find((e) => e.title === seed.eventTitle);
      if (!seedEvent) throw new Error(`SEED_SESSIONS references unknown event ${seed.eventTitle}`);
      expect(matches(conditions, bound, seedEvent)).toBe(true);

      for (const { why, row } of IMPOSTORS) {
        expect(matches(conditions, bound, row), `${seed.title}: ${why}`).toBe(false);
      }
    }
  });
});
