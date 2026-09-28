/**
 * View-model types for the dashboard components. These describe the shapes the components
 * expect as props (or nested inside them) — not a wire/API contract of any particular
 * backend. A consumer maps its own API responses onto these before rendering.
 */

/** The wider status vocabulary a host job engine may use; narrow it with `normaliseJobStatus`. */
export type JobStatus =
  "waiting" | "active" | "running" | "completed" | "failed" | "delayed" | "paused";

export interface JobLog {
  message: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  system: boolean;
  step?: string;
  /** Which attempt produced this log line. Absent on older data. */
  attempt?: number;
}

export interface JobStep {
  name: string;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  status: "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
  /** Which attempt this step belongs to. Absent on older data. */
  attempt?: number;
  /** Absent = "run" (legacy entries persisted before durable execution). */
  kind?: "run" | "sendEvent" | "sleep";
  /** Attempt whose completed step this entry replays; absent on a real run. */
  replayedFrom?: number;
}

/** One execution attempt of a job, with its own steps — the execution timeline's per-attempt lane. */
export interface JobAttempt {
  attempt: number;
  status: "running" | "completed" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  retryAt: string | null;
  nonRetriable: boolean;
  steps: JobStep[];
}

/** A child job spawned by a step, anchored to the step that spawned it. */
export interface JobChildSummary {
  id: string;
  name: string;
  code: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  spawnedByStep: string | null;
}

export interface JobParentSummary {
  id: string;
  name: string;
  code: string;
  status: JobStatus;
}

export interface AttemptHistoryEntry {
  attempt: number;
  error: string;
  failedAt: string;
  retryAt?: string;
  nonRetriable?: true;
}

export interface JobDetail {
  id: string;
  jobId: string;
  name: string;
  code: string;
  queue: string;
  status: JobStatus;
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  result: string | null;
  error: string | null;

  // Timing information
  createdAt: number | null;
  updatedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;

  // Attempt and retry information
  attempt: number;
  maxAttempts: number;

  // Other metadata
  priority: number;
  parentJobId: string | null;
  childJobIds: string[];
  /** Per-value concurrency key the job holds (e.g. "billing/invoice.sync:<orderId>"), or null if not keyed. */
  concurrencyKey: string | null;
  /** Max jobs allowed to hold `concurrencyKey` at once, or null if not keyed. */
  concurrencyLimit: number | null;

  // Retry information
  attemptHistory: AttemptHistoryEntry[];

  // Logs
  logs: JobLog[];

  // Steps
  steps: JobStep[];

  // Computed fields
  duration: number | null;

  // Per-attempt execution timeline. Optional: a host API that hasn't shipped these fields
  // yet degrades gracefully to a single legacy lane built from `steps`/`attemptHistory`.
  attempts?: JobAttempt[];
  children?: JobChildSummary[];
  parent?: JobParentSummary | null;
}

export interface CronLastRun {
  at: string; // ISO
  status: "pending" | "processing" | "completed" | "failed" | "delayed";
  durationMs: number | null;
}

/** One hour's worth of a task's outcomes, used by `FleetTable`'s inline sparkline and `ActivityChart`. */
export interface TaskStats24hSeriesPoint {
  hour: string;
  completed: number;
  failed: number;
}

/** A task's rolled-up outcome over the last 24 hours, attached to its `FleetRow`. */
export interface TaskStats24h {
  completed: number;
  failed: number;
  p95DurationMs: number | null;
  series: TaskStats24hSeriesPoint[];
}

/** One registered task (event- or cron-triggered), the `FleetTable`/`FleetRow` unit of analysis. */
export interface JobTypeSummary {
  code: string;
  description?: string;
  type?: "event" | "cron";
  cron?: string | null;
  timezone?: string;
  nextRunAt?: string | null;
  lastRun?: CronLastRun | null;
  stats24h?: TaskStats24h;
}

/** One hour (or day, in `ticks="day"` mode) of completed/failed counts — `ActivityChart`'s data prop. */
export interface ActivitySeriesPoint {
  time: string;
  completed: number;
  failed: number;
}
