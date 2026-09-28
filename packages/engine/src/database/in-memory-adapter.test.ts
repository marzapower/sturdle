import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryAdapter } from "./in-memory-adapter.js";

const QUEUE = "test-queue";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseInput = () => ({
  code: "job",
  payload: {},
  status: "pending" as const,
  priority: 1,
  attempts: 0,
  maxAttempts: 3,
});

describe("InMemoryAdapter", () => {
  let adapter: InMemoryAdapter;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
  });

  describe("getQueueHealth", () => {
    it("returns the oldest pending job's createdAt", async () => {
      const older = await adapter.enqueueJob(QUEUE, baseInput());
      await sleep(5);
      await adapter.enqueueJob(QUEUE, baseInput());

      const health = await adapter.getQueueHealth(QUEUE, new Date(0));

      expect(health.oldestPendingAt).toEqual(older.createdAt);
    });

    it("counts completed and failed jobs only within the given range", async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const completedInRange = await adapter.enqueueJob(QUEUE, baseInput());
      await adapter.updateJob(completedInRange.id, {
        status: "completed",
        completedAt: new Date(since.getTime() + 60_000),
      });

      const completedOutOfRange = await adapter.enqueueJob(QUEUE, baseInput());
      await adapter.updateJob(completedOutOfRange.id, {
        status: "completed",
        completedAt: new Date(since.getTime() - 60_000),
      });

      const failedInRange = await adapter.enqueueJob(QUEUE, baseInput());
      await adapter.updateJob(failedInRange.id, {
        status: "failed",
        failedAt: new Date(since.getTime() + 30_000),
      });

      const failedOutOfRange = await adapter.enqueueJob(QUEUE, baseInput());
      await adapter.updateJob(failedOutOfRange.id, {
        status: "failed",
        failedAt: new Date(since.getTime() - 30_000),
      });

      const health = await adapter.getQueueHealth(QUEUE, since);

      expect(health.completedSince).toBe(1);
      expect(health.failedSince).toBe(1);
    });

    it("ignores jobs from other queues", async () => {
      await adapter.enqueueJob("other-queue", baseInput());

      const health = await adapter.getQueueHealth(QUEUE, new Date(0));

      expect(health.oldestPendingAt).toBeNull();
    });

    it("returns a null oldestPendingAt and zero counts for an empty queue", async () => {
      const health = await adapter.getQueueHealth(QUEUE, new Date());

      expect(health.oldestPendingAt).toBeNull();
      expect(health.completedSince).toBe(0);
      expect(health.failedSince).toBe(0);
    });
  });

  describe("getLastRunByCode", () => {
    it("returns the most recent job for the code, regardless of its status", async () => {
      const older = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await adapter.updateJob(older.id, { status: "completed", completedAt: new Date() });

      await sleep(5);

      const newer = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await adapter.updateJob(newer.id, { status: "failed", failedAt: new Date() });

      const lastRun = await adapter.getLastRunByCode("send-email");

      expect(lastRun?.id).toBe(newer.id);
      expect(lastRun?.status).toBe("failed");
    });

    it("returns null when no job with that code exists", async () => {
      const lastRun = await adapter.getLastRunByCode("unknown-code");

      expect(lastRun).toBeNull();
    });
  });

  describe("saveJobSteps / getJobSteps", () => {
    it("merges by attempt: saving a later attempt preserves the steps of earlier attempts", async () => {
      const job = await adapter.enqueueJob(QUEUE, baseInput());

      await adapter.saveJobSteps(job.id, [
        { name: "step-a", attempt: 1, startedAt: new Date(), status: "completed" },
      ]);
      await adapter.saveJobSteps(job.id, [
        { name: "step-b", attempt: 2, startedAt: new Date(), status: "running" },
      ]);

      const steps = await adapter.getJobSteps(job.id);

      expect(steps).toHaveLength(2);
      expect(steps.find((step) => step.name === "step-a")?.attempt).toBe(1);
      expect(steps.find((step) => step.name === "step-b")?.attempt).toBe(2);
    });

    it("replaces only the steps of the attempt being re-saved", async () => {
      const job = await adapter.enqueueJob(QUEUE, baseInput());

      await adapter.saveJobSteps(job.id, [
        { name: "step-a", attempt: 1, startedAt: new Date(), status: "running" },
      ]);
      await adapter.saveJobSteps(job.id, [
        { name: "step-a", attempt: 1, startedAt: new Date(), status: "completed", duration: 42 },
      ]);

      const steps = await adapter.getJobSteps(job.id);

      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe("completed");
      expect(steps[0]?.duration).toBe(42);
    });

    it("persists kind and preserves falsy results", async () => {
      const job = await adapter.enqueueJob(QUEUE, baseInput());

      await adapter.saveJobSteps(job.id, [
        {
          name: "sendEvent:child",
          attempt: 1,
          kind: "sendEvent",
          startedAt: new Date(),
          status: "completed",
          result: false,
        },
        {
          name: "count",
          attempt: 1,
          kind: "run",
          startedAt: new Date(),
          status: "completed",
          result: 0,
        },
      ]);

      const steps = await adapter.getJobSteps(job.id);

      expect(steps.find((step) => step.name === "sendEvent:child")?.kind).toBe("sendEvent");
      expect(steps.find((step) => step.name === "sendEvent:child")?.result).toBe(false);
      expect(steps.find((step) => step.name === "count")?.kind).toBe("run");
      expect(steps.find((step) => step.name === "count")?.result).toBe(0);
    });
  });

  describe("saveJobLogs / getJobLogs", () => {
    it("merges by attempt: saving a later attempt preserves the logs of earlier attempts", async () => {
      const job = await adapter.enqueueJob(QUEUE, baseInput());

      await adapter.saveJobLogs(job.id, [
        { level: "info", message: "attempt 1", timestamp: new Date(), attempt: 1 },
      ]);
      await adapter.saveJobLogs(job.id, [
        { level: "error", message: "attempt 2", timestamp: new Date(), attempt: 2 },
      ]);

      const logs = await adapter.getJobLogs(job.id);

      expect(logs.map((log) => log.message)).toEqual(["attempt 1", "attempt 2"]);
    });
  });

  describe("heartbeatJob", () => {
    it("renews updatedAt when the job is processing", async () => {
      const job = await adapter.enqueueJob(QUEUE, baseInput());
      await adapter.updateJob(job.id, { status: "processing" });
      const before = (await adapter.getJob(job.id))?.updatedAt;

      await sleep(5);
      await adapter.heartbeatJob(job.id);

      const after = await adapter.getJob(job.id);
      expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    });

    it("is a no-op when the job is not processing", async () => {
      const job = await adapter.enqueueJob(QUEUE, baseInput());
      const before = (await adapter.getJob(job.id))?.updatedAt;

      await sleep(5);
      await adapter.heartbeatJob(job.id);

      const after = await adapter.getJob(job.id);
      expect(after?.updatedAt.getTime()).toBe(before?.getTime());
    });
  });

  describe("suspendJob", () => {
    it("suspends the job: delayed, delayUntil, attempts - 1, stream acked, delayed row, metadata untouched", async () => {
      const job = await adapter.enqueueJob(QUEUE, { ...baseInput(), metadata: { foo: "bar" } });
      await adapter.updateJob(job.id, { status: "processing", attempts: 2 });

      const wakeAt = new Date(Date.now() + 60_000);
      await adapter.suspendJob(QUEUE, job.id, wakeAt);

      const updated = await adapter.getJob(job.id);
      expect(updated?.status).toBe("delayed");
      expect(updated?.delayUntil).toEqual(wakeAt);
      expect(updated?.attempts).toBe(1);
      expect(updated?.metadata).toEqual({ foo: "bar" });

      const ready = await adapter.getReadyDelayedJobs(QUEUE);
      expect(ready.map((j) => j.id)).not.toContain(job.id); // wakeAt is in the future

      // moveJobToStream then brings it back to the stream
      await adapter.moveJobToStream(QUEUE, job.id);
      const resumed = await adapter.getJob(job.id);
      expect(resumed?.status).toBe("pending");
    });
  });

  describe("releaseStaleJobs", () => {
    it("releases a processing job whose updatedAt is stale", async () => {
      const job = await adapter.enqueueJob(QUEUE, { ...baseInput(), attempts: 1, maxAttempts: 3 });
      await adapter.updateJob(job.id, { status: "processing" });
      // Force updatedAt into the past directly, bypassing updateJob (which always sets "now").
      const stale = await adapter.getJob(job.id);
      if (!stale) throw new Error("job not found");
      const jobs = (adapter as unknown as { jobs: Map<string, NonNullable<typeof stale>> }).jobs;
      jobs.set(job.id, { ...stale, updatedAt: new Date(Date.now() - 20 * 60 * 1000) });

      const releasedCount = await adapter.releaseStaleJobs(QUEUE, 15 * 60 * 1000);

      expect(releasedCount).toBe(1);
      const updated = await adapter.getJob(job.id);
      expect(updated?.status).toBe("pending");
    });

    it("leaves a processing job alone when updatedAt is recent, even if it started long ago", async () => {
      const job = await adapter.enqueueJob(QUEUE, { ...baseInput(), attempts: 1, maxAttempts: 3 });
      await adapter.updateJob(job.id, {
        status: "processing",
        processedAt: new Date(Date.now() - 20 * 60 * 1000),
      });

      const releasedCount = await adapter.releaseStaleJobs(QUEUE, 15 * 60 * 1000);

      expect(releasedCount).toBe(0);
      const updated = await adapter.getJob(job.id);
      expect(updated?.status).toBe("processing");
    });
  });

  describe("getChildJobs", () => {
    it("returns the full child jobs in creation order", async () => {
      const parent = await adapter.enqueueJob(QUEUE, baseInput());
      const child1 = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        parentJobId: parent.id,
      });
      const child2 = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        parentJobId: parent.id,
      });

      const children = await adapter.getChildJobs(parent.id);

      expect(children.map((child) => child.id)).toEqual([child1.id, child2.id]);
    });
  });

  describe("getTaskStats", () => {
    it("delegates to aggregateTaskStats, mapping processedAt to startedAt", async () => {
      const job = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      const startedAt = new Date(Date.now() - 60_000);
      await adapter.updateJob(job.id, {
        status: "completed",
        processedAt: startedAt,
        completedAt: new Date(),
      });

      const stats = await adapter.getTaskStats(24);

      const email = stats.find((s) => s.code === "send-email");
      expect(email?.completed).toBe(1);
      expect(email?.failed).toBe(0);
      expect(email?.p95DurationMs).toBeGreaterThan(0);
      expect(email?.series).toHaveLength(24);
    });

    it("with a code, only loads that code's rows", async () => {
      const email = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await adapter.updateJob(email.id, { status: "completed", completedAt: new Date() });

      const sms = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-sms" });
      await adapter.updateJob(sms.id, { status: "completed", completedAt: new Date() });

      const stats = await adapter.getTaskStats(24, "send-email");

      expect(stats.map((s) => s.code)).toEqual(["send-email"]);
    });
  });

  describe("listJobsByCode", () => {
    it("orders by createdAt desc across queues, regardless of listJobs' own ordering", async () => {
      const older = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await sleep(5);
      const newer = await adapter.enqueueJob("other-queue", { ...baseInput(), code: "send-email" });

      const jobs = await adapter.listJobsByCode("send-email");

      expect(jobs.map((job) => job.id)).toEqual([newer.id, older.id]);
    });

    it("ignores jobs of other codes", async () => {
      await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-sms" });
      const email = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });

      const jobs = await adapter.listJobsByCode("send-email");

      expect(jobs.map((job) => job.id)).toEqual([email.id]);
    });

    it("filters by status", async () => {
      const pending = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      const completed = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await adapter.updateJob(completed.id, { status: "completed", completedAt: new Date() });

      const jobs = await adapter.listJobsByCode("send-email", { status: "pending" });

      expect(jobs.map((job) => job.id)).toEqual([pending.id]);
    });

    it("applies offset and limit after ordering", async () => {
      const first = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await sleep(5);
      const second = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await sleep(5);
      const third = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });

      // Newest first: third, second, first. offset 1, limit 1 -> second only.
      const jobs = await adapter.listJobsByCode("send-email", { offset: 1, limit: 1 });

      expect(jobs.map((job) => job.id)).toEqual([second.id]);
      expect(first).toBeDefined();
      expect(third).toBeDefined();
    });
  });

  describe("dequeueJob keyed concurrency", () => {
    it("blocks a second job with the same key while the first is processing", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });
      await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });

      const first = await adapter.dequeueJob(QUEUE, "consumer");
      expect(first?.id).toBe(a.id);

      const second = await adapter.dequeueJob(QUEUE, "consumer");
      expect(second).toBeNull();
    });

    it("blocks a second job with the same key while the first is delayed with processedAt set", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });
      await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });

      const dequeuedA = await adapter.dequeueJob(QUEUE, "consumer");
      expect(dequeuedA?.id).toBe(a.id);

      await adapter.suspendJob(QUEUE, a.id, new Date(Date.now() + 60_000));

      const second = await adapter.dequeueJob(QUEUE, "consumer");
      expect(second).toBeNull();
    });

    it("still holds the key after the first is released from stale: it is re-picked before the second, which stays blocked", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });
      const b = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });

      const dequeuedA = await adapter.dequeueJob(QUEUE, "consumer");
      expect(dequeuedA?.id).toBe(a.id);

      // Force updatedAt into the past so releaseStaleJobs picks it up.
      const stale = await adapter.getJob(a.id);
      if (!stale) throw new Error("job not found");
      const jobs = (adapter as unknown as { jobs: Map<string, NonNullable<typeof stale>> }).jobs;
      jobs.set(a.id, { ...stale, updatedAt: new Date(Date.now() - 20 * 60 * 1000) });

      await adapter.releaseStaleJobs(QUEUE, 15 * 60 * 1000);

      const released = await adapter.getJob(a.id);
      expect(released?.status).toBe("pending");
      expect(released?.processedAt).toBeDefined(); // started_at is never cleared

      // A, being older and still holding its own key, is picked up again before B.
      const rePicked = await adapter.dequeueJob(QUEUE, "consumer");
      expect(rePicked?.id).toBe(a.id);

      // B remains blocked: A still holds the key.
      const stillBlocked = await adapter.dequeueJob(QUEUE, "consumer");
      expect(stillBlocked).toBeNull();
      expect(b).toBeDefined();
    });

    it("frees the key once the holder reaches completed", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });
      const b = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });

      const dequeuedA = await adapter.dequeueJob(QUEUE, "consumer");
      expect(dequeuedA?.id).toBe(a.id);

      await adapter.updateJob(a.id, { status: "completed", completedAt: new Date() });

      const dequeuedB = await adapter.dequeueJob(QUEUE, "consumer");
      expect(dequeuedB?.id).toBe(b.id);
    });

    it("frees the key once the holder reaches failed", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });
      const b = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });

      const dequeuedA = await adapter.dequeueJob(QUEUE, "consumer");
      expect(dequeuedA?.id).toBe(a.id);

      await adapter.updateJob(a.id, { status: "failed", failedAt: new Date() });

      const dequeuedB = await adapter.dequeueJob(QUEUE, "consumer");
      expect(dequeuedB?.id).toBe(b.id);
    });

    it("lets jobs with different keys be picked up together", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });
      const b = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:2",
        concurrencyLimit: 1,
      });

      const dequeuedA = await adapter.dequeueJob(QUEUE, "consumer");
      const dequeuedB = await adapter.dequeueJob(QUEUE, "consumer");

      expect([dequeuedA?.id, dequeuedB?.id].sort()).toEqual([a.id, b.id].sort());
    });

    it("allows up to the declared limit, blocking beyond it", async () => {
      const a = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 2,
      });
      const b = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 2,
      });
      await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 2,
      });

      const dequeuedA = await adapter.dequeueJob(QUEUE, "consumer");
      const dequeuedB = await adapter.dequeueJob(QUEUE, "consumer");
      expect([dequeuedA?.id, dequeuedB?.id].sort()).toEqual([a.id, b.id].sort());

      const third = await adapter.dequeueJob(QUEUE, "consumer");
      expect(third).toBeNull();
    });

    it("never filters jobs without a concurrencyKey", async () => {
      await adapter.enqueueJob(QUEUE, baseInput());
      await adapter.enqueueJob(QUEUE, baseInput());

      const first = await adapter.dequeueJob(QUEUE, "consumer");
      const second = await adapter.dequeueJob(QUEUE, "consumer");

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
    });

    it("does not let a delayed job that never started hold the key", async () => {
      const delayedNeverStarted = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
        status: "delayed",
        delayUntil: new Date(Date.now() + 60_000),
      });
      const b = await adapter.enqueueJob(QUEUE, {
        ...baseInput(),
        concurrencyKey: "order:1",
        concurrencyLimit: 1,
      });

      const dequeuedB = await adapter.dequeueJob(QUEUE, "consumer");

      expect(dequeuedB?.id).toBe(b.id);
      expect(delayedNeverStarted.processedAt).toBeUndefined();
    });
  });

  describe("getJobStatsByCode", () => {
    it("counts jobs per status for the given code only", async () => {
      const pending = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      const completed = await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-email" });
      await adapter.updateJob(completed.id, { status: "completed", completedAt: new Date() });
      await adapter.enqueueJob(QUEUE, { ...baseInput(), code: "send-sms" });

      const stats = await adapter.getJobStatsByCode("send-email");

      expect(stats).toEqual({
        total: 2,
        pending: 1,
        processing: 0,
        completed: 1,
        failed: 0,
        delayed: 0,
      });
      expect(pending).toBeDefined();
    });

    it("returns all-zero stats for a code with no jobs", async () => {
      const stats = await adapter.getJobStatsByCode("unknown-code");

      expect(stats).toEqual({
        total: 0,
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      });
    });
  });
});
