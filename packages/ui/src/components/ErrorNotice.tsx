import type * as React from "react";
import { CircleX } from "lucide-react";

import { cn } from "../lib/cn.js";

export interface ErrorNoticeProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * The one error surface of the dashboard: a faint carmine tint with a matching border and an icon —
 * never a coloured side border. Use it for a job's failure reason, a fetch error inline in a page,
 * and similar.
 */
export function ErrorNotice({ title, children, className }: ErrorNoticeProps) {
  return (
    <div
      role="alert"
      className={cn(
        "bg-carmine/10 border-carmine/30 flex items-start gap-2.5 rounded-lg border p-4",
        className,
      )}
    >
      <CircleX
        className="text-carmine mt-0.5 size-4 shrink-0"
        strokeWidth={2.25}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1">
        {title && <p className="text-carmine text-sm font-semibold">{title}</p>}
        <div className="text-sand-100 text-sm">{children}</div>
      </div>
    </div>
  );
}
