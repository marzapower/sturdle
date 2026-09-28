import { NextResponse } from "next/server";

import { getEngine } from "../../../lib/engine";

export const runtime = "nodejs";

// POST /api/enqueue { "to": "someone@example.com", "subject": "Hello" }
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Partial<{
    to: string;
    subject: string;
  }>;

  const to = body.to ?? "someone@example.com";
  const subject = body.subject ?? "Hello from Sturdle";

  const engine = await getEngine();
  const jobId = await engine.addJob("email/send", { to, subject });

  return NextResponse.json({ jobId, to, subject });
}
