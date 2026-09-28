import type { DatabaseEngine } from "./database-engine.js";
import { Event, Messenger } from "./messenger.js";
import { JobRegistry } from "./registry.js";
import { Stoppable } from "./shared.js";
import { getNextCronRun } from "./utils.js";

export class CronScheduler extends Stoppable {
  private static cronInterval = 1000;
  private static lockTtlMs = 120_000;
  private lastScheduledTimes = new Map<string, number>(); // Store seconds timestamp directly
  private databaseEngine: DatabaseEngine;

  constructor(databaseEngine: DatabaseEngine) {
    super();
    this.databaseEngine = databaseEngine;
    this.cycleIntervalMs = CronScheduler.cronInterval;
  }

  async start() {
    this.logger.info("CronScheduler started");

    await this.startCycle();
  }

  async runCycle() {
    for (const cronJob of JobRegistry.allCronJobs) {
      const nextRun = getNextCronRun(cronJob.func.cron!);
      if (nextRun < new Date(new Date().getTime() + CronScheduler.cronInterval)) {
        const lastScheduledSeconds = this.lastScheduledTimes.get(cronJob.code);
        // Compare by second precision to prevent multiple scheduling within the same second
        const nextRunSeconds = Math.floor(nextRun.getTime() / 1000);

        if (lastScheduledSeconds !== nextRunSeconds) {
          // Distributed lock so a single scheduling window is honored across replicas. The
          // lock is intentionally never released: it expires on its own and that expiry is
          // exactly what prevents the double emission within the window.
          const token = await this.databaseEngine.acquireLock(
            `cron:${cronJob.code}:${nextRunSeconds}`,
            CronScheduler.lockTtlMs,
          );
          if (!token) {
            continue;
          }

          this.lastScheduledTimes.set(cronJob.code, nextRunSeconds);
          this.logger.info("Scheduling cron job", cronJob.code);
          Messenger.emit(Event.JobScheduled, cronJob.code);
        }
      }
    }

    await Promise.resolve();
  }

  async shutdown() {
    while (this.running) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    this.logger.info("CronScheduler stopped");
  }
}
