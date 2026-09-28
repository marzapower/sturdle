"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { StepRow } from "../lib/job-steps.js";
import { Chip } from "./Chip.js";
import { CopyTextButton, JsonWell } from "./JobDetailJson.js";
import { Panel } from "./Panel.js";
import { StatusDot } from "./StatusDot.js";
import { formatDuration, formatShortId } from "../lib/format.js";
import { formatResultSize, isLargeResult, stringifyJson } from "../lib/job-steps.js";
import { jobPath } from "../lib/paths.js";
import { cn } from "../lib/cn.js";

export interface JobStepsProps {
  rows: StepRow[];
  /** Attempt numbers to offer as chips, in order. Omit (or empty) to hide the attempt filter. */
  attempts?: number[];
  selectedAttempt: number | "all";
  onSelectAttempt: (attempt: number | "all") => void;
  /** The row expanded and highlighted, typically driven by a click on the timeline. */
  selectedStepKey: string | null;
  onSelectStep: (key: string | null) => void;
}

const STATUS_TEXT_COLOR: Record<StepRow["status"], string> = {
  running: "text-plume",
  completed: "text-sand-400",
  failed: "text-carmine",
};

interface ResolvedRow extends StepRow {
  resultText: string;
  isLarge: boolean;
  lineCount: number;
}

/**
 * The Steps panel: every step of every attempt (including `sendEvent` entries and replay traces,
 * unlike the timeline's per-attempt lanes), in the same dense mono table as `JobLogs`. A row expands
 * to a JSON well (`JsonWell`) showing the step's persisted result, or its error. Shares
 * `selectedStepKey`/`onSelectStep` with `JobDetailTimeline` so a click on either surface expands and
 * highlights the same row.
 */
