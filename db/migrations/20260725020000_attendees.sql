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
