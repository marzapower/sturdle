import {
  type FunctionContext,
  type FunctionDefinition,
  type Payload,
  type TaskEvent,
} from "../types.js";
import { emitEngineEvent, type EngineEventListener } from "../telemetry.js";

import type { AttemptHistoryEntry, Job, JobMetadata, JobStep } from "../database/types.js";
import type { DatabaseEngine } from "./database-engine.js";
import type { Chatter } from "./messenger.js";
import { EnhancedJob } from "../database/enhanced-job.js";
import JobLogger from "../logger.js";
import { AsyncScheduler } from "./asyncScheduler.js";
import { resolveConcurrency } from "./concurrency.js";
import { CronScheduler } from "./cronScheduler.js";
import { Event, Messenger } from "./messenger.js";
import { type Queue } from "./queue.js";
import { JobRegistry } from "./registry.js";
import { Stoppable } from "./shared.js";
import { Worker } from "./worker.js";

export type OnJobAssigned = (jobId: string, startedAt: Date) => void;

/**
 * Thrown by `step.sleep`/`step.sleepUntil` to unwind the handler when a job must be suspended
 * (persisted as "delayed") instead of blocking a worker in-process. Caught by createJobHandler's
 * top-level catch, never expected to escape it.
 */
export class JobSuspended extends Error {
  constructor(public readonly wakeAt: Date) {
    super(`Job suspended until ${wakeAt.toISOString()}`);
    this.name = "JobSuspended";
  }
}

/**
 * Sentinel returned by the function created by createJobHandler (and relayed by Worker) when the
 * job was suspended rather than completed or failed. Never thrown, never rejected: a normal
 * return value the caller must check for explicitly.
 */
export const JOB_SUSPENDED: unique symbol = Symbol("sturdle.job-suspended");

const noop = () => {};

// Tracks errors that already produced a `job.dead-lettered` (or other specific) telemetry event
// at the point they were raised, so the generic catch-all in Worker.executeJobAsync doesn't also
// report them as a plain `job.error`. Keyed by object identity: nothing here is ever read back,
// only checked for membership, so a WeakSet never leaks.
const reportedErrors = new WeakSet<object>();

export function markErrorReported(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    reportedErrors.add(error);
  }
}

export function wasErrorReported(error: unknown): boolean {
  return typeof error === "object" && error !== null && reportedErrors.has(error);
}

export class Dispatcher extends Stoppable implements Chatter {
  private static jobQueueInterval = 50;
  private static maxQueueSize = 1000; // Prevent memory leaks
  // Interval between lease renewals for a "processing" job (see createJobHandler). Mutable so
  // tests can lower it instead of relying on fake timers.
  static heartbeatIntervalMs = 30_000;

  private workers: Set<Worker> = new Set<Worker>();
  private availableWorkers = new Set<Worker>();
  private jobQueue: Job[] = [];
  private cronScheduler: CronScheduler;
  private asyncScheduler: AsyncScheduler;
  private registeredQueues = new Set<Queue>();
  public databaseEngine: DatabaseEngine;
  private onJobAssigned?: OnJobAssigned;
  public readonly onEvent?: EngineEventListener;

  constructor(
    maxWorkers = 10,
    databaseEngine: DatabaseEngine,
    onJobAssigned?: OnJobAssigned,
    onEvent?: EngineEventListener,
  ) {
    super();

    this.databaseEngine = databaseEngine;
    this.onJobAssigned = onJobAssigned;
    this.onEvent = onEvent;
    this.logger.debug("Creating dispatcher with", maxWorkers, "workers");

    for (let i = 0; i < maxWorkers; i++) {
      this.logger.debug("Creating worker", i);
      const worker = new Worker(this, `worker-${i}`);
      this.workers.add(worker);
      this.waitForStoppable(worker);
    }
    this.cronScheduler = new CronScheduler(databaseEngine);
    this.asyncScheduler = new AsyncScheduler();
    this.waitForStoppable(this.cronScheduler);
    this.waitForStoppable(this.asyncScheduler);

    this.cycleIntervalMs = Dispatcher.jobQueueInterval;
  }

