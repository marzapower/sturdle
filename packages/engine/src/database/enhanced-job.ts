import type { Log } from "../logger.js";

import type { DatabaseAdapter, Job, JobMetadata, JobStep } from "./types.js";

/**
 * Enhanced job that provides methods for updating status, saving steps, and saving logs on top
 * of a plain `Job`, persisting each change through the adapter.
 */
export class EnhancedJob implements Job {
  private _job: Job;
  private _adapter: DatabaseAdapter;
  private _steps: JobStep[] = [];
  private _logs: Log[] = [];
  // Single write queue shared by saveSteps/saveLogs so the two never race on the same
  // job metadata row (both do a read-modify-write on adapters like Postgres). Each call below
  // appends its own write to this chain and returns that write's own promise, which can reject;
  // the chain itself always recovers (.catch(noop)) so one failed write never blocks the next
  // one queued behind it.
  private _writeChain: Promise<void> = Promise.resolve();

  constructor(job: Job, adapter: DatabaseAdapter) {
    this._job = job;
    this._adapter = adapter;
  }

  // Proxy all Job interface properties
  get id() {
    return this._job.id;
  }
  get code() {
    return this._job.code;
  }
  get queueName() {
    return this._job.queueName;
  }
  get payload() {
    return this._job.payload;
  }
  get status() {
    return this._job.status;
  }
  get priority() {
    return this._job.priority;
  }
  get attempts() {
    return this._job.attempts;
  }
  get maxAttempts() {
    return this._job.maxAttempts;
  }
  get createdAt() {
    return this._job.createdAt;
  }
  get updatedAt() {
    return this._job.updatedAt;
  }
  get processedAt() {
    return this._job.processedAt;
  }
  get completedAt() {
    return this._job.completedAt;
  }
  get failedAt() {
    return this._job.failedAt;
  }
  get delayUntil() {
    return this._job.delayUntil;
  }
  get parentJobId() {
    return this._job.parentJobId;
  }
  get error() {
    return this._job.error;
  }
  get result() {
    return this._job.result;
  }
  get metadata() {
    return this._job.metadata;
  }

  /**
   * Update job status and metadata
   */
  async updateStatus(
    status: Job["status"],
    metadata?: {
      startedAt?: Date;
      completedAt?: Date;
      result?: Record<string, unknown>;
      error?: string;
      metadata?: JobMetadata;
      delayUntil?: Date;
    },
  ): Promise<void> {
    const updates: Partial<Job> = { status };

    if (metadata) {
      if (metadata.startedAt) {
        updates.processedAt = metadata.startedAt;
      }
      if (metadata.completedAt) {
        updates.completedAt = metadata.completedAt;
        if (status === "failed") {
          updates.failedAt = metadata.completedAt;
        }
      }
      if (metadata.result !== undefined) {
        updates.result = metadata.result;
      }
      if (metadata.error) {
        updates.error = metadata.error;
      }
      if (metadata.metadata !== undefined) {
        updates.metadata = metadata.metadata;
      }
      if (metadata.delayUntil) {
        updates.delayUntil = metadata.delayUntil;
      }
    }

    const updatedJob = await this._adapter.updateJob(this._job.id, updates);
    this._job = updatedJob;
  }

  /**
   * Save job execution steps. Queued on the shared write chain: resolves/rejects with the
   * outcome of THIS write, once every write queued ahead of it (steps or logs) has settled.
   */
  async saveSteps(steps: JobStep[]): Promise<void> {
    // Shallow copy captured now, in this call's closure: the dispatcher mutates step objects in
    // place, so by the time this write runs the snapshot may already reflect later, monotonic
    // status changes (e.g. "running" -> "completed") — harmless, never a regression.
    const snapshot = [...steps];
    this._steps = snapshot;
    const jobId = this._job.id;
    const adapter = this._adapter;

    const write = this._writeChain.then(() => adapter.saveJobSteps(jobId, snapshot));
    this._writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /**
   * Save job execution logs. Same shared write chain as saveSteps (see there).
   */
  async saveLogs(logs: Log[]): Promise<void> {
    const snapshot = [...logs];
    this._logs = snapshot;
    const jobId = this._job.id;
    const adapter = this._adapter;

    const write = this._writeChain.then(() => adapter.saveJobLogs(jobId, snapshot));
    this._writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /**
   * Get the underlying job data
   */
  toJob(): Job {
    return this._job;
  }
}
