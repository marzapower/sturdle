import type { FunctionDefinition, Payload } from "../types.js";
import { Logger } from "../logger.js";

import { resolveConcurrency } from "./concurrency.js";
import { getNextCronRun } from "./utils.js";

const log = Logger.ns("Sturdle").tagged("Registry");

export interface JobDefinition {
  queueName: string;
  code: string;
  func: FunctionDefinition<Payload>;
  cron: boolean;
}

/**
 * Converts a string to a URL-friendly slug.
 * @param str - The string to parameterize
 * @returns A parameterized string with lowercase, hyphens instead of spaces, and no special characters
 */
function parameterize(str: string): string {
  return (
    str
      .toLowerCase()
      // Remove diacritics (accents)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Replace spaces and special characters with hyphens
      .replace(/[^a-z0-9]+/g, "-")
      // Remove leading and trailing hyphens
      .replace(/^-+|-+$/g, "")
      // Ensure we don't have empty string
      .replace(/^$/, "default")
  );
}

export class JobRegistry {
  private static jobs = new Map<string, JobDefinition>();

  static register<T extends Payload>(task: FunctionDefinition<T>) {
    const parameterizedName = task.event || parameterize(task.name);
    const isCron = Boolean(task.cron);

    if (isCron) {
      this.validateCron(task.cron!);
    }

    resolveConcurrency(task.event || parameterizedName, task.concurrency, {});

    this.jobs.set(task.event || parameterizedName, {
      queueName: task.queue ?? "default",
      code: parameterizedName,
      func: task as FunctionDefinition<Payload>,
      cron: isCron,
    });
  }

  static validateCron(cron: string) {
    if (!cron) {
      throw new Error("Cron is required");
    }

    try {
      getNextCronRun(cron);
    } catch (error) {
      console.error(`Error parsing cron expression "${cron}":`, error);
      throw new Error(`Invalid cron expression: ${cron}`);
    }
  }

  static getDefinition(jobCode: string) {
    log.debug("Getting definition for", jobCode);
    return this.jobs.get(jobCode);
  }

  static getFunction(jobCode: string) {
    return this.getDefinition(jobCode)?.func;
  }

  static getQueue(jobCode: string) {
    const job = this.getDefinition(jobCode);
    if (!job) {
      throw new Error(`Job ${jobCode} not found`);
    }
    return job.queueName;
  }

  static cleanUp() {
    this.jobs.clear();
  }

  static get registry() {
    return this.jobs;
  }

  static get allJobs() {
    return Array.from(this.jobs.values());
  }

  static get allCronJobs() {
    return Array.from(this.jobs.values()).filter((job) => job.cron);
  }

  static get allAsyncJobs() {
    return Array.from(this.jobs.values()).filter((job) => !job.cron);
  }
}
