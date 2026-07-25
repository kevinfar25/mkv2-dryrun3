import Link from "next/link";
import { notFound } from "next/navigation";
import { rsvpSummary } from "@/lib/format";
import { getEvent, rsvpCount } from "@/lib/store";
import RsvpForm from "./rsvp-form";

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
    </main>
  );
}
