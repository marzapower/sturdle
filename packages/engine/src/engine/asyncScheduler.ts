import { type Queue } from "./queue.js";
import { Stoppable } from "./shared.js";

export interface AsyncSchedulerOptions {
  cycleIntervalMs?: number;
}

export class AsyncScheduler extends Stoppable {
  private queues = new Set<Queue>();

  constructor(options: AsyncSchedulerOptions = {}) {
    super();
    this.cycleIntervalMs = options.cycleIntervalMs ?? 1000;
  }

  registerQueue(queue: Queue): void {
    this.queues.add(queue);
    this.logger.info(`Registered queue "${queue.name}" for delayed job polling`);
  }

  unregisterQueue(queue: Queue): void {
    this.queues.delete(queue);
    this.logger.info(`Unregistered queue "${queue.name}" from delayed job polling`);
  }

  async start() {
    this.logger.info("AsyncScheduler started");
    await this.startCycle();
  }

  async runCycle() {
    const now = Date.now();

    for (const queue of this.queues) {
      try {
        const readyJobIds = await queue.getReadyDelayedJobIds(now);
        for (const jobId of readyJobIds) {
          await queue.moveJobToStream(jobId);
          this.logger.info(`Moved delayed job ${jobId} to stream for queue "${queue.name}"`);
        }
      } catch (error) {
        // An uncaught error here would kill the cycle timer forever (Stoppable.startCycle
        // never re-arms after a throw), silently stopping all delayed-job polling.
        this.logger.error(`Error processing delayed jobs for queue "${queue.name}"`, error);
      }
    }
  }

  async shutdown() {
    while (this.running) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    this.logger.info("AsyncScheduler stopped");
  }

  /**
   * Returns the number of ready delayed jobs per queue.
   */
  async getDelayedJobStats(): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    for (const queue of this.queues) {
      const readyJobIds = await queue.getReadyDelayedJobIds(Date.now());
      stats[queue.name] = readyJobIds.length;
    }
    return stats;
  }
}
