import type * as React from "react";

import type { JobDetail } from "../types.js";
import { formatAbsolute, formatShortId } from "../lib/format.js";
import { jobPath, taskPath } from "../lib/paths.js";

export interface JobFactsProps {
  job: JobDetail;
  deadLetter: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <dt className="text-sand-400 shrink-0">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Timestamp({ value }: { value: number | string | null | undefined }) {
  if (value === null || value === undefined)
    return <span className="text-sand-400 text-xs">—</span>;
  return <span className="font-mono text-xs tabular-nums">{formatAbsolute(value)}</span>;
}

function JobLink({ id }: { id: string }) {
  return (
    <a
      href={jobPath(id)}
      className="text-plume font-mono text-xs underline-offset-4 hover:underline"
    >
      {formatShortId(id)}
    </a>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shortens a concurrency key's value part when it's a uuid; the code prefix always stays whole. */
function formatConcurrencyKey(key: string): string {
  const separatorIndex = key.indexOf(":");
  if (separatorIndex === -1) return key;
  const code = key.slice(0, separatorIndex);
  const value = key.slice(separatorIndex + 1);
  return `${code}:${UUID_RE.test(value) ? formatShortId(value) : value}`;
}

/**
 * Job detail's "Facts" panel: task, id, queue, attempts and the timeline's key timestamps, plus
 * the parent/children relations.
 *
 * `startedAt` on `JobDetail` is the job's LAST claim, not its first: the first attempt's own
 * `startedAt` is the true start. Symmetrically, `completedAt` is null on a failed job (there is no
 * `failedAt`), so the last attempt's `endedAt` is the real finish time. No "total" row — the
 * Execution timeline's own header already shows the run's total duration.
 */
export function JobFacts({ job, deadLetter }: JobFactsProps) {
  const started = job.attempts?.[0]?.startedAt ?? job.startedAt;
  const finished = job.attempts?.at(-1)?.endedAt ?? job.completedAt;

  return (
    <dl className="space-y-2 text-sm">
      <Row label="Task">
        <a
          href={taskPath(job.code)}
          className="text-plume font-mono text-xs underline-offset-4 hover:underline"
        >
          {job.code}
        </a>
      </Row>
      <Row label="Job id">
        <span className="font-mono text-xs" title={job.id}>
          {formatShortId(job.id)}
        </span>
      </Row>
      <Row label="Queue">
        <span>{job.queue}</span>
      </Row>
      <Row label="Priority">
        <span className="tabular-nums">{job.priority}</span>
      </Row>
      {job.concurrencyKey && (
        <Row label="Concurrency">
          <span className="font-mono text-xs" title={job.concurrencyKey}>
            {formatConcurrencyKey(job.concurrencyKey)}
          </span>
          {job.concurrencyLimit != null && (
            <span className="text-sand-400 ml-1.5 text-xs">limit {job.concurrencyLimit}</span>
          )}
        </Row>
      )}
      <Row label="Attempts">
        <span className="tabular-nums">
          {job.attempt}/{job.maxAttempts}
        </span>
        {deadLetter && <span className="text-sand-400 ml-1.5 text-xs">dead letter</span>}
      </Row>
      <Row label="Created">
        <Timestamp value={job.createdAt} />
      </Row>
      <Row label="Started">
        <Timestamp value={started} />
      </Row>
      <Row label="Finished">
        <Timestamp value={finished} />
      </Row>
      <Row label="Parent">
        {job.parentJobId ? (
          <JobLink id={job.parentJobId} />
        ) : (
          <span className="text-sand-400 text-xs">None</span>
        )}
      </Row>
      <Row label="Children">
        {job.childJobIds.length === 0 ? (
          <span className="text-sand-400 text-xs">None</span>
        ) : (
          <ul className="space-y-1">
            {job.childJobIds.map((childId) => (
              <li key={childId}>
                <JobLink id={childId} />
              </li>
            ))}
          </ul>
        )}
      </Row>
    </dl>
  );
}
