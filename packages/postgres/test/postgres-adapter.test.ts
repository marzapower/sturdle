import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EnqueueJobInput, JobStep, Log } from "@sturdle/engine";

import { PostgresAdapter } from "../src/adapter.js";

// Integration tests against a real Postgres instance. Skipped entirely when no test database is
// configured (e.g. local `pnpm vitest run` without the container up); the behavioural coverage
// only runs when TEST_DATABASE_URL is set, as it is in CI and via the second `pnpm vitest run`
// invocation documented in the package README.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function randomSchema(): string {
  return `sturdle_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// Each test gets its own queue: FIFO dequeue order is per-queue, so this keeps tests that assert
// "the next dequeued job is mine" independent of jobs left pending by other tests.
function uniqueQueue(): string {
  return `queue-${randomUUID()}`;
}

function baseJob(overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  return {
    code: "report/daily",
    status: "pending",
    priority: 1,
    attempts: 0,
    maxAttempts: 3,
    payload: { userId: "user-1" },
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)("PostgresAdapter", () => {
  const schema = randomSchema();
  let pool: Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    adapter = new PostgresAdapter({ pool, schema });
    await adapter.connect();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("connects, migrates and reports healthy", async () => {
    expect(adapter.isConnected()).toBe(true);
    await expect(adapter.healthCheck()).resolves.toEqual({ healthy: true });
  });

  it("enqueues an immediate job and dequeues it", async () => {
    const queueName = uniqueQueue();
    const job = await adapter.enqueueJob(queueName, baseJob({ code: "enqueue-dequeue" }));
    expect(job.id).toBeTruthy();
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);

    const dequeued = await adapter.dequeueJob(queueName, "consumer-1");
    expect(dequeued?.id).toBe(job.id);
    expect(dequeued?.status).toBe("processing");
    expect(dequeued?.attempts).toBe(1);

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("processing");
  });

  it("does not dequeue a job with a future delayUntil", async () => {
    const queueName = uniqueQueue();
    const future = new Date(Date.now() + 60_000);
    await adapter.enqueueJob(queueName, baseJob({ code: "future-delay", delayUntil: future }));

    const dequeued = await adapter.dequeueJob(queueName, "consumer-future");
    expect(dequeued).toBeNull();
  });

  it("moves a ready delayed job back to the stream and it becomes dequeueable", async () => {
    const queueName = uniqueQueue();
    const job = await adapter.enqueueJob(queueName, baseJob({ code: "delayed-resume" }));
    await adapter.dequeueJob(queueName, "consumer-resume");

    const past = new Date(Date.now() - 1000);
    await adapter.scheduleDelayedJob(queueName, job.id, past);

    const ready = await adapter.getReadyDelayedJobs(queueName);
    expect(ready.some((r) => r.id === job.id)).toBe(true);

    await adapter.moveJobToStream(queueName, job.id);

    const afterMove = await adapter.getJob(job.id);
    expect(afterMove?.status).toBe("pending");

    const dequeued = await adapter.dequeueJob(queueName, "consumer-resume-2");
    expect(dequeued?.id).toBe(job.id);
  });

  it("suspends a job and rolls back its attempt count", async () => {
    const queueName = uniqueQueue();
    const job = await adapter.enqueueJob(queueName, baseJob({ code: "suspend-me" }));
    const dequeued = await adapter.dequeueJob(queueName, "consumer-suspend");
    expect(dequeued?.attempts).toBe(1);

    const wakeAt = new Date(Date.now() + 1000);
    await adapter.suspendJob(queueName, job.id, wakeAt);

    const suspended = await adapter.getJob(job.id);
    expect(suspended?.status).toBe("delayed");
    expect(suspended?.attempts).toBe(0);
    expect(suspended?.delayUntil?.getTime()).toBe(wakeAt.getTime());

    const ready = await adapter.getReadyDelayedJobs(queueName);
    expect(ready.some((r) => r.id === job.id)).toBe(false); // not ready yet (wakeAt in the future)
  });

  it("updates a job, replacing metadata and disconnecting the parent", async () => {
    const queueName = uniqueQueue();
    const parent = await adapter.enqueueJob(queueName, baseJob({ code: "parent-job" }));
    const child = await adapter.enqueueJob(
      queueName,
      baseJob({ code: "child-job", parentJobId: parent.id }),
    );

    const completed = await adapter.updateJob(child.id, {
      status: "completed",
      completedAt: new Date(),
      result: { ok: true },
      metadata: { attemptHistory: [] },
    });
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ ok: true });
    expect(completed.parentJobId).toBe(parent.id);

    const disconnected = await adapter.updateJob(child.id, { parentJobId: "" });
    expect(disconnected.parentJobId).toBeUndefined();
  });

  it("acknowledges the stream entry when a job reaches a terminal or delayed status", async () => {
    const queueName = uniqueQueue();
    const job = await adapter.enqueueJob(queueName, baseJob({ code: "ack-on-complete" }));
    await adapter.dequeueJob(queueName, "consumer-ack");
    await adapter.updateJob(job.id, { status: "completed", completedAt: new Date() });

    // A second dequeue attempt must not pick this job up again (stream entry acknowledged).
    const again = await adapter.dequeueJob(queueName, "consumer-ack-2");
    expect(again?.id).not.toBe(job.id);
  });

  it("deletes a job entirely", async () => {
    const queueName = uniqueQueue();
    const job = await adapter.enqueueJob(queueName, baseJob({ code: "delete-me" }));
    await adapter.deleteJob(job.id);
    await expect(adapter.getJob(job.id)).resolves.toBeNull();
  });

  it("lists and counts jobs by queue and by code with filters", async () => {
    const queueName = uniqueQueue();
    const code = `list-code-${randomUUID()}`;
    await adapter.enqueueJob(queueName, baseJob({ code, priority: 5 }));
    await adapter.enqueueJob(queueName, baseJob({ code, priority: 9 }));

    const byQueue = await adapter.listJobs(queueName, { priority: 5 });
    expect(byQueue.filter((j) => j.code === code)).toHaveLength(1);

    const byCode = await adapter.listJobsByCode(code);
    expect(byCode).toHaveLength(2);

    const limited = await adapter.listJobsByCode(code, { limit: 1 });
    expect(limited).toHaveLength(1);

    const count = await adapter.countJobs(queueName, { status: "pending" });
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("computes job stats by queue and by code as numbers", async () => {
    const queueName = uniqueQueue();
    const code = `stats-code-${randomUUID()}`;
    await adapter.enqueueJob(queueName, baseJob({ code }));
    const job2 = await adapter.enqueueJob(queueName, baseJob({ code }));
    await adapter.updateJob(job2.id, { status: "failed", failedAt: new Date(), error: "boom" });

    const statsByCode = await adapter.getJobStatsByCode(code);
    expect(statsByCode.total).toBe(2);
    expect(statsByCode.pending).toBe(1);
    expect(statsByCode.failed).toBe(1);
    for (const value of Object.values(statsByCode)) {
      expect(typeof value).toBe("number");
    }

    const queueInfo = await adapter.getQueueInfo(queueName);
    expect(typeof queueInfo.size).toBe("number");
    expect(typeof queueInfo.delayedSize).toBe("number");
    expect(typeof queueInfo.processingSize).toBe("number");
  });

  it("releases stale processing jobs: retries under max attempts, fails at max attempts", async () => {
    const queueName = uniqueQueue();
    const retryable = await adapter.enqueueJob(
      queueName,
      baseJob({ code: "stale-retry", maxAttempts: 3 }),
    );
    await adapter.dequeueJob(queueName, "consumer-stale-1");

    const exhausted = await adapter.enqueueJob(
      queueName,
      baseJob({ code: "stale-exhausted", maxAttempts: 1 }),
    );
    await adapter.dequeueJob(queueName, "consumer-stale-2");

    // Backdate updated_at directly (the adapter has no public API for this) so both jobs look stale.
    await pool.query(
      `UPDATE "${schema}".jobs SET updated_at = now() - interval '10 minutes' WHERE id = ANY($1)`,
      [[retryable.id, exhausted.id]],
    );

    const released = await adapter.releaseStaleJobs(queueName, 5 * 60 * 1000);
    expect(released).toBeGreaterThanOrEqual(1);

    const retriedJob = await adapter.getJob(retryable.id);
    expect(retriedJob?.status).toBe("pending");

    const failedJob = await adapter.getJob(exhausted.id);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.error).toContain("stale");
  });

  it("tracks parent/child relationships", async () => {
    const queueName = uniqueQueue();
    const parent = await adapter.enqueueJob(queueName, baseJob({ code: "children-parent" }));
    const childA = await adapter.enqueueJob(
      queueName,
      baseJob({ code: "children-a", parentJobId: parent.id }),
    );
    const childB = await adapter.enqueueJob(
      queueName,
      baseJob({ code: "children-b", parentJobId: parent.id }),
    );

    const ids = await adapter.getChildJobIds(parent.id);
    expect(ids).toEqual([childA.id, childB.id]);

    const children = await adapter.getChildJobs(parent.id);
    expect(children.map((c) => c.id)).toEqual([childA.id, childB.id]);
  });

  it("round-trips logs and steps, merging by attempt", async () => {
    const queueName = uniqueQueue();
    const job = await adapter.enqueueJob(queueName, baseJob({ code: "logs-steps" }));

    const attempt1Logs: Log[] = [
      { level: "info", message: "attempt 1 started", timestamp: Date.now(), attempt: 1 },
    ];
    await adapter.saveJobLogs(job.id, attempt1Logs);

    const attempt1Steps: JobStep[] = [
      {
        name: "run:step-a",
        attempt: 1,
        kind: "run",
        startedAt: new Date(),
        completedAt: new Date(),
        duration: 5,
        status: "completed",
        result: { ok: true },
      },
    ];
    await adapter.saveJobSteps(job.id, attempt1Steps);

    const attempt2Logs: Log[] = [
      { level: "info", message: "attempt 2 started", timestamp: Date.now(), attempt: 2 },
    ];
    await adapter.saveJobLogs(job.id, attempt2Logs);

    const logs = await adapter.getJobLogs(job.id);
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.message).sort()).toEqual(
      ["attempt 1 started", "attempt 2 started"].sort(),
    );

    const steps = await adapter.getJobSteps(job.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.name).toBe("run:step-a");
    expect(steps[0]?.result).toEqual({ ok: true });
  });

  it("computes historical stats, performance metrics, queue health and last run", async () => {
    const queueName = uniqueQueue();
    const code = `history-code-${randomUUID()}`;
    const completed = await adapter.enqueueJob(queueName, baseJob({ code }));
    await adapter.dequeueJob(queueName, "consumer-history-1");
    await adapter.updateJob(completed.id, { status: "completed", completedAt: new Date() });

    const failed = await adapter.enqueueJob(queueName, baseJob({ code }));
    await adapter.dequeueJob(queueName, "consumer-history-2");
    await adapter.updateJob(failed.id, {
      status: "failed",
      failedAt: new Date(),
      error: "boom",
    });

    const historical = await adapter.getHistoricalStats(queueName, 2);
    expect(historical.length).toBeGreaterThan(0);
    for (const bucket of historical) {
      expect(typeof bucket.completed).toBe("number");
      expect(typeof bucket.failed).toBe("number");
      expect(typeof bucket.total).toBe("number");
    }

    const perf = await adapter.getPerformanceMetricsFromDB(queueName, 2);
    expect(typeof perf.totalJobs).toBe("number");
    expect(perf.totalJobs).toBeGreaterThanOrEqual(2);
    expect(typeof perf.successRate).toBe("number");

    const health = await adapter.getQueueHealth(queueName, new Date(Date.now() - 60 * 60 * 1000));
    expect(typeof health.completedSince).toBe("number");
    expect(typeof health.failedSince).toBe("number");

    const lastRun = await adapter.getLastRunByCode(code);
    expect(lastRun?.code).toBe(code);

    const taskStats = await adapter.getTaskStats(2, code);
    expect(taskStats).toHaveLength(1);
    expect(taskStats[0]?.completed).toBe(1);
    expect(taskStats[0]?.failed).toBe(1);
  });

  it("reports metrics as numbers", async () => {
    const metrics = await adapter.getMetrics();
    expect(metrics.database_type).toBe("postgresql");
    expect(typeof metrics.total_jobs).toBe("number");
    expect(typeof metrics.active_streams).toBe("number");
    expect(typeof metrics.active_locks).toBe("number");
    expect(typeof metrics.delayed_jobs).toBe("number");
  });

  it("acquires a lock, blocks a second acquirer, and rejects the wrong release token", async () => {
    const key = `lock-${randomUUID()}`;
    const token = await adapter.acquireLock(key, 5000);
    expect(token).toBeTruthy();

    const second = await adapter.acquireLock(key, 5000);
    expect(second).toBeNull();

    const wrongRelease = await adapter.releaseLock(key, "not-the-token");
    expect(wrongRelease).toBe(false);

    const rightRelease = await adapter.releaseLock(key, token!);
    expect(rightRelease).toBe(true);
  });

  it("re-acquires an expired lock", async () => {
    const key = `lock-expiring-${randomUUID()}`;
    const first = await adapter.acquireLock(key, 10);
    expect(first).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await adapter.acquireLock(key, 5000);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("resolves exactly one winner among two concurrent acquireLock calls on the same key", async () => {
    const key = `lock-concurrent-${randomUUID()}`;
    const [a, b] = await Promise.all([
      adapter.acquireLock(key, 5000),
      adapter.acquireLock(key, 5000),
    ]);

    const tokens = [a, b];
    expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    expect(tokens.filter((t) => t === null)).toHaveLength(1);
  });

  it("cleans up expired locks", async () => {
    const key = `lock-cleanup-${randomUUID()}`;
    await adapter.acquireLock(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cleaned = await adapter.cleanupExpiredLocks();
    expect(cleaned).toBeGreaterThanOrEqual(1);
  });

  it("lets only one of two concurrent dequeues win under a keyed concurrency limit of 1", async () => {
    const concurrencyQueue = "concurrency-queue";
    const key = `concurrency-key-${randomUUID()}`;

    const jobA = await adapter.enqueueJob(
      concurrencyQueue,
      baseJob({ code: "keyed-a", concurrencyKey: key, concurrencyLimit: 1 }),
    );
    const jobB = await adapter.enqueueJob(
      concurrencyQueue,
      baseJob({ code: "keyed-b", concurrencyKey: key, concurrencyLimit: 1 }),
    );

    const [first, second] = await Promise.all([
      adapter.dequeueJob(concurrencyQueue, "consumer-keyed-1"),
      adapter.dequeueJob(concurrencyQueue, "consumer-keyed-2"),
    ]);

    const winners = [first, second].filter((j) => j !== null);
    expect(winners).toHaveLength(1);
    expect([jobA.id, jobB.id]).toContain(winners[0]?.id);

    // The other job is still pending, correctly excluded by the concurrency key filter.
    const loserId = winners[0]?.id === jobA.id ? jobB.id : jobA.id;
    const loser = await adapter.getJob(loserId);
    expect(loser?.status).toBe("pending");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PostgresAdapter disconnect ownership", () => {
  it("does not close a pool it was not given ownership of", async () => {
    const schema = randomSchema();
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    const adapter = new PostgresAdapter({ pool, schema });
    await adapter.connect();

    await adapter.disconnect();
    // The externally-owned pool must still be usable after disconnect().
    await expect(pool.query("SELECT 1")).resolves.toBeDefined();

    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("closes a pool it created itself from a connectionString", async () => {
    const schema = randomSchema();
    const adapter = new PostgresAdapter({ connectionString: TEST_DATABASE_URL!, schema });
    await adapter.connect();
    await adapter.disconnect();

    // Clean up the schema through a fresh pool, since the adapter's own pool is now closed.
    const cleanupPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanupPool.end();
  });
});
