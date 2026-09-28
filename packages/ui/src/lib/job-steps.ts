import type { JobDetail, JobStep } from "../types.js";

/** JSON text above this length is not rendered inline — see `isLargeResult`. */
export const LARGE_RESULT_CHARS = 200_000;

export interface StepRow {
  key: string;
  attempt: number;
  name: string;
  kind: "run" | "sendEvent" | "sleep";
  status: "running" | "completed" | "failed";
  startedAt: string;
  durationMs: number | null;
  replayedFrom: number | null;
  /** The persisted result: for a replay, the original step's (same name, attempt = replayedFrom). */
  result: unknown;
  hasResult: boolean;
  error: string | null;
  /** For a `sendEvent` step whose result is `{ jobId }`: the child job id, else null. */
  childJobId: string | null;
}

export function stepKey(attempt: number, name: string): string {
  return `${attempt}:${name}`;
}

/** The attempt prefix of a step key: names may themselves contain ":" (e.g. "Retrieve order:2"). */
export function attemptFromStepKey(key: string): number {
  return Number(key.slice(0, key.indexOf(":")));
}

function isJobIdResult(value: unknown): value is { jobId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobId" in value &&
    typeof (value as { jobId: unknown }).jobId === "string"
  );
}

/**
 * The result a step row shows: its own for a real run, or the original run's for a replay (same
 * name, attempt === replayedFrom). A replay whose original is missing (inconsistent data) resolves
 * to `undefined` rather than throwing.
 */
function resolveResult(step: JobStep, steps: JobStep[]): unknown {
  if (step.replayedFrom === undefined) return step.result;
  const original = steps.find(
    (s) => s.name === step.name && (s.attempt ?? 1) === step.replayedFrom,
  );
  return original?.result;
}

/**
 * Rows for the Steps panel, built from `job.steps` (the flat list — includes `sendEvent` entries
 * and replay traces, unlike the timeline's per-attempt `attempts[]`). Sorted by attempt ascending,
 * then `startedAt` ascending, stable on ties.
 */
export function buildStepRows(job: JobDetail): StepRow[] {
  const steps = job.steps ?? [];

  return steps
    .map((step, index) => {
      const attempt = step.attempt ?? 1;
      const kind = step.kind ?? "run";
      const replayedFrom = step.replayedFrom ?? null;
      const result = resolveResult(step, steps);
      const hasResult = result !== undefined && result !== null;
      const childJobId = kind === "sendEvent" && isJobIdResult(result) ? result.jobId : null;
      const row: StepRow = {
        key: stepKey(attempt, step.name),
        attempt,
        name: step.name,
        kind,
        status: step.status,
        startedAt: step.startedAt,
        durationMs: step.duration ?? null,
        replayedFrom,
        result,
        hasResult,
        error: step.error ?? null,
        childJobId,
      };
      return { row, index };
    })
    .sort((a, b) => {
      if (a.row.attempt !== b.row.attempt) return a.row.attempt - b.row.attempt;
      const aTime = Date.parse(a.row.startedAt);
      const bTime = Date.parse(b.row.startedAt);
      if (aTime !== bTime) return aTime - bTime;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * JSON text as every JSON block of the dashboard shows it: a JSON-looking string is parsed and
 * pretty-printed, any other string passes through as-is, an object gets a 2-space indent, and
 * "Unable to display this value." replaces a value `JSON.stringify` can't serialize. `null`/
 * `undefined` return "" (the caller renders the empty state).
 */
export function stringifyJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unable to display this value.";
  }
}

export function isLargeResult(text: string): boolean {
  return text.length > LARGE_RESULT_CHARS;
}

/** "1.2 MB" / "340 KB" / "812 B" from a character count (UTF-16 units, good enough for a label). */
export function formatResultSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${Math.round(chars / 1024)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}
