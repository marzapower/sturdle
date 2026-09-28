import { emitEngineEvent } from "../telemetry.js";

import type { Job } from "../database/types.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Chatter } from "./messenger.js";
import { EnhancedJob } from "../database/enhanced-job.js";
import {
  buildDeadLetterUpdate,
  createJobHandler,
  JOB_SUSPENDED,
  markErrorReported,
  wasErrorReported,
} from "./dispatcher.js";
import { Event, Messenger } from "./messenger.js";
import { validateJobPayload } from "./payload.js";
import { JobRegistry } from "./registry.js";
import { Stoppable } from "./shared.js";

interface WorkerStats {
  completed: number;
  failed: number;
}

export class Worker extends Stoppable implements Chatter {
  id: string;
  private dispatcher: Dispatcher;
  private stats: WorkerStats;
  private isWaiting = false;
  private reserved = false;
  private currentJobPromise: Promise<void> | null = null;

  constructor(dispatcher: Dispatcher, id: string) {
    super();
    this.dispatcher = dispatcher;
    this.stats = {
      completed: 0,
      failed: 0,
    };
    this.id = id;
  }

  async start() {
    this.logger.info("Starting worker", this.id);

    this.signalReady();

    await Promise.resolve();
  }

  async runCycle() {
    // Worker executes work based on dispatcher signals; nothing to run in a cycle.
  }

  async shutdown() {
    this.logger.info("Worker", this.id, "shutting down...");

    this.shuttingDown = true;

    const timeoutMs = 10000;
    const startTime = Date.now();

    while (this.running && Date.now() - startTime < timeoutMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    if (this.running) {
      this.logger.warn("Worker", this.id, "forced shutdown after timeout");
      this.running = false;
    }

    if (this.currentJobPromise) {
      try {
        await Promise.race([
          this.currentJobPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Job timeout")), 5000);
          }),
        ]);
      } catch (error) {
        this.logger.warn("Worker", this.id, "job completion error during shutdown:", error);
      }
    }

    this.logger.info("Worker", this.id, "stopped");
  }

  private signalReady() {
    if (!this.running && !this.isWaiting && !this.halted) {
      this.isWaiting = true;
      Messenger.emit(Event.WorkerReady, this);
    }
  }

  private async executeJobAsync(job: Job): Promise<void> {
    this.running = true;
    this.reserved = false; // Assignment completed, now executing

    try {
      const task = JobRegistry.getFunction(job.code);
      if (!task) {
        // No handler registered on this instance for this job code: dead letter it immediately
        // instead of retrying, since retries can never succeed.
        const errorMessage = `Task ${job.code} not found on this Sturdle instance`;
        const failedAt = new Date();

        await new EnhancedJob(job, this.dispatcher.databaseEngine.adapter).updateStatus(
          "failed",
          buildDeadLetterUpdate(job, errorMessage, "no handler registered", failedAt),
        );

        emitEngineEvent(this.dispatcher.onEvent, {
          type: "job.dead-lettered",
          jobId: job.id,
          code: job.code,
          attempts: job.attempts,
          error: errorMessage,
        });

        const error = new Error(errorMessage);
        markErrorReported(error);
        throw error;
      }

      const validation = validateJobPayload(task.payloadSchema, job.payload);
      if (!validation.ok) {
        // The payload can never become valid on a retry: dead letter it right away.
        const errorMessage = `Invalid payload for ${job.code}: ${validation.message}`;
        const failedAt = new Date();

        await new EnhancedJob(job, this.dispatcher.databaseEngine.adapter).updateStatus(
          "failed",
          buildDeadLetterUpdate(job, errorMessage, "invalid payload", failedAt),
        );

        emitEngineEvent(this.dispatcher.onEvent, {
          type: "job.dead-lettered",
          jobId: job.id,
          code: job.code,
          attempts: job.attempts,
          error: errorMessage,
        });

        const error = new Error(errorMessage);
        markErrorReported(error);
        throw error;
      }

      const handler = createJobHandler(task, this.dispatcher);
      const outcome = await handler(job);

      if (outcome === JOB_SUSPENDED) {
        Messenger.emit(Event.WorkerJobSuspended, this, job);
      } else {
        this.stats.completed++;
        Messenger.emit(Event.WorkerJobCompleted, this, job);
      }
    } catch (e) {
      this.stats.failed++;

      // Dead-letter cases already emitted their own `job.dead-lettered` event (here or in
      // createJobHandler); everything else is a genuine execution error (e.g. still retriable).
      if (!wasErrorReported(e)) {
        emitEngineEvent(this.dispatcher.onEvent, {
          type: "job.error",
          jobId: job.id,
          code: job.code,
          attempt: job.attempts, // Current attempt being executed (already incremented by dequeueJob)
          error: e,
        });
      }

      Messenger.emit(Event.WorkerJobFailed, this, job, e);
    } finally {
      this.running = false;
      this.currentJobPromise = null;
      this.signalReady();
    }
  }

  assignJob(job: Job): void {
    if (this.running || this.halted || this.reserved) {
      throw new Error(`Worker ${this.id} is not available`);
    }

    this.reserved = true;
    this.isWaiting = false;

    this.currentJobPromise = this.executeJobAsync(job);
  }

  get isAvailable(): boolean {
    return !this.reserved && !this.running && !this.halted;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async waitForCompletion(): Promise<void> {
    if (this.currentJobPromise) {
      await this.currentJobPromise;
    }
  }

  getStats(): WorkerStats {
    return { ...this.stats };
  }
}
