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
        {children}
      </body>
    </html>
  );
}
