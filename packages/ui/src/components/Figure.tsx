import type * as React from "react";

export interface FigureProps {
  value: React.ReactNode;
  /** Rendered smaller and muted right after the value, e.g. "ms" or "%". */
  unit?: string;
  label: string;
  /** "bad" reddens the value for a figure that should draw the eye (e.g. failed > 0). */
  tone?: "default" | "bad" | "warn";
}

const TONE_CLASS: Record<NonNullable<FigureProps["tone"]>, string> = {
  default: "text-sand-100",
  bad: "text-carmine",
  warn: "text-amber",
};

/**
 * A headline number: a row of figures reads at a glance because every figure shares this same
 * shape (big tabular value, optional unit, label underneath) — no card, no border, just type.
 */
export function Figure({ value, unit, label, tone = "default" }: FigureProps) {
  return (
    <div className="grid gap-0.5">
      <p className="text-figure font-medium tabular-nums">
        <span className={TONE_CLASS[tone]}>{value}</span>
        {unit && <small className="text-sand-600 ml-0.5 text-sm font-normal">{unit}</small>}
      </p>
      <span className="text-sand-400 text-xs">{label}</span>
    </div>
  );
}