export function JobSteps({
  rows,
  attempts = [],
  selectedAttempt,
  onSelectAttempt,
  selectedStepKey,
  onSelectStep,
}: JobStepsProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showLargeAnyway, setShowLargeAnyway] = useState<Set<string>>(new Set());
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const showAttemptChips = attempts.length > 0;

  const resolvedRows = useMemo<ResolvedRow[]>(
    () =>
      rows.map((row) => {
        const resultText = row.hasResult ? stringifyJson(row.result) : "";
        return {
          ...row,
          resultText,
          isLarge: isLargeResult(resultText),
          lineCount: resultText ? resultText.split("\n").length : 0,
        };
      }),
    [rows],
  );

  const visibleRows =
    selectedAttempt === "all"
      ? resolvedRows
      : resolvedRows.filter((row) => row.attempt === selectedAttempt);

  useEffect(() => {
    if (!selectedStepKey) return;
    rowRefs.current.get(selectedStepKey)?.scrollIntoView({ block: "nearest" });
  }, [selectedStepKey]);

  const toggleRow = (key: string) => {
    if (key === selectedStepKey) {
      onSelectStep(null);
      setExpanded((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Panel title="Steps" flush>
      <div className="space-y-2 pt-3">
        {showAttemptChips && (
          <div
            className="flex flex-wrap gap-1 px-4 text-xs"
            role="group"
            aria-label="Filter by attempt"
          >
            <Chip
              onClick={() => onSelectAttempt("all")}
              aria-pressed={selectedAttempt === "all"}
              active={selectedAttempt === "all"}
            >
              All
            </Chip>
            {attempts.map((attempt) => (
              <Chip
                key={attempt}
                onClick={() => onSelectAttempt(attempt)}
                aria-pressed={selectedAttempt === attempt}
                active={selectedAttempt === attempt}
              >
                Attempt {attempt}
              </Chip>
            ))}
          </div>
        )}

        <div className="bg-ink-800 max-h-[420px] overflow-auto pb-2">
          <table className="w-full font-mono text-[13px] leading-relaxed">
            <thead className="bg-ink-800 text-sand-600 sticky top-0 z-10 text-xs shadow-[0_1px_0_0_hsl(var(--ink-600))]">
              <tr>
                <th scope="col" className="py-1.5 pl-4 pr-3 text-left font-normal">
                  Step
                </th>
                <th scope="col" className="w-[9ch] px-2 py-1.5 text-left font-normal">
                  Kind
                </th>
                <th scope="col" className="w-[12ch] px-2 py-1.5 text-left font-normal">
                  Status
                </th>
                <th scope="col" className="w-[7ch] px-2 py-1.5 text-right font-normal">
                  Duration
                </th>
                <th scope="col" className="py-1.5 pl-2 pr-4 text-left font-normal">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-sand-600 py-3 pl-4 pr-3">
                    {rows.length === 0
                      ? "No steps recorded for this job."
                      : "No steps match this filter."}
                  </td>
                </tr>
              )}
              {visibleRows.map((row) => {
                const canExpand = row.hasResult || Boolean(row.error);
                const isSelected = row.key === selectedStepKey;
                const isExpanded = isSelected || expanded.has(row.key);
                const isReplay = row.replayedFrom !== null;
                const wellId = `step-well-${row.key}`;

                return (
                  <Fragment key={row.key}>
                    <tr
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.key, el);
                        else rowRefs.current.delete(row.key);
                      }}
                      onClick={() => canExpand && toggleRow(row.key)}
                      className={cn(
                        "align-top",
                        canExpand && "cursor-pointer",
                        isSelected && "bg-ink-700 ring-plume/50 ring-1 ring-inset",
                      )}
                    >
                      <td className="py-0.5 pl-4 pr-3">
                        {canExpand ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleRow(row.key);
                            }}
                            aria-expanded={isExpanded}
                            aria-controls={wellId}
                            className="text-sand-100 focus-visible:outline-plume flex min-w-0 items-center gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                          >
                            {isExpanded ? (
                              <ChevronDown className="text-sand-400 size-3.5 shrink-0" />
                            ) : (
                              <ChevronRight className="text-sand-400 size-3.5 shrink-0" />
                            )}
                            <span className="truncate" title={row.name}>
                              {row.name}
                            </span>
                          </button>
                        ) : (
                          <span className="text-sand-100 flex min-w-0 items-center gap-1.5 pl-5">
                            <span className="truncate" title={row.name}>
                              {row.name}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="text-sand-400 px-2 py-0.5">{row.kind}</td>
                      <td className="px-2 py-0.5">
                        {isReplay ? (
                          <span className="flex items-center gap-1.5 whitespace-nowrap">
                            <StatusDot status="neutral" />
                            <span
                              className="text-sand-400"
                              title={`Replayed from attempt ${row.replayedFrom}`}
                            >
                              cached
                            </span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <StatusDot status={row.status} />
                            <span className={STATUS_TEXT_COLOR[row.status]}>{row.status}</span>
                          </span>
                        )}
                      </td>
                      <td className="text-sand-400 whitespace-nowrap px-2 py-0.5 text-right tabular-nums">
                        {isReplay ? "—" : formatDuration(row.durationMs)}
                      </td>
                      <td className="text-sand-600 py-0.5 pl-2 pr-4">
                        {row.childJobId ? (
                          <a
                            href={jobPath(row.childJobId)}
                            title={row.childJobId}
                            // Navigating away must not also toggle the row underneath.
                            onClick={(event) => event.stopPropagation()}
                            className="text-plume font-mono underline-offset-4 hover:underline"
                          >
                            {formatShortId(row.childJobId)}
                          </a>
                        ) : row.hasResult ? (
                          <span className="font-mono tabular-nums">
                            {row.isLarge
                              ? formatResultSize(row.resultText.length)
                              : `${row.lineCount} ${row.lineCount === 1 ? "line" : "lines"}`}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td id={wellId} colSpan={5} className="bg-ink-900 p-0">
                          {row.error ? (
                            <div className="p-3">
                              <div className="flex items-center justify-end">
                                <CopyTextButton text={row.error} ariaLabel="Copy error" />
                              </div>
                              <pre className="text-sand-100 mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                                {row.error}
                              </pre>
                            </div>
                          ) : row.isLarge && !showLargeAnyway.has(row.key) ? (
                            <div className="flex flex-wrap items-center gap-3 p-3 text-xs">
                              <span className="text-sand-400">
                                Large result ({formatResultSize(row.resultText.length)}).
                              </span>
                              <Chip
                                onClick={() =>
                                  setShowLargeAnyway((prev) => {
                                    const next = new Set(prev);
                                    next.add(row.key);
                                    return next;
                                  })
                                }
                              >
                                Show anyway
                              </Chip>
                              <CopyTextButton
                                text={row.resultText}
                                ariaLabel={`Copy ${row.name.toLowerCase()} as JSON`}
                              />
                            </div>
                          ) : (
                            <div className="p-3">
                              <JsonWell
                                text={row.resultText}
                                label={row.name}
                                className="bg-ink-900 mt-0"
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}
