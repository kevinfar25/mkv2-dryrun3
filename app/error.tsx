"use client";

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
  // Keep the cause diagnosable — the visitor gets no detail, the console keeps the digest.
  console.error("render failed", error.digest ?? error.message);

  return (
    <main data-testid="app-error">
      <h1>Something went wrong</h1>
      <p>We could not load the event board just now. Please try again in a moment.</p>
      <button type="button" data-testid="app-error-retry" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
