import { defineConfig, devices } from "@playwright/test";

// Drive against BASE_URL: a local server by default, or the Vercel PRODUCTION URL for the
// free-plan dry-run (preview deployment protection can't be bypassed on the free tier, so
// the production link is the drivable surface). Set BASE_URL=https://<project>.vercel.app.
// Local port 3100 (not 3000 — that's often taken; reusing it silently drives the WRONG app).
const PORT = process.env.PORT || "3100";
const baseURL = process.env.BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Only auto-start a server when driving localhost; against a hosted URL we drive what's live.
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `npm run start -- -p ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
