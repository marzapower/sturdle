import type { DotStatus } from "../components/StatusDot.js";
import type { JobDetail, JobStep } from "../types.js";
import { stepKey } from "./job-steps.js";
import { jobPath } from "./paths.js";

/** Any idle gap longer than this multiple of the median step duration is a candidate for compression. */
const GAP_COMPRESSION_MULTIPLIER = 10;
/**
 * ...but only if it is also longer than this floor: exponential backoffs (1s, 2s, 4s… capped at 5 min)
 * must stay visible as waits, only really long idle stretches (delayed jobs, stale promotions) collapse.
 */
const GAP_COMPRESSION_MIN_MS = 30_000;
/**
 * Width a compressed gap keeps on the axis, as a fraction of the time that stays uncompressed, so a
 * break never dominates a short job (the component enforces a minimum pixel width on top of this).
 */
const COMPRESSED_GAP_FRACTION = 0.06;

export type TimelineSegmentKind = "queued" | "step" | "backoff" | "child";
export type TimelineLaneKind = "queued" | "attempt" | "backoff" | "child";

export interface TimelineSegment {
  kind: TimelineSegmentKind;
  id: string;
  label: string;
  status?: "running" | "completed" | "failed" | "pending";
  /** Position and width on the compressed axis (gaps collapsed), in ms. */
  startMs: number;
  endMs: number;
  /** Real duration, unaffected by gap compression — this is what gets displayed in mono. */
  durationMs: number;
  error?: string | null;
  href?: string;
  ariaLabel: string;
  /** Only on `kind: "step"`: the key shared with the Steps panel (`stepKey(attempt, name)`). */
  stepKey?: string;
  /** Only on a replayed step: the attempt whose result was reused. */
  replayedFrom?: number | null;
}

export interface TimelineLane {
  kind: TimelineLaneKind;
  id: string;
  label: string;
  attempt?: number;
  status?: "running" | "completed" | "failed" | "pending";
  dotStatus?: DotStatus;
  segments: TimelineSegment[];
  /** For a child lane, the attempt number of the step that spawned it, so the UI nests it below. */
  parentAttempt?: number;
  href?: string;
  error?: string | null;
  retryAt?: string | null;
  nonRetriable?: boolean;
}

export interface TimelineTick {
  /** Position on the compressed axis, in ms. */
  ms: number;
  label: string;
}

export interface TimelineGapBreak {
  /** Position on the compressed axis where the break sits, in ms. */
  atMs: number;
  /** Compressed width the break occupies on the axis, in ms. */
  widthMs: number;
  /** The real, uncompressed duration of the gap — shown in the break's label. */
  realGapMs: number;
}

