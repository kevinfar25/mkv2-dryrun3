import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness probe — no DB touch, so it works before any migration runs.
export async function GET() {
  return NextResponse.json({ ok: true, service: "mkv2-dryrun3" });
}
