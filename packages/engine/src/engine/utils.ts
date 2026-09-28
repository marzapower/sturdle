import cronParser from "cron-parser";

const TZ_PREFIX_PATTERN = /^TZ=(\S+)\s+(.+)$/;

/**
 * Splits a cron expression into its schedule and timezone, supporting the `TZ=<zone> <cron>`
 * prefix (e.g. "TZ=Europe/Rome 30 9 * * THU"). Without the prefix the timezone defaults to UTC.
 */
export const parseCronExpression = (cron: string): { expression: string; tz: string } => {
  const match = TZ_PREFIX_PATTERN.exec(cron.trim());
  if (match) {
    const [, tz, expression] = match;
    return { expression: (expression ?? "").trim(), tz: (tz ?? "").trim() };
  }

  return { expression: cron.trim(), tz: "UTC" };
};

export const getNextCronRun = (cron: string, currentDate: Date = new Date()) => {
  const { expression, tz } = parseCronExpression(cron);
  const interval = cronParser.parseExpression(expression, {
    currentDate,
    tz,
  });
  return interval.next().toDate();
};
