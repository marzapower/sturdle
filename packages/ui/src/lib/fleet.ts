import type { JobTypeSummary, TaskStats24h } from "../types.js";

/**
 * One row of the Fleet table: a registered task plus its 24 h outcome. `stats` is null when the
 * caller could not attach `stats24h` (stats not requested, or the aggregation failed upstream) —
 * every derived number stays at its neutral default so the row still renders, just with dashes.
 */
export interface FleetRow {
  task: JobTypeSummary;
  stats: TaskStats24h | null;
  runs: number;
  failed: number;
  /** 0–100, or null when the task did not run in the window. */
  successRate: number | null;
}

function toFleetRow(task: JobTypeSummary): FleetRow {
  const stats = task.stats24h ?? null;
  const runs = stats ? stats.completed + stats.failed : 0;
  return {
    task,
    stats,
    runs,
    failed: stats?.failed ?? 0,
    successRate: stats && runs > 0 ? (stats.completed / runs) * 100 : null,
  };
}

/**
 * The task, not the single job, is the unit of analysis: whoever is failing the most sinks to the
 * top, ties broken by volume, then alphabetically so the order never looks arbitrary.
 */
export function toFleetRows(jobTypes: JobTypeSummary[]): FleetRow[] {
  return jobTypes
    .map(toFleetRow)
    .sort(
      (a, b) =>
        b.failed - a.failed ||
        b.runs - a.runs ||
        (a.task.description ?? a.task.code).localeCompare(b.task.description ?? b.task.code),
    );
}

/** One decimal below 100%, so 99.1% and 100% never look the same; whole numbers otherwise. */
export function formatRate(rate: number): string {
  if (rate === 100 || rate === 0) return `${rate}%`;
  return `${Math.min(rate, 99.9).toFixed(1)}%`;
}
