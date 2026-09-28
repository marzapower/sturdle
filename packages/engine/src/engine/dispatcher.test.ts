import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineEvent } from "../telemetry.js";
import type { FunctionContext, FunctionDefinition } from "../types.js";

import type { Log } from "../logger.js";

import type { Job, JobStep } from "../database/types.js";
import { EnhancedJob } from "../database/enhanced-job.js";
import { InMemoryAdapter } from "../database/in-memory-adapter.js";
import { DatabaseEngine } from "./database-engine.js";
import {
  calculateExponentialBackoff,
  createJobHandler,
  Dispatcher,
  JOB_SUSPENDED,
} from "./dispatcher.js";
import { Queue } from "./queue.js";
import { JobRegistry } from "./registry.js";

const QUEUE_NAME = "default";

function setup() {
  const events: EngineEvent[] = [];
  const adapter = new InMemoryAdapter();
  const databaseEngine = new DatabaseEngine({ adapter });
  const dispatcher = new Dispatcher(1, databaseEngine, undefined, (event) => events.push(event));
  const queue = new Queue(
    { name: QUEUE_NAME, concurrency: 3, priority: 50 },
    databaseEngine,
    "test-consumer",
  );
  dispatcher.registerQueue(queue);
  return { adapter, databaseEngine, dispatcher, queue, events };
}

async function enqueueAndDequeue(
  queue: Queue,
  databaseEngine: DatabaseEngine,
  code: string,
  maxAttempts = 3,
): Promise<Job> {
  await queue.enqueueJob(code, {}, { maxAttempts });
  const job = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
  if (!job) throw new Error("Expected a dequeued job");
  return job;
}

describe("calculateExponentialBackoff", () => {
  it("grows with the attempt number and caps at 5 minutes", () => {
    const first = calculateExponentialBackoff(1);
    const second = calculateExponentialBackoff(2);
    const third = calculateExponentialBackoff(3);

    // Jitter adds up to 1s of noise, so compare with slack while still asserting growth.
    expect(second).toBeGreaterThan(first - 1000);
    expect(third).toBeGreaterThan(second - 1000);
    expect(calculateExponentialBackoff(100)).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });
});

