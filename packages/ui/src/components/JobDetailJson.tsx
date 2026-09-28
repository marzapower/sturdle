"use client";

import type * as React from "react";
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";

import { stringifyJson } from "../lib/job-steps.js";
import { cn } from "../lib/cn.js";

export interface JsonWellProps {
  /** Text already stringified (`stringifyJson`); "" renders the "None." empty state. */
  text: string;
  /** Used for the copy button's accessible label ("Copy <label> as JSON"). */
  label: string;
  /** Rendered to the left of the line count / copy action, e.g. a collapse toggle. */
  leading?: React.ReactNode;
  /** Merged onto the `<pre>` well itself (tailwind-merge), e.g. to swap its background. */
  className?: string;
}

/**
 * The one "Copy" action of the dashboard's text wells: copies `text` and confirms for two seconds.
 * `ariaLabel` names what is copied ("Copy payload as JSON", "Copy error").
 */
export interface CopyTextButtonProps {
  text: string;
  ariaLabel: string;
}

export function CopyTextButton({ text, ariaLabel }: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={ariaLabel}
      className="text-sand-400 hover:text-sand-100 focus-visible:outline-plume inline-flex items-center gap-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * The header row (leading slot, line count, copy button) plus the mono `<pre>` well, shared by
 * `JobDetailJson` (Payload/Result) and `JobSteps` (a step's result) so "N lines · Copy" never
 * diverges between the two.
 */
export function JsonWell({ text, label, leading, className }: JsonWellProps) {
  const isEmpty = text === "";
  const lineCount = text ? text.split("\n").length : 0;

  return (
    <div>
      <div className="flex items-center gap-2">
        {leading}
        {!isEmpty && (
          <div className="text-sand-600 ml-auto flex shrink-0 items-center gap-3 text-xs">
            <span className="font-mono tabular-nums">
              {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
            <CopyTextButton text={text} ariaLabel={`Copy ${label.toLowerCase()} as JSON`} />
          </div>
        )}
      </div>
      {isEmpty ? (
        <p className="text-sand-400 mt-1 text-xs">None.</p>
      ) : (
        <pre
          className={cn(
            "bg-ink-800 mt-2 max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs",
            "text-sand-100",
            className,
          )}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

export interface JobDetailJsonProps {
  title: string;
  /** Raw value to render as JSON; a JSON-looking string is parsed first so it pretty-prints. */
  value: unknown;
  defaultOpen?: boolean;
  /** Drops the inner title and top border/padding — for a `Panel` whose own title already says it. */
  bare?: boolean;
}

/**
 * Collapsible mono JSON block for a job's payload and result: a header row with the title, the
 * line count and a copy action over the code well. Built on `JsonWell`, passing its own collapse
 * toggle as the well's `leading` slot in non-bare mode.
 */
export function JobDetailJson({
  title,
  value,
  defaultOpen = false,
  bare = false,
}: JobDetailJsonProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isEmpty = value === null || value === undefined;
  const text = isEmpty ? "" : stringifyJson(value);
  // In `bare` mode there is no toggle: the content is always shown, so it's the only place open is
  // ever read as true here — kept as state (rather than a `const`) so a future non-bare caller of the
  // shared render below would still behave, but bare itself never calls setOpen.
  const isOpen = bare || open;

  const toggle = !bare && (
    <button
      type="button"
      onClick={() => setOpen((prev) => !prev)}
      disabled={isEmpty}
      aria-expanded={open}
      className="text-sand-100 focus-visible:outline-plume disabled:text-sand-400 flex min-w-0 items-center gap-1.5 text-left text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default"
    >
      {open ? (
        <ChevronDown className="size-3.5 shrink-0" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0" />
      )}
      {title}
    </button>
  );

  return (
    <div className={cn(!bare && "border-ink-600 border-t pt-3")}>
      {isOpen ? (
        <JsonWell text={text} label={title} leading={toggle} />
      ) : (
        <>
          <div className="flex items-center gap-2">{toggle}</div>
          {/* The toggle is disabled on an empty value, so "None." must show while collapsed too. */}
          {isEmpty && <p className="text-sand-400 mt-1 text-xs">None.</p>}
        </>
      )}
    </div>
  );
}
