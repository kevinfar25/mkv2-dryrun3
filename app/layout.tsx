import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = {
  title: "Event RSVP Board",
  description: "MK V2 dry-run sandbox — UI-bearing Next.js + pg app",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          padding: "2rem",
          maxWidth: 760,
          marginInline: "auto",
        }}
      >
        {/* Shared top nav. Minimal on purpose — P3 adds its own link alongside Home. */}
        <nav
          data-testid="top-nav"
          style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}
        >
          <Link href="/">Home</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
