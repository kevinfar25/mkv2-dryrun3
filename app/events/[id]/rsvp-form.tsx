"use client";

// Its OWN file: the App Router forbids "use client" in a file that also exports a
// server component, and app/events/[id]/page.tsx must stay a server component.

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function RsvpForm({ eventId }: { eventId: number }) {
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