  async start() {
    this.logger.debug("Starting dispatcher");

    this.setupEvents();

    const allPromises = [
      ...Array.from(this.workers.values()).map(async (worker) => {
        await worker.start();
      }),
      this.cronScheduler.start(),
      this.asyncScheduler.start(),
    ];

    await Promise.allSettled(allPromises);
    await this.startCycle();

    this.logger.info("Dispatcher started");
  }

  async shutdown() {
    this.logger.info("Shutting down dispatcher with", this.workers.size, "workers");

    // Stop all workers gracefully
    const shutdownPromises = Array.from(this.workers).map(async (worker) => {
      try {
        await worker.shutdown();
      } catch (error) {
        this.logger.warn(`Error shutting down worker ${worker.id}:`, error);
      }
    });

    await Promise.allSettled(shutdownPromises);

    this.workers.clear();
    this.availableWorkers.clear();
    this.jobQueue.length = 0;

    this.logger.info("Dispatcher shutdown completed");
  }

  async registerWorker(worker: Worker) {
    this.workers.add(worker);
    await worker.start();
  }

  /**
   * Registers a queue for delayed-job polling.
   */
  registerQueue(queue: Queue): void {
    this.registeredQueues.add(queue);
    this.asyncScheduler.registerQueue(queue);
    this.logger.debug(`Registered queue "${queue.name}" for job polling`);
  }

  /**
   * Removes a queue from polling.
   */
  unregisterQueue(queue: Queue): void {
    this.registeredQueues.delete(queue);
    this.logger.debug(`Unregistered queue "${queue.name}" from job polling`);
  }

  private setupEvents() {
    Messenger.listen(this, Event.WorkerReady, (worker: Worker) => {
      this.availableWorkers.add(worker);
    });

    Messenger.listen(this, Event.WorkerJobCompleted, (worker: Worker, job: Job) => {
      this.availableWorkers.add(worker);
      Messenger.emit(Event.JobCompleted, job);
    });

    Messenger.listen(this, Event.WorkerJobFailed, (worker: Worker, job: Job, error: unknown) => {
      this.availableWorkers.add(worker);
      Messenger.emit(Event.JobFailed, job, error);
    });

    Messenger.listen(this, Event.WorkerJobSuspended, (worker: Worker, job: Job) => {
      this.availableWorkers.add(worker);
      Messenger.emit(Event.JobSuspended, job);
    });

    Messenger.listen(this, Event.JobScheduled, (code: string) => {
      this.logger.debug("Scheduling job", code);
      const append = async () => {
        await this.enqueueJob(code, {}, {});
      };
      void append();
    });
  }

  async runCycle() {
    if (this.availableWorkers.size === 0) {
      this.logger.debug("No workers available, skipping job queue processing");
      this.logger.debug("Available workers", this.availableWorkers);
      return;
    }

    try {
      while (this.jobQueue.length > 0 && this.availableWorkers.size > 0) {
        const job = this.jobQueue.shift()!;
        const worker = this.getFirstFreeWorker();

        if (worker) {
          try {
            this.availableWorkers.delete(worker);
            this.onJobAssigned?.(job.id, new Date());
            worker.assignJob(job);
          } catch (error) {
            console.error(`Assignment failed for job ${job.id}:`, error);

            emitEngineEvent(this.onEvent, {
              type: "job.assignment-error",
              jobId: job.id,
              code: job.code,
              error,
            });

            if (this.jobQueue.length < Dispatcher.maxQueueSize) {
              this.jobQueue.unshift(job);
            } else {
              this.logger.error(
                `Job queue at capacity (${Dispatcher.maxQueueSize}), dropping job ${job.id}`,
              );
              emitEngineEvent(this.onEvent, {
                type: "job.dropped",
                jobId: job.id,
                code: job.code,
                reason: "queue-overflow",
              });
            }
            if (worker.isAvailable) {
              this.availableWorkers.add(worker);
            }
          }
        }
      }

      // Nothing left queued in-process: try to pull new jobs from the queues.
      if (this.jobQueue.length === 0) {
        await this.fetchNewJobs();
      }
    } catch (error) {
      this.logger.error("Error processing job queue", error);
    }
  }

