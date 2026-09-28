import { describe, expect, it } from "vitest";

import type { JobDetail, JobStep } from "../types.js";
import {
  attemptFromStepKey,
  buildStepRows,
  formatResultSize,
  isLargeResult,
  LARGE_RESULT_CHARS,
  stepKey,
  stringifyJson,
} from "./job-steps.js";

const BASE_TIME = new Date("2026-09-21T12:00:00.000Z").getTime();
const iso = (offsetMs: number) => new Date(BASE_TIME + offsetMs).toISOString();

function baseDetail(steps: JobStep[]): JobDetail {
  return {
    id: "job-1",
    jobId: "job-1",
    name: "Send daily report",
    code: "report/daily",
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
    steps,
    duration: 1000,
    concurrencyKey: null,
    concurrencyLimit: null,
  };
}

describe("stepKey / attemptFromStepKey", () => {
  it("joins attempt and name with a colon", () => {
    expect(stepKey(2, "Retrieve order")).toBe("2:Retrieve order");
  });

  it("reads the attempt prefix even when the name itself contains a colon", () => {
    expect(attemptFromStepKey(stepKey(2, "Retrieve order:2"))).toBe(2);
    expect(attemptFromStepKey("2:Retrieve order:2")).toBe(2);
  });
});

describe("buildStepRows", () => {
  it("sorts rows by attempt ascending, then startedAt ascending", () => {
    const detail = baseDetail([
      { name: "b", startedAt: iso(500), status: "completed", attempt: 2 },
      { name: "a", startedAt: iso(0), status: "completed", attempt: 1 },
      { name: "c", startedAt: iso(100), status: "completed", attempt: 1 },
    ]);

    const rows = buildStepRows(detail);

    expect(rows.map((r) => r.name)).toEqual(["a", "c", "b"]);
  });

  it("keeps original order on a tie (stable sort)", () => {
    const detail = baseDetail([
      { name: "first", startedAt: iso(0), status: "completed", attempt: 1 },
      { name: "second", startedAt: iso(0), status: "completed", attempt: 1 },
    ]);

    const rows = buildStepRows(detail);

    expect(rows.map((r) => r.name)).toEqual(["first", "second"]);
  });

  it("defaults kind to 'run' when absent", () => {
    const detail = baseDetail([{ name: "a", startedAt: iso(0), status: "completed", attempt: 1 }]);

    expect(buildStepRows(detail)[0]?.kind).toBe("run");
  });

  it("defaults attempt to 1 for a legacy step with no attempt/kind", () => {
    const detail = baseDetail([{ name: "a", startedAt: iso(0), status: "completed" }]);

    const [row] = buildStepRows(detail);
    expect(row?.attempt).toBe(1);
    expect(row?.key).toBe("1:a");
    expect(row?.kind).toBe("run");
  });

  it("resolves a replay's result from the original step it points at", () => {
    const detail = baseDetail([
      {
        name: "Retrieve order",
        startedAt: iso(0),
        status: "completed",
        attempt: 1,
        result: { orderId: "o1" },
      },
      {
        name: "Retrieve order",
        startedAt: iso(1000),
        status: "completed",
        attempt: 2,
        duration: 0,
        replayedFrom: 1,
      },
    ]);

    const rows = buildStepRows(detail);
    const replay = rows.find((r) => r.attempt === 2);

    expect(replay?.replayedFrom).toBe(1);
    expect(replay?.result).toEqual({ orderId: "o1" });
    expect(replay?.hasResult).toBe(true);
  });

  it("resolves an orphan replay (no matching original) to no result, without throwing", () => {
    const detail = baseDetail([
      {
        name: "Retrieve order",
        startedAt: iso(0),
        status: "completed",
        attempt: 2,
        duration: 0,
        replayedFrom: 1,
      },
    ]);

    expect(() => buildStepRows(detail)).not.toThrow();
    const [row] = buildStepRows(detail);
    expect(row?.result).toBeUndefined();
    expect(row?.hasResult).toBe(false);
  });

  it("extracts childJobId from a sendEvent step whose result is { jobId }", () => {
    const detail = baseDetail([
      {
        name: "sendEvent:report/weekly",
        startedAt: iso(0),
        status: "completed",
        attempt: 1,
        kind: "sendEvent",
        result: { jobId: "job-42" },
      },
    ]);

    expect(buildStepRows(detail)[0]?.childJobId).toBe("job-42");
  });

  it("leaves childJobId null for a sendEvent whose result is not a { jobId }, and for non-sendEvent steps", () => {
    const detail = baseDetail([
      {
        name: "sendEvent:report/weekly",
        startedAt: iso(0),
        status: "completed",
        attempt: 1,
        kind: "sendEvent",
        result: { ok: true },
      },
      {
        name: "run-step",
        startedAt: iso(100),
        status: "completed",
        attempt: 1,
        result: { jobId: "job-42" },
      },
    ]);

    const rows = buildStepRows(detail);
    expect(rows.every((r) => r.childJobId === null)).toBe(true);
  });

  it("treats a null result as no result", () => {
    const detail = baseDetail([
      { name: "a", startedAt: iso(0), status: "completed", attempt: 1, result: null },
    ]);

    const [row] = buildStepRows(detail);
    expect(row?.hasResult).toBe(false);
  });
});

describe("stringifyJson", () => {
  it("pretty-prints an object with a 2-space indent", () => {
    expect(stringifyJson({ a: 1, b: [2, 3] })).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
  });

  it("parses and pretty-prints a JSON-looking string", () => {
    expect(stringifyJson('{"a":1}')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("passes a plain, non-JSON string through as-is", () => {
    expect(stringifyJson("just some text")).toBe("just some text");
  });

  it("returns '' for null and undefined", () => {
    expect(stringifyJson(null)).toBe("");
    expect(stringifyJson(undefined)).toBe("");
  });

  it("falls back to a message when JSON.stringify throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyJson(circular)).toBe("Unable to display this value.");
  });
});

describe("isLargeResult", () => {
  it("is false at and below the threshold, true above it", () => {
    expect(isLargeResult("a".repeat(LARGE_RESULT_CHARS))).toBe(false);
    expect(isLargeResult("a".repeat(LARGE_RESULT_CHARS + 1))).toBe(true);
  });
});

describe("formatResultSize", () => {
  it("formats bytes below 1 KB", () => {
    expect(formatResultSize(812)).toBe("812 B");
  });

  it("formats kilobytes without a decimal", () => {
    expect(formatResultSize(340 * 1024)).toBe("340 KB");
  });

  it("formats megabytes with one decimal", () => {
    expect(formatResultSize(1.2 * 1024 * 1024)).toBe("1.2 MB");
  });
});
