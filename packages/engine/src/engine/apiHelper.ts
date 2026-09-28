import { type Engine } from "./engine.js";
import { JobRegistry } from "./registry.js";

export class ApiHelper {
  private engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  getRegisteredJobs() {
    return JobRegistry.allJobs;
  }

  get allAsyncJobs() {
    return JobRegistry.allAsyncJobs;
  }

  get allCronJobs() {
    return JobRegistry.allCronJobs;
  }

  get allJobs() {
    return JobRegistry.allJobs;
  }

  get registry() {
    return JobRegistry.registry;
  }

  async addJob(
    jobCode: string,
    payload: Record<string, unknown>,
    options?: Partial<{ delayUntil?: Date; priority?: number; maxAttempts?: number }>,
  ) {
    return this.engine.addJob(jobCode, payload, options);
  }
}
