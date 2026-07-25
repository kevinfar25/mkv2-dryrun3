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
