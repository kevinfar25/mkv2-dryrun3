// The schema the deployed app applies via POST /api/setup. DATABASE_URL is Sensitive
// on Vercel, so a hosted DB can only be migrated from inside a deployed function —
// this constant is that path, and db/migrations/*.sql is the local/CI path.
//
// SCHEMA_SQL MUST stay byte-equivalent to db/migrations/20260725010000_events.sql.
// tests/unit/schema-drift.test.ts fails the build if the two ever drift.
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
