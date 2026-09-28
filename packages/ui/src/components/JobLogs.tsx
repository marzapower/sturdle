"use client";

import { useEffect, useRef, useState } from "react";

import type { JobLog } from "../types.js";
import { Chip } from "./Chip.js";
import { cn } from "../lib/cn.js";

export interface JobLogsProps {
  logs: JobLog[];
  /** Whether the job is still running: drives the default state of the "Follow" toggle. */
  live: boolean;
  /** Attempt numbers to offer as chips, in order. Omit (or empty) to hide the attempt filter. */
  attempts?: number[];
  selectedAttempt?: number | "all";
  onSelectAttempt?: (attempt: number | "all") => void;
}

const LEVELS: JobLog["level"][] = ["info", "warn", "error", "debug"];

const LEVEL_COLOR: Record<JobLog["level"], string> = {
  info: "text-sand-400",
  warn: "text-amber",
  error: "text-carmine",
  debug: "text-sand-600",
};

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const base = date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${base}.${date.getMilliseconds().toString().padStart(3, "0")}`;
}

/**
 * Log well laid out as a dense event table: a pinned header, time / level / step / message
 * columns, the level as a coloured dot plus word. Keeps the attempt and level filter chips and
 * the follow-to-bottom toggle.
 */
export function JobLogs({
  logs,
  live,
  attempts = [],
  selectedAttempt = "all",
  onSelectAttempt,
}: JobLogsProps) {
  const [activeLevels, setActiveLevels] = useState<Set<JobLog["level"]>>(new Set(LEVELS));
  const [follow, setFollow] = useState(live);
  const containerRef = useRef<HTMLDivElement>(null);

  const showAttemptChips = attempts.length > 0 && Boolean(onSelectAttempt);
  const hasSteps = logs.some((log) => Boolean(log.step));

  const visibleLogs = logs
    .filter((log) => activeLevels.has(log.level))
    .filter((log) =>
      showAttemptChips && selectedAttempt !== "all" ? log.attempt === selectedAttempt : true,
    );

  useEffect(() => {
    if (!follow) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleLogs.length, follow]);

  const toggleLevel = (level: JobLog["level"]) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const columnCount = hasSteps ? 4 : 3;

  return (
    <div className="space-y-2 pt-3">
      {showAttemptChips && (
        <div
          className="flex flex-wrap gap-1 px-4 text-xs"
          role="group"
          aria-label="Filter by attempt"
        >
          <Chip
            onClick={() => onSelectAttempt?.("all")}
            aria-pressed={selectedAttempt === "all"}
            active={selectedAttempt === "all"}
          >
            All
          </Chip>
          {attempts.map((attempt) => (
            <Chip
              key={attempt}
              onClick={() => onSelectAttempt?.(attempt)}
              aria-pressed={selectedAttempt === attempt}
              active={selectedAttempt === attempt}
            >
              Attempt {attempt}
            </Chip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-4">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by level">
          {LEVELS.map((level) => {
            const active = activeLevels.has(level);
            return (
              <Chip
                key={level}
                onClick={() => toggleLevel(level)}
                aria-pressed={active}
                active={active}
                className={cn(!active && "decoration-sand-600 line-through")}
              >
                {level}
              </Chip>
            );
          })}
        </div>
        <Chip
          onClick={() => setFollow((prev) => !prev)}
          aria-pressed={follow}
          active={follow}
          title="Keep the newest lines in view as they arrive"
        >
          Follow
        </Chip>
      </div>

      <div ref={containerRef} className="bg-ink-800 max-h-[420px] overflow-auto pb-2">
        <table className="w-full font-mono text-[13px] leading-relaxed">
          <thead className="bg-ink-800 text-sand-600 sticky top-0 z-10 text-xs shadow-[0_1px_0_0_hsl(var(--ink-600))]">
            <tr>
              <th scope="col" className="w-[11ch] py-1.5 pl-4 pr-3 text-left font-normal">
                Time
              </th>
              <th scope="col" className="w-[7ch] px-2 py-1.5 text-left font-normal">
                Level
              </th>
              {hasSteps && (
                <th
                  scope="col"
                  className="hidden w-[16ch] px-2 py-1.5 text-left font-normal sm:table-cell"
                >
                  Step
                </th>
              )}
              <th scope="col" className="py-1.5 pl-2 pr-4 text-left font-normal">
                Message
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleLogs.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="text-sand-600 py-3 pl-4 pr-3">
                  {logs.length === 0
                    ? "No logs recorded for this job."
                    : "No logs match this filter."}
                </td>
              </tr>
            )}
            {visibleLogs.map((log, index) => (
              <tr key={index} className={cn("align-top", log.system && "opacity-60")}>
                <td className="text-sand-600 whitespace-nowrap py-0.5 pl-4 pr-3 tabular-nums">
                  {formatLogTime(log.timestamp)}
                </td>
                <td
                  className={cn(
                    "whitespace-nowrap px-2 py-0.5 before:mr-1.5 before:inline-block before:size-1.5 before:rounded-full before:bg-current before:align-middle",
                    LEVEL_COLOR[log.level],
                  )}
                >
                  {log.level}
                </td>
                {hasSteps && (
                  <td
                    className="text-sand-400 hidden max-w-[16ch] truncate px-2 py-0.5 sm:table-cell"
                    title={log.step}
                  >
                    {log.step ?? ""}
                  </td>
                )}
                <td className="text-sand-100 whitespace-pre-wrap break-words py-0.5 pl-2 pr-4">
                  {log.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
