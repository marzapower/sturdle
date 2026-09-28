import { describe, expect, it } from "vitest";

import type { JobTypeSummary, TaskStats24h } from "../types.js";
import { formatRate, toFleetRows } from "./fleet.js";

const stats = (completed: number, failed: number): TaskStats24h => ({
  completed,
  failed,
  p95DurationMs: 100,
  series: [{ hour: "2026-09-17T00:00:00.000Z", completed, failed }],
});

const task = (code: string, overrides: Partial<JobTypeSummary> = {}): JobTypeSummary => ({
  code,
  description: overrides.description,
  type: overrides.type ?? "event",
  ...overrides,
});

describe("toFleetRows", () => {
  it("sorts by failed desc first", () => {
    const jobTypes: JobTypeSummary[] = [
      task("a.low-failed", { description: "Low failed", stats24h: stats(10, 1) }),
      task("b.high-failed", { description: "High failed", stats24h: stats(5, 5) }),
      task("d.no-runs", { description: "No runs", stats24h: stats(0, 0) }),
    ];

    expect(toFleetRows(jobTypes).map((row) => row.task.code)).toEqual([
      "b.high-failed",
      "a.low-failed",
      "d.no-runs",
    ]);
  });

  it("breaks a tie on failed by runs desc", () => {
    const jobTypes: JobTypeSummary[] = [
      task("fewer-runs", { description: "Fewer runs", stats24h: stats(4, 1) }),
      task("more-runs", { description: "More runs", stats24h: stats(19, 1) }),
    ];

    expect(toFleetRows(jobTypes).map((row) => row.task.code)).toEqual(["more-runs", "fewer-runs"]);
  });

  it("breaks a tie on failed and runs by name asc", () => {
    const jobTypes: JobTypeSummary[] = [
      task("z.zebra", { description: "Zebra", stats24h: stats(0, 5) }),
      task("a.antelope", { description: "Antelope", stats24h: stats(0, 5) }),
    ];

    expect(toFleetRows(jobTypes).map((row) => row.task.code)).toEqual(["a.antelope", "z.zebra"]);
  });

  it("gives failed count priority over run volume", () => {
    const jobTypes: JobTypeSummary[] = [
      task("many-runs", { description: "Many runs", stats24h: stats(100, 0) }),
      task("one-failure", { description: "One failure", stats24h: stats(0, 1) }),
    ];

    expect(toFleetRows(jobTypes).map((row) => row.task.code)).toEqual(["one-failure", "many-runs"]);
  });

  it("falls back to the code when there is no description, for both sorting and identity", () => {
    const jobTypes: JobTypeSummary[] = [
      task("zzz.code-only", { stats24h: stats(1, 0) }),
      task("aaa.code-only", { stats24h: stats(1, 0) }),
    ];

    expect(toFleetRows(jobTypes).map((row) => row.task.code)).toEqual([
      "aaa.code-only",
      "zzz.code-only",
    ]);
  });

  it("treats a missing stats24h as a task with no runs, no failures and a null success rate", () => {
    const rows = toFleetRows([task("no-stats")]);

    expect(rows).toEqual([
      { task: rows[0]?.task, stats: null, runs: 0, failed: 0, successRate: null },
    ]);
  });

  it("gives a null success rate at zero runs even when stats24h is present", () => {
    const rows = toFleetRows([task("idle", { stats24h: stats(0, 0) })]);

    expect(rows[0]?.successRate).toBeNull();
    expect(rows[0]?.runs).toBe(0);
  });

  it("computes the success rate as a 0-100 percentage over completed + failed", () => {
    const rows = toFleetRows([task("mixed", { stats24h: stats(3, 1) })]);

    expect(rows[0]?.runs).toBe(4);
    expect(rows[0]?.successRate).toBe(75);
  });
});

describe("formatRate", () => {
  it("renders whole numbers at the extremes", () => {
    expect(formatRate(100)).toBe("100%");
    expect(formatRate(0)).toBe("0%");
  });

  it("renders one decimal in between", () => {
    expect(formatRate(99.1)).toBe("99.1%");
  });

  it("caps just under 100% just below rounding to 100.0%", () => {
    expect(formatRate(99.96)).toBe("99.9%");
  });
});
