import { describe, expect, it } from "vitest";

import { failedAt, failedWithin, isTerminalJobStatus, normaliseJobStatus } from "./job-status.js";

describe("normaliseJobStatus", () => {
  it("maps a wider status vocabulary onto the dashboard's six kinds", () => {
    expect(normaliseJobStatus("waiting")).toBe("pending");
    expect(normaliseJobStatus("pending")).toBe("pending");
    expect(normaliseJobStatus("processing")).toBe("running");
    expect(normaliseJobStatus("active")).toBe("running");
    expect(normaliseJobStatus("Running")).toBe("running");
    expect(normaliseJobStatus("delayed")).toBe("delayed");
    expect(normaliseJobStatus("completed")).toBe("completed");
    expect(normaliseJobStatus("failed")).toBe("failed");
    expect(normaliseJobStatus("paused")).toBe("paused");
  });

  it("returns null for unknown or missing values", () => {
    expect(normaliseJobStatus("weird")).toBeNull();
    expect(normaliseJobStatus(undefined)).toBeNull();
    expect(normaliseJobStatus(null)).toBeNull();
  });
});

describe("isTerminalJobStatus", () => {
  it("is true only for completed and failed jobs", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    for (const status of ["pending", "waiting", "processing", "active", "delayed", "paused", "x"]) {
      expect(isTerminalJobStatus(status)).toBe(false);
    }
  });
});

describe("failedAt / failedWithin", () => {
  const now = Date.UTC(2026, 8, 18, 12);
  const hour = 3_600_000;

  it("reads the failure time from updatedAt, not the creation timestamp", () => {
    expect(failedAt({ timestamp: now - 48 * hour, updatedAt: now - hour })).toBe(now - hour);
    expect(failedAt({ timestamp: now - 2 * hour })).toBe(now - 2 * hour);
  });

  it("keeps a job created long ago that failed inside the window", () => {
    expect(failedWithin({ timestamp: now - 48 * hour, updatedAt: now - hour }, 24, now)).toBe(true);
  });

  it("drops a job that failed before the window, boundary included", () => {
    expect(failedWithin({ timestamp: now - 30 * hour, updatedAt: now - 25 * hour }, 24, now)).toBe(
      false,
    );
    expect(failedWithin({ timestamp: now - 30 * hour, updatedAt: now - 24 * hour }, 24, now)).toBe(
      true,
    );
  });
});
