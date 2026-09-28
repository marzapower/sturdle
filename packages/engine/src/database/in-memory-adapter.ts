import { randomUUID } from "node:crypto";

import type { Log } from "../logger.js";

import type { FinishedJobRow } from "./task-stats.js";
import type {
  DatabaseAdapter,
  DatabasePerformanceMetrics,
  EnqueueJobInput,
  HistoricalJobStats,
  Job,
  JobFilter,
  JobMetadata,
  JobStats,
  JobStep,
  QueueHealthStats,
  QueueInfo,
  TaskStats,
} from "./types.js";
import { mergeByAttempt } from "./merge-by-attempt.js";
import { aggregateTaskStats } from "./task-stats.js";

interface DelayedEntry {
  jobId: string;
  queueName: string;
  executeAt: Date;
}

interface LockEntry {
  token: string;
  expiresAt: Date;
}

/**
 * In-memory implementation of DatabaseAdapter, backed by Maps. Used only in tests so the
 * engine's logic can be exercised without a real database.
 */
export class InMemoryAdapter implements DatabaseAdapter {
  private connected = false;
  private jobs = new Map<string, Job>();
  private stream = new Map<string, { queueName: string; acknowledged: boolean }>(); // jobId -> entry
  private delayed = new Map<string, DelayedEntry>(); // jobId -> entry
  private locks = new Map<string, LockEntry>();
  private logs = new Map<string, Log[]>();
  private steps = new Map<string, JobStep[]>();

  async connect(): Promise<void> {
    this.connected = true;
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async enqueueJob(queueName: string, job: EnqueueJobInput): Promise<Job> {
    const id = randomUUID();
    const now = new Date();
    const fullJob: Job = {
      ...job,
      id,
      queueName,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, fullJob);

    if (!job.delayUntil || job.delayUntil <= now) {
      this.stream.set(id, { queueName, acknowledged: false });
    } else {
      this.delayed.set(id, { jobId: id, queueName, executeAt: job.delayUntil });
    }

    await Promise.resolve();
    return fullJob;
  }

  // A job with a concurrencyKey is pickable only if fewer than concurrencyLimit other jobs
  // currently "hold" the same key: started (processedAt set) and not yet in a terminal status.
  // This covers processing, delayed-after-start (retry backoff, step.sleep suspension) and
  // pending-after-stale-release alike; a delayed job that never started (scheduleJob, no
  // processedAt) does not hold the key.
  private isPickable(job: Job): boolean {
    if (!job.concurrencyKey) return true;

    const holders = Array.from(this.jobs.values()).filter(
      (candidate) =>
        candidate.concurrencyKey === job.concurrencyKey &&
        candidate.id !== job.id &&
        Boolean(candidate.processedAt) &&
        candidate.status !== "completed" &&
        candidate.status !== "failed",
    ).length;

    return holders < (job.concurrencyLimit ?? 1);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for interface-shaped call sites
  async dequeueJob(queueName: string, _consumerName: string): Promise<Job | null> {
    for (const [jobId, entry] of this.stream.entries()) {
      if (entry.queueName !== queueName || entry.acknowledged) continue;
      const job = this.jobs.get(jobId);
      if (!job) continue;
      // A job stays in the stream, unacknowledged, from enqueue until it reaches a terminal or
      // delayed status; skip one already claimed by an earlier dequeue (status no longer
      // "pending") so concurrent pickers never select the same entry twice.
      if (job.status !== "pending") continue;
      if (!this.isPickable(job)) continue;

      const updated: Job = {
        ...job,
        status: "processing",
        attempts: job.attempts + 1,
        processedAt: new Date(),
        updatedAt: new Date(),
      };
      this.jobs.set(jobId, updated);
      await Promise.resolve();
      return updated;
    }

    await Promise.resolve();
    return null;
  }

  async getJob(id: string): Promise<Job | null> {
    await Promise.resolve();
    return this.jobs.get(id) ?? null;
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<Job> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }

    const updated: Job = { ...job, ...updates, updatedAt: new Date() };
    this.jobs.set(id, updated);

    if (
      updates.status === "completed" ||
      updates.status === "failed" ||
      updates.status === "delayed"
    ) {
      const entry = this.stream.get(id);
      if (entry) {
        entry.acknowledged = true;
      }
    }

    await Promise.resolve();
    return updated;
  }

  async deleteJob(id: string): Promise<void> {
    this.jobs.delete(id);
    this.stream.delete(id);
    this.delayed.delete(id);
    await Promise.resolve();
  }

  async listJobs(queueName: string, filter?: JobFilter): Promise<Job[]> {
    let jobs = Array.from(this.jobs.values()).filter((job) => job.queueName === queueName);
    if (filter?.status) {
      jobs = jobs.filter((job) => job.status === filter.status);
    }
    await Promise.resolve();
    return jobs;
  }

  async countJobs(queueName: string, filter?: { status?: string }): Promise<number> {
    const jobs = await this.listJobs(queueName, filter as JobFilter);
    return jobs.length;
  }

  // Does NOT delegate to listJobs: that method ignores ordering, limit and offset, which this
  // one must honour (it backs the paginated per-task job list).
  async listJobsByCode(code: string, filter?: JobFilter): Promise<Job[]> {
    let jobs = Array.from(this.jobs.values())
      .filter((job) => job.code === code)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filter?.status) {
      jobs = jobs.filter((job) => job.status === filter.status);
    }

    const offset = filter?.offset ?? 0;
    const end = filter?.limit !== undefined ? offset + filter.limit : undefined;
    jobs = jobs.slice(offset, end);

    await Promise.resolve();
    return jobs;
  }

