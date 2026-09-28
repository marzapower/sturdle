"use client";

import { useState } from "react";

import type { JobTypeSummary, TaskStats24h } from "../types.js";
import { formatRate, toFleetRows } from "../lib/fleet.js";
import { formatAbsolute, formatDuration, formatRelative } from "../lib/format.js";
import { taskPath } from "../lib/paths.js";
import { cn } from "../lib/cn.js";
import { Chip } from "./Chip.js";
import { Surface } from "./Panel.js";
import { Button } from "./ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

type FleetFilter = "all" | "failing" | "event" | "cron";

export interface FleetTableProps {
  jobTypes: JobTypeSummary[];
  /** The per-row "Schedule" action column renders only when this is provided — omit it
   *  (e.g. a read-only or demo table) and the column disappears rather than rendering a
   *  dead button. */
  onSchedule?: (code: string) => void;
}

/**
 * The core listing of registered tasks: one row per registered task, worst first. The unit of
 * analysis is the task, not the single job — volume, success, failures and p95 over the last 24
 * hours sit on one line, so "which task is degrading" is answered without opening a job.
 */
export function FleetTable({ jobTypes, onSchedule }: FleetTableProps) {
  const [filter, setFilter] = useState<FleetFilter>("all");

  const rows = toFleetRows(jobTypes);

  const counts = {
    all: rows.length,
    failing: rows.filter((row) => row.failed > 0).length,
    event: rows.filter((row) => row.task.type !== "cron").length,
    cron: rows.filter((row) => row.task.type === "cron").length,
  };

  const visible = rows.filter((row) => {
    if (filter === "failing") return row.failed > 0;
    if (filter === "cron") return row.task.type === "cron";
    if (filter === "event") return row.task.type !== "cron";
    return true;
  });

  const FILTERS: { value: FleetFilter; label: string }[] = [
    { value: "all", label: "All tasks" },
    { value: "failing", label: "Failing" },
    { value: "event", label: "Events" },
    { value: "cron", label: "Crons" },
  ];

  return (
    <Surface aria-label="Registered tasks" className="min-w-0">
      <div className="border-ink-600 flex flex-wrap items-center gap-2 border-b px-4 py-3">
        {FILTERS.map((item) => (
          <Chip
            key={item.value}
            active={filter === item.value}
            aria-pressed={filter === item.value}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
            <span
              className={cn("tabular-nums", filter === item.value ? "text-plume" : "text-sand-600")}
            >
              {counts[item.value]}
            </span>
          </Chip>
        ))}
        <span className="text-sand-600 ml-auto text-xs">last 24 h</span>
      </div>

      {visible.length === 0 ? (
        <p className="text-sand-400 p-4 text-sm">
          {rows.length === 0 ? "No tasks are registered." : "No task matches this filter."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead>Per hour</TableHead>
              <TableHead>Success</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">p95</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Next run</TableHead>
              {onSchedule && (
                <TableHead className="text-right">
                  <span className="sr-only">Action</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map(({ task, stats, runs, failed, successRate }) => (
              <TableRow key={task.code}>
                <TableCell className="max-w-[22rem]">
                  <div className="flex min-w-0 flex-col leading-tight">
                    <a
                      href={taskPath(task.code)}
                      className="focus-visible:outline-plume text-sand-100 truncate font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      {task.description || task.code}
                    </a>
                    <span className="text-sand-600 truncate font-mono text-xs">
                      {task.type === "cron" && task.cron ? task.cron : task.code}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-sand-400">{task.type || "event"}</TableCell>
                <TableCell className="text-right">
                  {stats ? runs.toLocaleString("en-US") : <Dash />}
                </TableCell>
                <TableCell>{stats ? <HourlyBars stats={stats} /> : <Dash />}</TableCell>
                <TableCell>
                  {successRate === null ? (
                    <Dash />
                  ) : (
                    <span className="flex items-center gap-2">
                      {/* The track is the failure colour, the fill is what succeeded: the red
                          remainder is proportional to the failures and absent at 100%. */}
                      <span
                        aria-hidden="true"
                        className="bg-carmine block h-1 w-[72px] overflow-hidden rounded-full"
                      >
                        <span
                          className="bg-ink-400 block h-full"
                          style={{ width: `${successRate}%` }}
                        />
                      </span>
                      <span className={successRate < 50 ? "text-carmine" : "text-sand-400"}>
                        {formatRate(successRate)}
                      </span>
                    </span>
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right",
                    failed > 0 ? "text-carmine font-semibold" : "text-sand-600",
                  )}
                >
                  {stats ? failed : <Dash />}
                </TableCell>
                <TableCell className="text-sand-400 text-right font-mono text-xs">
                  {stats?.p95DurationMs ? formatDuration(stats.p95DurationMs) : <Dash />}
                </TableCell>
                <TableCell
                  className="text-sand-400"
                  title={task.lastRun ? formatAbsolute(task.lastRun.at) : undefined}
                >
                  {task.lastRun ? formatRelative(task.lastRun.at) : <Dash />}
                </TableCell>
                <TableCell
                  className="text-sand-400 font-mono text-xs"
                  title={formatAbsolute(task.nextRunAt ?? null) || undefined}
                >
                  {task.nextRunAt ? (
                    formatRelative(task.nextRunAt)
                  ) : (
                    <span className="text-sand-600 font-sans">on event</span>
                  )}
                </TableCell>
                {onSchedule && (
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => onSchedule(task.code)}>
                      Schedule
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Surface>
  );
}

function Dash() {
  return <span className="text-sand-600">—</span>;
}

const BAR_WIDTH = 3;
const BAR_GAP = 1;
const BARS_HEIGHT = 20;

/**
 * 24 bars, one per hour, scaled to the task's own busiest hour: the shape of the day, not a volume
 * comparison between tasks (the Runs column is that). Failed jobs stack on top in carmine.
 */
function HourlyBars({ stats }: { stats: TaskStats24h }) {
  const peak = Math.max(1, ...stats.series.map((point) => point.completed + point.failed));
  const width = stats.series.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;

  return (
    <svg
      width={width}
      height={BARS_HEIGHT}
      viewBox={`0 0 ${width} ${BARS_HEIGHT}`}
      role="img"
      aria-label={`Runs per hour over the last 24 hours, busiest hour ${peak}`}
      className="block"
    >
      {stats.series.map((point, index) => {
        const x = index * (BAR_WIDTH + BAR_GAP);
        const total = point.completed + point.failed;
        if (total === 0) {
          return (
            <rect
              key={point.hour}
              x={x}
              y={BARS_HEIGHT - 1.5}
              width={BAR_WIDTH}
              height={1.5}
              rx={0.75}
              className="fill-ink-500"
            />
          );
        }

        const scale = (BARS_HEIGHT - 2) / peak;
        const completedHeight = point.completed * scale;
        const failedHeight = Math.max(point.failed > 0 ? 2 : 0, point.failed * scale);

        return (
          <g key={point.hour}>
            {point.completed > 0 && (
              <rect
                x={x}
                y={BARS_HEIGHT - completedHeight}
                width={BAR_WIDTH}
                height={completedHeight}
                rx={0.75}
                className="fill-ink-400"
              />
            )}
            {point.failed > 0 && (
              <rect
                x={x}
                y={BARS_HEIGHT - completedHeight - failedHeight}
                width={BAR_WIDTH}
                height={failedHeight}
                rx={0.75}
                className="fill-carmine"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
