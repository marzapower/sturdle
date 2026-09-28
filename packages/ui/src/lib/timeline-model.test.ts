import { describe, expect, it } from "vitest";

import type { JobDetail } from "../types.js";
import type { TimelineLane, TimelineModel } from "./timeline-model.js";
import { buildTimelineModel } from "./timeline-model.js";

/** Finds a lane by id, throwing (rather than a banned non-null assertion) when it's missing. */
function getLane(model: TimelineModel, id: string): TimelineLane {
  const lane = model.lanes.find((l) => l.id === id);
  if (!lane) throw new Error(`Expected a lane with id "${id}"`);
  return lane;
}

const BASE_TIME = new Date("2026-09-11T12:00:00.000Z").getTime();
const iso = (offsetMs: number) => new Date(BASE_TIME + offsetMs).toISOString();

function baseDetail(overrides: Partial<JobDetail>): JobDetail {
  return {
    id: "job-1",
    jobId: "job-1",
    name: "Send email",
    code: "email/send",
    queue: "default",
    status: "completed",
    data: {},
    config: {},
    result: null,
    error: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    startedAt: BASE_TIME,
    completedAt: BASE_TIME + 1000,
    attempt: 1,
    maxAttempts: 3,
    priority: 0,
    parentJobId: null,
    childJobIds: [],
    attemptHistory: [],
    logs: [],
    steps: [],
    duration: 1000,
    concurrencyKey: null,
    concurrencyLimit: null,
    ...overrides,
  };
}