  async getJobStatsByCode(code: string): Promise<JobStats> {
    const stats: JobStats = {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };
    for (const job of this.jobs.values()) {
      if (job.code !== code) continue;
      stats[job.status]++;
      stats.total++;
    }
    await Promise.resolve();
    return stats;
  }

  async getJobStats(queueName: string): Promise<JobStats> {
    const jobs = await this.listJobs(queueName);
    const stats: JobStats = {
      total: jobs.length,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    };
    for (const job of jobs) {
      stats[job.status]++;
    }
    return stats;
  }

  async getQueueInfo(queueName: string): Promise<QueueInfo> {
    const stats = await this.getJobStats(queueName);
    return {
      name: queueName,
      size: stats.total,
      delayedSize: stats.delayed,
      processingSize: stats.processing,
      stats,
    };
  }

  async scheduleDelayedJob(
    queueName: string,
    jobId: string,
    delayUntil: Date,
    metadata?: JobMetadata,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const updated: Job = {
      ...job,
      status: "delayed",
      delayUntil,
      updatedAt: new Date(),
      metadata: metadata ?? job.metadata,
    };
    this.jobs.set(jobId, updated);

    const entry = this.stream.get(jobId);
    if (entry) {
      entry.acknowledged = true;
    }

    this.delayed.set(jobId, { jobId, queueName, executeAt: delayUntil });
    await Promise.resolve();
  }

  async getReadyDelayedJobs(queueName: string): Promise<Job[]> {
    const now = new Date();
    const ready: Job[] = [];
    for (const entry of this.delayed.values()) {
      if (entry.queueName !== queueName || entry.executeAt > now) continue;
      const job = this.jobs.get(entry.jobId);
      if (job) ready.push(job);
    }
    await Promise.resolve();
    return ready;
  }

  async moveJobToStream(queueName: string, jobId: string): Promise<void> {
    const hadDelayed = this.delayed.delete(jobId);
    if (!hadDelayed) {
      // Another replica already claimed it
      await Promise.resolve();
      return;
    }

    this.stream.set(jobId, { queueName, acknowledged: false });

    const job = this.jobs.get(jobId);
    if (job) {
      this.jobs.set(jobId, { ...job, status: "pending", updatedAt: new Date() });
    }

    await Promise.resolve();
  }

