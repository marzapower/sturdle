import os from "node:os";

import { type FunctionDefinition, type Payload } from "../types.js";
import type { EngineEventListener } from "../telemetry.js";

import type { DatabaseAdapter, Job } from "../database/types.js";
import type { Chatter } from "./messenger.js";
import type { QueueConfig } from "./shared.js";
import { ApiHelper } from "./apiHelper.js";
import { DatabaseEngine } from "./database-engine.js";
import { Dispatcher } from "./dispatcher.js";
import { Event, Messenger } from "./messenger.js";
import { Queue } from "./queue.js";
import { JobRegistry } from "./registry.js";
import { defaultQueues, Stoppable } from "./shared.js";

export interface EngineStats {
  workers: {
    total: number;
    available: number;
    running: number;
  };
  queues: {
    name: string;
    concurrency: number;
    priority: number;
    runningJobs: number;
  }[];
  jobs: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
  };
  system: {
    uptime: number;
    isHealthy: boolean;
    registeredQueues: number;
    instanceId: string;
    startedAt: string; // ISO
    nodeVersion: string;
    staleJobsDeadlineMs: number;
    registeredJobs: {
      total: number;
      events: number;
      crons: number;
    };
  };
}

export interface EngineHealthStatus {
  healthy: boolean;
  timestamp: Date;
  checks: {
    database: { healthy: boolean; latencyMs?: number; error?: string };
    workers: { healthy: boolean; available: number; total: number };
    queues: { healthy: boolean; activeQueues: number; issues?: string[] };
    memory: { healthy: boolean; queueSize: number; maxQueueSize: number };
    performance: {
      healthy: boolean;
      avgJobDurationMs?: number;
      p95JobDurationMs?: number;
      throughputPerMin?: number;
      totalJobsProcessed?: number;
    };
  };
  overall: {
    status: "healthy" | "degraded" | "unhealthy";
    issues: string[];
  };
}

export interface EngineOptions {
  databaseAdapter: DatabaseAdapter;
  queues?: QueueConfig[];
  maxWorkers?: number;
  staleJobsDeadlineMs?: number;
  instanceId?: string;
  /** Telemetry hook: called for engine-level events (errors, dropped/dead-lettered jobs, ...). */
  onEvent?: EngineEventListener;
}

export class Engine extends Stoppable implements Chatter {
  // A live job renews its lease every Dispatcher.heartbeatIntervalMs (30s), so this only needs
  // to catch orphaned jobs (crashed process, dead instance) — kept short instead of a long default.
  static readonly defaultStaleJobsDeadlineMs = 5 * 60 * 1000;

  queues: Queue[];
  private dispatcher: Dispatcher;
  protected databaseEngine: DatabaseEngine;
  private startTime: Date;
  private apiHelper: ApiHelper;
  private isRunning: boolean;
  private completedJobs = 0;
  private failedJobs = 0;
  private staleJobsCleanupInterval?: NodeJS.Timeout;
  private staleJobsDeadlineMs: number;
  private instanceId: string;

  // Performance metrics tracking
  private jobStartTimes = new Map<string, number>(); // jobId -> start timestamp
  private jobDurations: number[] = []; // Rolling window of job durations
  private maxMetricsHistory = 1000; // Keep last 1000 job durations

  constructor({
    databaseAdapter,
    queues = defaultQueues,
    maxWorkers,
    staleJobsDeadlineMs,
    instanceId,
    onEvent,
  }: EngineOptions) {
    super();

    this.databaseEngine = new DatabaseEngine({ adapter: databaseAdapter });
    this.staleJobsDeadlineMs = staleJobsDeadlineMs ?? Engine.defaultStaleJobsDeadlineMs;
    this.instanceId = instanceId ?? `${os.hostname()}-${process.pid}`;

    this.queues = queues
      .sort((a, b) => a.priority - b.priority)
      .map((queue) => new Queue(queue, this.databaseEngine, this.instanceId));
    this.dispatcher = new Dispatcher(
      maxWorkers ?? 10,
      this.databaseEngine,
      (jobId, startedAt) => this.trackJobStart(jobId, startedAt),
      onEvent,
    );
    this.startTime = new Date();

    this.waitForStoppable(this.dispatcher);

    this.apiHelper = new ApiHelper(this);
    this.isRunning = false;
  }

  async start() {
    await this.databaseEngine.initialize();

    this.setupEvents();

    await this.cleanupStaleJobs();

    await Promise.all(
      this.queues.map(async (queue) => {
        await queue.start();
      }),
    );

    this.registerQueues();

    await this.dispatcher.start();

    this.isRunning = true;
    void this.healthCheck();

    this.startPeriodicStaleJobsCleanup();

    this.logger.info("Engine started");
  }

  async runCycle() {
    // Engine doesn't implement a periodic cycle by default.
    await Promise.resolve();
  }

