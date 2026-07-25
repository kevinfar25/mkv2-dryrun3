import Link from "next/link";
import { listEvents } from "@/lib/store";

// Reads the DB at request time. WITHOUT this, `next build` would try to prerender the
// page — where DATABASE_URL is absent — and the (lazy) pool in lib/db.ts would throw.
export const dynamic = "force-dynamic";

// Fixed UTC formatting rather than toLocale*: the server's locale/timezone is not the
// viewer's, and a deterministic string is what the browser tests can assert on.
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** store.ts normalizes timestamptz to an ISO string; guard anyway rather than print NaN. */
function formatStartsAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${DATE_FORMAT.format(date)} UTC`;
}

export default async function Home() {
  const events = await listEvents();

  return (
    <main data-testid="home">
      <h1>Event RSVP Board</h1>

      {events.length === 0 ? (
        <p data-testid="events-empty">No events yet.</p>
      ) : (
        <table
          data-testid="events-list"
          style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}
        >
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid #ccc", padding: "0.5rem 0.5rem 0.5rem 0" }}>
                Event
              </th>
              <th style={{ borderBottom: "1px solid #ccc", padding: "0.5rem" }}>Starts</th>
              <th style={{ borderBottom: "1px solid #ccc", padding: "0.5rem" }}>Location</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} data-testid="event-row">
                <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem 0.5rem 0.5rem 0" }}>
                  <Link href={`/events/${event.id}`}>{event.title}</Link>
                </td>
                <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                  <time dateTime={event.starts_at}>{formatStartsAt(event.starts_at)}</time>
                </td>
                <td style={{ borderBottom: "1px solid #eee", padding: "0.5rem" }}>
                  {event.location}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
