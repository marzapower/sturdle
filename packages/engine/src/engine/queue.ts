import { type Payload } from "../types.js";

import type { Job, JobMetadata } from "../database/types.js";
import type { DatabaseEngine } from "./database-engine.js";
import type { QueueConfig } from "./shared.js";
import { Event, Messenger } from "./messenger.js";
import { Loggable } from "./shared.js";

export class Queue extends Loggable {
  name: string;
  private concurrency: number;
  priority: number;
  private runningJobIds = new Set<string>();
  private databaseEngine: DatabaseEngine;
  private isPolling = false;
  private consumerName: string;

  constructor(config: QueueConfig, databaseEngine: DatabaseEngine, consumerName: string) {
    super();
    this.name = config.name;
    this.concurrency = config.concurrency;
    this.priority = config.priority;
    this.databaseEngine = databaseEngine;
    this.consumerName = consumerName;
  }

  async start() {
    this.setupEvents();
    return Promise.resolve();
  }

  private setupEvents() {
    Messenger.listen(this, Event.JobCompleted, (job: Job) => {
      this.runningJobIds.delete(job.id);
    });

    Messenger.listen(this, Event.JobFailed, (job: Job) => {
      this.runningJobIds.delete(job.id);
    });

    Messenger.listen(this, Event.JobSuspended, (job: Job) => {
      this.runningJobIds.delete(job.id);
    });
  }

  async getNextJob() {
    if (this.runningJobIds.size >= this.concurrency) {
      return null;
    }

    const job = await this.databaseEngine.dequeueJob(this.name, this.consumerName);
    if (!job) {
      return null;
    }

    this.runningJobIds.add(job.id);
    this.logger.info("Found job", job.id, "in queue", this.name);
    return job;
  }

  async enqueueJob(
    jobCode: string,
    payload: Payload,
    options: Partial<{
      delayUntil?: Date;
      priority?: number;
      maxAttempts?: number;
      parentJobId?: string;
      metadata?: JobMetadata;
      concurrencyKey?: string;
      concurrencyLimit?: number;
    }> = {},
  ) {
    const job = await this.databaseEngine.enqueueJob(this.name, {
      code: jobCode,
      payload,
      status: "pending",
      priority: options.priority || 1,
      attempts: 0, // 0-based: no attempts made yet
      maxAttempts: options.maxAttempts || 3,
      delayUntil: options.delayUntil,
      parentJobId: options.parentJobId,
      metadata: options.metadata,
      concurrencyKey: options.concurrencyKey,
      concurrencyLimit: options.concurrencyLimit,
    });

    return job.id;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for interface-shaped call sites
  async getReadyDelayedJobIds(_now: number): Promise<string[]> {
    const jobs = await this.databaseEngine.getReadyDelayedJobs(this.name);
    return jobs.map((job) => job.id);
  }

  async moveJobToStream(jobId: string): Promise<void> {
    await this.databaseEngine.moveJobToStream(this.name, jobId);
  }

  getStats() {
    return {
      name: this.name,
      concurrency: this.concurrency,
      priority: this.priority,
      runningJobs: this.runningJobIds.size,
      isPolling: this.isPolling,
    };
  }
}
