import Link from "next/link";
import { notFound } from "next/navigation";
import { rsvpSummary } from "@/lib/format";
import { getEvent, rsvpCount } from "@/lib/store";
import RsvpForm from "./rsvp-form";
// P6 imports on its OWN line rather than widening the import above: P6 installs LAST in
// the merge train, so a diff with ZERO deleted lines cannot conflict on rebase.
import { listAttendees } from "@/lib/store";

// Reads the DB → must be dynamic. `next build` has no DATABASE_URL and the pool in
// lib/db.ts is lazy for the same reason; a statically rendered page would throw.
export const dynamic = "force-dynamic";

/** starts_at/created_at are normalized to ISO strings by lib/store.ts. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Only a plain positive integer is a real id — "abc" or "1e3" is a 404, not a query.
  const eventId = /^\d+$/.test(id) ? Number(id) : Number.NaN;
  // events.id is a `serial` (int4): anything past 2147483647 makes Postgres raise 22003
  // instead of returning no rows, so it has to 404 here rather than reach the query.
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > 2147483647) notFound();

  const event = await getEvent(eventId);
  if (!event) notFound();

  // rsvpCount tolerates 42P01 (attendees not created yet) → 0, so the page still renders
  // in the deploy → POST /api/setup window.
  const count = await rsvpCount(eventId);

  // P6 — the drill-down list. ONE query for every attendee (no per-row fan-out), and it
  // tolerates 42P01 the same way rsvpCount does, so the page still renders on the old
  // schema. rsvp-form.tsx calls router.refresh() after a successful RSVP, which re-runs
  // this server component and picks the new name up.
  const attendees = await listAttendees(eventId);

  return (
    <main>
      <p>
        <Link href="/">← All events</Link>
      </p>
      <h1 data-testid="event-title">{event.title}</h1>
      <dl>
        <dt>When</dt>
        <dd data-testid="event-starts-at">{formatWhen(event.starts_at)}</dd>
        <dt>Where</dt>
        <dd data-testid="event-location">{event.location}</dd>
      </dl>
      <p data-testid="rsvp-summary">{rsvpSummary(count)}</p>
      <RsvpForm eventId={event.id} />
      {/* The testid lives on the WRAPPER, not the <ul>, so it is present in BOTH states —
          a locator on it never has to know whether anybody has RSVP'd yet. */}
      <section data-testid="attendee-list">
        <h2>Attendees</h2>
        {attendees.length === 0 ? (
          <p data-testid="attendees-empty">No one has RSVP&apos;d yet.</p>
        ) : (
          <ul>
            {attendees.map((attendee, index) => (
              // name is unique per event only case-insensitively, and two rows can share
              // a created_at, so the index is the only stable key for this ordered list.
              <li key={`${attendee.name}-${index}`} data-testid="attendee">
                <span data-testid="attendee-name">{attendee.name}</span>{" "}
                <time dateTime={attendee.createdAt}>{formatWhen(attendee.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
