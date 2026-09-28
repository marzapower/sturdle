"use client";

import type { TooltipContentProps } from "recharts";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ActivitySeriesPoint } from "../types.js";

export interface ActivityChartProps {
  data: ActivitySeriesPoint[];
  /** Short, axis-light variant that sits beside headline figures: no legend, no y axis. */
  compact?: boolean;
  /**
   * Governs both the axis tick label and the tooltip label. "hour" (default) is a 24 h window;
   * "day" is a 7-day window, where 168 hourly bars need a day label instead of one per hour.
   */
  ticks?: "hour" | "day";
  /** Names the window in the empty-state sentence, e.g. "the last 7 days". Defaults to a 24 h window. */
  windowLabel?: string;
}

// SVG presentation attributes can't resolve CSS variables, so the two series carry the hex value of
// `--ink-400` and of `--carmine` from tokens.css: completed is the normal course and stays quiet,
// failed is the deviation and takes the colour. Everything else (axes, grid, tooltip) uses
// `currentColor` and Tailwind classes so it follows the tokens automatically.
const SERIES = {
  completed: { label: "Completed", color: "#565F81" },
  failed: { label: "Failed", color: "#FF6B6B" },
} as const;

const AXIS_TICK = {
  fill: "currentColor",
  fontSize: 11,
  fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

// Fallback for an empty/all-zero series — `yAxisWidth` below always compares against at
// least this many characters, so a bare "0" axis still gets a sane reserved width.
const MIN_YAXIS_WIDTH = 30;

/**
 * The y axis (full mode only — compact hides it) reserves a fixed pixel width for its tick
 * labels, so it has to be at least as wide as the widest one actually renders: a stacked
 * bar's top tick can read in the thousands ("1,800"), and a too-narrow reservation clips
 * the label's leading digits instead of wrapping (SVG text doesn't wrap). Sized from the
 * data's own max stacked value — recharts' "nice" axis max is never smaller than that, so
 * this is always a safe (if occasionally one-tick-too-wide) upper bound. ~7px/character at
 * the axis's 11px mono tick font, plus the 8px `tickMargin` and a couple of px of padding.
 */
function yAxisWidth(data: ActivitySeriesPoint[]): number {
  const maxValue = data.reduce((max, point) => Math.max(max, point.completed + point.failed), 0);
  const widestLabel = Math.max(maxValue, 0).toLocaleString("en-US");
  return Math.max(MIN_YAXIS_WIDTH, widestLabel.length * 7 + 12);
}

// A day-mode series is real ISO timestamps and is always read in UTC — crons and job engines
// typically speak UTC, and the browser's own zone would shift which hour a bar belongs to. An
// hour-mode series may instead send server-formatted "HH:MM" strings (not ISO), which
// `parseIsoTime` rejects, so those pass through unchanged.
const TIME_ZONE = "UTC";

function parseIsoTime(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Axis tick label: "14" for an hour, "Sep 12" for a day. Non-ISO values pass through unchanged. */
function formatTick(value: string, ticks: "hour" | "day"): string {
  const date = parseIsoTime(value);
  if (!date) return value;
  if (ticks === "day") {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: TIME_ZONE,
    });
  }
  return date.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false, timeZone: TIME_ZONE });
}

/** Tooltip label: fuller than the axis tick ("14:00", or "Sep 12, 14:00" in day mode). */
function formatTooltipLabel(value: string, ticks: "hour" | "day"): string {
  const date = parseIsoTime(value);
  if (!date) return value;
  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TIME_ZONE,
  });
  if (ticks === "day") {
    const day = date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: TIME_ZONE,
    });
    return `${day}, ${time}`;
  }
  return time;
}

/**
 * Jobs per hour over the window as stacked bars — completed in a neutral tone under failed in
 * carmine. Bars, not a curve: the data is a count per hour, and a smoothed line would suggest "2.5
 * jobs at 22:30". Has a `compact` mode (shorter, no legend, no y-axis) meant to sit beside headline
 * figures. `ticks?: "hour" | "day"` (default `"hour"`) governs both the axis tick label and the
 * tooltip label.
 */
export function ActivityChart({
  data,
  compact = false,
  ticks = "hour",
  windowLabel = "the last 24 hours",
}: ActivityChartProps) {
  const hasActivity = data.some((point) => point.completed > 0 || point.failed > 0);

  if (!hasActivity && compact) {
    return (
      <p className="text-sand-400 text-left text-xs lg:text-right">No jobs ran in {windowLabel}.</p>
    );
  }

  if (!hasActivity) {
    return (
      <div className="flex h-40 w-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-sand-100 text-sm">No jobs ran in {windowLabel}.</p>
      </div>
    );
  }

  return (
    <div className="text-sand-400">
      <ul className={compact ? "hidden" : "mb-2 flex justify-end gap-4 text-xs"} aria-hidden="true">
        {[SERIES.completed, SERIES.failed].map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-[2px] ring-1 ring-inset ring-white/10"
              style={{ background: item.color }}
            />
            {item.label}
          </li>
        ))}
      </ul>

      <div className={compact ? "relative h-[88px] w-full" : "relative h-[220px] w-full"}>
        {!compact && (
          <div aria-hidden="true" className="chart-surface pointer-events-none absolute inset-0" />
        )}
        <div className="relative h-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: compact ? 2 : 8, right: compact ? 0 : 8, left: 0, bottom: 0 }}
              barCategoryGap={compact ? "18%" : "25%"}
            >
              <CartesianGrid
                horizontal={!compact}
                vertical={false}
                stroke="currentColor"
                strokeOpacity={0.18}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="time"
                tickFormatter={(value: string) => formatTick(value, ticks)}
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                minTickGap={ticks === "day" ? 56 : 32}
              />
              <YAxis
                hide={compact}
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                width={compact ? MIN_YAXIS_WIDTH : yAxisWidth(data)}
                allowDecimals={false}
              />
              <Tooltip
                content={(props) => <ActivityTooltip {...props} ticks={ticks} />}
                cursor={{ fill: "currentColor", fillOpacity: 0.08 }}
              />
              <Bar
                dataKey="completed"
                name={SERIES.completed.label}
                stackId="jobs"
                fill={SERIES.completed.color}
                isAnimationActive={false}
              />
              <Bar
                dataKey="failed"
                name={SERIES.failed.label}
                stackId="jobs"
                fill={SERIES.failed.color}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function ActivityTooltip({
  active,
  payload,
  label,
  ticks,
}: TooltipContentProps & { ticks: "hour" | "day" }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="border-ink-600 bg-ink-700/90 text-sand-100 min-w-[9rem] rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      <p className="text-sand-100 mb-1.5 font-medium">{formatTooltipLabel(String(label), ticks)}</p>
      <ul className="flex flex-col gap-1">
        {payload.map((item) => (
          <li key={String(item.dataKey ?? item.name)} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-[2px] ring-1 ring-inset ring-white/10"
              style={{ background: String(item.color ?? "") }}
            />
            <span className="text-sand-400">{item.name}</span>
            <span className="text-sand-100 ml-auto font-mono tabular-nums">
              {typeof item.value === "number" ? item.value.toLocaleString() : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
