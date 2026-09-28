import type { TaskStats } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;

/** A finished (completed|failed) job row, as loaded by an adapter for `aggregateTaskStats`. */
export interface FinishedJobRow {
  code: string;
  status: "completed" | "failed";
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
}

function percentile(sortedValues: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  const clampedIndex = Math.max(0, Math.min(index, sortedValues.length - 1));
  return sortedValues[clampedIndex] ?? 0;
}

function finishedAt(row: FinishedJobRow): Date | null {
  return row.status === "completed"
    ? (row.completedAt ?? row.failedAt ?? null)
    : (row.failedAt ?? row.completedAt ?? null);
}

/**
 * ISO hour strings truncated in UTC, oldest first, exactly `hoursBack` entries; the last entry
 * is the hour containing `now`. Same bucketing as `getHistoricalStats`.
 */
export function buildHourBuckets(hoursBack: number, now: Date = new Date()): string[] {
  const buckets: string[] = [];
  for (let i = hoursBack - 1; i >= 0; i--) {
    const hour = new Date(now.getTime() - i * HOUR_MS);
    hour.setUTCMinutes(0, 0, 0);
    buckets.push(hour.toISOString());
  }
  return buckets;
}

/** Zero stats with a `hoursBack`-entry zero series, for a code with no finished job in the window. */
export function emptyTaskStats(hoursBack: number, now: Date = new Date()): Omit<TaskStats, "code"> {
  return {
    completed: 0,
    failed: 0,
    p95DurationMs: null,
    series: buildHourBuckets(hoursBack, now).map((hour) => ({ hour, completed: 0, failed: 0 })),
  };
}

/**
 * Aggregates finished job rows per code. finishedAt = completedAt when completed, failedAt when
 * failed (falling back to the other one when missing). The window starts at the beginning of the
 * oldest bucket (`buildHourBuckets(...)[0]`), not `now - hoursBack`h: rows whose finishedAt is
 * missing or earlier than that are ignored, so `sum(series) === completed + failed` always holds
 * for every row that is kept. p95 is computed over strictly positive durations
 * (finishedAt - (startedAt ?? createdAt)), null when there is none. Result sorted by `code`.
 */
export function aggregateTaskStats(
  rows: FinishedJobRow[],
  hoursBack: number,
  now: Date = new Date(),
): TaskStats[] {
  const buckets = buildHourBuckets(hoursBack, now);
  const windowStart = new Date(buckets[0] as string);

  const byCode = new Map<string, FinishedJobRow[]>();
  for (const row of rows) {
    const at = finishedAt(row);
    if (!at || at < windowStart) continue;

    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }

  const results: TaskStats[] = [];
  for (const [code, codeRows] of byCode.entries()) {
    const series = buckets.map((hour) => ({ hour, completed: 0, failed: 0 }));
    let completed = 0;
    let failed = 0;
    const durations: number[] = [];

    for (const row of codeRows) {
      const at = finishedAt(row) as Date;
      const startedAt = row.startedAt ?? row.createdAt;
      const durationMs = at.getTime() - startedAt.getTime();
      if (durationMs > 0) durations.push(durationMs);

      // Index by ms offset rather than an ISO-string lookup so every kept row (finishedAt is
      // already >= windowStart) lands in a bucket, keeping sum(series) === completed + failed.
      const index = Math.min(
        hoursBack - 1,
        Math.max(0, Math.floor((at.getTime() - windowStart.getTime()) / HOUR_MS)),
      );
      const bucket = series[index];

      if (row.status === "completed") {
        completed++;
        if (bucket) bucket.completed++;
      } else {
        failed++;
        if (bucket) bucket.failed++;
      }
    }

    durations.sort((a, b) => a - b);
    const p95DurationMs = durations.length > 0 ? percentile(durations, 95) : null;

    results.push({ code, completed, failed, p95DurationMs, series });
  }

  results.sort((a, b) => a.code.localeCompare(b.code));
  return results;
}
