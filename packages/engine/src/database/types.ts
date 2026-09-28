import { z } from "zod";

import type { Log } from "../logger.js";

export interface Job {
  id: string;
  code: string;
  queueName: string; // always set by the adapter
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "failed" | "delayed";
  priority: number;
  attempts: number; // executions started, current one included, suspensions excluded (a resumed sleep keeps its attempt number)
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date; // = started_at
  completedAt?: Date;
  failedAt?: Date;
  delayUntil?: Date;
  parentJobId?: string; // parent_job_id column
  error?: string;
  result?: Record<string, unknown>;
  metadata?: JobMetadata;
  concurrencyKey?: string; // `<code>` or `<code>:<value>`, set at enqueue, never changed afterwards
  concurrencyLimit?: number; // >= 1 when concurrencyKey is set
}

export interface AttemptHistoryEntry {
  attempt: number; // 1-based
  error: string;
  failedAt: string; // ISO
  retryAt?: string; // ISO, absent on the last attempt
  nonRetriable?: true;
}

export interface JobMetadata extends Record<string, unknown> {
  attemptHistory?: AttemptHistoryEntry[];
  deadLetter?: { at: string; reason: string };
  // Set on a child job's metadata when it is created via step.sendEvent, so the timeline can
  // anchor it to the step that spawned it.
  spawnedBy?: { jobId: string; step: string | null };
}

export type EnqueueJobInput = Omit<Job, "id" | "createdAt" | "updatedAt" | "queueName">;

export interface JobFilter {
  status?: Job["status"];
  type?: string;
  priority?: number;
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
  offset?: number;
}

export interface JobStats {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface HistoricalJobStats {
  hour: string; // ISO string for the hour
  completed: number;
  failed: number;
  total: number;
}

export interface DatabasePerformanceMetrics {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  activeJobs: number;
}

export interface QueueInfo {
  name: string;
  size: number;
  delayedSize: number;
  processingSize: number;
  stats: JobStats;
}

export interface QueueHealthStats {
  oldestPendingAt: Date | null; // min(createdAt) of pending jobs in the queue, or null if none
  completedSince: number; // completed jobs with completedAt >= since
  failedSince: number; // failed jobs with failedAt >= since
}

export interface TaskStats {
  code: string;
  /** Jobs that reached `completed` inside the window (by completed_at). */
  completed: number;
  /** Jobs that reached `failed` inside the window (by failed_at). */
  failed: number;
  /** p95 of (completed_at|failed_at) - (started_at ?? created_at), in ms, over finished jobs in the window; null when none has a positive duration. */
  p95DurationMs: number | null;
  /** One bucket per hour, oldest first, exactly `hoursBack` entries, hour = ISO string truncated to the hour (UTC), same bucketing as getHistoricalStats. */
  series: { hour: string; completed: number; failed: number }[];
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Job operations
  enqueueJob(queueName: string, job: EnqueueJobInput): Promise<Job>; // persists parentJobId
  dequeueJob(queueName: string, consumerName: string): Promise<Job | null>; // increments attempts
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, updates: Partial<Job>): Promise<Job>; // metadata: replaces the whole object; acks the stream on completed|failed|delayed
  deleteJob(id: string): Promise<void>;

  // Job queries
  listJobs(queueName: string, filter?: JobFilter): Promise<Job[]>;
  countJobs(queueName: string, filter?: { status?: string }): Promise<number>;
  getJobStats(queueName: string): Promise<JobStats>;
  getQueueInfo(queueName: string): Promise<QueueInfo>;
  // Same as listJobs/getJobStats, but across all queues, filtered by job code instead of queue.
  // Ordered by createdAt desc.
  listJobsByCode(code: string, filter?: JobFilter): Promise<Job[]>;
  getJobStatsByCode(code: string): Promise<JobStats>;

  // Delayed jobs
  // Atomic retry (single transaction): 1) update job { status: "delayed", delayUntil, metadata? } 2)
  // ack the stream entry 3) create the delayed entry.
  scheduleDelayedJob(
    queueName: string,
    jobId: string,
    delayUntil: Date,
    metadata?: JobMetadata,
  ): Promise<void>;
  getReadyDelayedJobs(queueName: string): Promise<Job[]>;
  // Claim (single transaction): 1) delete the delayed entry, no-op if already claimed by another
  // replica 2) upsert the stream entry 3) set the job back to "pending".
  moveJobToStream(queueName: string, jobId: string): Promise<void>;