describe("createJobHandler", () => {
  afterEach(() => {
    JobRegistry.cleanUp();
  });

  it("completes successfully and persists the result and steps", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "success-job");

    const funcDef: FunctionDefinition = {
      name: "Success job",
      func: async (ctx: FunctionContext) => {
        const value = await ctx.step.run("compute", () => ({ ok: true }));
        return value;
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    const result = await handler(job);

    expect(result).toStrictEqual({ ok: true });

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.result).toStrictEqual({ ok: true });

    const steps = await adapter.getJobSteps(job.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe("completed");
  });

  it("schedules a retry with attempt history when the job can still be retried", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "retriable-job", 3);

    const funcDef: FunctionDefinition = {
      name: "Retriable job",
      func: async () => {
        await Promise.resolve();
        throw new Error("boom");
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("boom");

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("delayed");
    expect(stored?.delayUntil).toBeInstanceOf(Date);
    expect(stored?.metadata?.attemptHistory).toHaveLength(1);
    expect(stored?.metadata?.attemptHistory?.[0]?.retryAt).toBeTruthy();
    expect(stored?.metadata?.attemptHistory?.[0]?.error).toBe("boom");

    // A retriable failure is not a dead letter: createJobHandler itself emits nothing (Worker's
    // generic catch is the one that would report a plain job.error, and isn't exercised here).
    expect(events).toHaveLength(0);
  });

  it("moves the job to failed with a dead letter reason on the last attempt", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "last-attempt-job", 1);

    const funcDef: FunctionDefinition = {
      name: "Last attempt job",
      func: async () => {
        await Promise.resolve();
        throw new Error("final failure");
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("final failure");

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.deadLetter?.reason).toBe("max attempts reached");
    expect(stored?.metadata?.attemptHistory).toHaveLength(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "job.dead-lettered",
      jobId: job.id,
      code: "last-attempt-job",
      attempts: job.attempts,
      error: "final failure",
    });
  });

  it("fails immediately on a NonRetriableError regardless of remaining attempts", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "non-retriable-job", 5);

    const funcDef: FunctionDefinition = {
      name: "Non retriable job",
      func: async () => {
        await Promise.resolve();
        const error = new Error("do not retry");
        error.name = "NonRetriableError";
        throw error;
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("do not retry");

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.deadLetter?.reason).toBe("non-retriable error");
    expect(stored?.metadata?.attemptHistory?.[0]?.nonRetriable).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("job.dead-lettered");
  });

  it("calls onDeadLetter with the payload, error, jobId and attempts when the job reaches max attempts", async () => {
    const { databaseEngine, dispatcher, queue } = setup();
    await queue.enqueueJob("dead-letter-hook-job", { foo: "bar" }, { maxAttempts: 1 });
    const job = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!job) throw new Error("Expected a dequeued job");

    const onDeadLetter = vi.fn().mockResolvedValue(undefined);
    const funcDef: FunctionDefinition = {
      name: "Dead letter hook job",
      func: async () => {
        await Promise.resolve();
        throw new Error("final failure");
      },
      onDeadLetter,
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("final failure");

    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(onDeadLetter).toHaveBeenCalledWith({
      payload: { foo: "bar" },
      error: "final failure",
      jobId: job.id,
      attempts: job.attempts,
    });
  });

  it("calls onDeadLetter on a NonRetriableError even with attempts remaining", async () => {
    const { databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "non-retriable-hook-job", 5);

    const onDeadLetter = vi.fn().mockResolvedValue(undefined);
    const funcDef: FunctionDefinition = {
      name: "Non retriable hook job",
      func: async () => {
        await Promise.resolve();
        const error = new Error("do not retry");
        error.name = "NonRetriableError";
        throw error;
      },
      onDeadLetter,
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("do not retry");

    expect(onDeadLetter).toHaveBeenCalledTimes(1);
  });

  it("does not call onDeadLetter when the job is scheduled for retry", async () => {
    const { databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "retry-no-hook-job", 3);

    const onDeadLetter = vi.fn().mockResolvedValue(undefined);
    const funcDef: FunctionDefinition = {
      name: "Retry no hook job",
      func: async () => {
        await Promise.resolve();
        throw new Error("boom");
      },
      onDeadLetter,
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("boom");

    expect(onDeadLetter).not.toHaveBeenCalled();
  });

  it("emits hook.error and does not rethrow when the onDeadLetter hook itself fails, leaving the job failed", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "hook-error-job", 1);

    const onDeadLetter = vi.fn().mockRejectedValue(new Error("hook exploded"));
    const funcDef: FunctionDefinition = {
      name: "Hook error job",
      func: async () => {
        await Promise.resolve();
        throw new Error("final failure");
      },
      onDeadLetter,
    };

    const handler = createJobHandler(funcDef, dispatcher);
    // The original failure is what rejects the handler, not the hook's own error.
    await expect(handler(job)).rejects.toThrow("final failure");

    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("failed");

    expect(events.map((e) => e.type)).toStrictEqual(["job.dead-lettered", "hook.error"]);
  });

  it("creates a child job with parentJobId when step.sendEvent is called", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();

    JobRegistry.register({
      name: "Child job",
      event: "child-event",
      func: async () => Promise.resolve({}),
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "parent-job");

    const funcDef: FunctionDefinition = {
      name: "Parent job",
      func: async (ctx: FunctionContext) => {
        await ctx.step.sendEvent("child-event", { name: "child-event", data: {} });
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await handler(job);

    const childIds = await adapter.getChildJobIds(job.id);
    expect(childIds).toHaveLength(1);

    const childJob = await adapter.getJob(childIds[0] as string);
    expect(childJob?.parentJobId).toBe(job.id);
  });

  it("tags a child job with the step that spawned it via step.sendEvent", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();

    JobRegistry.register({
      name: "Child job",
      event: "child-event",
      func: async () => Promise.resolve({}),
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "parent-job-with-step");

    const funcDef: FunctionDefinition = {
      name: "Parent job with step",
      func: async (ctx: FunctionContext) => {
        await ctx.step.run("notify", async () => {
          await ctx.step.sendEvent("child-event", { name: "child-event", data: {} });
        });
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await handler(job);

    const childIds = await adapter.getChildJobIds(job.id);
    const childJob = await adapter.getJob(childIds[0] as string);

    expect(childJob?.metadata?.spawnedBy).toStrictEqual({ jobId: job.id, step: "notify" });
  });

  it("tags a child job with a null step when step.sendEvent is called outside step.run", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();

    JobRegistry.register({
      name: "Child job",
      event: "child-event",
      func: async () => Promise.resolve({}),
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "parent-job-no-step");

    const funcDef: FunctionDefinition = {
      name: "Parent job no step",
      func: async (ctx: FunctionContext) => {
        await ctx.step.sendEvent("child-event", { name: "child-event", data: {} });
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await handler(job);

    const childIds = await adapter.getChildJobIds(job.id);
    const childJob = await adapter.getJob(childIds[0] as string);

    expect(childJob?.metadata?.spawnedBy).toStrictEqual({ jobId: job.id, step: null });
  });

  it("tags every persisted step with the current job attempt", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "step-attempt-job");

    const funcDef: FunctionDefinition = {
      name: "Step attempt job",
      func: async (ctx: FunctionContext) => {
        return await ctx.step.run("compute", () => ({ ok: true }));
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await handler(job);

    const steps = await adapter.getJobSteps(job.id);
    expect(steps[0]?.attempt).toBe(job.attempts);
  });

  it("persists ctx.logger.info calls into the saved job logs", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "logging-job");

    const funcDef: FunctionDefinition = {
      name: "Logging job",
      func: async (ctx: FunctionContext & { logger?: { info: (...args: unknown[]) => void } }) => {
        await Promise.resolve();
        ctx.logger?.info("hello from the job");
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await handler(job);

    const logs = await adapter.getJobLogs(job.id);
    expect(logs.some((log) => log.message.includes("hello from the job"))).toBe(true);
  });

  it("fails the job when step.sendEvent targets an unregistered code", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();

    const job = await enqueueAndDequeue(queue, databaseEngine, "parent-job-no-target", 1);

    const funcDef: FunctionDefinition = {
      name: "Parent job no target",
      func: async (ctx: FunctionContext) => {
        await ctx.step.sendEvent("unregistered-event", { name: "unregistered-event", data: {} });
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("Job unregistered-event not found");

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("failed");
  });

  it("replays a completed step's persisted result on retry instead of re-running it", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "replay-job", 3);

    const firstFn = vi.fn().mockResolvedValue({ value: 1 });
    let attempt = 0;

    const funcDef: FunctionDefinition = {
      name: "Replay job",
      func: async (ctx: FunctionContext) => {
        const first = await ctx.step.run("first", firstFn);
        attempt++;
        if (attempt === 1) {
          throw new Error("boom");
        }
        return { first };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("boom");
    expect(firstFn).toHaveBeenCalledTimes(1);

    // Retry: promote the delayed job back to the stream, exactly as AsyncScheduler would.
    await queue.moveJobToStream(job.id);
    const retried = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!retried) throw new Error("Expected a retried job");

    const result = await handler(retried);
    expect(result).toStrictEqual({ first: { value: 1 } });
    // fn was never called again: the value came from the replayed, persisted step.
    expect(firstFn).toHaveBeenCalledTimes(1);

    const logs = await adapter.getJobLogs(retried.id);
    expect(logs.some((log) => log.message.includes("replayed from attempt"))).toBe(true);
  });

  it("re-executes a step that failed on the previous attempt instead of replaying it", async () => {
    const { databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "failed-step-retry-job", 3);

    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ ok: true });

    const funcDef: FunctionDefinition = {
      name: "Failed step retry job",
      func: async (ctx: FunctionContext) => {
        return await ctx.step.run<{ ok: boolean }>("flaky", flaky);
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("transient");

    await queue.moveJobToStream(job.id);
    const retried = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!retried) throw new Error("Expected a retried job");

    const result = await handler(retried);
    expect(result).toStrictEqual({ ok: true });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("gives repeated step names in the same execution distinct keys and memoizes them separately", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "dup-name-job", 3);

    const funcDef: FunctionDefinition = {
      name: "Dup name job",
      func: async (ctx: FunctionContext) => {
        const a = await ctx.step.run("compute", () => 1);
        const b = await ctx.step.run("compute", () => 2);
        return { a, b };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    const result = await handler(job);
    expect(result).toStrictEqual({ a: 1, b: 2 });

    const steps = await adapter.getJobSteps(job.id);
    const byName = new Map(steps.map((step) => [step.name, step]));
    expect(Array.from(byName.keys()).sort()).toStrictEqual(["compute", "compute:2"]);
    expect(byName.get("compute")?.result).toBe(1);
    expect(byName.get("compute:2")?.result).toBe(2);
  });

  it("does not create a second child job when step.sendEvent is retried", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();

    JobRegistry.register({
      name: "Send event child",
      event: "send-event-retry-child",
      func: async () => Promise.resolve({}),
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "send-event-retry-parent", 3);

    let shouldFail = true;
    const funcDef: FunctionDefinition = {
      name: "Send event retry parent",
      func: async (ctx: FunctionContext) => {
        await ctx.step.sendEvent("send-event-retry-child", {
          name: "send-event-retry-child",
          data: {},
        });
        if (shouldFail) {
          shouldFail = false;
          throw new Error("boom after send");
        }
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await expect(handler(job)).rejects.toThrow("boom after send");

    await queue.moveJobToStream(job.id);
    const retried = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!retried) throw new Error("Expected a retried job");

    await handler(retried);

    const childIds = await adapter.getChildJobIds(job.id);
    expect(childIds).toHaveLength(1);

    // The replayed sendEvent leaves a zero-duration trace in attempt 2, pointing at attempt 1.
    const steps = await adapter.getJobSteps(job.id);
    const trace = steps.find(
      (step) => step.attempt === 2 && step.name === "sendEvent:send-event-retry-child",
    );
    expect(trace).toMatchObject({
      kind: "sendEvent",
      status: "completed",
      duration: 0,
      replayedFrom: 1,
    });
  });

  it("suspends the job as delayed on step.sleep, without consuming an attempt or writing attemptHistory", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "sleep-job", 3);
    const attemptsBeforeSleep = job.attempts;

    const funcDef: FunctionDefinition = {
      name: "Sleep job",
      func: async (ctx: FunctionContext) => {
        await ctx.step.run("before-sleep", () => ({ ok: true }));
        await ctx.step.sleep("wait", 60_000);
        // Never reached: the handler unwinds via JobSuspended before this line.
        return { done: true };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    const outcome = await handler(job);
    expect(outcome).toBe(JOB_SUSPENDED);

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("delayed");
    expect(stored?.delayUntil).toBeInstanceOf(Date);

    const deltaMs = (stored?.delayUntil?.getTime() ?? 0) - Date.now();
    expect(deltaMs).toBeGreaterThan(55_000);
    expect(deltaMs).toBeLessThanOrEqual(60_000);

    expect(stored?.attempts).toBe(attemptsBeforeSleep - 1);
    expect(stored?.metadata?.attemptHistory ?? []).toHaveLength(0);

    const steps = await adapter.getJobSteps(job.id);
    const sleepStep = steps.find((step) => step.name === "wait");
    expect(sleepStep?.kind).toBe("sleep");
    expect(sleepStep?.status).toBe("completed");
  });

  it("resumes after a suspended sleep, skipping the sleep and prior steps and keeping the same attempt", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "resume-job", 3);
    const initialAttempts = job.attempts;

    const beforeFn = vi.fn().mockResolvedValue({ ok: true });
    const afterFn = vi.fn().mockResolvedValue({ resumed: true });

    const funcDef: FunctionDefinition = {
      name: "Resume job",
      func: async (ctx: FunctionContext) => {
        const before = await ctx.step.run("before-sleep", beforeFn);
        await ctx.step.sleep("wait", 60_000);
        const after = await ctx.step.run("after-sleep", afterFn);
        return { before, after };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    const suspended = await handler(job);
    expect(suspended).toBe(JOB_SUSPENDED);
    expect(beforeFn).toHaveBeenCalledTimes(1);

    const suspendedJob = await adapter.getJob(job.id);
    expect(suspendedJob?.attempts).toBe(initialAttempts - 1);

    // Resume: promote the delayed entry back to the stream and dequeue, like AsyncScheduler does.
    await queue.moveJobToStream(job.id);
    const resumed = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!resumed) throw new Error("Expected a resumed job");

    // The suspend/resume cycle nets out to the same attempt number the sleep was taken in.
    expect(resumed.attempts).toBe(initialAttempts);

    const result = await handler(resumed);
    expect(result).toStrictEqual({ before: { ok: true }, after: { resumed: true } });
    expect(beforeFn).toHaveBeenCalledTimes(1); // not re-run: replayed from the memo
    expect(afterFn).toHaveBeenCalledTimes(1);

    const steps = await adapter.getJobSteps(job.id);
    const names = steps.map((step) => step.name).sort();
    expect(names).toStrictEqual(["after-sleep", "before-sleep", "wait"]);
    // Steps from before the sleep and the ones added on resume all share the same attempt.
    const attempts = new Set(steps.map((step) => step.attempt));
    expect(attempts).toStrictEqual(new Set([initialAttempts]));
    // No replay trace: "before-sleep" really ran once in this lane, resuming it is silent.
    expect(steps.find((step) => step.name === "before-sleep")?.replayedFrom).toBeUndefined();
  });

  it("does not double-trace a step replayed earlier in the same attempt when resuming after a suspended sleep", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "replay-then-sleep-job", 3);

    const aFn = vi.fn().mockResolvedValue({ a: true });
    const bFn = vi.fn().mockResolvedValue({ b: true });
    const cFn = vi.fn().mockResolvedValue({ c: true });
    let attempt = 0;

    const funcDef: FunctionDefinition = {
      name: "Replay then sleep job",
      func: async (ctx: FunctionContext) => {
        const a = await ctx.step.run("A", aFn);
        attempt++;
        if (attempt === 1) {
          throw new Error("boom");
        }
        const b = await ctx.step.run("B", bFn);
        await ctx.step.sleep("wait", 60_000);
        const c = await ctx.step.run("C", cFn);
        return { a, b, c };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);

    // Attempt 1: A runs for real, then the job fails.
    await expect(handler(job)).rejects.toThrow("boom");

    // Attempt 2: A is replayed (trace added), B runs for real, sleep suspends the job.
    await queue.moveJobToStream(job.id);
    const attempt2 = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!attempt2) throw new Error("Expected attempt 2");
    const suspended = await handler(attempt2);
    expect(suspended).toBe(JOB_SUSPENDED);
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);

    let steps = await adapter.getJobSteps(job.id);
    expect(steps.filter((step) => step.attempt === 2 && step.name === "A")).toHaveLength(1);

    // Resume in the same attempt: A must not get a second trace, B must not re-run, C runs.
    await queue.moveJobToStream(job.id);
    const resumed = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!resumed) throw new Error("Expected the resumed job");
    const result = await handler(resumed);
    expect(result).toStrictEqual({ a: { a: true }, b: { b: true }, c: { c: true } });
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
    expect(cFn).toHaveBeenCalledTimes(1);

    steps = await adapter.getJobSteps(job.id);
    expect(steps.filter((step) => step.attempt === 2 && step.name === "A")).toHaveLength(1);
  });

  it("records a replay trace with duration 0 pointing at the attempt that really ran the step, unchanged across further retries", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "replay-trace-job", 4);

    const firstFn = vi.fn().mockResolvedValue({ value: 1 });
    let attempt = 0;

    const funcDef: FunctionDefinition = {
      name: "Replay trace job",
      func: async (ctx: FunctionContext) => {
        const first = await ctx.step.run("first", firstFn);
        attempt++;
        if (attempt < 3) {
          throw new Error("boom");
        }
        return { first };
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);

    // Attempt 1: "first" runs for real, then the job fails.
    await expect(handler(job)).rejects.toThrow("boom");

    // Attempt 2: "first" is replayed.
    await queue.moveJobToStream(job.id);
    const attempt2 = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!attempt2) throw new Error("Expected attempt 2");
    await expect(handler(attempt2)).rejects.toThrow("boom");

    let steps = await adapter.getJobSteps(job.id);
    const original = steps.find((step) => step.attempt === 1 && step.name === "first");
    const traceAttempt2 = steps.find((step) => step.attempt === 2 && step.name === "first");
    expect(original?.result).toStrictEqual({ value: 1 });
    expect(traceAttempt2).toMatchObject({ status: "completed", duration: 0, replayedFrom: 1 });
    expect(traceAttempt2?.result).toBeUndefined();

    // Attempt 3: "first" is replayed again; replayedFrom still points at attempt 1, since the
    // memo ignores attempt 2's trace as a real run.
    await queue.moveJobToStream(job.id);
    const attempt3 = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
    if (!attempt3) throw new Error("Expected attempt 3");
    const result = await handler(attempt3);
    expect(result).toStrictEqual({ first: { value: 1 } });
    expect(firstFn).toHaveBeenCalledTimes(1);

    steps = await adapter.getJobSteps(job.id);
    const traceAttempt3 = steps.find((step) => step.attempt === 3 && step.name === "first");
    expect(traceAttempt3?.replayedFrom).toBe(1);
  });
});