export interface TimelineModel {
  hasTimingInfo: boolean;
  /** Total width of the compressed axis, in ms. */
  totalMs: number;
  /** Real wall-clock span from job creation to its end (or `now`), unaffected by compression. */
  realTotalMs: number;
  lanes: TimelineLane[];
  ticks: TimelineTick[];
  gaps: TimelineGapBreak[];
  attemptsCount: number;
  isDeadLetter: boolean;
  usesLegacyFallback: boolean;
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/** A real-time interval (ms relative to the timeline's zero), used to compute idle gaps. */
interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function findIdleGaps(coverage: Interval[], realEnd: number): Interval[] {
  const merged = mergeIntervals(coverage);
  const gaps: Interval[] = [];
  const first = merged[0];
  if (first && first.start > 0) gaps.push({ start: 0, end: first.start });
  for (let i = 0; i < merged.length - 1; i++) {
    const current = merged[i];
    const next = merged[i + 1];
    if (current && next && next.start > current.end) {
      gaps.push({ start: current.end, end: next.start });
    }
  }
  const last = merged[merged.length - 1];
  if (last && realEnd > last.end) gaps.push({ start: last.end, end: realEnd });
  return gaps;
}

/** A raw, real-time-positioned segment, before gap compression is applied to its axis position. */
interface RawSegment extends Omit<TimelineSegment, "startMs" | "endMs"> {
  realStart: number;
  realEnd: number;
  laneId: string;
}

interface RawLane extends Omit<TimelineLane, "segments"> {
  segments: RawSegment[];
}

function stepDuration(step: JobStep, realStart: number, realEnd: number): number {
  // Clamped to 0: data persisted before per-attempt merging existed can carry a step whose
  // timestamps don't fall within its attempt's own window (see the "legacy step timestamps" test) —
  // never let that surface as a negative duration or a negative-width bar.
  // `realEnd` is already clamped to `now` by the callers: a sleep step still in progress carries
  // its full planned `duration`, so the elapsed span wins whenever it is shorter.
  const elapsed = realEnd - realStart;
  const raw = typeof step.duration === "number" ? Math.min(step.duration, elapsed) : elapsed;
  return Math.max(raw, 0);
}

/** Clamps a segment's real end so it's never before its start — see `stepDuration` above. */
function clampEnd(realStart: number, realEnd: number): number {
  return Math.max(realEnd, realStart);
}

function buildAriaLabel(
  name: string,
  durationMs: number,
  status?: string,
  error?: string | null,
): string {
  const parts = [name, formatMsForAria(durationMs)];
  if (status) parts.push(status);
  if (error) parts.push(error);
  return parts.join(", ");
}

function formatMsForAria(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Builds the pure data model behind the job detail's execution timeline: one lane per attempt (plus
 * queued time and child jobs nested under the attempt that spawned them), with idle gaps longer than
 * 10x the median step duration (and longer than 30s) collapsed to a fixed width on the axis.
 *
 * Degrades gracefully when the job detail hasn't got the per-attempt `attempts`/`children` fields
 * yet: it falls back to a single legacy lane built from `steps` and `attemptHistory`.
 */
export function buildTimelineModel(detail: JobDetail, now: number): TimelineModel {
  const zero = toMs(detail.createdAt) ?? toMs(detail.attempts?.[0]?.startedAt);

  if (zero === null) {
    return {
      hasTimingInfo: false,
      totalMs: 0,
      realTotalMs: 0,
      lanes: [],
      ticks: [],
      gaps: [],
      attemptsCount: 0,
      isDeadLetter: false,
      usesLegacyFallback: false,
    };
  }

  const isTerminal = detail.status === "completed" || detail.status === "failed";
  const realEnd = (isTerminal ? toMs(detail.completedAt) : null) ?? now;
  const rel = (ms: number | null): number => (ms === null ? 0 : ms - zero);

  const rawLanes: RawLane[] = [];
  const rawSegments: RawSegment[] = [];

  const usesLegacyFallback = !detail.attempts || detail.attempts.length === 0;

  if (!usesLegacyFallback && detail.attempts) {
    const attempts = detail.attempts;
    const firstAttempt = attempts[0];
    const firstAttemptStart = firstAttempt ? toMs(firstAttempt.startedAt) : null;

    // Queued lane: from job creation to the first attempt's start.
    if (firstAttemptStart !== null && firstAttemptStart > zero) {
      const seg: RawSegment = {
        kind: "queued",
        id: "queued",
        laneId: "queued",
        label: "queued",
        status: "pending",
        realStart: 0,
        realEnd: rel(firstAttemptStart),
        durationMs: rel(firstAttemptStart),
        ariaLabel: buildAriaLabel("Queued", rel(firstAttemptStart)),
      };
      rawSegments.push(seg);
      rawLanes.push({
        kind: "queued",
        id: "queued",
        label: "queued",
        status: "pending",
        dotStatus: "pending",
        segments: [seg],
      });
    }

    attempts.forEach((attempt) => {
      const laneId = `attempt-${attempt.attempt}`;
      const attemptStart = toMs(attempt.startedAt) ?? zero;
      const stepSegments: RawSegment[] = attempt.steps.map((step, stepIndex) => {
        const stepStart = toMs(step.startedAt) ?? attemptStart;
        // A persisted sleep step is `completed` with `completedAt = wakeAt`, which can sit in the
        // future relative to `now` while the job is still asleep: clamp so the bar never overshoots.
        const stepEnd = Math.min(
          toMs(step.completedAt) ?? (step.status === "running" ? realEnd : stepStart),
          now,
        );
        const realStart = rel(stepStart);
        const replayedFrom = step.replayedFrom ?? null;
        let ariaLabel = buildAriaLabel(
          step.name,
          stepDuration(step, stepStart, stepEnd),
          step.status,
          step.error,
        );
        if (replayedFrom !== null) ariaLabel += `, replayed from attempt ${replayedFrom}`;
        return {
          kind: "step",
          id: `${laneId}-step-${stepIndex}`,
          laneId,
          label: step.name,
          status: step.status,
          realStart,
          realEnd: clampEnd(realStart, rel(stepEnd)),
          durationMs: stepDuration(step, stepStart, stepEnd),
          error: step.error ?? null,
          ariaLabel,
          stepKey: stepKey(attempt.attempt, step.name),
          replayedFrom,
        };
      });

      rawSegments.push(...stepSegments);

      const dotStatus: DotStatus =
        attempt.status === "running"
          ? "running"
          : attempt.status === "failed"
            ? "failed"
            : "completed";

      rawLanes.push({
        kind: "attempt",
        id: laneId,
        label: `attempt ${attempt.attempt}`,
        attempt: attempt.attempt,
        status: attempt.status,
        dotStatus,
        segments: stepSegments,
        error: attempt.error,
        retryAt: attempt.retryAt,
        nonRetriable: attempt.nonRetriable,
      });

      // Backoff segment: from this attempt's end to its scheduled retry.
      const endedAt = toMs(attempt.endedAt);
      const retryAt = toMs(attempt.retryAt);
      if (endedAt !== null && retryAt !== null && retryAt > endedAt) {
        const backoffLaneId = `backoff-${attempt.attempt}`;
        const seg: RawSegment = {
          kind: "backoff",
          id: backoffLaneId,
          laneId: backoffLaneId,
          label: "backoff",
          status: "pending",
          realStart: rel(endedAt),
          realEnd: rel(retryAt),
          durationMs: rel(retryAt) - rel(endedAt),
          ariaLabel: buildAriaLabel("Backoff, retry scheduled", rel(retryAt) - rel(endedAt)),
        };
        rawSegments.push(seg);
        rawLanes.push({
          kind: "backoff",
          id: backoffLaneId,
          label: "backoff",
          attempt: attempt.attempt,
          status: "pending",
          dotStatus: "pending",
          segments: [seg],
        });
      }
    });

    // Children, nested under the attempt whose step spawned them.
    for (const child of detail.children ?? []) {
      const spawningAttempt = child.spawnedByStep
        ? attempts.find((a) => a.steps.some((s) => s.name === child.spawnedByStep))?.attempt
        : undefined;
      const childStart = toMs(child.createdAt);
      const childEnd = child.completedAt
        ? toMs(child.completedAt)
        : child.status === "completed" || child.status === "failed"
          ? toMs(child.createdAt)
          : realEnd;
      if (childStart === null) continue;

      const laneId = `child-${child.id}`;
      const childRealStart = rel(childStart);
      const childRealEnd = clampEnd(childRealStart, rel(childEnd ?? realEnd));
      const childDurationMs = childRealEnd - childRealStart;
      const seg: RawSegment = {
        kind: "child",
        id: laneId,
        laneId,
        label: child.name,
        status:
          child.status === "failed"
            ? "failed"
            : child.status === "completed"
              ? "completed"
              : "running",
        realStart: childRealStart,
        realEnd: childRealEnd,
        durationMs: childDurationMs,
        href: jobPath(child.id),
        ariaLabel: buildAriaLabel(`Child job ${child.name}`, childDurationMs, child.status),
      };
      rawSegments.push(seg);
      rawLanes.push({
        kind: "child",
        id: laneId,
        label: child.name,
        parentAttempt: spawningAttempt,
        status: seg.status,
        dotStatus: seg.status as DotStatus,
        segments: [seg],
        href: jobPath(child.id),
      });
    }
  } else {
    // Legacy fallback: no per-attempt data yet, build one lane from the cumulative steps.
    const start = toMs(detail.startedAt);
    const stepSegments: RawSegment[] = (detail.steps ?? []).map((step, stepIndex) => {
      const stepStart = toMs(step.startedAt) ?? start ?? zero;
      const stepEnd = Math.min(
        toMs(step.completedAt) ?? (step.status === "running" ? realEnd : stepStart),
        now,
      );
      const realStart = rel(stepStart);
      const replayedFrom = step.replayedFrom ?? null;
      let ariaLabel = buildAriaLabel(
        step.name,
        stepDuration(step, stepStart, stepEnd),
        step.status,
        step.error,
      );
      if (replayedFrom !== null) ariaLabel += `, replayed from attempt ${replayedFrom}`;
      return {
        kind: "step",
        id: `attempt-${detail.attempt}-step-${stepIndex}`,
        laneId: `attempt-${detail.attempt}`,
        label: step.name,
        status: step.status,
        realStart,
        realEnd: clampEnd(realStart, rel(stepEnd)),
        durationMs: stepDuration(step, stepStart, stepEnd),
        error: step.error ?? null,
        ariaLabel,
        stepKey: stepKey(detail.attempt, step.name),
        replayedFrom,
      };
    });

    if (start !== null && start > zero) {
      const seg: RawSegment = {
        kind: "queued",
        id: "queued",
        laneId: "queued",
        label: "queued",
        status: "pending",
        realStart: 0,
        realEnd: rel(start),
        durationMs: rel(start),
        ariaLabel: buildAriaLabel("Queued", rel(start)),
      };
      rawSegments.push(seg);
      rawLanes.push({
        kind: "queued",
        id: "queued",
        label: "queued",
        status: "pending",
        dotStatus: "pending",
        segments: [seg],
      });
    }

    rawSegments.push(...stepSegments);

    const dotStatus: DotStatus =
      detail.status === "running" || detail.status === "active"
        ? "running"
        : detail.status === "failed"
          ? "failed"
          : "completed";

    rawLanes.push({
      kind: "attempt",
      id: `attempt-${detail.attempt}`,
      label: `attempt ${detail.attempt}`,
      attempt: detail.attempt,
      status:
        detail.status === "failed"
          ? "failed"
          : detail.status === "running"
            ? "running"
            : "completed",
      dotStatus,
      segments: stepSegments,
      error: detail.error,
    });
  }

  const realTotalEnd = Math.max(rel(realEnd), 0, ...rawSegments.map((s) => s.realEnd));

  // Gap compression: collapse the long stretches where nothing worth seeing happens. Everything drawn
  // counts as coverage — including short waits, so a 2 s backoff right before a retry that was only
  // picked up 17 minutes later stays visible instead of being swallowed by the break that follows —
  // except waits that are themselves long (a 15 min queued delay, a 5 min backoff): those are left
  // out of the coverage so they collapse into a break of their own.
  // Replay traces are 0 ms by construction: including them would drag the median toward the
  // compression floor and change how real retries get compressed (see the dedicated test).
  const stepDurations = rawSegments
    .filter((s) => s.kind === "step" && s.replayedFrom == null)
    .map((s) => s.durationMs);
  const medianStepMs = median(stepDurations) ?? 0;
  const isCompressible = (ms: number) =>
    ms > medianStepMs * GAP_COMPRESSION_MULTIPLIER && ms > GAP_COMPRESSION_MIN_MS;
  const isWait = (s: RawSegment) => s.kind === "queued" || s.kind === "backoff";

  const coverage: Interval[] = rawSegments
    .filter((s) => !isWait(s) || !isCompressible(s.realEnd - s.realStart))
    .map((s) => ({ start: s.realStart, end: s.realEnd }));

  const idleGaps = findIdleGaps(coverage, realTotalEnd);
  const compressedGaps = idleGaps
    .filter((gap) => isCompressible(gap.end - gap.start))
    .sort((a, b) => a.start - b.start);

  const compressedRealMs = compressedGaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  const compressedGapMs = Math.max((realTotalEnd - compressedRealMs) * COMPRESSED_GAP_FRACTION, 1);

  // Maps a real-time position to its position on the compressed axis: every compressed gap fully
  // before `realMs` shrinks to its fixed width; a gap `realMs` falls inside shrinks proportionally.
  const compress = (realMs: number): number => {
    let compressed = realMs;
    for (const gap of compressedGaps) {
      if (realMs <= gap.start) continue;
      const gapRealWidth = gap.end - gap.start;
      if (realMs >= gap.end) {
        compressed -= gapRealWidth - compressedGapMs;
      } else {
        const fraction = gapRealWidth === 0 ? 0 : (realMs - gap.start) / gapRealWidth;
        compressed -= gapRealWidth * fraction - compressedGapMs * fraction;
      }
    }
    return compressed;
  };

  const lanes: TimelineLane[] = rawLanes.map((lane) => ({
    ...lane,
    segments: lane.segments.map((seg) => ({
      ...seg,
      startMs: compress(seg.realStart),
      endMs: compress(seg.realEnd),
    })),
  }));

  const gaps: TimelineGapBreak[] = compressedGaps.map((gap) => ({
    atMs: compress(gap.start),
    widthMs: compressedGapMs,
    realGapMs: gap.end - gap.start,
  }));

  const totalMs = Math.max(compress(realTotalEnd), 1);

  const ticks = buildTicks(compressedGaps, realTotalEnd, totalMs, compress);

  const attemptsCount = usesLegacyFallback
    ? detail.attempt
    : (detail.attempts?.length ?? 0) || detail.attempt;

  const isDeadLetter = usesLegacyFallback
    ? detail.status === "failed" && detail.attempt >= detail.maxAttempts
    : (detail.attempts?.some((a) => a.nonRetriable) ?? false) ||
      (detail.status === "failed" && attemptsCount >= detail.maxAttempts);

  return {
    hasTimingInfo: true,
    totalMs,
    realTotalMs: realTotalEnd,
    lanes,
    ticks,
    gaps,
    attemptsCount,
    isDeadLetter,
    usesLegacyFallback,
  };
}

const TARGET_TICK_COUNT = 6;

/**
 * Axis ticks are laid out per uncompressed region (the stretches between collapsed gaps): each region
 * gets a share of the ticks proportional to the width it keeps on the axis, its ticks sit on round
 * real-time values and are labelled with the real elapsed time, so a tick after an "18 min" break
 * reads "18m 1s", never a compressed number.
 */
function buildTicks(
  compressedGaps: Interval[],
  realTotalEnd: number,
  totalMs: number,
  compress: (realMs: number) => number,
): TimelineTick[] {
  const regions: Interval[] = [];
  let cursor = 0;
  for (const gap of compressedGaps) {
    if (gap.start > cursor) regions.push({ start: cursor, end: gap.start });
    cursor = gap.end;
  }
  if (realTotalEnd > cursor) regions.push({ start: cursor, end: realTotalEnd });
  if (regions.length === 0) return [{ ms: 0, label: formatTickLabel(0) }];

  const ticks: TimelineTick[] = [];
  for (const region of regions) {
    const realWidth = region.end - region.start;
    const share = (compress(region.end) - compress(region.start)) / totalMs;
    const targetTicks = Math.max(1, Math.round(TARGET_TICK_COUNT * share));
    const step = niceStep(realWidth / targetTicks);
    // A region that follows a break starts strictly after it: the break already carries its own
    // label, and a tick within half a step of the break would print on top of it. Only a region that really
    // starts at zero gets the "0 ms" tick — a job whose first region comes after a collapsed queued
    // wait must not lay hundreds of ticks across the break.
    const first = region.start === 0 ? 0 : Math.ceil((region.start + step / 2) / step) * step;
    for (let realMs = first; realMs <= region.end; realMs += step) {
      ticks.push({ ms: compress(realMs), label: formatTickLabel(realMs, step) });
    }
  }
  return ticks;
}

function niceStep(rawMs: number): number {
  if (rawMs <= 0) return 1000;
  const steps = [
    100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
    900_000, 1_800_000, 3_600_000,
  ];
  return steps.find((s) => s >= rawMs) ?? steps[steps.length - 1] ?? 3_600_000;
}

/**
 * Real elapsed time at a tick. Sub-second steps keep one decimal on the seconds ("15m 50.5s"), so two
 * neighbouring ticks half a second apart never print the same label.
 */
function formatTickLabel(ms: number, stepMs = 1000): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const subSecond = stepMs < 1000;
  const formatSeconds = (seconds: number) =>
    subSecond ? seconds.toFixed(1).replace(/\.0$/, "") : String(Math.round(seconds));
  if (ms < 60_000) return `${formatSeconds(ms / 1000)}s`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = (ms % 60_000) / 1000;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${formatSeconds(seconds)}s`;
}
