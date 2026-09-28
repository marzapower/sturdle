/** Formatting helpers shared across the dashboard — relative time, duration, short ids. */

/**
 * Relative time following the dashboard's copy rules: "12s ago", "3 min ago", "2 h ago", then
 * the date. Accepts a timestamp in ms, an ISO string, or a Date.
 */
export function formatRelative(value: number | string | Date | null | undefined): string {
  if (value === null || value === undefined) return "—";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);

  if (diffSec < 0) return formatFutureRelative(-diffSec);
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} h ago`;

  return formatDate(date);
}

function formatFutureRelative(diffSec: number): string {
  if (diffSec < 60) return `in ${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `in ${diffMin} min`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `in ${diffHour} h`;
  return formatDate(new Date(Date.now() + diffSec * 1000));
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Absolute timestamp for title attributes, so the relative label always has a precise fallback. */
export function formatAbsolute(value: number | string | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Duration in ms as a short human string: "320ms", "4.1s", "2m 03s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;

  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

/** First 8 chars of an id, for compact mono display; pass the full value as the element's `title`. */
export function formatShortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/** Engine uptime, given in milliseconds: "3 d 2 h", "2 h 14 min", "5 min". */
export function formatUptime(uptimeMs: number | null | undefined): string {
  if (uptimeMs == null || !Number.isFinite(uptimeMs) || uptimeMs < 0) return "—";
  const totalMinutes = Math.floor(uptimeMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}