  private getFirstFreeWorker(): Worker | null {
    // Find the first available worker.
    while (this.availableWorkers.size > 0) {
      const worker = this.availableWorkers.values().next().value;
      if (!worker) {
        return null;
      }

      if (worker.isAvailable) {
        return worker;
      } else {
        this.availableWorkers.delete(worker);
      }
    }

    return null;
  }

  async enqueueJob<T extends Payload>(
    jobCode: string,
    payload: T,
    options?: Partial<{
      delayUntil?: Date;
      priority?: number;
      maxAttempts?: number;
      parentJobId?: string;
      metadata?: JobMetadata;
    }>,
  ) {
    const jobDefinition = JobRegistry.getDefinition(jobCode);
    if (!jobDefinition) {
      throw new Error(`Job ${jobCode} not found`);
    }

    const queue = Array.from(this.registeredQueues.values()).find(
      (q) => q.name === jobDefinition.queueName,
    );
    if (!queue) {
      throw new Error(`Queue ${jobDefinition.queueName} not found`);
    }

    const resolved = resolveConcurrency(
      jobCode,
      jobDefinition.func.concurrency,
      payload as Record<string, unknown>,
    );

    return await queue.enqueueJob(jobCode, payload, {
      ...options,
      concurrencyKey: resolved?.key,
      concurrencyLimit: resolved?.limit,
    });
  }

  private async fetchNewJobs() {
    try {
      const job = await this.getNextJob();
      if (job) {
        this.logger.debug("Found job", job.id);
        this.jobQueue.push(job);
        // If workers are available, process the queue right away.
        if (this.availableWorkers.size > 0) {
          this.logger.debug("Found available workers, processing job queue");
          await this.runCycle();
        }
      }
    } catch (error) {
      console.error("Error fetching new jobs:", error);
    }
  }

  private async getNextJob() {
    // Only registered queues, sorted by priority.
    const sortedQueues = Array.from(this.registeredQueues.values()).sort(
      (a, b) => a.priority - b.priority,
    );

    for (const queue of sortedQueues) {
      const job = await queue.getNextJob();
      if (job) {
        return job;
      }
    }

    return null;
  }

  getStats() {
    return {
      totalWorkers: this.workers.size,
      availableWorkers: this.availableWorkers.size,
      queuedJobs: this.jobQueue.length,
      registeredQueues: this.registeredQueues.size,
    };
  }
}

/**
 * Builds the `updateStatus` payload for moving a job straight to the dead letter queue (status
 * "failed"), tagging the attempt history entry as non-retriable and recording the dead letter
 * reason. Used by the worker when no handler is registered for the job code; createJobHandler
 * keeps its own branch because there `nonRetriable` depends on the error thrown.
 */
export function buildDeadLetterUpdate(job: Job, error: string, reason: string, failedAt: Date) {
  const entry: AttemptHistoryEntry = {
    attempt: job.attempts,
    error,
    failedAt: failedAt.toISOString(),
    nonRetriable: true,
  };
  const history = [...(job.metadata?.attemptHistory ?? []), entry];

  return {
    completedAt: failedAt,
    error,
    result: { error },
    metadata: {
      ...job.metadata,
      attemptHistory: history,
      deadLetter: { at: failedAt.toISOString(), reason },
    },
  };
}

/**
 * Calculate exponential backoff delay for job retries
 * Formula: min(baseDelay * 2^attempt + jitter, maxDelay)
 */
export function calculateExponentialBackoff(attempt: number): number {
  const baseDelayMs = 1000;
  const maxDelayMs = 5 * 60 * 1000;
  const jitterMs = Math.random() * 1000;

  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const delayWithJitter = exponentialDelay + jitterMs;

  return Math.min(delayWithJitter, maxDelayMs);
}

