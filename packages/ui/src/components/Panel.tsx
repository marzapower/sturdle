import type * as React from "react";

import { cn } from "../lib/cn.js";

/**
 * The bare surface, one step above the ground (ink-800 on ink-900) with a hairline edge and an inner
 * top highlight: `Panel`'s shell without its header, for content that draws its own (e.g. an
 * execution timeline) or wants the surface with no title row at all.
 */
export type SurfaceProps = React.ComponentProps<"section">;

export function Surface({ className, ...props }: SurfaceProps) {
  return (
    <section
      className={cn(
        "border-ink-600 bg-ink-800 min-w-0 rounded-lg border shadow-[inset_0_1px_0_rgb(255_255_255/0.025)]",
        className,
      )}
      {...props}
    />
  );
}

export interface PanelProps {
  title: string;
  /** Rendered on the same row as the title, e.g. a stat sentence or a link. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** Drops the body padding so a table, a list or a log runs edge to edge. */
  flush?: boolean;
  className?: string;
}

/**
 * The one container of the dashboard: a `Surface` with a title row. Tables and lists go in `flush`;
 * never nest a Panel in a Panel.
 */
export function Panel({ title, aside, children, flush = false, className }: PanelProps) {
  return (
    <Surface className={className}>
      <div className="border-ink-600 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <h2 className="text-sand-100 text-sm font-semibold">{title}</h2>
        {aside && <div className="text-sand-400 text-xs">{aside}</div>}
      </div>
      <div className={cn(!flush && "p-4", flush && "overflow-hidden rounded-b-lg")}>{children}</div>
    </Surface>
  );
}
