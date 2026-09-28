import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../lib/cn.js";

export interface ChipProps extends React.ComponentProps<"button"> {
  active?: boolean;
  /** Render the chip's classes on the child element (e.g. an `<a>`) instead of a button. */
  asChild?: boolean;
}

/**
 * The one toggle/filter chip of the dashboard: status filters, log level and attempt filters, the
 * timeline zoom and Follow all use it, so "selected" looks the same everywhere.
 */
export function Chip({ active = false, asChild = false, className, type, ...props }: ChipProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      className={cn(
        "focus-visible:outline-plume inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        active
          ? "border-plume/45 bg-plume/15 text-sand-100"
          : "border-ink-500 text-sand-400 hover:bg-ink-700 hover:text-sand-100",
        className,
      )}
      {...props}
    />
  );
}
