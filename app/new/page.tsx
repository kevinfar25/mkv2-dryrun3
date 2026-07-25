"use client";

// Client component: the form owns its own state and POSTs JSON to /api/events, so the
// server stays the single validator (never trust the client — the route re-checks with Zod).

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * A `datetime-local` value is wall-clock with NO offset ("2026-08-04T17:00"), but the API
 * requires ISO 8601 WITH an offset. Convert here; on an empty/unparseable value hand the raw
 * string to the server so the 400 — and the inline error — comes from one place.
 */
function toIsoStartsAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

type CreatedEvent = { id: number };

export default function NewEventPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, startsAt: toIsoStartsAt(startsAt), location }),
      });
      const body = (await res.json().catch(() => null)) as
        | { event?: CreatedEvent; error?: string; errors?: string[] }
        | null;

      if (!res.ok) {
        // Flatten the route's field messages; fall back to the status so the inline error
        // is never blank.
        const detail = body?.errors?.length ? body.errors.join(", ") : body?.error;
        setError(detail ?? `Could not create the event (${res.status})`);
        return;
      }

      const id = body?.event?.id;
      if (typeof id !== "number") {
        setError("Event created, but the response was malformed");
        return;
      }
      router.push(`/events/${id}`);
    } catch {
      setError("Could not create the event — network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <main data-testid="new-event">
      <h1>New event</h1>

      {/* No `required` attributes on purpose: the browser would block submit before the
          request, and the server-side 400 path is what we want exercised and shown. */}
      <form onSubmit={onSubmit} data-testid="create-form" noValidate>
        <p>
          <label htmlFor="title">Title</label>
          <br />
          <input
            id="title"
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Team Offsite Planning"
            data-testid="create-title"
          />
        </p>
        <p>
          <label htmlFor="startsAt">Starts at</label>
          <br />
          <input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            data-testid="create-starts-at"
          />
        </p>
        <p>
          <label htmlFor="location">Location</label>
          <br />
          <input
            id="location"
            name="location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Valletta HQ — Room 2"
            data-testid="create-location"
          />
        </p>
        <button type="submit" disabled={pending} data-testid="create-submit">
          {pending ? "Creating…" : "Create event"}
        </button>
        {error ? (
          <p role="alert" data-testid="form-error">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