describe("buildTimelineModel", () => {
  it("reports no timing info when the job has no createdAt and no attempts", () => {
    const detail = baseDetail({ createdAt: null, startedAt: null, attempts: undefined });
    const model = buildTimelineModel(detail, BASE_TIME + 5000);
    expect(model.hasTimingInfo).toBe(false);
    expect(model.lanes).toHaveLength(0);
  });

  it("builds a single completed attempt lane for a job that succeeded on the first try", () => {
    const detail = baseDetail({
      status: "completed",
      attempt: 1,
      completedAt: BASE_TIME + 4100,
      attempts: [
        {
          attempt: 1,
          status: "completed",
          startedAt: iso(0),
          endedAt: iso(4100),
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(0),
              completedAt: iso(4100),
              duration: 4100,
              status: "completed",
              attempt: 1,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 10_000);

    expect(model.hasTimingInfo).toBe(true);
    expect(model.usesLegacyFallback).toBe(false);
    expect(model.attemptsCount).toBe(1);
    expect(model.isDeadLetter).toBe(false);

    const attemptLane = getLane(model, "attempt-1");
    expect(attemptLane.status).toBe("completed");
    expect(attemptLane.segments).toHaveLength(1);
    const [segment] = attemptLane.segments;
    expect(segment?.durationMs).toBe(4100);
    expect(segment?.startMs).toBe(0);
    expect(segment?.endMs).toBe(4100);

    // No queued lane: the attempt started exactly at createdAt.
    expect(model.lanes.some((lane) => lane.kind === "queued")).toBe(false);
    expect(model.gaps).toHaveLength(0);
  });

  it("builds three attempt lanes with backoff segments and marks a dead letter", () => {
    const detail = baseDetail({
      status: "failed",
      attempt: 3,
      maxAttempts: 3,
      completedAt: BASE_TIME + 3_050,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          startedAt: iso(0),
          endedAt: iso(50),
          error: "SMTP timeout",
          retryAt: iso(1_050),
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(0),
              completedAt: iso(50),
              duration: 50,
              status: "failed",
              error: "SMTP timeout",
              attempt: 1,
            },
          ],
        },
        {
          attempt: 2,
          status: "failed",
          startedAt: iso(1_050),
          endedAt: iso(1_100),
          error: "SMTP timeout",
          retryAt: iso(2_100),
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(1_050),
              completedAt: iso(1_100),
              duration: 50,
              status: "failed",
              error: "SMTP timeout",
              attempt: 2,
            },
          ],
        },
        {
          attempt: 3,
          status: "failed",
          startedAt: iso(2_100),
          endedAt: iso(3_050),
          error: "SMTP timeout",
          retryAt: null,
          nonRetriable: true,
          steps: [
            {
              name: "send-email",
              startedAt: iso(2_100),
              completedAt: iso(3_050),
              duration: 950,
              status: "failed",
              error: "SMTP timeout",
              attempt: 3,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 10_000);

    const attemptLanes = model.lanes.filter((lane) => lane.kind === "attempt");
    expect(attemptLanes.map((lane) => lane.attempt)).toEqual([1, 2, 3]);

    const backoffLanes = model.lanes.filter((lane) => lane.kind === "backoff");
    expect(backoffLanes).toHaveLength(2);
    expect(backoffLanes.map((lane) => lane.id)).toEqual(["backoff-1", "backoff-2"]);

    expect(model.isDeadLetter).toBe(true);
    expect(model.attemptsCount).toBe(3);

    // Attempts are ordered on the axis: attempt 2 starts after attempt 1's backoff ends.
    const lane1 = getLane(model, "attempt-1");
    const lane2 = getLane(model, "attempt-2");
    expect(lane2.segments[0]?.startMs).toBeGreaterThan(lane1.segments[0]?.endMs ?? Infinity);
  });

  it("nests a child job under the attempt whose step spawned it", () => {
    const detail = baseDetail({
      status: "completed",
      attempt: 1,
      completedAt: BASE_TIME + 4_000,
      attempts: [
        {
          attempt: 1,
          status: "completed",
          startedAt: iso(0),
          endedAt: iso(4_000),
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "notify",
              startedAt: iso(0),
              completedAt: iso(500),
              duration: 500,
              status: "completed",
              attempt: 1,
            },
          ],
        },
      ],
      children: [
        {
          id: "child-1",
          name: "notify-user",
          code: "notify/send",
          status: "completed",
          createdAt: iso(500),
          startedAt: iso(600),
          completedAt: iso(920),
          spawnedByStep: "notify",
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 10_000);

    const childLane = model.lanes.find((lane) => lane.kind === "child");
    expect(childLane).toBeDefined();
    expect(childLane?.parentAttempt).toBe(1);
    expect(childLane?.href).toBe("/jobs/child-1");
    expect(childLane?.segments[0]?.durationMs).toBe(420);
  });

  it("compresses an idle gap longer than 10x the median step duration and over 30s", () => {
    const detail = baseDetail({
      status: "failed",
      attempt: 2,
      maxAttempts: 3,
      completedAt: BASE_TIME + 18 * 60_000 + 4_100,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          startedAt: iso(0),
          endedAt: iso(100),
          error: "SMTP timeout",
          // Retry was scheduled quickly, but the delayed-job promotion actually fired 18 minutes later.
          retryAt: iso(1_100),
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(0),
              completedAt: iso(100),
              duration: 100,
              status: "failed",
              error: "SMTP timeout",
              attempt: 1,
            },
          ],
        },
        {
          attempt: 2,
          status: "failed",
          startedAt: iso(18 * 60_000 + 1_100),
          endedAt: iso(18 * 60_000 + 4_100),
          error: "SMTP timeout",
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(18 * 60_000 + 1_100),
              completedAt: iso(18 * 60_000 + 4_100),
              duration: 3_000,
              status: "failed",
              error: "SMTP timeout",
              attempt: 2,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 20 * 60_000);

    // The whole wait between the two executions (backoff included) collapses into one break.
    expect(model.gaps).toHaveLength(1);
    // The 1s backoff before the break counts as coverage, so the gap starts where the backoff ends.
    expect(model.gaps[0]?.realGapMs).toBe(18 * 60_000);
    // The break keeps 6% of the uncompressed time (100 ms + 3 s of steps) on the axis.
    expect(model.gaps[0]?.widthMs).toBeCloseTo(4_100 * 0.06, 5);

    // The compressed axis must be dramatically shorter than the real 18-minute span.
    expect(model.totalMs).toBeLessThan(20_000);

    // Ticks after the break are labelled with the real elapsed time, not the compressed one.
    const labels = model.ticks.map((tick) => tick.label);
    expect(labels[0]).toBe("0ms");
    expect(labels.some((label) => label.startsWith("18m"))).toBe(true);
    expect(model.ticks.every((tick) => tick.ms >= 0 && tick.ms <= model.totalMs)).toBe(true);
  });

  it("collapses a long queued wait before the first attempt even when steps are tiny", () => {
    const detail = baseDetail({
      status: "completed",
      attempt: 1,
      maxAttempts: 3,
      completedAt: BASE_TIME + 15 * 60_000 + 50,
      attempts: [
        {
          attempt: 1,
          status: "completed",
          startedAt: iso(15 * 60_000),
          endedAt: iso(15 * 60_000 + 50),
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(15 * 60_000),
              completedAt: iso(15 * 60_000 + 50),
              duration: 50,
              status: "completed",
              attempt: 1,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 16 * 60_000);

    const queued = getLane(model, "queued");
    expect(queued.segments[0]?.durationMs).toBe(15 * 60_000);
    expect(model.gaps).toHaveLength(1);
    expect(model.gaps[0]?.realGapMs).toBe(15 * 60_000);
    expect(model.realTotalMs).toBe(15 * 60_000 + 50);
    // No "0 ms" tick and no pile of ticks across the collapsed wait: the break carries its own label.
    expect(model.ticks.length).toBeLessThan(10);
    const breakWidth = model.gaps[0]?.widthMs ?? 0;
    expect(model.ticks.every((tick) => tick.ms >= breakWidth)).toBe(true);
    // The queued bar keeps its real duration but only the break's width on the axis.
    expect(queued.segments[0]?.endMs).toBeCloseTo(model.gaps[0]?.widthMs ?? -1, 5);
    expect(model.totalMs).toBeLessThan(100);
  });

  it("keeps a short backoff visible when its retry was only picked up minutes later", () => {
    // Attempt 2 fails at 1.83s, the engine schedules the retry 2.3s later, but the job is only
    // picked up 17 minutes after that (engine restart): the 2.3s backoff must stay on the axis and
    // the break must start where the backoff ends, not where attempt 2's step ended.
    const attempt3Start = 18 * 60_000;
    const detail = baseDetail({
      status: "failed",
      attempt: 3,
      maxAttempts: 3,
      completedAt: BASE_TIME + attempt3Start + 1,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          startedAt: iso(0),
          endedAt: iso(1),
          error: "Template not found",
          retryAt: iso(1_830),
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(0),
              completedAt: iso(1),
              duration: 1,
              status: "failed",
              error: "Template not found",
              attempt: 1,
            },
          ],
        },
        {
          attempt: 2,
          status: "failed",
          startedAt: iso(1_830),
          endedAt: iso(1_831),
          error: "Template not found",
          retryAt: iso(4_131),
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(1_830),
              completedAt: iso(1_831),
              duration: 1,
              status: "failed",
              error: "Template not found",
              attempt: 2,
            },
          ],
        },
        {
          attempt: 3,
          status: "failed",
          startedAt: iso(attempt3Start),
          endedAt: iso(attempt3Start + 1),
          error: "Template not found",
          retryAt: null,
          nonRetriable: true,
          steps: [
            {
              name: "send-email",
              startedAt: iso(attempt3Start),
              completedAt: iso(attempt3Start + 1),
              duration: 1,
              status: "failed",
              error: "Template not found",
              attempt: 3,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + attempt3Start + 10_000);

    expect(model.gaps).toHaveLength(1);
    expect(model.gaps[0]?.realGapMs).toBe(attempt3Start - 4_131);

    const backoff2 = getLane(model, "backoff-2").segments[0];
    expect(backoff2).toBeDefined();
    expect((backoff2?.endMs ?? 0) - (backoff2?.startMs ?? 0)).toBeCloseTo(2_300, 0);
    // The break sits right where the backoff ends.
    expect(model.gaps[0]?.atMs).toBeCloseTo(backoff2?.endMs ?? -1, 0);
  });

  it("extends a running attempt's lane up to `now` and does not mark it as a dead letter", () => {
    const detail = baseDetail({
      status: "running",
      attempt: 1,
      completedAt: null,
      attempts: [
        {
          attempt: 1,
          status: "running",
          startedAt: iso(0),
          endedAt: null,
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(0),
              status: "running",
              attempt: 1,
            },
          ],
        },
      ],
    });

    const now = BASE_TIME + 3_000;
    const model = buildTimelineModel(detail, now);

    expect(model.isDeadLetter).toBe(false);
    const attemptLane = getLane(model, "attempt-1");
    expect(attemptLane.segments[0]?.endMs).toBe(3_000);
    expect(attemptLane.status).toBe("running");
  });

  it("tolerates a pre-merge step whose timestamps fall outside its attempt's own window", () => {
    // Real-world case (job 3779fd02…, persisted before the per-attempt merge existed): the single
    // step attributed to attempt 1 started at 20:50:55, six seconds AFTER attempt 1's own endedAt
    // (20:50:49) — data that predates `mergeByAttempt`. The model must not produce a negative
    // duration or width for this, only draw the step wherever it chronologically falls.
    const detail = baseDetail({
      status: "failed",
      attempt: 1,
      maxAttempts: 3,
      completedAt: BASE_TIME + 6_000,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          startedAt: iso(0),
          endedAt: iso(1_000), // 20:50:49-equivalent
          error: "SMTP timeout",
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              // 20:50:55-equivalent — after this attempt's own endedAt.
              name: "send-email",
              startedAt: iso(6_000),
              completedAt: iso(6_500),
              duration: 500,
              status: "failed",
              error: "SMTP timeout",
              attempt: 1,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 10_000);

    const attemptLane = getLane(model, "attempt-1");
    const [segment] = attemptLane.segments;
    expect(segment).toBeDefined();
    expect(segment?.durationMs).toBe(500);
    expect(segment?.durationMs).toBeGreaterThanOrEqual(0);
    expect(segment?.startMs).toBeLessThanOrEqual(segment?.endMs ?? -Infinity);
    expect(Number.isNaN(segment?.startMs)).toBe(false);
    expect(Number.isNaN(segment?.endMs)).toBe(false);
    expect(model.totalMs).toBeGreaterThan(0);
    expect(Number.isNaN(model.totalMs)).toBe(false);
  });

  it("clamps a step whose completedAt precedes its startedAt to a zero, not negative, duration", () => {
    const detail = baseDetail({
      status: "failed",
      attempt: 1,
      maxAttempts: 3,
      completedAt: BASE_TIME + 2_000,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          startedAt: iso(0),
          endedAt: iso(2_000),
          error: "clock skew",
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "send-email",
              startedAt: iso(1_000),
              completedAt: iso(500), // before its own startedAt
              status: "failed",
              error: "clock skew",
              attempt: 1,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 5_000);

    const attemptLane = getLane(model, "attempt-1");
    const [segment] = attemptLane.segments;
    expect(segment?.durationMs).toBe(0);
    expect(segment?.startMs).toBeLessThanOrEqual(segment?.endMs ?? -Infinity);
    expect(Number.isNaN(segment?.durationMs)).toBe(false);
  });

  it("clamps a step's completedAt to now when it sits in the future (a persisted sleep's wakeAt)", () => {
    const wakeAt = BASE_TIME + 60 * 60_000; // the sleep step wakes up an hour from BASE_TIME
    const detail = baseDetail({
      status: "delayed",
      attempt: 1,
      completedAt: null,
      attempts: [
        {
          attempt: 1,
          status: "running",
          startedAt: iso(0),
          endedAt: null,
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "sleep-until-tomorrow",
              startedAt: iso(0),
              completedAt: new Date(wakeAt).toISOString(),
              // The dispatcher persists the full planned sleep as `duration` at suspend time.
              duration: 60 * 60_000,
              status: "completed",
              attempt: 1,
              kind: "sleep",
            },
          ],
        },
      ],
    });

    // `now` is well before wakeAt: the job is still asleep.
    const now = BASE_TIME + 3_000;
    const model = buildTimelineModel(detail, now);

    const attemptLane = getLane(model, "attempt-1");
    const [segment] = attemptLane.segments;
    expect(segment?.endMs).toBe(3_000);
    expect(segment?.endMs).toBeLessThanOrEqual(model.totalMs);
    // The label follows the bar: elapsed time so far, not the planned hour.
    expect(segment?.durationMs).toBe(3_000);
  });

  it("falls back to a single legacy lane when the API has not shipped `attempts` yet", () => {
    const detail = baseDetail({
      status: "completed",
      attempt: 1,
      attempts: undefined,
      children: undefined,
      steps: [
        {
          name: "send-email",
          startedAt: iso(0),
          completedAt: iso(1_000),
          duration: 1_000,
          status: "completed",
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 5_000);

    expect(model.hasTimingInfo).toBe(true);
    expect(model.usesLegacyFallback).toBe(true);
    expect(model.lanes.some((lane) => lane.id === "attempt-1")).toBe(true);
    expect(model.lanes.find((lane) => lane.id === "attempt-1")?.segments).toHaveLength(1);
  });

  it("sets stepKey and replayedFrom on step segments (attempts branch)", () => {
    const detail = baseDetail({
      status: "completed",
      attempt: 2,
      completedAt: BASE_TIME + 2_000,
      attempts: [
        {
          attempt: 1,
          status: "failed",
          startedAt: iso(0),
          endedAt: iso(500),
          error: "boom",
          retryAt: iso(600),
          nonRetriable: false,
          steps: [
            {
              name: "Retrieve plan",
              startedAt: iso(0),
              completedAt: iso(500),
              duration: 500,
              status: "completed",
              attempt: 1,
            },
          ],
        },
        {
          attempt: 2,
          status: "completed",
          startedAt: iso(700),
          endedAt: iso(2_000),
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "Retrieve plan",
              startedAt: iso(700),
              completedAt: iso(700),
              duration: 0,
              status: "completed",
              attempt: 2,
              replayedFrom: 1,
            },
            {
              name: "Send emails",
              startedAt: iso(700),
              completedAt: iso(2_000),
              duration: 1_300,
              status: "completed",
              attempt: 2,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 5_000);

    const attempt1Segment = getLane(model, "attempt-1").segments[0];
    expect(attempt1Segment?.stepKey).toBe("1:Retrieve plan");
    expect(attempt1Segment?.replayedFrom).toBeNull();
    expect(attempt1Segment?.ariaLabel.endsWith("replayed from attempt 1")).toBe(false);

    const attempt2 = getLane(model, "attempt-2");
    const replaySegment = attempt2.segments.find((s) => s.label === "Retrieve plan");
    expect(replaySegment?.stepKey).toBe("2:Retrieve plan");
    expect(replaySegment?.replayedFrom).toBe(1);
    expect(replaySegment?.ariaLabel.endsWith(", replayed from attempt 1")).toBe(true);

    const realSegment = attempt2.segments.find((s) => s.label === "Send emails");
    expect(realSegment?.stepKey).toBe("2:Send emails");
    expect(realSegment?.replayedFrom).toBeNull();
  });

  it("sets stepKey using detail.attempt in the legacy fallback branch", () => {
    const detail = baseDetail({
      status: "completed",
      attempt: 3,
      attempts: undefined,
      children: undefined,
      steps: [
        {
          name: "send-email",
          startedAt: iso(0),
          completedAt: iso(1_000),
          duration: 1_000,
          status: "completed",
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 5_000);

    const segment = getLane(model, "attempt-3").segments[0];
    expect(segment?.stepKey).toBe("3:send-email");
    expect(segment?.replayedFrom).toBeNull();
  });

  it("excludes replay traces from the gap-compression median", () => {
    // 3 real steps of 5s each (median 5s, threshold 50s) plus 20 zero-duration replay traces at the
    // same instant (no real gap of their own). A 40s gap sits strictly between the 30s floor and the
    // clean 50s threshold: it must stay uncompressed. If the replay traces polluted the median down
    // to 0, the threshold would collapse to the 30s floor and this same gap would wrongly compress.
    const replayTraces = Array.from({ length: 20 }, (_, i) => ({
      name: `replay-${i}`,
      startedAt: iso(10_000),
      completedAt: iso(10_000),
      duration: 0,
      status: "completed" as const,
      attempt: 1,
      replayedFrom: 1,
    }));

    const detail = baseDetail({
      status: "completed",
      attempt: 1,
      completedAt: BASE_TIME + 55_000,
      attempts: [
        {
          attempt: 1,
          status: "completed",
          startedAt: iso(0),
          endedAt: iso(55_000),
          error: null,
          retryAt: null,
          nonRetriable: false,
          steps: [
            {
              name: "s1",
              startedAt: iso(0),
              completedAt: iso(5_000),
              duration: 5_000,
              status: "completed",
              attempt: 1,
            },
            {
              name: "s2",
              startedAt: iso(5_000),
              completedAt: iso(10_000),
              duration: 5_000,
              status: "completed",
              attempt: 1,
            },
            ...replayTraces,
            {
              name: "s3",
              startedAt: iso(50_000),
              completedAt: iso(55_000),
              duration: 5_000,
              status: "completed",
              attempt: 1,
            },
          ],
        },
      ],
    });

    const model = buildTimelineModel(detail, BASE_TIME + 60_000);

    // The 40s idle stretch between s2/traces (ending at 10s) and s3 (starting at 50s) is not
    // compressed: correctly computed, the median (5s) sets a 50s threshold above the 40s gap.
    expect(model.gaps).toHaveLength(0);
  });
});
