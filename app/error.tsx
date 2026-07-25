"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";

// App Router error boundary: a server-component render throw (most likely the database
// being unreachable) would otherwise white-screen. Render a plain, friendly fallback and
// let the visitor retry — reset() re-renders the segment.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // Keep the cause diagnosable — the visitor gets no detail, the console keeps the digest.
  console.error("render failed", error.digest ?? error.message);

  // reset() alone only re-renders the boundary against the cached RSC payload, so a
  // force-dynamic server page that threw stays thrown even after the database recovers —
  // the visitor would be stuck here until a manual reload. refresh() discards that payload
  // and re-runs the server render, and reset() then clears the boundary so it can mount.
  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <main data-testid="app-error">
      <h1>Something went wrong</h1>
      <p>We could not load the event board just now. Please try again in a moment.</p>
      <button type="button" data-testid="app-error-retry" onClick={retry}>
        Try again
      </button>
    </main>
  );
}
