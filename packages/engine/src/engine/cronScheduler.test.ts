import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type FunctionDefinition } from "../types.js";

import { InMemoryAdapter } from "../database/in-memory-adapter.js";
import { CronScheduler } from "./cronScheduler.js";
import { DatabaseEngine } from "./database-engine.js";
import { Event, Messenger } from "./messenger.js";
import { JobRegistry } from "./registry.js";

describe("CronScheduler", () => {
  let adapter: InMemoryAdapter;
  let databaseEngine: DatabaseEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    // 500ms before a minute boundary so a "* * * * *" cron's next run falls within the
    // scheduler's 1s lookahead window.
    vi.setSystemTime(new Date("2024-01-01T00:00:59.500Z"));
    adapter = new InMemoryAdapter();
    databaseEngine = new DatabaseEngine({ adapter });
  });

  afterEach(() => {
    JobRegistry.cleanUp();
    vi.useRealTimers();
  });

  const buildCronTask = (cron: string): FunctionDefinition => ({
    name: "Every minute job",
    cron,
    func: async () => Promise.resolve({}),
  });

  it("does not emit JobScheduled when the lock cannot be acquired", async () => {
    JobRegistry.register(buildCronTask("* * * * *"));

    const acquireLockSpy = vi.spyOn(adapter, "acquireLock").mockResolvedValue(null);
    const listener = vi.fn();
    Messenger.listen({}, Event.JobScheduled, listener);

    const scheduler = new CronScheduler(databaseEngine);
    await scheduler.runCycle();

    expect(acquireLockSpy).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    Messenger.unlisten({}, Event.JobScheduled);
  });

  it("does not emit the same scheduling run twice", async () => {
    JobRegistry.register(buildCronTask("* * * * *"));

    const listener = vi.fn();
    const chatter = {};
    Messenger.listen(chatter, Event.JobScheduled, listener);

    const scheduler = new CronScheduler(databaseEngine);
    await scheduler.runCycle();
    await scheduler.runCycle();

    expect(listener).toHaveBeenCalledTimes(1);

    Messenger.unlisten(chatter, Event.JobScheduled);
  });

  it("emits JobScheduled when the lock is acquired", async () => {
    JobRegistry.register(buildCronTask("* * * * *"));

    const listener = vi.fn();
    const chatter = {};
    Messenger.listen(chatter, Event.JobScheduled, listener);

    const scheduler = new CronScheduler(databaseEngine);
    await scheduler.runCycle();

    expect(listener).toHaveBeenCalledWith("every-minute-job");

    Messenger.unlisten(chatter, Event.JobScheduled);
  });
});
