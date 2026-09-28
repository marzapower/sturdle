import { Logger } from "../logger.js";

import type { Chatter } from "./messenger.js";
import { Event, Messenger } from "./messenger.js";

export abstract class Loggable {
  logger: Logger;
  private loggerCode: string;

  private static getClassName(instance: Loggable): string {
    return `${instance.constructor.name} (${instance.loggerCode})`;
  }

  private static createClassLogger(instance: Loggable): Logger {
    const className = Loggable.getClassName(instance);
    return Logger.ns("Sturdle").tagged(className);
  }

  constructor() {
    this.loggerCode = Math.random().toString(36).substring(2, 6);
    this.logger = Loggable.createClassLogger(this);
  }
}

export abstract class Stoppable extends Loggable implements Chatter {
  protected shuttingDown = false;
  protected stopped = false;
  protected running = false;
  protected cycleInterval: NodeJS.Timeout | null = null;
  protected cycleIntervalMs = 100;

  protected stoppablesToWaitFor: Set<Stoppable> = new Set<Stoppable>();

  constructor() {
    super();
    Messenger.listen(this, Event.GracefullyShutdown, () => void this.stop());
    Messenger.listen(this, Event.StoppableStopped, (stoppable: Stoppable) => {
      if (this == stoppable) {
        return;
      }

      if (this.stoppablesToWaitFor.has(stoppable)) {
        this.stoppablesToWaitFor.delete(stoppable);
      }
    });
  }

  get halted() {
    return this.shuttingDown || this.stopped;
  }

  async stop() {
    this.logger.info("Stopping", this.constructor.name);

    if (this.halted) {
      return;
    }

    if (this.stoppablesToWaitFor.size > 0) {
      while (this.stoppablesToWaitFor.size > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      }
    }

    Messenger.stopListening(this);

    // Clear any running cycle interval
    if (this.cycleInterval) {
      clearTimeout(this.cycleInterval);
      this.cycleInterval = null;
    }

    this.shuttingDown = true;
    Messenger.emit(Event.StoppableStopping, this);
    await this.shutdown();
    this.stopped = true;

    Messenger.emit(Event.StoppableStopped, this);
  }

  async startCycle() {
    if (this.running || this.halted) {
      return;
    }

    this.running = true;
    await this.runCycle();

    if (this.cycleInterval) {
      clearTimeout(this.cycleInterval);
    }

    this.running = false;
    this.cycleInterval = setTimeout(() => {
      void this.startCycle();
    }, this.cycleIntervalMs);
  }

  waitForStoppable(stoppable: Stoppable) {
    this.stoppablesToWaitFor.add(stoppable);
  }

  abstract shutdown(): Promise<void>;

  abstract start(): Promise<void>;

  abstract runCycle(): Promise<void>;
}

export interface QueueConfig {
  name: string;
  concurrency: number;
  priority: number; // Computed automatically from declaration order
}

export const defaultQueues: QueueConfig[] = [
  // { name: "critical", concurrency: 1, priority: 100 }, // Highest priority, 1 task at a time
  // { name: "email", concurrency: 2, priority: 90 }, // High priority, 2 concurrent tasks
  { name: "default", concurrency: 3, priority: 50 }, // Normal priority, 3 concurrent tasks
  // { name: "bulk", concurrency: 5, priority: 10 }, // Low priority, 5 concurrent tasks
] as const;
