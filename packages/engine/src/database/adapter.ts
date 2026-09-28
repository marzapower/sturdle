import type { Log } from "../logger.js";

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

export abstract class BaseDatabaseAdapter implements DatabaseAdapter {
  protected connected = false;

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  isConnected(): boolean {
    return this.connected;
  }

  protected setConnected(connected: boolean): void {
    this.connected = connected;
  }

  // All other methods must be implemented by concrete adapters
  abstract enqueueJob(queueName: string, job: EnqueueJobInput): Promise<Job>;
  abstract dequeueJob(queueName: string, consumerName: string): Promise<Job | null>;
  abstract getJob(id: string): Promise<Job | null>;
  abstract updateJob(id: string, updates: Partial<Job>): Promise<Job>;
  abstract deleteJob(id: string): Promise<void>;
  abstract listJobs(queueName: string, filter?: JobFilter): Promise<Job[]>;
  abstract countJobs(queueName: string, filter?: { status?: Job["status"] }): Promise<number>;
  abstract getJobStats(queueName: string): Promise<JobStats>;
  abstract getQueueInfo(queueName: string): Promise<QueueInfo>;
  abstract listJobsByCode(code: string, filter?: JobFilter): Promise<Job[]>;
  abstract getJobStatsByCode(code: string): Promise<JobStats>;
  abstract scheduleDelayedJob(
    queueName: string,
    jobId: string,
    delayUntil: Date,
    metadata?: JobMetadata,
  ): Promise<void>;
  abstract getReadyDelayedJobs(queueName: string): Promise<Job[]>;
  abstract moveJobToStream(queueName: string, jobId: string): Promise<void>;
  abstract heartbeatJob(jobId: string): Promise<void>;
  abstract suspendJob(queueName: string, jobId: string, wakeAt: Date): Promise<void>;
  abstract acquireLock(key: string, ttlMs: number): Promise<string | null>;
  abstract releaseLock(key: string, token: string): Promise<boolean>;
  abstract cleanupExpiredLocks(): Promise<number>;
  abstract healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  abstract getMetrics(): Promise<Record<string, unknown>>;
  abstract releaseStaleJobs(queueName: string, staleAfterMs: number): Promise<number>;
  abstract getChildJobIds(jobId: string): Promise<string[]>;
  abstract getChildJobs(jobId: string): Promise<Job[]>;
  abstract saveJobLogs(jobId: string, logs: Log[]): Promise<void>;
  abstract saveJobSteps(jobId: string, steps: JobStep[]): Promise<void>;
  abstract getJobLogs(jobId: string): Promise<Log[]>;
  abstract getJobSteps(jobId: string): Promise<JobStep[]>;
  abstract getHistoricalStats(queueName: string, hoursBack: number): Promise<HistoricalJobStats[]>;
  abstract getPerformanceMetricsFromDB(
    queueName?: string,
    hoursBack?: number,
  ): Promise<DatabasePerformanceMetrics>;
  abstract getQueueHealth(queueName: string, since: Date): Promise<QueueHealthStats>;
  abstract getLastRunByCode(code: string): Promise<Job | null>;
  abstract getTaskStats(hoursBack: number, code?: string): Promise<TaskStats[]>;
}
