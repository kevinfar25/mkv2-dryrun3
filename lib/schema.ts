// The schema the deployed app applies via POST /api/setup. DATABASE_URL is Sensitive
// on Vercel, so a hosted DB can only be migrated from inside a deployed function —
// this constant is that path, and db/migrations/*.sql is the local/CI path.
//
// SCHEMA_SQL MUST stay byte-equivalent to db/migrations/*.sql concatenated in version
// order. tests/unit/schema-drift.test.ts fails the build if the two ever drift.
export const SCHEMA_SQL = `-- P1 — events foundation.
-- EXPAND-ONLY: creates a new table; no DROP / RENAME / type-narrow on live objects.
-- This file must stay byte-equivalent to SCHEMA_SQL in lib/schema.ts
-- (tests/unit/schema-drift.test.ts enforces it).
create table if not exists events (
  id serial primary key,
  title text not null,
  starts_at timestamptz not null,
  location text not null,
  created_at timestamptz not null default now()
);
-- P4 — attendees (RSVPs).
-- EXPAND-ONLY: creates a new table + index; no DROP / RENAME / type-narrow on live objects.
-- This file must stay byte-equivalent to its half of SCHEMA_SQL in lib/schema.ts
-- (tests/unit/schema-drift.test.ts enforces it).
create table if not exists attendees (
  id serial primary key,
  event_id integer not null references events (id),
  name text not null,
  created_at timestamptz not null default now()
);

-- SEPARATE statement on purpose: Postgres will NOT accept lower(name) inside a
-- table-level UNIQUE constraint — case-insensitive uniqueness must be an expression index.
create unique index if not exists attendees_event_name_uniq
  on attendees (event_id, lower(name));
-- W1 — capacity + waitlist + venue. EXPAND-ONLY.
-- The "location" column is deliberately LEFT IN PLACE: the currently-deployed code still reads
-- it, and migrations deploy separately from code. Retiring it is a later CONTRACT migration, run
-- once no deployed version references it.
-- Note: no backticks in this file — it is mirrored verbatim into the SCHEMA_SQL template literal
-- in lib/schema.ts, and a backtick would terminate that literal.
alter table events add column if not exists capacity integer;
alter table events add column if not exists venue text;
update events set venue = location where venue is null;
create table if not exists waitlist (
  id serial primary key,
  event_id integer not null references events (id),
  name text not null,
  position integer not null,
  created_at timestamptz not null default now()
);
create unique index if not exists waitlist_event_name_uniq on waitlist (event_id, lower(name));
-- touched to force a new head SHA for injection 4
-- injection 4, tight race
`;

export type SeedEvent = {
  title: string;
  startsAt: string;
  location: string;
};

// Demo rows for the RSVP board. Inserted idempotently by POST /api/setup {"seed":true}.
export const SEED_EVENTS: SeedEvent[] = [
  {
    title: "Team Offsite Planning",
    startsAt: "2026-08-04T17:00:00.000Z",
    location: "Valletta HQ — Room 2",
  },
  {
    title: "Open Source Meetup",
    startsAt: "2026-08-11T18:30:00.000Z",
    location: "Sliema Community Hall",
  },
  {
    title: "Quarterly Demo Day",
    startsAt: "2026-08-20T15:00:00.000Z",
    location: "Online — video link in invite",
  },
];
