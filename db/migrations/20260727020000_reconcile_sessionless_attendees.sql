-- RECONCILIATION PASS — ordered step between X2's install and X4's install.
--
-- Note: no backticks in this file — it is mirrored verbatim into the SCHEMA_SQL template
-- literal in lib/schema.ts, where a backtick would terminate the literal.
--
-- WHY THIS EXISTS. 20260727010000_sessions_checkin backfilled attendees.session_id at a single
-- point in time, but the build serving traffic at that moment was still the PRE-X2 one, which
-- had no notion of sessions and kept INSERTing attendees with session_id NULL. That window is
-- inherent to expand/contract in this sandbox: the migration runner lives inside the deployed
-- app, so the migration necessarily applies while the previous build is live. The window closed
-- when X2 deployed (8b36c16) — X2 writes session_id on every RSVP into a sessionful event — so
-- from here on no new session-less row can arrive for an event that has sessions.
--
-- X4 is the phase that would misreport them: it reports per-session attendance and a show-up
-- rate, so a row sitting at NULL is silently absent from its own event's session totals. Hence
-- this runs BEFORE X4 installs and AFTER X2 deployed. Earlier would be useless (the old writer
-- would still be running); later would mean X4's first report is already wrong.
--
-- WHAT IT DOES NOT DO. Attendees of an event that has NO sessions stay NULL, and that is
-- correct, not a miss: an event created after 20260727010000 applied gets no legacy session, so
-- there is nothing to attribute them to and session_id is nullable by design. The subquery
-- yields NULL for such an event, so the statement leaves those rows exactly as they were.
-- Post-condition to verify is therefore "no session-less attendee on an event that HAS a
-- session", not "no session-less attendee anywhere".
--
-- EXPAND-SAFE + IDEMPOTENT: a scoped UPDATE only. No DROP, no RENAME, no type narrowing, no
-- NOT NULL. session_id stays nullable — SET NOT NULL remains a later CONTRACT migration.
--
-- The exists predicate is load-bearing and is NOT redundant with the subquery. Without it the
-- statement matches every session_id-NULL row, including those on zero-session events where the
-- correlated lookup yields NULL — Postgres would still rewrite each of those rows from NULL to
-- NULL, taking a row lock and leaving a dead tuple on every apply. The data outcome is identical
-- either way, so this is not a semantic fix; it is what makes the statement genuinely touch
-- nothing on a re-run instead of merely producing the same values. Same predicate, same reason,
-- as 20260727010000's backfill.
update attendees
   set session_id = (select s.id
                       from sessions s
                      where s.event_id = attendees.event_id
                        and lower(s.title) = lower('General Admission')
                      order by s.id
                      limit 1)
 where session_id is null
   and exists (select 1
                 from sessions s
                where s.event_id = attendees.event_id
                  and lower(s.title) = lower('General Admission'));
