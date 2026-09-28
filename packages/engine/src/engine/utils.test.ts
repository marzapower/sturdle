import { describe, expect, it } from "vitest";

import { getNextCronRun, parseCronExpression } from "./utils.js";

describe("parseCronExpression", () => {
  it("splits the TZ= prefix from the cron expression", () => {
    expect(parseCronExpression("TZ=Europe/Rome 30 9 * * THU")).toStrictEqual({
      expression: "30 9 * * THU",
      tz: "Europe/Rome",
    });
  });

  it("defaults to UTC when there is no TZ= prefix", () => {
    expect(parseCronExpression("30 9 * * THU")).toStrictEqual({
      expression: "30 9 * * THU",
      tz: "UTC",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseCronExpression("  TZ=Europe/Rome   30 9 * * THU  ")).toStrictEqual({
      expression: "30 9 * * THU",
      tz: "Europe/Rome",
    });
  });
});

describe("getNextCronRun", () => {
  it("resolves a TZ= prefixed cron to the correct UTC instant in summer (DST)", () => {
    const next = getNextCronRun("TZ=Europe/Rome 30 9 * * *", new Date("2026-07-01T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-07-01T07:30:00.000Z");
  });

  it("resolves a TZ= prefixed cron to the correct UTC instant in winter", () => {
    const next = getNextCronRun("TZ=Europe/Rome 30 9 * * *", new Date("2026-01-05T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-01-05T08:30:00.000Z");
  });

  it("behaves as before (UTC) when there is no TZ= prefix", () => {
    const next = getNextCronRun("30 9 * * *", new Date("2026-07-01T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-07-01T09:30:00.000Z");
  });

  it("throws for an invalid timezone", () => {
    expect(() =>
      getNextCronRun("TZ=Not/AZone 30 9 * * *", new Date("2026-07-01T00:00:00Z")),
    ).toThrow();
  });
});
