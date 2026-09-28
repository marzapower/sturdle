import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { EngineEvent } from "../telemetry.js";
import type { FunctionContext, Payload } from "../types.js";

import type { Job } from "../database/types.js";
import { InMemoryAdapter } from "../database/in-memory-adapter.js";
import { DatabaseEngine } from "./database-engine.js";
import { Dispatcher } from "./dispatcher.js";
import { Event, Messenger } from "./messenger.js";
import { Queue } from "./queue.js";
import { JobRegistry } from "./registry.js";
import { Worker } from "./worker.js";

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
  payload: Payload = {},
): Promise<Job> {
  await queue.enqueueJob(code, payload, { maxAttempts });
  const job = await databaseEngine.dequeueJob(QUEUE_NAME, "test-consumer");
  if (!job) throw new Error("Expected a dequeued job");
  return job;
}

describe("Worker", () => {
  afterEach(() => {
    JobRegistry.cleanUp();
  });

  it("dead letters a job whose code has no registered handler on this instance", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();
    const job = await enqueueAndDequeue(queue, databaseEngine, "unregistered-code");

    const worker = new Worker(dispatcher, "test-worker");
    worker.assignJob(job);
    await worker.waitForCompletion();

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.deadLetter?.reason).toBe("no handler registered");

    const history = stored?.metadata?.attemptHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[history.length - 1]?.nonRetriable).toBe(true);

    // Not put back on the delayed queue for a retry.
    const readyDelayed = await adapter.getReadyDelayedJobs(QUEUE_NAME);
    expect(readyDelayed).toHaveLength(0);

    // Reported as a dead letter, not a plain job error.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "job.dead-lettered",
      jobId: job.id,
      code: "unregistered-code",
    });
  });

  it("dead letters a job whose payload fails the definition's schema, without calling the handler", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();
    const func = vi.fn();
    JobRegistry.register({
      name: "Order / Unlock",
      event: "orders/order.unlock",
      func,
      payloadSchema: z.object({ orderId: z.string() }),
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "orders/order.unlock", 3, {
      orderId: 1,
    });

    const worker = new Worker(dispatcher, "test-worker");
    worker.assignJob(job);
    await worker.waitForCompletion();

    expect(func).not.toHaveBeenCalled();

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.metadata?.deadLetter?.reason).toBe("invalid payload");
    expect(stored?.error).toContain("orderId: Invalid input: expected string");

    const history = stored?.metadata?.attemptHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[history.length - 1]?.nonRetriable).toBe(true);

    const readyDelayed = await adapter.getReadyDelayedJobs(QUEUE_NAME);
    expect(readyDelayed).toHaveLength(0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "job.dead-lettered", jobId: job.id });
  });

  it("runs the handler and completes the job when the payload matches the schema", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const func = vi.fn().mockResolvedValue(undefined);
    JobRegistry.register({
      name: "Order / Unlock",
      event: "orders/order.unlock",
      func,
      payloadSchema: z.object({ orderId: z.string() }),
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "orders/order.unlock", 3, {
      orderId: "abc",
    });

    const worker = new Worker(dispatcher, "test-worker");
    worker.assignJob(job);
    await worker.waitForCompletion();

    expect(func).toHaveBeenCalledTimes(1);

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("completed");
  });

  it("runs the handler unchanged when the definition declares no payloadSchema", async () => {
    const { adapter, databaseEngine, dispatcher, queue } = setup();
    const func = vi.fn().mockResolvedValue(undefined);
    JobRegistry.register({
      name: "Order / Unlock",
      event: "orders/order.unlock",
      func,
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "orders/order.unlock", 3, {
      anything: "goes",
    });

    const worker = new Worker(dispatcher, "test-worker");
    worker.assignJob(job);
    await worker.waitForCompletion();

    expect(func).toHaveBeenCalledTimes(1);

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("completed");
  });

  it("emits WorkerJobSuspended and leaves stats and telemetry untouched when the handler suspends the job", async () => {
    const { adapter, databaseEngine, dispatcher, queue, events } = setup();

    JobRegistry.register({
      name: "Worker sleep job",
      event: "worker-sleep-job",
      func: async (ctx: FunctionContext) => {
        await ctx.step.sleep("wait", 60_000);
        return { done: true };
      },
    });

    const job = await enqueueAndDequeue(queue, databaseEngine, "worker-sleep-job");

    const worker = new Worker(dispatcher, "test-worker");
    const chatter = {};
    const suspendedEvents: unknown[] = [];
    Messenger.listen(chatter, Event.WorkerJobSuspended, (...args: unknown[]) => {
      suspendedEvents.push(args);
    });

    worker.assignJob(job);
    await worker.waitForCompletion();

    expect(suspendedEvents).toHaveLength(1);
    expect(worker.getStats()).toStrictEqual({ completed: 0, failed: 0 });
    expect(events).toHaveLength(0);

    const stored = await adapter.getJob(job.id);
    expect(stored?.status).toBe("delayed");

    Messenger.stopListening(chatter);
  });
});