  // Renews the lease of a running job: no-op when the job is no longer "processing".
  heartbeatJob(jobId: string): Promise<void>;
  // Atomic suspension (one transaction): status "delayed", delayUntil = wakeAt, attempts - 1,
  // ack of the stream entry, delayed row. Metadata untouched.
  suspendJob(queueName: string, jobId: string, wakeAt: Date): Promise<void>;

  // Locking for concurrency
  acquireLock(key: string, ttlMs: number): Promise<string | null>; // clears an expired lock on the same key
  releaseLock(key: string, token: string): Promise<boolean>;
  cleanupExpiredLocks(): Promise<number>;

  // Health and monitoring
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  getMetrics(): Promise<Record<string, unknown>>;

  // Job recovery
  // stale = status "processing" AND updatedAt <= now - staleAfterMs (lease expired); no re-enqueue
  releaseStaleJobs(queueName: string, staleAfterMs: number): Promise<number>;

  // Parent/child relationships
  getChildJobIds(jobId: string): Promise<string[]>;
  getChildJobs(jobId: string): Promise<Job[]>;

  // Job logs and steps. Steps and logs are per-attempt: entries carrying the same `attempt` as
  // the ones being saved are replaced, entries of other attempts are preserved (see
  // createJobHandler). Legacy entries without `attempt` are treated as attempt 1 on read.
  saveJobLogs(jobId: string, logs: Log[]): Promise<void>;
  saveJobSteps(jobId: string, steps: JobStep[]): Promise<void>;
  getJobLogs(jobId: string): Promise<Log[]>;
  getJobSteps(jobId: string): Promise<JobStep[]>;

  // Historical statistics
  getHistoricalStats(queueName: string, hoursBack: number): Promise<HistoricalJobStats[]>;

  // Performance metrics from database
  getPerformanceMetricsFromDB(
    queueName?: string,
    hoursBack?: number,
  ): Promise<DatabasePerformanceMetrics>;

  // Health dashboard support
  getQueueHealth(queueName: string, since: Date): Promise<QueueHealthStats>;
  getLastRunByCode(code: string): Promise<Job | null>; // most recent job for a code, any status
  // 24h-style aggregates per job code, for the fleet table. Only codes with at least one
  // finished job in the window are returned. With `code`, only that code's rows are loaded.
  getTaskStats(hoursBack: number, code?: string): Promise<TaskStats[]>;
}

// Errors
export class JobError extends Error {
  constructor(
    message: string,
    public readonly jobId: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export class QueueError extends Error {
  constructor(
    message: string,
    public readonly queueName: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

export class LockError extends Error {
  constructor(
    message: string,
    public readonly jobId: string,
  ) {
    super(message);
    this.name = "LockError";
  }
}

// Job Step tracking for execution tracing
export const JobStepStatus = z.enum(["running", "completed", "failed"]);
export type JobStepStatus = z.infer<typeof JobStepStatus>;

export const JobStepKind = z.enum(["run", "sendEvent", "sleep"]);
export type JobStepKind = z.infer<typeof JobStepKind>;

export const jobStepSchema = z.object({
  name: z.string(),
  attempt: z.number(), // 1-based, the job attempt this step ran in
  kind: JobStepKind.optional(), // absent = "run" (legacy entries persisted before this field existed)
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
  duration: z.number().optional(), // in milliseconds
  status: JobStepStatus,
  result: z.unknown().optional(),
  error: z.string().optional(),
  /** Attempt whose completed step this entry replays (memoized skip); absent on a real run. */
  replayedFrom: z.number().optional(),
});

export type JobStep = z.infer<typeof jobStepSchema>;
export const jobStepsSchema = z.array(jobStepSchema);
export type JobSteps = z.infer<typeof jobStepsSchema>;

export const jobStreamSchema = z.object({
  jobId: z.string(),
  jobCode: z.string(),
  timestamp: z.string(),
});

export type JobStream = z.infer<typeof jobStreamSchema>;

export type JobMessage = {
  id: string;
  fields: JobStream;
};
