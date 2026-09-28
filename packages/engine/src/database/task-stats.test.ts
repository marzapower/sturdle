import { describe, expect, it } from "vitest";

import type { FinishedJobRow } from "./task-stats.js";
import { aggregateTaskStats, buildHourBuckets, emptyTaskStats } from "./task-stats.js";

const NOW = new Date("2026-09-17T10:20:00.000Z");

const row = (overrides: Partial<FinishedJobRow> & Pick<FinishedJobRow, "code" | "status">) => ({
  createdAt: NOW,
  ...overrides,
});

describe("buildHourBuckets", () => {
  it("returns exactly hoursBack entries, oldest first, truncated to the hour in UTC", () => {
    const buckets = buildHourBuckets(3, NOW);

    expect(buckets).toEqual([
      "2026-09-17T08:00:00.000Z",
      "2026-09-17T09:00:00.000Z",
      "2026-09-17T10:00:00.000Z",
    ]);
  });

  it("the last entry is the hour containing now", () => {
    const buckets = buildHourBuckets(24, NOW);

    expect(buckets.at(-1)).toBe("2026-09-17T10:00:00.000Z");
    expect(buckets).toHaveLength(24);
  });
});

describe("emptyTaskStats", () => {
  it("returns zero counts, null p95 and a hoursBack-entry zero series", () => {
    const stats = emptyTaskStats(24, NOW);

    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.p95DurationMs).toBeNull();
    expect(stats.series).toHaveLength(24);
    expect(stats.series.every((entry) => entry.completed === 0 && entry.failed === 0)).toBe(true);
    expect(stats.series[0]?.hour).toBe(buildHourBuckets(24, NOW)[0]);
  });
});

describe("aggregateTaskStats", () => {
  it("counts completed and failed jobs per code", () => {
    const rows: FinishedJobRow[] = [
      row({ code: "a", status: "completed", completedAt: NOW }),
      row({ code: "a", status: "completed", completedAt: NOW }),
      row({ code: "a", status: "failed", failedAt: NOW }),
      row({ code: "b", status: "failed", failedAt: NOW }),
    ];

    const stats = aggregateTaskStats(rows, 24, NOW);

    const a = stats.find((s) => s.code === "a");
    const b = stats.find((s) => s.code === "b");
    expect(a).toMatchObject({ completed: 2, failed: 1 });
    expect(b).toMatchObject({ completed: 0, failed: 1 });
  });

  it("sorts the result by code", () => {
    const rows: FinishedJobRow[] = [
      row({ code: "zeta", status: "completed", completedAt: NOW }),
      row({ code: "alpha", status: "completed", completedAt: NOW }),
    ];

    const stats = aggregateTaskStats(rows, 24, NOW);

    expect(stats.map((s) => s.code)).toEqual(["alpha", "zeta"]);
  });

  it("bucketizes finishedAt into UTC hours matching buildHourBuckets", () => {
    const rows: FinishedJobRow[] = [
      row({ code: "a", status: "completed", completedAt: new Date("2026-09-17T09:45:00.000Z") }),
    ];

    const stats = aggregateTaskStats(rows, 3, NOW);
    const buckets = buildHourBuckets(3, NOW);

    const a = stats.find((s) => s.code === "a");
    const bucketIndex = buckets.indexOf("2026-09-17T09:00:00.000Z");
    expect(a?.series[bucketIndex]).toEqual({
      hour: "2026-09-17T09:00:00.000Z",
      completed: 1,
      failed: 0,
    });
  });

  it("uses completedAt for completed jobs and failedAt for failed jobs, falling back to the other", () => {
    const rows: FinishedJobRow[] = [
      // completed but only failedAt is set (data anomaly) -> falls back to failedAt.
      row({ code: "a", status: "completed", failedAt: NOW }),
      // failed but only completedAt is set -> falls back to completedAt.
      row({ code: "b", status: "failed", completedAt: NOW }),
    ];

    const stats = aggregateTaskStats(rows, 24, NOW);

    expect(stats.find((s) => s.code === "a")?.completed).toBe(1);
    expect(stats.find((s) => s.code === "b")?.failed).toBe(1);
  });

  it("computes p95 over strictly positive durations, null when there is none", () => {
    const startedAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    const rows: FinishedJobRow[] = [
      row({ code: "a", status: "completed", startedAt, completedAt: NOW }),
      // zero/negative duration is excluded from the percentile.
      row({ code: "a", status: "completed", startedAt: NOW, completedAt: NOW }),
    ];

    const stats = aggregateTaskStats(rows, 24, NOW);

    expect(stats.find((s) => s.code === "a")?.p95DurationMs).toBe(10 * 60 * 1000);

    const noPositiveDuration = aggregateTaskStats(
      [row({ code: "b", status: "completed", startedAt: NOW, completedAt: NOW })],
      24,
      NOW,
    );
    expect(noPositiveDuration.find((s) => s.code === "b")?.p95DurationMs).toBeNull();
  });

  it("falls back to createdAt when startedAt is missing for the duration calculation", () => {
    const createdAt = new Date(NOW.getTime() - 5 * 60 * 1000);
    const rows: FinishedJobRow[] = [
      row({ code: "a", status: "completed", createdAt, completedAt: NOW }),
    ];

    const stats = aggregateTaskStats(rows, 24, NOW);

    expect(stats.find((s) => s.code === "a")?.p95DurationMs).toBe(5 * 60 * 1000);
  });

  it("ignores rows with a missing finishedAt", () => {
    const rows: FinishedJobRow[] = [row({ code: "a", status: "completed" })];

    const stats = aggregateTaskStats(rows, 24, NOW);

    expect(stats).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(aggregateTaskStats([], 24, NOW)).toEqual([]);
  });

  it("ignores a row finished before the oldest bucket start, even though it's within now - hoursBack", () => {
    // Oldest bucket for hoursBack=2 at NOW (10:20) starts at 09:00. A job that finished at 08:50
    // is inside "now - 2h" (08:20) as a raw window, but before the oldest bucket start: ignored.
    const rows: FinishedJobRow[] = [
      row({ code: "a", status: "completed", completedAt: new Date("2026-09-17T08:50:00.000Z") }),
    ];

    const stats = aggregateTaskStats(rows, 2, NOW);

    expect(stats).toEqual([]);
  });

  it("invariant: sum(series) === completed + failed for every code, across many rows", () => {
    const rows: FinishedJobRow[] = [];
    for (let i = 0; i < 50; i++) {
      const minutesAgo = i * 30; // spread across the whole 24h window and beyond
      const finishedAt = new Date(NOW.getTime() - minutesAgo * 60 * 1000);
      rows.push(
        row({
          code: "a",
          status: i % 3 === 0 ? "failed" : "completed",
          startedAt: new Date(finishedAt.getTime() - 60_000),
          completedAt: i % 3 === 0 ? undefined : finishedAt,
          failedAt: i % 3 === 0 ? finishedAt : undefined,
        }),
      );
    }

    const stats = aggregateTaskStats(rows, 24, NOW);
    const a = stats.find((s) => s.code === "a");
    if (!a) throw new Error("expected stats for code 'a'");

    const seriesSum = a.series.reduce((sum, entry) => sum + entry.completed + entry.failed, 0);
    expect(seriesSum).toBe(a.completed + a.failed);
  });
});