  private async cleanupStaleJobs(): Promise<void> {
    try {
      for (const queue of this.queues) {
        const releasedCount = await this.databaseEngine.releaseStaleJobs(
          queue.name,
          this.staleJobsDeadlineMs,
        );
        if (releasedCount > 0) {
          this.logger.warn(`Released ${releasedCount} stale jobs from queue "${queue.name}"`);
        }
      }

      const cleanedLocksCount = await this.databaseEngine.cleanupExpiredLocks();
      if (cleanedLocksCount > 0) {
        this.logger.debug(`Cleaned up ${cleanedLocksCount} expired locks`);
      }
    } catch (error) {
      this.logger.error("Error during stale jobs cleanup:", error);
    }
  }

  private startPeriodicStaleJobsCleanup(): void {
    this.staleJobsCleanupInterval = setInterval(() => {
      if (this.isRunning) {
        void this.cleanupStaleJobs();
      }
    }, this.staleJobsDeadlineMs);
  }

  registerJobs(functions: FunctionDefinition[]) {
    functions.forEach((func) => {
      JobRegistry.register(func);
    });
  }

  private registerQueues(): void {
    for (const queue of this.queues) {
      this.dispatcher.registerQueue(queue);
    }
  }

  setupEvents() {
    Messenger.listen(this, Event.JobCompleted, (job: Job) => {
      this.completedJobs++;
      this.trackJobCompletion(job);
    });

    Messenger.listen(this, Event.JobFailed, (job: Job) => {
      this.failedJobs++;
      this.trackJobCompletion(job); // Track duration even for failed jobs
    });

    Messenger.listen(this, Event.JobSuspended, (job: Job) => {
      // A suspension is neither a completion nor a failure: just discard the in-flight start
      // time so it doesn't linger in jobStartTimes or skew durations on the eventual resume.
      this.jobStartTimes.delete(job.id);
    });

    // Note: Job start times are tracked when jobs transition to processing status
    // This would require integration with dispatcher to call trackJobStart()
  }

  private trackJobCompletion(job: Job): void {
    const startTime = this.jobStartTimes.get(job.id);
    if (startTime && job.completedAt) {
      const duration = job.completedAt.getTime() - startTime;
      this.jobDurations.push(duration);

      if (this.jobDurations.length > this.maxMetricsHistory) {
        this.jobDurations.shift();
      }

      this.jobStartTimes.delete(job.id);
    }
  }

  // Called when job starts processing - public for dispatcher integration
  trackJobStart(jobId: string, startTime: Date): void {
    this.jobStartTimes.set(jobId, startTime.getTime());
  }

  private calculateAverageJobDuration(): number {
    if (this.jobDurations.length === 0) return 0;
    const sum = this.jobDurations.reduce((acc, duration) => acc + duration, 0);
    return Math.round(sum / this.jobDurations.length);
  }

  private calculatePercentile(percentile: number): number {
    if (this.jobDurations.length === 0) return 0;

    const sorted = [...this.jobDurations].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return Math.round(sorted[Math.max(0, index)] || 0);
  }

  getPerformanceMetrics() {
    return {
      totalJobs: this.completedJobs + this.failedJobs,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      successRate:
        this.completedJobs + this.failedJobs > 0
          ? Math.round((this.completedJobs / (this.completedJobs + this.failedJobs)) * 100)
          : 0,
      avgDurationMs: this.calculateAverageJobDuration(),
      p50DurationMs: this.calculatePercentile(50),
      p95DurationMs: this.calculatePercentile(95),
      p99DurationMs: this.calculatePercentile(99),
      throughputPerMin: this.calculateThroughput(),
      activeJobs: this.jobStartTimes.size,
      queuedJobs: this.dispatcher.getStats().queuedJobs,
    };
  }

  private calculateThroughput(): number {
    const uptimeMinutes = (Date.now() - this.startTime.getTime()) / (1000 * 60);
    return uptimeMinutes > 0 ? Math.round((this.completedJobs / uptimeMinutes) * 100) / 100 : 0;
  }

  get conn(): DatabaseEngine {
    return this.databaseEngine;
  }

  async addJob<T extends Payload>(
    jobCode: string,
    payload: T,
    options?: Partial<{ delayUntil?: Date; priority?: number; maxAttempts?: number }>,
  ): Promise<string> {
    return await this.dispatcher.enqueueJob(jobCode, payload, options);
  }

  async healthCheck(): Promise<boolean> {
    const detailedHealth = await this.getDetailedHealthStatus();
    return detailedHealth.healthy;
  }

