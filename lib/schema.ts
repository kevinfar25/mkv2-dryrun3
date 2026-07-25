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
-- X1 — sessions + per-session check-in. STRICTLY EXPAND-ONLY.
-- Nothing here removes, renames, narrows or hard-constrains a live object: the atomic runner
-- lives inside the deployed app, so this migration is GUARANTEED to be applied while the
-- PREVIOUS build is still serving traffic. That build inserts only (event_id, name) into
-- attendees and orders by created_at, so attendees.session_id stays NULLABLE and created_at
-- stays in place. Making session_id NOT NULL and retiring created_at are later CONTRACT
-- migrations, run once no deployed build writes session-less attendees.
-- Note: no backticks in this file — it is mirrored verbatim into the SCHEMA_SQL template
-- literal in lib/schema.ts, and a backtick would terminate that literal.
create table if not exists sessions (
  id serial primary key,
  event_id integer not null references events (id),
  title text not null,
  starts_at timestamptz not null,
  room text,
  created_at timestamptz not null default now()
);

-- SEPARATE statement, and an EXPRESSION INDEX rather than a table-level UNIQUE: Postgres
-- will not accept lower(title) in a UNIQUE constraint, and a plain UNIQUE (event_id, title)
-- would happily accept "Keynote" alongside "keynote". Matches attendees_event_name_uniq
-- and waitlist_event_name_uniq.
create unique index if not exists sessions_event_title_uniq
  on sessions (event_id, lower(title));

-- Per-session attendance. NULLABLE on purpose (see the header): the live build cannot supply
-- it, and application code (X2) is what requires it on every new RSVP.
alter table attendees add column if not exists session_id integer references sessions (id);

-- Check-in. NULL means "not yet arrived".
alter table attendees add column if not exists checked_in_at timestamptz;

-- attendees.created_at is misleading — it is the moment someone RSVPed. Introduce the
-- accurate name ADDITIVELY and keep created_at: the live build selects and orders by it.
alter table attendees add column if not exists rsvped_at timestamptz default now();

-- Backfill the accurate timestamp from the row's real RSVP moment. Scoped, and idempotent.
-- The second disjunct is load-bearing: Postgres 11+ fills existing rows with the evaluated
-- DEFAULT when the column is added, so pre-existing attendees arrive here stamped with the
-- migration time (rsvped_at > created_at) rather than NULL. Rows written by either build get
-- both timestamps from the same transaction clock, so they are equal and never rewritten.
update attendees
   set rsvped_at = created_at
 where rsvped_at is null
    or rsvped_at > created_at;

-- LEGACY BACKFILL — one General Admission session per event, so historical attendance is
-- attributed rather than invisible (X4 would otherwise undercount). Idempotent (insert ...
-- where not exists, keyed on event + lower(title)).
-- Deliberately NOT gated on "the event already has attendees": the INSERT and the UPDATE
-- below run in this one migration, but the OLD build is still serving traffic while it
-- applies. An event with no attendees at INSERT time would get no session; if the old build
-- then RSVPs into it, the UPDATE's exists-guard fails and that attendee's session_id stays
-- NULL forever, because this migration is ledger-recorded and never re-runs. Giving EVERY
-- event a session keeps that guard always satisfiable. Still expand-only — one extra row
-- per event, nothing removed or narrowed.
insert into sessions (event_id, title, starts_at, room)
select e.id, 'General Admission', e.starts_at, null::text
  from events e
 where not exists (
     select 1
       from sessions s
      where s.event_id = e.id
        and lower(s.title) = lower('General Admission')
   )
on conflict do nothing;

-- SCOPED update, never a blanket rewrite: only attendees that have no session yet, and only
-- where their event actually has a General Admission session to point at.
update attendees
   set session_id = (
     select s.id
       from sessions s
      where s.event_id = attendees.event_id
        and lower(s.title) = lower('General Admission')
      order by s.id
      limit 1
   )
 where session_id is null
   and exists (
     select 1
       from sessions s
      where s.event_id = attendees.event_id
        and lower(s.title) = lower('General Admission')
   );