export function createJobHandler(
  funcDef: FunctionDefinition<Payload>,
  dispatcher: Dispatcher,
): (job: Job) => Promise<unknown> {
  return async (job: Job): Promise<unknown> => {
    // Convert plain job to enhanced job with methods
    const enhancedJob = new EnhancedJob(job, dispatcher.databaseEngine.adapter);
    const jobId = enhancedJob.id;
    const payload = enhancedJob.payload as Payload;

    // Memoization: replay any step already completed in a prior execution of this job (retry,
    // or resume after a suspended sleep). Only "completed" steps replay — "running" (interrupted
    // by a crash) and "failed" ones are re-executed.
    const priorSteps = await dispatcher.databaseEngine.adapter.getJobSteps(jobId);
    const priorLogs = await dispatcher.databaseEngine.adapter.getJobLogs(jobId);

    // Only real runs feed the memo: a replay trace (`replayedFrom` set) is not itself a run to
    // replay from, so it is ignored here (the original step, from the attempt it really ran in,
    // is always still present in priorSteps).
    const memo = new Map<string, JobStep>();
    for (const step of priorSteps) {
      if (step.status === "completed" && step.replayedFrom === undefined) {
        memo.set(step.name, step);
      }
    }

    // Steps/logs of the current attempt are carried over: on a resume after a suspended sleep,
    // job.attempts is unchanged (suspendJob rolls it back), so new steps land in the same lane
    // as the ones already persisted for it.
    const steps: JobStep[] = priorSteps.filter((step) => step.attempt === job.attempts);
    const logger = new JobLogger(
      enhancedJob,
      priorLogs.filter((log) => log.attempt === job.attempts),
    );

    // Per-execution counter for deterministic step keys: first occurrence of a name is the name
    // itself, subsequent ones get a ":2", ":3", ... suffix.
    const occurrences = new Map<string, number>();
    const nextKey = (name: string): string => {
      const count = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, count);
      return count === 1 ? name : `${name}:${count}`;
    };

    const heartbeat = setInterval(() => {
      dispatcher.databaseEngine.heartbeatJob(jobId).catch(noop);
    }, Dispatcher.heartbeatIntervalMs);

    // Records a zero-duration trace for a memoized step, so the current attempt's lane shows
    // that the step was skipped and why. Guarded on the current lane's own list (not on
    // `memoized.attempt !== job.attempts`): a resume after `step.sleep` in the same attempt
    // replays the steps that already ran in that lane, and those must not get a second trace
    // either. Awaited on purpose by every caller: `updateStatus("completed")` is not on
    // EnhancedJob's write chain, so an un-awaited trace could land after the job is already
    // completed.
    const recordReplay = async (key: string, memoized: JobStep): Promise<void> => {
      if (steps.some((s) => s.name === key)) return;
      const now = new Date();
      steps.push({
        name: key,
        kind: memoized.kind ?? "run",
        attempt: job.attempts,
        startedAt: now,
        completedAt: now,
        duration: 0,
        status: "completed",
        replayedFrom: memoized.attempt,
      });
      await enhancedJob.saveSteps(steps);
    };

    logger.system.info("Running task", funcDef.name);
    logger.system.info("Job payload:", JSON.stringify(payload));

    // Update status to processing. Attempts are already incremented atomically by dequeueJob.
    await enhancedJob.updateStatus("processing", {
      startedAt: new Date(),
    });

    let result: unknown = null;

    try {
      const enhancedCtx: FunctionContext<Record<string, unknown>> & { logger: JobLogger } = {
        event: {
          data: payload,
          name: funcDef.event || "",
        },
        step: {
          sendEvent: async (id: string, event: TaskEvent<void | Payload>) => {
            const key = nextKey(`sendEvent:${id}`);
            const memoized = memo.get(key);
            if (memoized) {
              logger.system.info(`Step '${key}' replayed from attempt ${memoized.attempt}`);
              await recordReplay(key, memoized);
              return;
            }

            logger.system.info(`Sending event: ${id}`);

            const startedAt = new Date();
            let stepResult: Record<string, unknown>;

            try {
              // Create a child job with a reference to the parent, tagging the currently bound
              // step (if any) so the execution timeline can anchor the child under it.
              const childJobId = await dispatcher.enqueueJob(id, event.data as Payload, {
                parentJobId: jobId,
                metadata: { spawnedBy: { jobId, step: logger.currentStep() } },
              });

              logger.system.info(`Child job created: ${childJobId} with parent: ${jobId}`);
              stepResult = { jobId: childJobId };
            } catch (err) {
              logger.error(`Failed to create child job: ${String(err)}`);
              throw err;
            }

            const completedAt = new Date();
            steps.push({
              name: key,
              kind: "sendEvent",
              attempt: job.attempts,
              startedAt,
              completedAt,
              duration: completedAt.getTime() - startedAt.getTime(),
              status: "completed",
              result: stepResult,
            });
            await enhancedJob.saveSteps(steps);
          },
          run: async <J>(stepName: string, fn: () => J | Promise<J>): Promise<J> => {
            const key = nextKey(stepName);
            const memoized = memo.get(key);
            if (memoized) {
              logger.system.info(`Step '${key}' replayed from attempt ${memoized.attempt}`);
              await recordReplay(key, memoized);
              return memoized.result as J;
            }

            const startedAt = new Date();
            const startTs = Date.now();

            logger.system.info(`Running step '${key}'`);
            logger.bind(key);

            const stepEntry: JobStep = {
              name: key,
              kind: "run",
              attempt: job.attempts,
              startedAt,
              status: "running",
            };
            steps.push(stepEntry);

            // Persist steps so observers can see the step start immediately. Not awaited: only
            // the completed/failed write below is, so memoization stays reliable.
            enhancedJob.saveSteps(steps).catch(noop);

            try {
              const out = await Promise.resolve(fn());
              const duration = Date.now() - startTs;
              stepEntry.completedAt = new Date();
              stepEntry.duration = duration;
              stepEntry.status = "completed";
              try {
                stepEntry.result = JSON.parse(JSON.stringify(out));
              } catch {
                stepEntry.result = `[${typeof out}]`;
              }
              logger.system.info(`Step '${key}' completed in ${duration}ms`);

              // Await the completed write: memoization is only reliable once this is durable.
              await enhancedJob.saveSteps(steps);
              return out;
            } catch (e) {
              const duration = Date.now() - startTs;
              stepEntry.completedAt = new Date();
              stepEntry.duration = duration;
              stepEntry.status = "failed";
              stepEntry.error = e instanceof Error ? e.message : String(e);
              logger.system.info(`Step '${key}' failed after ${duration}ms: ${stepEntry.error}`);

              // Await the failed write too, for the same reason.
              await enhancedJob.saveSteps(steps);
              throw e;
            } finally {
              logger.unbind();
            }
          },
          sleep: async (stepName: string, ms: number) => {
            const key = nextKey(stepName);
            const memoized = memo.get(key);
            if (memoized) {
              logger.system.info(`Step '${key}' replayed from attempt ${memoized.attempt}`);
              await recordReplay(key, memoized);
              return;
            }

            if (ms <= 0) {
              return;
            }

            const now = new Date();
            const wakeAt = new Date(now.getTime() + ms);
            logger.system.info(`Sleeping for ${ms}ms`);

            steps.push({
              name: key,
              kind: "sleep",
              attempt: job.attempts,
              startedAt: now,
              completedAt: wakeAt,
              duration: ms,
              status: "completed",
              result: { wakeAt: wakeAt.toISOString() },
            });
            await enhancedJob.saveSteps(steps);

            throw new JobSuspended(wakeAt);
          },
          sleepUntil: async (stepName: string, date: Date | string) => {
            const key = nextKey(stepName);
            const memoized = memo.get(key);
            if (memoized) {
              logger.system.info(`Step '${key}' replayed from attempt ${memoized.attempt}`);
              await recordReplay(key, memoized);
              return;
            }

            const target = typeof date === "string" ? new Date(date) : date;
            const now = new Date();
            if (target.getTime() <= now.getTime()) {
              return;
            }

            logger.system.info(`Sleeping until ${target.toISOString()}`);

            steps.push({
              name: key,
              kind: "sleep",
              attempt: job.attempts,
              startedAt: now,
              completedAt: target,
              duration: target.getTime() - now.getTime(),
              status: "completed",
              result: { wakeAt: target.toISOString() },
            });
            await enhancedJob.saveSteps(steps);

            throw new JobSuspended(target);
          },
        },
        logger,
      };

      result = await funcDef.func(enhancedCtx);
      if (result) {
        logger.system.info("Task result");
        logger.system.info(JSON.stringify(result) ?? "undefined");
      }

      // Mark the job completed and persist the result.
      await enhancedJob.updateStatus("completed", {
        completedAt: new Date(),
        result: result as Record<string, unknown>,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e instanceof JobSuspended) {
        logger.system.info(`Job suspended until ${e.wakeAt.toISOString()}`);
        await dispatcher.databaseEngine.suspendJob(job.queueName, jobId, e.wakeAt);
        return JOB_SUSPENDED;
      }

      logger.error("Error running task", e);
      logger.error(`Error running function ${funcDef.name}`);

      const failedAt = new Date();
      const entry: AttemptHistoryEntry = {
        attempt: job.attempts,
        error: e instanceof Error ? e.message : String(e),
        failedAt: failedAt.toISOString(),
      };
      const history = [...(job.metadata?.attemptHistory ?? []), entry];

      const isNonRetriable = e?.name === "NonRetriableError";

      if (isNonRetriable || job.attempts >= job.maxAttempts) {
        if (isNonRetriable) {
          entry.nonRetriable = true;
        }
        logger.error("Job failed permanently", job.id);

        await enhancedJob.updateStatus("failed", {
          completedAt: failedAt,
          error: entry.error,
          result: { error: entry.error },
          metadata: {
            ...job.metadata,
            attemptHistory: history,
            deadLetter: {
              at: failedAt.toISOString(),
              reason: isNonRetriable ? "non-retriable error" : "max attempts reached",
            },
          },
        });

        emitEngineEvent(dispatcher.onEvent, {
          type: "job.dead-lettered",
          jobId: job.id,
          code: job.code,
          attempts: job.attempts,
          error: entry.error,
        });
        markErrorReported(e);

        if (funcDef.onDeadLetter) {
          try {
            await funcDef.onDeadLetter({
              payload,
              error: entry.error,
              jobId: job.id,
              attempts: job.attempts,
            });
          } catch (hookError) {
            logger.error("onDeadLetter hook failed", hookError);
            emitEngineEvent(dispatcher.onEvent, {
              type: "hook.error",
              jobId: job.id,
              code: job.code,
              hook: "onDeadLetter",
              error: hookError,
            });
          }
        }
      } else {
        const backoffDelayMs = calculateExponentialBackoff(job.attempts);
        const delayUntil = new Date(Date.now() + backoffDelayMs);
        entry.retryAt = delayUntil.toISOString();
        history[history.length - 1] = entry;

        logger.system.info(`Retrying job in ${backoffDelayMs}ms (attempt ${job.attempts})`);

        await dispatcher.databaseEngine.scheduleDelayedJob(job.queueName, job.id, delayUntil, {
          ...job.metadata,
          attemptHistory: history,
        });
      }

      throw e;
    } finally {
      clearInterval(heartbeat);
      logger.unbind();
      await Promise.all([
        enhancedJob.saveLogs(logger.logs()).catch(noop),
        enhancedJob.saveSteps(steps).catch(noop),
      ]);
    }

    return result;
  };
}
