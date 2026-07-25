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
   * Accepted and rendered NOWHERE yet: X2 owns the picker UI that consumes it. Keeping the
   * prop here means X2 never has to touch app/events/[id]/page.tsx (X3's file).
   */
  sessions?: SessionSummary[];
};

export default function RsvpForm({ eventId, sessions }: RsvpFormProps) {
  // Referenced, not rendered — the prop is part of the contract now; X2 replaces this line
  // with the picker. `void` keeps the no-unused-vars rule honest without inventing markup.
  void sessions;
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/events/${eventId}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
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