-- DEMO FIXTURE — seeded THROUGH THIS MIGRATION, because POST /api/setup records no migration
-- versions and is a hard stop in this run: a fixture that only lived there could never
-- legitimately reach the hosted database.
-- Keyed on the FULL SEED_EVENTS identity from lib/schema.ts — title AND starts_at AND location,
-- not the display title alone. events has no unique constraint on title (real events may share
-- one), so a title-only join would attach these fixed demo dates and rooms to somebody's
-- unrelated event that merely happens to be called "Team Offsite Planning". starts_at is
-- compared as a timestamptz (the literal is cast), never as text. The join matching nothing is
-- the normal case, so this is a no-op unless the actual seed events are present.
--   · "Team Offsite Planning" gets TWO sessions at the SAME starts_at (the title tiebreak X3
--     asserts) plus a later one, and one of them has a NULL room.
--   · "Quarterly Demo Day" is deliberately left with ZERO sessions — X3 must prove that page
--     renders exactly as it does today.
-- Titles cannot collide case-insensitively with the legacy General Admission session above,
-- so an event may safely carry both.
insert into sessions (event_id, title, starts_at, room)
select e.id, v.title, v.starts_at::timestamptz, v.room::text
  from events e
  join (
    values
      ('Team Offsite Planning', '2026-08-04T17:00:00.000Z', 'Valletta HQ — Room 2', 'Budget Review', '2026-08-04T17:00:00Z', 'Valletta HQ — Room 2'),
      ('Team Offsite Planning', '2026-08-04T17:00:00.000Z', 'Valletta HQ — Room 2', 'Roadmap Deep Dive', '2026-08-04T17:00:00Z', null),
      ('Team Offsite Planning', '2026-08-04T17:00:00.000Z', 'Valletta HQ — Room 2', 'Retro and Wrap-up', '2026-08-04T18:30:00Z', 'Valletta HQ — Room 3'),
      ('Open Source Meetup', '2026-08-11T18:30:00.000Z', 'Sliema Community Hall', 'Lightning Talks', '2026-08-11T18:30:00Z', 'Sliema Community Hall')
  ) as v (event_title, event_starts_at, event_location, title, starts_at, room)
    on v.event_title = e.title
   and e.starts_at = v.event_starts_at::timestamptz
   and e.location = v.event_location
 where not exists (
   select 1
     from sessions s
    where s.event_id = e.id
      and lower(s.title) = lower(v.title)
 )
on conflict do nothing;
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

export type SeedSession = {
  // The FULL identity of the SEED_EVENTS row this session hangs off. Titles are NOT unique in
  // this schema, so the title alone would also match a real, unrelated event that happens to
  // share it — and hand it these fixed demo dates and rooms. All three fields together are the
  // seed event's identity, and all three must match. Same predicate as the migration's fixture.
  eventTitle: string;
  eventStartsAt: string;
  eventLocation: string;
  title: string;
  startsAt: string;
  room: string | null;
};

// Mirrors the demo fixture the X1 migration seeds itself (see
// db/migrations/20260727010000_sessions_checkin.sql). The migration is the path that reaches
// the HOSTED database; this constant exists so a from-scratch bootstrap through
// POST /api/setup produces the same rows instead of an events-only database.
//
// Deliberate shape, relied on by X3/X4:
//   · "Team Offsite Planning" has TWO sessions at the SAME startsAt (the title tiebreak) and
//     one with a null room.
//   · "Quarterly Demo Day" has ZERO sessions and must stay that way.
export const SEED_SESSIONS: SeedSession[] = [
  {
    eventTitle: "Team Offsite Planning",
    eventStartsAt: "2026-08-04T17:00:00.000Z",
    eventLocation: "Valletta HQ — Room 2",
    title: "Budget Review",
    startsAt: "2026-08-04T17:00:00.000Z",
    room: "Valletta HQ — Room 2",
  },
  {
    eventTitle: "Team Offsite Planning",
    eventStartsAt: "2026-08-04T17:00:00.000Z",
    eventLocation: "Valletta HQ — Room 2",
    title: "Roadmap Deep Dive",
    startsAt: "2026-08-04T17:00:00.000Z",
    room: null,
  },
  {
    eventTitle: "Team Offsite Planning",
    eventStartsAt: "2026-08-04T17:00:00.000Z",
    eventLocation: "Valletta HQ — Room 2",
    title: "Retro and Wrap-up",
    startsAt: "2026-08-04T18:30:00.000Z",
    room: "Valletta HQ — Room 3",
  },
  {
    eventTitle: "Open Source Meetup",
    eventStartsAt: "2026-08-11T18:30:00.000Z",
    eventLocation: "Sliema Community Hall",
    title: "Lightning Talks",
    startsAt: "2026-08-11T18:30:00.000Z",
    room: "Sliema Community Hall",
  },
];
