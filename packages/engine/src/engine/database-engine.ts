import { Logger } from "../logger.js";

import {
  type DatabaseAdapter,
  type DatabasePerformanceMetrics,
  type EnqueueJobInput,
  type HistoricalJobStats,
  type Job,
  type JobFilter,
  type JobMetadata,
  type JobStats,
  type QueueInfo,
} from "../database/types.js";

const logger = Logger.ns("Sturdle").tagged("DatabaseEngine");

export interface DatabaseEngineOptions {
  adapter: DatabaseAdapter;
}

export class DatabaseEngine {
  public adapter: DatabaseAdapter;

  constructor(configOrOptions: DatabaseEngineOptions) {
    this.adapter = configOrOptions.adapter;
  }

  async initialize(): Promise<void> {
    const adapterType = this.getAdapterType();
    logger.info(`Initializing database engine with ${adapterType} adapter`);

    if (!this.adapter.isConnected()) {
      await this.adapter.connect();
    }

    const health = await this.adapter.healthCheck();
    if (!health.healthy) {
      throw new Error(`Database health check failed: ${health.message}`);
    }

    logger.info(`Database engine initialized successfully`);
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down database engine");

    if (this.adapter.isConnected()) {
      await this.adapter.disconnect();
    }

    logger.info("Database engine shutdown complete");
  }

  // Job Management
  async enqueueJob(queueName: string, job: EnqueueJobInput): Promise<Job> {
    return this.adapter.enqueueJob(queueName, job);
  }

  async dequeueJob(queueName: string, consumerName: string): Promise<Job | null> {
    return this.adapter.dequeueJob(queueName, consumerName);
  }

  async getJob(id: string): Promise<Job | null> {
    return this.adapter.getJob(id);
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<Job> {
    return this.adapter.updateJob(id, updates);
  }

  async deleteJob(id: string): Promise<void> {
    return this.adapter.deleteJob(id);
  }

  async listJobs(queueName: string, filter?: JobFilter): Promise<Job[]> {
    return this.adapter.listJobs(queueName, filter);
  }

  async countJobs(queueName: string, filter?: { status?: string }): Promise<number> {
    return this.adapter.countJobs(queueName, filter);
  }

  async getJobStats(queueName: string): Promise<JobStats> {
    return this.adapter.getJobStats(queueName);
  }

  async getQueueInfo(queueName: string): Promise<QueueInfo> {
    return this.adapter.getQueueInfo(queueName);
  }

  async listJobsByCode(code: string, filter?: JobFilter): Promise<Job[]> {
    return this.adapter.listJobsByCode(code, filter);
  }

  async getJobStatsByCode(code: string): Promise<JobStats> {
    return this.adapter.getJobStatsByCode(code);
  }

  // Delayed Jobs
  async scheduleDelayedJob(
    queueName: string,
    jobId: string,
    delayUntil: Date,
    metadata?: JobMetadata,
  ): Promise<void> {
    return this.adapter.scheduleDelayedJob(queueName, jobId, delayUntil, metadata);
  }

  async getReadyDelayedJobs(queueName: string): Promise<Job[]> {
    return this.adapter.getReadyDelayedJobs(queueName);
  }

  async moveJobToStream(queueName: string, jobId: string): Promise<void> {
    return this.adapter.moveJobToStream(queueName, jobId);
  }

  // Locking
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    return this.adapter.acquireLock(key, ttlMs);
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    return this.adapter.releaseLock(key, token);
  }

  async cleanupExpiredLocks(): Promise<number> {
    return this.adapter.cleanupExpiredLocks();
  }

  // Job Recovery
  async releaseStaleJobs(queueName: string, staleAfterMs: number): Promise<number> {
    return this.adapter.releaseStaleJobs(queueName, staleAfterMs);
  }

  // Renews the lease of a job currently "processing" (no-op otherwise).
  async heartbeatJob(jobId: string): Promise<void> {
    return this.adapter.heartbeatJob(jobId);
  }

  // Suspends a running job as "delayed" until wakeAt, rolling back the attempt it consumed.
  async suspendJob(queueName: string, jobId: string, wakeAt: Date): Promise<void> {
    return this.adapter.suspendJob(queueName, jobId, wakeAt);
  }

  // Parent/child relationships
  async getChildJobIds(jobId: string): Promise<string[]> {
    return this.adapter.getChildJobIds(jobId);
  }

  // Health and Metrics
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return this.adapter.healthCheck();
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const adapterMetrics = await this.adapter.getMetrics();

    return {
      adapter_type: "base",
      connected: this.adapter.isConnected(),
      ...adapterMetrics,
    };
  }

  // Utility Methods
  isConnected(): boolean {
    return this.adapter.isConnected();
  }

  getAdapterType(): string {
    return "base";
  }

  // Historical Statistics
  async getHistoricalStats(queueName: string, hoursBack: number): Promise<HistoricalJobStats[]> {
    return this.adapter.getHistoricalStats(queueName, hoursBack);
  }

  // Performance Metrics from Database
  async getPerformanceMetricsFromDB(
    queueName?: string,
    hoursBack?: number,
  ): Promise<DatabasePerformanceMetrics> {
    return this.adapter.getPerformanceMetricsFromDB(queueName, hoursBack);
  }
}
