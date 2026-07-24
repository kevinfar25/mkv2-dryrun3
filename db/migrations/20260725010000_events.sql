-- P1 — events foundation.
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
