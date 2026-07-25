"use client";

// Its OWN file: the App Router forbids "use client" in a file that also exports a
// server component, and app/events/[id]/page.tsx must stay a server component.

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
// Type-only import: erased at compile time, so this client component never pulls lib/db in.
import type { SessionSummary } from "@/lib/store";

export type RsvpFormProps = {
  eventId: number;
  /**
   * X1 plumbing — the event's sessions, already aggregated by listSessions and passed down by
   * the server page. OPTIONAL so any caller that has not been updated still type-checks.
   * X2 renders the picker below when this is non-empty. Consuming the prop HERE is what means
   * X2 never has to touch app/events/[id]/page.tsx (X3's file).
   */
  sessions?: SessionSummary[];
};

export default function RsvpForm({ eventId, sessions }: RsvpFormProps) {
  // An event with NO sessions keeps the single-field form exactly as it was: no <select>,
  // and no sessionId key in the body (rsvpInput is .strict(), and the server accepts the
  // omission only for a zero-session event).
  const sessionList = sessions ?? [];
  const hasSessions = sessionList.length > 0;
  const router = useRouter();
  const [name, setName] = useState("");
  // Default to the first session — the list is ordered starts_at, title, id, so that is the
  // one the door is most likely scanning. Stored as a string: <select> values always are.
  const [sessionId, setSessionId] = useState(
    hasSessions ? String(sessionList[0].id) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Derived, not stored: router.refresh() can hand this component a NEW session list (X3's
  // schedule, or the migration finally being applied), and a stale selected id would then
  // POST a session this event no longer has. Falling back to the first session keeps the
  // rendered value and the submitted value the same thing.
  const selected =
    hasSessions && sessionList.some((s) => String(s.id) === sessionId)
      ? sessionId
      : hasSessions
        ? String(sessionList[0].id)
        : "";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The key is present ONLY when the event has sessions: rsvpInput is .strict(), so
        // sending sessionId: undefined-turned-null to a zero-session event would be a 400.
        body: JSON.stringify(hasSessions ? { name, sessionId: Number(selected) } : { name }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `RSVP failed (${res.status})`);
        return;
      }
      setName("");
      // Re-render the server component so the summary reflects the new count. A repeat
      // RSVP is a no-op server-side, so the count simply stays put.
      router.refresh();
    } catch {
      setError("RSVP failed — network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} data-testid="rsvp-form">
      <label htmlFor="rsvp-name">Your name</label>{" "}
      <input
        id="rsvp-name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ada Lovelace"
        data-testid="rsvp-name"
      />{" "}
      {hasSessions ? (
        <>
          <label htmlFor="rsvp-session">Session</label>{" "}
          <select
            id="rsvp-session"
            name="sessionId"
            value={selected}
            onChange={(e) => setSessionId(e.target.value)}
            data-testid="rsvp-session"
          >
            {sessionList.map((session) => (
              <option key={session.id} value={session.id}>
                {session.room ? `${session.title} — ${session.room}` : session.title}
              </option>
            ))}
          </select>{" "}
        </>
      ) : null}
      <button type="submit" disabled={pending} data-testid="rsvp-submit">
        {pending ? "RSVPing…" : "RSVP"}
      </button>
      {error ? (
        <p role="alert" data-testid="rsvp-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
