import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Engine, type FunctionDefinition, JobRegistry } from "@sturdle/engine";

import { PostgresAdapter } from "../src/adapter.js";

// End-to-end coverage of the engine driving PostgresAdapter for real: memoized steps across a
// retry, suspend/resume via step.sleep, a cron job under its distributed lock, keyed concurrency,
// and a dead letter with its hook. JobRegistry and the engine's messenger are process-wide
// statics, so each test resets the registry and runs exactly one Engine at a time, stopped in
// afterEach.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function randomSchema(): string {
  return `sturdle_test_e2e_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  options: WaitOptions = {},
): Promise<T> {
  const { timeoutMs = 15000, intervalMs = 100 } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe.skipIf(!TEST_DATABASE_URL)("Engine + PostgresAdapter", () => {
  const schema = randomSchema();
  let pool: Pool;
  let adapter: PostgresAdapter;
  let engine: Engine | null = null;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    adapter = new PostgresAdapter({ pool, schema });
    await adapter.connect();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  beforeEach(() => {
    JobRegistry.cleanUp();
  });

  afterEach(async () => {
    if (engine) {
      // Engine.stop() (bare) waits for the dispatcher's own Stoppable wrapper to have already
      // reported itself stopped, which nothing triggers on its own — gracefullyShutdown() is the
      // actual public shutdown entry point: it broadcasts a GracefullyShutdown event that every
      // Stoppable (workers, dispatcher, schedulers, the engine itself) reacts to independently,
      // then waits for the engine to reach `stopped`.
      await engine.gracefullyShutdown();
      engine = null;
    }
  }, 20000);

  it("memoizes a completed step.run across a retry", async () => {
    let runCount = 0;
    let invocationCount = 0;

    const definition: FunctionDefinition = {
      name: "memo-retry",
      event: "test/memo-retry",
      func: async (ctx) => {
        const value = await ctx.step.run("compute", async () => {
          runCount++;
          return "computed-value";
        });
        invocationCount++;
        if (invocationCount === 1) {
          throw new Error("fail on first attempt");
        }
        return { value };
      },
    };

    engine = new Engine({ databaseAdapter: adapter });
    engine.registerJobs([definition]);
    await engine.start();

    const jobId = await engine.addJob("test/memo-retry", {}, { maxAttempts: 3 });

    const job = await waitFor(async () => {
      const current = await adapter.getJob(jobId);
      return current?.status === "completed" || current?.status === "failed" ? current : null;
    });

    expect(job.status).toBe("completed");
    expect(runCount).toBe(1); // the memoized step never re-ran on the retry
    expect(invocationCount).toBe(2); // but the handler itself ran once per attempt
  }, 20000);

  it("suspends on step.sleep and resumes to completion", async () => {
    const definition: FunctionDefinition = {
      name: "sleep-resume",
      event: "test/sleep-resume",
      func: async (ctx) => {
        await ctx.step.sleep("wait", 1500);
        return { done: true };
      },
    };

    engine = new Engine({ databaseAdapter: adapter });
    engine.registerJobs([definition]);
    await engine.start();

    const jobId = await engine.addJob("test/sleep-resume", {});

    const suspended = await waitFor(async () => {
      const current = await adapter.getJob(jobId);
      return current?.status === "delayed" ? current : null;
    });
    expect(suspended.status).toBe("delayed");

    const completed = await waitFor(async () => {
      const current = await adapter.getJob(jobId);
      return current?.status === "completed" ? current : null;
    });

    expect(completed.result).toEqual({ done: true });
  }, 20000);

  it("runs a cron job under its distributed lock", async () => {
    let runCount = 0;

    const definition: FunctionDefinition = {
      name: "cron-job",
      event: "test/cron-job",
      cron: "*/2 * * * * *",
      func: async () => {
        runCount++;
        return {};
      },
    };

    engine = new Engine({ databaseAdapter: adapter });
    engine.registerJobs([definition]);
    await engine.start();

    await waitFor(async () => (runCount > 0 ? runCount : null));

    expect(runCount).toBeGreaterThan(0);
  }, 20000);

  it("enforces a keyed concurrency limit of 1", async () => {
    let running = 0;
    let maxObservedConcurrency = 0;

    const definition: FunctionDefinition = {
      name: "keyed-concurrency",
      event: "test/keyed-concurrency",
      concurrency: { limit: 1, key: "resourceId" },
      func: async () => {
        running++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, running);
        await new Promise((resolve) => setTimeout(resolve, 400));
        running--;
        return {};
      },
    };

    engine = new Engine({ databaseAdapter: adapter, maxWorkers: 5 });
    engine.registerJobs([definition]);
    await engine.start();

    const jobId1 = await engine.addJob("test/keyed-concurrency", { resourceId: "shared" });
    const jobId2 = await engine.addJob("test/keyed-concurrency", { resourceId: "shared" });

    await waitFor(async () => {
      const [j1, j2] = await Promise.all([adapter.getJob(jobId1), adapter.getJob(jobId2)]);
      return j1?.status === "completed" && j2?.status === "completed" ? true : null;
    });

    expect(maxObservedConcurrency).toBe(1);
  }, 20000);

  it("dead-letters a job that exhausts its (single) attempt and calls onDeadLetter", async () => {
    const deadLetters: { jobId: string; error: string; attempts: number }[] = [];

    const definition: FunctionDefinition = {
      name: "always-fails",
      event: "test/always-fails",
      func: async () => {
        throw new Error("boom");
      },
      onDeadLetter: async (ctx) => {
        deadLetters.push({ jobId: ctx.jobId, error: ctx.error, attempts: ctx.attempts });
      },
    };

    engine = new Engine({ databaseAdapter: adapter });
    engine.registerJobs([definition]);
    await engine.start();

    const jobId = await engine.addJob("test/always-fails", {}, { maxAttempts: 1 });

    const failed = await waitFor(async () => {
      const current = await adapter.getJob(jobId);
      return current?.status === "failed" ? current : null;
    });

    expect(failed.status).toBe("failed");
    expect(failed.metadata?.deadLetter).toBeDefined();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.jobId).toBe(jobId);
  }, 20000);
});
