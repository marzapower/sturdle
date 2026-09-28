import type { LucideIcon } from "lucide-react";
import {
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CirclePause,
  CircleX,
  Clock5,
} from "lucide-react";

import type { JobStatusKind } from "../lib/job-status.js";
import { normaliseJobStatus } from "../lib/job-status.js";
import { cn } from "../lib/cn.js";

export type BadgeStatus = JobStatusKind;

interface StatusMeta {
  label: string;
  icon: LucideIcon;
  /** Spins slowly (motion-safe only) — the "in progress" idiom. */
  spin?: boolean;
  className: string;
}

/**
 * An icon plus a word inside a faint tinted pill with an inset ring. Colour marks deviation:
 * pending and completed are the normal course of a job and stay neutral, running takes the accent,
 * delayed is amber, failed is red. The tint stays at 10% so the pill reads as a label, not a button.
 */
const STATUS_META: Record<BadgeStatus, StatusMeta> = {
  pending: {
    label: "Pending",
    icon: CircleDotDashed,
    className: "bg-sand-600/10 text-sand-400 ring-sand-600/25",
  },
  running: {
    label: "Running",
    icon: CircleDashed,
    spin: true,
    className: "bg-plume/10 text-plume ring-plume/25",
  },
  delayed: {
    label: "Delayed",
    icon: Clock5,
    className: "bg-amber/10 text-amber ring-amber/25",
  },
  completed: {
    label: "Completed",
    icon: CircleCheck,
    className: "bg-sand-600/10 text-sand-400 ring-sand-600/25",
  },
  failed: {
    label: "Failed",
    icon: CircleX,
    className: "bg-carmine/10 text-carmine ring-carmine/25",
  },
  paused: {
    label: "Paused",
    icon: CirclePause,
    className: "bg-sand-600/10 text-sand-400 ring-sand-600/25",
  },
};

const SIZE = {
  sm: { pill: "gap-1 px-2 py-0.5 text-xs", icon: "size-3" },
  md: { pill: "gap-1.5 px-2.5 py-1 text-sm", icon: "size-3.5" },
} as const;

export interface StatusBadgeProps {
  /** A `BadgeStatus` or any raw status word; unknown values render as a neutral pill with the raw word. */
  status: string;
  size?: keyof typeof SIZE;
  /** Overrides the default word, e.g. "Dead letter" for a failed job that won't retry. */
  label?: string;
  className?: string;
}

export function StatusBadge({ status, size = "sm", label, className }: StatusBadgeProps) {
  const normalised = normaliseJobStatus(status);
  const meta = normalised ? STATUS_META[normalised] : null;
  const sizes = SIZE[size];

  if (!meta) {
    return (
      <span
        className={cn(
          "bg-sand-600/10 text-sand-400 ring-sand-600/25 inline-flex select-none items-center whitespace-nowrap rounded-full font-medium leading-none ring-1 ring-inset",
          sizes.pill,
          className,
        )}
      >
        {label ?? status}
      </span>
    );
  }

  const Icon = meta.icon;

  return (
    <span
      className={cn(
        "inline-flex select-none items-center whitespace-nowrap rounded-full font-medium leading-none ring-1 ring-inset",
        meta.className,
        sizes.pill,
        className,
      )}
    >
      <Icon
        className={cn(
          "shrink-0",
          sizes.icon,
          meta.spin && "motion-safe:animate-spin motion-safe:[animation-duration:3s]",
        )}
        strokeWidth={2.25}
        aria-hidden="true"
      />
      {label ?? meta.label}
    </span>
  );
}