  async heartbeatJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job && job.status === "processing") {
      this.jobs.set(jobId, { ...job, updatedAt: new Date() });
    }
    await Promise.resolve();
  }

  async suspendJob(queueName: string, jobId: string, wakeAt: Date): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const updated: Job = {
      ...job,
      status: "delayed",
      delayUntil: wakeAt,
      attempts: job.attempts - 1,
      updatedAt: new Date(),
    };
    this.jobs.set(jobId, updated);

    const entry = this.stream.get(jobId);
    if (entry) {
      entry.acknowledged = true;
    }

    this.delayed.set(jobId, { jobId, queueName, executeAt: wakeAt });
    await Promise.resolve();
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const existing = this.locks.get(key);
    const now = new Date();
    if (existing && existing.expiresAt > now) {
      await Promise.resolve();
      return null;
    }

    const token = randomUUID();
    this.locks.set(key, { token, expiresAt: new Date(now.getTime() + ttlMs) });
    await Promise.resolve();
    return token;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing && existing.token === token) {
      this.locks.delete(key);
      await Promise.resolve();
      return true;
    }
    await Promise.resolve();
    return false;
  }

  async cleanupExpiredLocks(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [key, entry] of this.locks.entries()) {
      if (entry.expiresAt < now) {
        this.locks.delete(key);
        count++;
      }
    }
    await Promise.resolve();
    return count;
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    await Promise.resolve();
    return { healthy: true };
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    await Promise.resolve();
    return { jobs: this.jobs.size };
  }

  async releaseStaleJobs(queueName: string, staleAfterMs: number): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.queueName !== queueName || job.status !== "processing") continue;
      if (now - job.updatedAt.getTime() <= staleAfterMs) continue;

      if (job.attempts < job.maxAttempts) {
        this.jobs.set(job.id, { ...job, status: "pending", updatedAt: new Date() });
        const entry = this.stream.get(job.id);
        if (entry) entry.acknowledged = false;
      } else {
        this.jobs.set(job.id, {
          ...job,
          status: "failed",
          failedAt: new Date(),
          error: "Job stale - max attempts reached",
          updatedAt: new Date(),
        });
        const entry = this.stream.get(job.id);
        if (entry) entry.acknowledged = true;
      }
      count++;
    }
    await Promise.resolve();
    return count;
  }

  async getChildJobIds(jobId: string): Promise<string[]> {
    const children = await this.getChildJobs(jobId);
    return children.map((job) => job.id);
  }

  async getChildJobs(jobId: string): Promise<Job[]> {
    const children = Array.from(this.jobs.values())
      .filter((job) => job.parentJobId === jobId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    await Promise.resolve();
    return children;
  }

  async saveJobLogs(jobId: string, logs: Log[]): Promise<void> {
    const existing = this.logs.get(jobId) ?? [];
    this.logs.set(jobId, mergeByAttempt(existing, logs));
    await Promise.resolve();
  }

  async saveJobSteps(jobId: string, steps: JobStep[]): Promise<void> {
    const existing = this.steps.get(jobId) ?? [];
    this.steps.set(jobId, mergeByAttempt(existing, steps));
    await Promise.resolve();
  }

  async getJobLogs(jobId: string): Promise<Log[]> {
    await Promise.resolve();
    return this.logs.get(jobId) ?? [];
  }

  async getJobSteps(jobId: string): Promise<JobStep[]> {
    await Promise.resolve();
    return this.steps.get(jobId) ?? [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for interface-shaped call sites
  async getHistoricalStats(_queueName: string, _hoursBack: number): Promise<HistoricalJobStats[]> {
    await Promise.resolve();
    return [];
  }

  async getPerformanceMetricsFromDB(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for interface-shaped call sites
    _queueName?: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for interface-shaped call sites
    _hoursBack?: number,
  ): Promise<DatabasePerformanceMetrics> {
    await Promise.resolve();
    return {
      totalJobs: this.jobs.size,
      completedJobs: 0,
      failedJobs: 0,
      successRate: 0,
      avgDurationMs: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      p99DurationMs: 0,
      minDurationMs: 0,
      maxDurationMs: 0,
      activeJobs: 0,
    };
  }

  async getQueueHealth(queueName: string, since: Date): Promise<QueueHealthStats> {
    let oldestPendingAt: Date | null = null;
    let completedSince = 0;
    let failedSince = 0;

    for (const job of this.jobs.values()) {
      if (job.queueName !== queueName) continue;

      if (job.status === "pending") {
        if (!oldestPendingAt || job.createdAt < oldestPendingAt) {
          oldestPendingAt = job.createdAt;
        }
      } else if (job.status === "completed" && job.completedAt && job.completedAt >= since) {
        completedSince++;
      } else if (job.status === "failed" && job.failedAt && job.failedAt >= since) {
        failedSince++;
      }
    }

    await Promise.resolve();
    return { oldestPendingAt, completedSince, failedSince };
  }

  async getLastRunByCode(code: string): Promise<Job | null> {
    let lastRun: Job | null = null;
    for (const job of this.jobs.values()) {
      if (job.code !== code) continue;
      if (!lastRun || job.createdAt > lastRun.createdAt) {
        lastRun = job;
      }
    }
    await Promise.resolve();
    return lastRun;
  }

  async getTaskStats(hoursBack: number, code?: string): Promise<TaskStats[]> {
    const rows: FinishedJobRow[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "completed" && job.status !== "failed") continue;
      if (code && job.code !== code) continue;
      rows.push({
        code: job.code,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.processedAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
      });
    }

    await Promise.resolve();
    return aggregateTaskStats(rows, hoursBack);
  }
}
