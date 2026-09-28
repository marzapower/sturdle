import { cn } from "../lib/cn.js";

/**
 * Every status the dashboard can show, mapped to the single semantic accent it should render with.
 * Colour marks deviation: what is normal (completed, waiting its turn) stays neutral, what is live
 * takes the accent, what is late is amber, what is broken is red. A healthy engine is the one green.
 * Centralised here so a job's status colour and the engine's health colour never drift apart.
 */
export type DotStatus =
  | "running"
  | "active"
  | "healthy"
  | "completed"
  | "pending"
  | "waiting"
  | "delayed"
  | "degraded"
  | "warning"
  | "failed"
  | "unhealthy"
  | "paused"
  | "neutral";

const STATUS_COLOR: Record<DotStatus, string> = {
  running: "bg-plume",
  active: "bg-plume",
  healthy: "bg-moss",
  completed: "bg-sand-600",
  pending: "bg-sand-400",
  waiting: "bg-sand-400",
  delayed: "bg-amber",
  degraded: "bg-amber",
  warning: "bg-amber",
  failed: "bg-carmine",
  unhealthy: "bg-carmine",
  paused: "bg-sand-600",
  neutral: "bg-sand-600",
};

/** Statuses considered "live" — eligible for the pulsing animation when `pulse` is set. */
const LIVE_STATUSES: ReadonlySet<DotStatus> = new Set(["running", "active", "healthy"]);

export interface StatusDotProps {
  status: DotStatus;
  /** Pulses (motion-safe only) when the status is live (running/active/healthy). Off by default. */
  pulse?: boolean;
  className?: string;
}

/** A small coloured dot for job/engine status — the only status indicator in the app, never a filled card. */
export function StatusDot({ status, pulse = false, className }: StatusDotProps) {
  const shouldPulse = pulse && LIVE_STATUSES.has(status);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        STATUS_COLOR[status],
        shouldPulse && "motion-safe:animate-pulse-dot",
        className,
      )}
    />
  );
}
