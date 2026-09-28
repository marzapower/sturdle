import { describe, expect, it, vi } from "vitest";

import { emitEngineEvent, type EngineEvent } from "./telemetry.js";

describe("emitEngineEvent", () => {
  it("does nothing when no listener is given", () => {
    expect(() =>
      emitEngineEvent(undefined, {
        type: "job.dropped",
        jobId: "j1",
        code: "c1",
        reason: "queue-overflow",
      }),
    ).not.toThrow();
  });

  it("calls the listener with the event", () => {
    const listener = vi.fn();
    const event: EngineEvent = {
      type: "job.error",
      jobId: "j1",
      code: "c1",
      attempt: 1,
      error: new Error("boom"),
    };

    emitEngineEvent(listener, event);

    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("logs and swallows the error when the listener itself throws, instead of propagating it", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = vi.fn(() => {
      throw new Error("listener exploded");
    });

    expect(() =>
      emitEngineEvent(listener, {
        type: "job.dead-lettered",
        jobId: "j1",
        code: "c1",
        attempts: 3,
        error: "boom",
      }),
    ).not.toThrow();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("keeps emitting further events after a listener throws once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: EngineEvent[] = [];
    let calls = 0;
    const listener = (event: EngineEvent) => {
      calls++;
      if (calls === 1) {
        throw new Error("listener exploded");
      }
      seen.push(event);
    };

    emitEngineEvent(listener, {
      type: "job.dropped",
      jobId: "j1",
      code: "c1",
      reason: "queue-overflow",
    });
    emitEngineEvent(listener, {
      type: "job.dropped",
      jobId: "j2",
      code: "c1",
      reason: "queue-overflow",
    });

    expect(calls).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.jobId).toBe("j2");

    warnSpy.mockRestore();
  });
});
