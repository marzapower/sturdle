import { afterEach, describe, expect, it } from "vitest";

import { type FunctionDefinition } from "../types.js";

import { JobRegistry } from "./registry.js";

const buildTask = (overrides: Partial<FunctionDefinition> = {}): FunctionDefinition => ({
  name: "Send Welcome Email",
  func: async () => Promise.resolve({}),
  ...overrides,
});

describe("JobRegistry", () => {
  afterEach(() => {
    JobRegistry.cleanUp();
  });

  it("parameterizes the task name when no event is given", () => {
    JobRegistry.register(buildTask({ name: "Send Welcome Email!" }));

    const definition = JobRegistry.getDefinition("send-welcome-email");
    expect(definition).toBeDefined();
    expect(definition?.code).toBe("send-welcome-email");
    expect(definition?.cron).toBe(false);
  });

  it("removes diacritics when parameterizing", () => {
    JobRegistry.register(buildTask({ name: "Città più bella" }));

    expect(JobRegistry.getDefinition("citta-piu-bella")).toBeDefined();
  });

  it("registers under the event name when provided", () => {
    JobRegistry.register(buildTask({ event: "email/send" }));

    expect(JobRegistry.getDefinition("email/send")).toBeDefined();
  });

  it("registers a valid cron job", () => {
    JobRegistry.register(buildTask({ name: "Nightly report", cron: "0 0 * * *" }));

    const definition = JobRegistry.getDefinition("nightly-report");
    expect(definition?.cron).toBe(true);
    expect(JobRegistry.allCronJobs).toHaveLength(1);
    expect(JobRegistry.allAsyncJobs).toHaveLength(0);
  });

  it("throws when the cron expression is invalid", () => {
    expect(() =>
      JobRegistry.register(buildTask({ name: "Broken cron", cron: "not-a-cron" })),
    ).toThrow(/Invalid cron expression/);
  });

  it("defaults the queue name to 'default'", () => {
    JobRegistry.register(buildTask({ name: "No queue" }));

    expect(JobRegistry.getQueue("no-queue")).toBe("default");
  });

  it("throws from getQueue when the job is not registered", () => {
    expect(() => JobRegistry.getQueue("unknown-job")).toThrow(/not found/);
  });

  it("throws when the task declares an invalid concurrency limit", () => {
    expect(() =>
      JobRegistry.register(buildTask({ name: "Bad concurrency", concurrency: 0 })),
    ).toThrow(/bad-concurrency/);

    expect(() =>
      JobRegistry.register(
        buildTask({ name: "Bad concurrency key", concurrency: { limit: 1.5, key: "orderId" } }),
      ),
    ).toThrow(/bad-concurrency-key/);
  });
});
