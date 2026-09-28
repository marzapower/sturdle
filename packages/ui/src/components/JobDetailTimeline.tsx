"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import type { TimelineLane, TimelineModel, TimelineSegment } from "../lib/timeline-model.js";
import type { JobDetail } from "../types.js";
import { Chip } from "./Chip.js";
import { StatusDot } from "./StatusDot.js";
import { formatDuration } from "../lib/format.js";
import { isTerminalJobStatus } from "../lib/job-status.js";
import { buildTimelineModel } from "../lib/timeline-model.js";
import { cn } from "../lib/cn.js";

export interface JobDetailTimelineProps {
  job: JobDetail;
  selectedAttempt: number | "all";
  onSelectAttempt: (attempt: number | "all") => void;
  /** The step whose bar/row is expanded and highlighted, shared with the Steps panel. */
  selectedStepKey: string | null;
  onSelectStep: (key: string) => void;
}

type Zoom = "fit" | 1 | 2 | 4;

/** Base scale for the 1x zoom level, in px per ms — 2x/4x multiply it, "Fit" recomputes it instead. */
const BASE_PX_PER_MS = 0.05;
const MIN_BAR_WIDTH_PX = 2;
const MIN_GAP_WIDTH_PX = 24;
/** Smallest track the zoomed levels may produce, so a 3 ms job still gets a readable axis. */
const MIN_TRACK_PX = 240;

// Every row (axis and lanes) shares the same four columns: label | track | duration | error.
// The overlays (ticks, gap breaks, "now" line) are positioned inside the track column, so the
// label and the right-hand columns are fixed CSS lengths that the overlay offset can reuse.
const LABEL_COL = "7rem";
const DURATION_COL = "3.5rem";
const ERROR_COL = "minmax(0, 30ch)";
/** When zoomed the row scrolls sideways, so the error column takes a fixed width and sticks right. */
const ERROR_COL_ZOOMED = "30ch";
const COL_GAP = "0.5rem";
const TRACK_OFFSET = `calc(${LABEL_COL} + ${COL_GAP})`;
const DURATION_RIGHT_OFFSET = `calc(${ERROR_COL_ZOOMED} + ${COL_GAP})`;

const SEGMENT_COLOR: Record<string, string> = {
  running: "bg-plume motion-safe:animate-pulse-dot",
  completed: "bg-sand-600",
  failed: "bg-carmine",
  pending: "",
};

