// Baseline landing page. The MK V2 fleet replaces this with the real events list
// (P2). Kept minimal but buildable so `next build` is green from the first commit.
export default function Home() {
  return (
    <main data-testid="home">
      <h1>Event RSVP Board</h1>
      <p>MK V2 dry-run sandbox. The fleet builds the real UI on top of this baseline.</p>
    </main>
  );
}