  async getDetailedHealthStatus(): Promise<EngineHealthStatus> {
    const timestamp = new Date();
    const issues: string[] = [];

    const dbStart = Date.now();
    let databaseCheck;
    try {
      const dbHealth = await this.databaseEngine.healthCheck();
      const latencyMs = Date.now() - dbStart;
      databaseCheck = {
        healthy: dbHealth.healthy,
        latencyMs,
        error: dbHealth.message,
      };
      if (!dbHealth.healthy) {
        issues.push(`Database unhealthy: ${dbHealth.message}`);
      }
      if (latencyMs > 1000) {
        issues.push(`Database high latency: ${latencyMs}ms`);
      }
    } catch (error) {
      databaseCheck = {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
      issues.push(`Database check failed: ${databaseCheck.error}`);
    }

    const dispatcherStats = this.dispatcher.getStats();
    const workersCheck = {
      healthy: dispatcherStats.totalWorkers > 0 && dispatcherStats.availableWorkers > 0,
      available: dispatcherStats.availableWorkers,
      total: dispatcherStats.totalWorkers,
    };
    if (dispatcherStats.totalWorkers === 0) {
      issues.push("No workers available");
    } else if (dispatcherStats.availableWorkers === 0) {
      issues.push("All workers busy");
    }

    const queueIssues: string[] = [];
    for (const queue of this.queues) {
      const queueStats = queue.getStats();
      if (queueStats.runningJobs >= queueStats.concurrency) {
        queueIssues.push(`Queue ${queue.name} at capacity`);
      }
    }
    const queuesCheck = {
      healthy: queueIssues.length === 0,
      activeQueues: this.queues.length,
      issues: queueIssues.length > 0 ? queueIssues : undefined,
    };
    issues.push(...queueIssues);

    const maxQueueSize = 1000;
    const memoryCheck = {
      healthy: dispatcherStats.queuedJobs < maxQueueSize * 0.8, // Warning at 80%
      queueSize: dispatcherStats.queuedJobs,
      maxQueueSize,
    };
    if (dispatcherStats.queuedJobs >= maxQueueSize * 0.8) {
      issues.push(`Job queue near capacity: ${dispatcherStats.queuedJobs}/${maxQueueSize}`);
    }

    const uptimeMinutes = (Date.now() - this.startTime.getTime()) / (1000 * 60);
    const throughputPerMin = uptimeMinutes > 0 ? this.completedJobs / uptimeMinutes : 0;

    // Calculate job duration percentiles
    const avgJobDurationMs = this.calculateAverageJobDuration();
    const p95JobDurationMs = this.calculatePercentile(95);

    const performanceCheck = {
      healthy: avgJobDurationMs < 30000, // Jobs should complete within 30s on average
      avgJobDurationMs,
      p95JobDurationMs,
      throughputPerMin: Math.round(throughputPerMin * 100) / 100,
      totalJobsProcessed: this.completedJobs + this.failedJobs,
    };

    if (avgJobDurationMs > 30000) {
      issues.push(`High average job duration: ${Math.round(avgJobDurationMs)}ms`);
    }

    // Overall status determination
    let overallStatus: "healthy" | "degraded" | "unhealthy";
    if (!databaseCheck.healthy || dispatcherStats.totalWorkers === 0) {
      overallStatus = "unhealthy";
    } else if (issues.length > 0) {
      overallStatus = "degraded";
    } else {
      overallStatus = "healthy";
    }

    return {
      healthy: overallStatus === "healthy",
      timestamp,
      checks: {
        database: databaseCheck,
        workers: workersCheck,
        queues: queuesCheck,
        memory: memoryCheck,
        performance: performanceCheck,
      },
      overall: {
        status: overallStatus,
        issues,
      },
    };
  }

  async gracefullyShutdown() {
    if (this.halted) {
      this.logger.debug("Engine already halted");
      return;
    }

    this.logger.debug("Gracefully shutting down engine...");
    Messenger.emit(Event.GracefullyShutdown);

    while (!this.stopped) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }

    this.logger.info("Engine stopped");
  }

  async shutdown() {
    this.logger.info("Engine shutting down...");

    if (this.staleJobsCleanupInterval) {
      clearInterval(this.staleJobsCleanupInterval);
      this.staleJobsCleanupInterval = undefined;
    }

    await this.dispatcher.shutdown();

    await this.databaseEngine.shutdown();

    this.logger.info("Engine shutdown completed");
    return Promise.resolve();
  }

  async getStats(): Promise<EngineStats> {
    const dispatcherStats = this.dispatcher.getStats();
    const queueStats = this.queues.map((queue) => queue.getStats());

    return {
      workers: {
        total: dispatcherStats.totalWorkers,
        available: dispatcherStats.availableWorkers,
        running: dispatcherStats.totalWorkers - dispatcherStats.availableWorkers,
      },
      queues: queueStats,
      jobs: {
        queued: dispatcherStats.queuedJobs,
        processing: dispatcherStats.totalWorkers - dispatcherStats.availableWorkers,
        completed: this.completedJobs,
        failed: this.failedJobs,
      },
      system: {
        uptime: Date.now() - this.startTime.getTime(),
        isHealthy: await this.healthCheck(),
        registeredQueues: this.queues.length,
        instanceId: this.instanceId,
        startedAt: this.startTime.toISOString(),
        nodeVersion: process.version,
        staleJobsDeadlineMs: this.staleJobsDeadlineMs,
        registeredJobs: {
          total: JobRegistry.allJobs.length,
          events: JobRegistry.allAsyncJobs.length,
          crons: JobRegistry.allCronJobs.length,
        },
      },
    };
  }

  get api(): ApiHelper {
    return this.apiHelper;
  }

  get isHealthy() {
    return this.healthCheck();
  }
}