/** Repeating diagonal hatch, used for queued (sand) and backoff (amber) waiting segments. */
function hatchStyle(colorVar: string): React.CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(135deg, hsl(var(${colorVar})) 0 2px, transparent 2px 6px)`,
    opacity: 0.7,
  };
}

function rowStyle(trackColumn: string, zoomed: boolean): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `${LABEL_COL} ${trackColumn} ${DURATION_COL} ${zoomed ? ERROR_COL_ZOOMED : ERROR_COL}`,
    columnGap: COL_GAP,
    alignItems: "center",
  };
}

/**
 * Label / duration / error cells stay put while the track scrolls under them at 1x-4x. They stretch
 * to the row's full height (the grid centres items, and an empty cell would otherwise be 0px tall
 * and paint no background), so the track can never show through them.
 */
const STICKY_LEFT = "sticky left-0 z-10 flex items-center self-stretch bg-inherit";
const STICKY_RIGHT = "sticky right-0 z-10 flex items-center self-stretch bg-inherit";
const stickyDuration = { position: "sticky", right: DURATION_RIGHT_OFFSET, zIndex: 10 } as const;

/**
 * The job detail's hero: a trace-style execution timeline (Jaeger/Temporal-like) with one lane per
 * attempt, steps as proportional bars, backoff waits, queued time and child jobs nested under the
 * step that spawned them, on one shared, gap-compressed time axis.
 */
export function JobDetailTimeline({
  job,
  selectedAttempt,
  onSelectAttempt,
  selectedStepKey,
  onSelectStep,
}: JobDetailTimelineProps) {
  const [now] = useState(() => Date.now());
  const [zoom, setZoom] = useState<Zoom>("fit");
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setTrackWidth(entry.contentRect.width);
    });
    // ResizeObserver fires an initial callback asynchronously once observation starts, so no need
    // to read `el.clientWidth` synchronously here.
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const model = buildTimelineModel(job, now);

  if (!model.hasTimingInfo) {
    return <p className="text-sand-400 text-sm">No timing information yet.</p>;
  }

  const fitPxPerMs = trackWidth > 0 ? trackWidth / model.totalMs : BASE_PX_PER_MS;
  const pxPerMs = zoom === "fit" ? fitPxPerMs : BASE_PX_PER_MS * zoom;
  const trackColumn =
    zoom === "fit"
      ? "minmax(0, 1fr)"
      : `${Math.max(Math.round(model.totalMs * pxPerMs), MIN_TRACK_PX)}px`;
  const isTerminal = isTerminalJobStatus(job.status);
  const zoomed = zoom !== "fit";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-md text-sand-100 flex flex-wrap items-baseline gap-x-2 font-semibold">
          Execution
          <span className="text-sand-400 text-xs font-normal">
            total {formatDuration(model.realTotalMs)}
          </span>
          <span className="text-sand-400 border-ink-600 border-l pl-2 text-xs font-normal">
            {model.attemptsCount} attempt{model.attemptsCount === 1 ? "" : "s"}
          </span>
        </h2>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="Zoom">
          {(["fit", 1, 2, 4] as const).map((level) => (
            <Chip
              key={level}
              onClick={() => setZoom(level)}
              aria-pressed={zoom === level}
              active={zoom === level}
              title={level === "fit" ? "Fit the whole run in view" : `${level * 50} px per second`}
            >
              {level === "fit" ? "Fit" : `${level}x`}
            </Chip>
          ))}
        </div>
      </div>

      {model.usesLegacyFallback && (
        <p className="text-sand-400 text-xs">
          Per-attempt detail is not available yet for this job. Showing the current attempt only.
        </p>
      )}

      <div className="overflow-x-auto">
        <div
          className="bg-ink-900 relative min-w-full"
          style={{ width: zoom === "fit" ? "100%" : "max-content" }}
        >
          {/* Axis row: same columns as the lanes, the track cell is what "Fit" measures. */}
          <div style={rowStyle(trackColumn, zoomed)} className="h-5">
            <span className={cn(zoomed && STICKY_LEFT, zoomed && "bg-ink-900")} />
            <div ref={trackRef} className="h-full" />
            <span
              style={zoomed ? stickyDuration : undefined}
              className={cn(zoomed && "bg-ink-900")}
            />
            <span className={cn(zoomed && STICKY_RIGHT, zoomed && "bg-ink-900")} />
          </div>

          <div className="space-y-1 pt-1">
            {model.lanes.map((lane) => (
              <Lane
                key={lane.id}
                lane={lane}
                pxPerMs={pxPerMs}
                trackColumn={trackColumn}
                zoomed={zoomed}
                selectedAttempt={selectedAttempt}
                onSelectAttempt={onSelectAttempt}
                selectedStepKey={selectedStepKey}
                onSelectStep={onSelectStep}
              />
            ))}
          </div>

          {/* Overlays live in the track column's coordinate space and span every lane. */}
          <Overlay model={model} pxPerMs={pxPerMs} showNow={!isTerminal} />
        </div>
      </div>

      <ScreenReaderTable model={model} />
    </div>
  );
}

function Overlay({
  model,
  pxPerMs,
  showNow,
}: {
  model: TimelineModel;
  pxPerMs: number;
  showNow: boolean;
}) {
  const trackLeft = (ms: number) => `calc(${TRACK_OFFSET} + ${ms * pxPerMs}px)`;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {model.ticks.map((tick) => (
        <div
          key={tick.ms}
          className="border-ink-600 text-sand-400 absolute bottom-0 top-0 border-l text-[11px]"
          style={{ left: trackLeft(tick.ms) }}
        >
          <span className="ml-1 whitespace-nowrap">{tick.label}</span>
        </div>
      ))}

      {model.gaps.map((gap, index) => (
        <div
          key={index}
          className="bg-ink-900 text-sand-400 absolute bottom-0 top-0 flex flex-col items-center text-[10px]"
          style={{
            left: trackLeft(gap.atMs),
            width: Math.max(gap.widthMs * pxPerMs, MIN_GAP_WIDTH_PX),
          }}
        >
          <span className="whitespace-nowrap leading-5">⫽ {formatDuration(gap.realGapMs)}</span>
          <div className="flex w-full flex-1 justify-center gap-1">
            <span className="bg-sand-600 h-full w-px" />
            <span className="bg-sand-600 h-full w-px" />
          </div>
        </div>
      ))}

      {showNow && (
        <div
          className="bg-plume absolute bottom-0 top-5 w-px"
          style={{ left: trackLeft(model.totalMs) }}
          title="Now"
        />
      )}
    </div>
  );
}

function Lane({
  lane,
  pxPerMs,
  trackColumn,
  zoomed,
  selectedAttempt,
  onSelectAttempt,
  selectedStepKey,
  onSelectStep,
}: {
  lane: TimelineLane;
  pxPerMs: number;
  trackColumn: string;
  zoomed: boolean;
  selectedAttempt: number | "all";
  onSelectAttempt: (attempt: number | "all") => void;
  selectedStepKey: string | null;
  onSelectStep: (key: string) => void;
}) {
  const isAttemptLane = lane.kind === "attempt" && typeof lane.attempt === "number";
  const isSelected = isAttemptLane && selectedAttempt === lane.attempt;
  const isChild = lane.kind === "child";
  const totalDurationMs = lane.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  // Backoff lanes carry `dotStatus: "pending"` in the model (a wait, not a failure): mark them amber
  // here instead, without touching the model shared with the screen-reader table.
  const dotStatus = lane.kind === "backoff" ? "delayed" : lane.dotStatus;

  const content = (
    <div style={rowStyle(trackColumn, zoomed)} className="bg-inherit text-xs">
      <span className={cn("min-w-0", isChild && "pl-4", zoomed && STICKY_LEFT)}>
        {isChild ? (
          <span className="text-sand-400 block truncate" title={lane.label}>
            ↳ {lane.label}
          </span>
        ) : lane.kind === "backoff" ? (
          <span
            className="text-sand-600 flex cursor-help items-center gap-1.5 pl-4 underline decoration-dotted underline-offset-4"
            title="Wait the engine scheduled before the next attempt"
          >
            {dotStatus && <StatusDot status={dotStatus} />}
            backoff
          </span>
        ) : lane.kind === "queued" ? (
          <span
            className="text-sand-600 cursor-help underline decoration-dotted underline-offset-4"
            title="Time spent waiting for a free worker, delay included"
          >
            queued
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onSelectAttempt(isSelected ? "all" : (lane.attempt as number))}
            aria-pressed={isSelected}
            aria-label={`Attempt ${lane.attempt}: ${isSelected ? "show all logs" : "show only its logs"}`}
            className="text-sand-100 focus-visible:outline-plume flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {dotStatus && <StatusDot status={dotStatus} pulse />}
            attempt {lane.attempt}
          </button>
        )}
      </span>

      <div className="relative h-4 min-w-0 overflow-hidden">
        {lane.segments.map((segment) => (
          <Segment
            key={segment.id}
            segment={segment}
            pxPerMs={pxPerMs}
            selectedStepKey={selectedStepKey}
            onSelectStep={onSelectStep}
          />
        ))}
      </div>

      <span
        style={zoomed ? stickyDuration : undefined}
        className={cn(
          "text-sand-400 text-right font-mono",
          zoomed && "flex items-center justify-end self-stretch bg-inherit",
        )}
      >
        {formatDuration(totalDurationMs)}
      </span>

      <span className={cn("min-w-0", zoomed && STICKY_RIGHT)}>
        {lane.error && (
          <span className="text-sand-400 block truncate" title={lane.error}>
            {lane.error}
          </span>
        )}
        {!lane.error && lane.nonRetriable && <span className="text-carmine">dead letter</span>}
      </span>
    </div>
  );

  if (isChild && lane.href) {
    return (
      <a
        href={lane.href}
        className="focus-visible:outline-plume bg-ink-900 hover:bg-ink-800 block py-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {content}
      </a>
    );
  }

  if (isAttemptLane) {
    return (
      <div
        className={cn(
          "bg-ink-900 hover:bg-ink-800 relative block w-full py-0.5",
          // Selected: a lighter surface plus an inset ring — no coloured side border, visible even
          // to someone who cannot tell ink-800 from ink-900. The row itself is no longer the button
          // (the label cell is, above) but keeps the same hover/selected treatment.
          isSelected && "bg-ink-700 ring-plume/50 ring-1 ring-inset",
        )}
      >
        {content}
      </div>
    );
  }

  return <div className="bg-ink-900 py-0.5">{content}</div>;
}

function Segment({
  segment,
  pxPerMs,
  selectedStepKey,
  onSelectStep,
}: {
  segment: TimelineSegment;
  pxPerMs: number;
  selectedStepKey: string | null;
  onSelectStep: (key: string) => void;
}) {
  const left = segment.startMs * pxPerMs;
  const width = Math.max((segment.endMs - segment.startMs) * pxPerMs, MIN_BAR_WIDTH_PX);
  const isWait = segment.kind === "queued" || segment.kind === "backoff";
  const isReplay = segment.replayedFrom != null;
  const isSelected = segment.stepKey !== undefined && segment.stepKey === selectedStepKey;

  if (segment.stepKey) {
    const stepKey = segment.stepKey;
    return (
      <button
        type="button"
        aria-label={segment.ariaLabel}
        title={segment.ariaLabel}
        onClick={() => onSelectStep(stepKey)}
        className={cn(
          // Wider invisible hit area (before:) so the click target isn't limited to a 2px-wide bar,
          // without changing the visible bar's own size.
          "before:absolute before:-inset-x-1 before:inset-y-0 before:content-['']",
          "absolute top-0 h-full min-w-[2px] focus-visible:outline-none",
          isReplay
            ? "border-sand-600 border bg-transparent"
            : SEGMENT_COLOR[segment.status ?? "completed"],
          // Selected and focus-visible both use the inset ring, never an outline: the track is
          // `overflow-hidden` so an outer outline would be clipped.
          isSelected && "ring-plume ring-2 ring-inset",
          "focus-visible:ring-plume focus-visible:ring-2 focus-visible:ring-inset",
        )}
        style={{ left, width }}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={segment.ariaLabel}
      title={segment.ariaLabel}
      className={cn(
        "absolute top-0 h-full min-w-[2px]",
        !isWait && SEGMENT_COLOR[segment.status ?? "completed"],
      )}
      style={{
        left,
        width,
        ...(isWait ? hatchStyle(segment.kind === "backoff" ? "--amber" : "--sand-600") : {}),
      }}
    />
  );
}

function ScreenReaderTable({ model }: { model: TimelineModel }) {
  // The wrapper carries `sr-only`, not the table: a table ignores a 1px width and would keep
  // widening the page (horizontal scroll on phones) even while visually hidden.
  return (
    <div className="sr-only">
      <table>
        <caption>Execution timeline, {model.attemptsCount} attempts</caption>
        <thead>
          <tr>
            <th>Lane</th>
            <th>Segment</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Replayed from</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {model.lanes.flatMap((lane) =>
            lane.segments.map((segment) => (
              <tr key={segment.id}>
                <td>{lane.label}</td>
                <td>{segment.label}</td>
                <td>{segment.status ?? "—"}</td>
                <td>{formatDuration(segment.durationMs)}</td>
                <td>{segment.replayedFrom != null ? `attempt ${segment.replayedFrom}` : "—"}</td>
                <td>{segment.error ?? "—"}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
