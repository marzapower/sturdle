import { Engine } from "@sturdle/engine";
import { PostgresAdapter } from "@sturdle/postgres";

import "../jobs/email-send";

// One engine per Node process. Next.js re-evaluates modules in development (hot reload) and
// may load this file from more than one bundle (instrumentation, route handlers), so the
// instance is parked on `globalThis`: whoever gets there first creates and starts it, everyone
// else awaits the same promise. Without this guard the dev server would start a second set of
// workers polling the same tables.
declare global {
  var __sturdleEngine: Promise<Engine> | undefined;
}

export function getEngine(): Promise<Engine> {
  if (!globalThis.__sturdleEngine) {
    globalThis.__sturdleEngine = startEngine();
  }
  return globalThis.__sturdleEngine;
}

async function startEngine(): Promise<Engine> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }

  const engine = new Engine({
    databaseAdapter: new PostgresAdapter({ connectionString }),
    onEvent: (event) => {
      if (event.type === "job.dead-lettered") {
        console.error("[sturdle] dead-lettered", event.jobId, event.error);
      }
    },
  });

  // Connects, applies the migrations if needed, then starts polling for jobs.
  await engine.start();
  console.log("[sturdle] engine started");
  return engine;
}
