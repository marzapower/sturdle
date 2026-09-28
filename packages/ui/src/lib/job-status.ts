/**
 * The dashboard's job status vocabulary. A host API may speak a wider one ("waiting",
 * "processing", "active"…): normalise with `normaliseJobStatus` before comparing, so a
 * "pending" job is never mistaken for a terminal one because a set only listed "waiting".
 */
export type JobStatusKind = "pending" | "running" | "delayed" | "completed" | "failed" | "paused";

const STATUS_ALIASES: Record<string, JobStatusKind> = {
  pending: "pending",
  waiting: "pending",
  queued: "pending",
  running: "running",
  active: "running",
  processing: "running",
  delayed: "delayed",
  scheduled: "delayed",
  completed: "completed",
  success: "completed",
  failed: "failed",
  error: "failed",
  paused: "paused",
};

export function normaliseJobStatus(status: string | null | undefined): JobStatusKind | null {
  if (!status) return null;
  return STATUS_ALIASES[status.toLowerCase()] ?? null;
}

/** Completed and failed jobs never change again; everything else (including unknown words) may still move. */
export function isTerminalJobStatus(status: string | null | undefined): boolean {
  const kind = normaliseJobStatus(status);
  return kind === "completed" || kind === "failed";
}

/**
 * When a failed job failed. `updatedAt` is written when the job turns failed; `finishedOn` stays null
 * on a failed job and `timestamp` is its creation time, so neither can stand in for it.
 */
export function failedAt(job: { updatedAt?: number; timestamp: number }): number {
  return job.updatedAt ?? job.timestamp;
}

/** Whether a failed job failed within the last `hours` hours, measured from `now` (ms). */
export function failedWithin(
  job: { updatedAt?: number; timestamp: number },
  hours: number,
  now: number,
): boolean {
  return now - failedAt(job) <= hours * 3_600_000;
}