describe("Dispatcher.heartbeatIntervalMs", () => {
  const originalHeartbeatIntervalMs = Dispatcher.heartbeatIntervalMs;

  afterEach(() => {
    Dispatcher.heartbeatIntervalMs = originalHeartbeatIntervalMs;
    JobRegistry.cleanUp();
  });

  it("renews the job's lease while it is processing", async () => {
    Dispatcher.heartbeatIntervalMs = 10;

    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "heartbeat-job", 3);
    const updatedAtBefore = job.updatedAt.getTime();

    const funcDef: FunctionDefinition = {
      name: "Heartbeat job",
      func: async (ctx: FunctionContext) => {
        return await ctx.step.run("wait", async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
          return { ok: true };
        });
      },
    };

    const handler = createJobHandler(funcDef, dispatcher);
    await handler(job);

    const stored = await adapter.getJob(job.id);
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(updatedAtBefore);
  });
});

describe("EnhancedJob write serialization", () => {
  function makeJob(overrides: Partial<Job> = {}): Job {
    const now = new Date();
    return {
      id: "job-1",
      code: "some-code",
      queueName: "default",
      payload: {},
      status: "processing",
      priority: 1,
      attempts: 1,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("serializes saveSteps/saveLogs writes in call order even without awaiting the first one", async () => {
    const adapter = new InMemoryAdapter();
    const calls: string[] = [];
    const deferred: (() => void)[] = [];

    const defer = () =>
      new Promise<void>((resolve) => {
        deferred.push(resolve);
      });

    vi.spyOn(adapter, "saveJobSteps").mockImplementation(async (_jobId, steps) => {
      calls.push(`steps:${steps.map((s) => s.name).join(",")}`);
      await defer();
    });
    vi.spyOn(adapter, "saveJobLogs").mockImplementation(async (_jobId, logs) => {
      calls.push(`logs:${logs.length}`);
      await defer();
    });

    const enhancedJob = new EnhancedJob(makeJob(), adapter);

    const stepA: JobStep = {
      name: "a",
      attempt: 1,
      kind: "run",
      startedAt: new Date(),
      status: "completed",
    };
    const logA: Log = { message: "log-a", timestamp: Date.now(), level: "info" };
    const stepB: JobStep = {
      name: "b",
      attempt: 1,
      kind: "run",
      startedAt: new Date(),
      status: "completed",
    };

    const p1 = enhancedJob.saveSteps([stepA]);
    const p2 = enhancedJob.saveLogs([logA]);
    const p3 = enhancedJob.saveSteps([stepA, stepB]);

    // Flush pending microtasks: only the first call should have reached the adapter, since the
    // second and third are queued behind its still-unresolved write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toStrictEqual(["steps:a"]);

    deferred[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toStrictEqual(["steps:a", "logs:1"]);

    deferred[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toStrictEqual(["steps:a", "logs:1", "steps:a,b"]);

    deferred[2]?.();
    await Promise.all([p1, p2, p3]);
  });

  it("does not let a failed write reject the writes queued behind it", async () => {
    const adapter = new InMemoryAdapter();
    vi.spyOn(adapter, "saveJobSteps")
      .mockImplementationOnce(() => {
        throw new Error("db down");
      })
      .mockImplementationOnce(() => Promise.resolve());

    const enhancedJob = new EnhancedJob(makeJob(), adapter);
    const step: JobStep = {
      name: "a",
      attempt: 1,
      kind: "run",
      startedAt: new Date(),
      status: "completed",
    };

    const p1 = enhancedJob.saveSteps([step]);
    const p2 = enhancedJob.saveSteps([step]);

    await expect(p1).rejects.toThrow("db down");
    await expect(p2).resolves.toBeUndefined();
  });
});

describe("Dispatcher.enqueueJob keyed concurrency", () => {
  afterEach(() => {
    JobRegistry.cleanUp();
  });

  it("persists the key and limit resolved from a definition with concurrency: { limit, key }", async () => {
    const { adapter, dispatcher } = setup();

    JobRegistry.register({
      name: "Order emails",
      event: "order-emails",
      func: async () => Promise.resolve({}),
      concurrency: { limit: 1, key: "orderId" },
    });

    const jobId = await dispatcher.enqueueJob("order-emails", { orderId: "o1" });

    const job = await adapter.getJob(jobId);
    expect(job?.concurrencyKey).toBe("order-emails:o1");
    expect(job?.concurrencyLimit).toBe(1);
  });

  it("persists the key and limit resolved from a definition with a numeric concurrency", async () => {
    const { adapter, dispatcher } = setup();

    JobRegistry.register({
      name: "Numeric concurrency job",
      event: "numeric-concurrency-job",
      func: async () => Promise.resolve({}),
      concurrency: 2,
    });

    const jobId = await dispatcher.enqueueJob("numeric-concurrency-job", {});

    const job = await adapter.getJob(jobId);
    expect(job?.concurrencyKey).toBe("numeric-concurrency-job");
    expect(job?.concurrencyLimit).toBe(2);
  });

  it("dequeues a second job with the same key only after the first is completed", async () => {
    const { adapter, databaseEngine, dispatcher } = setup();

    JobRegistry.register({
      name: "Order emails",
      event: "order-emails",
      func: async () => Promise.resolve({}),
      concurrency: { limit: 1, key: "orderId" },
    });

    const firstId = await dispatcher.enqueueJob("order-emails", { orderId: "o1" });
    await dispatcher.enqueueJob("order-emails", { orderId: "o1" });

    const first = await databaseEngine.dequeueJob("default", "consumer");
    expect(first?.id).toBe(firstId);

    const blocked = await databaseEngine.dequeueJob("default", "consumer");
    expect(blocked).toBeNull();

    await adapter.updateJob(firstId, { status: "completed", completedAt: new Date() });

    const second = await databaseEngine.dequeueJob("default", "consumer");
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(firstId);
  });

  it("dequeues both jobs when their resolved keys differ", async () => {
    const { databaseEngine, dispatcher } = setup();

    JobRegistry.register({
      name: "Order emails",
      event: "order-emails",
      func: async () => Promise.resolve({}),
      concurrency: { limit: 1, key: "orderId" },
    });

    const firstId = await dispatcher.enqueueJob("order-emails", { orderId: "o1" });
    const secondId = await dispatcher.enqueueJob("order-emails", { orderId: "o2" });

    const first = await databaseEngine.dequeueJob("default", "consumer");
    const second = await databaseEngine.dequeueJob("default", "consumer");

    expect([first?.id, second?.id].sort()).toEqual([firstId, secondId].sort());
  });
});
