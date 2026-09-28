import { cn } from "../lib/cn.js";

export interface WorkerMeterProps {
  /** Number of slots currently processing a job. */
  busy: number;
  /** Total slots. */
  total: number;
  /**
   * What a block stands for, spelled out in the accessible name: the engine's worker pool
   * ("workers") or one queue's concurrency ("queue slots"). The two are different numbers.
   */
  unit?: "workers" | "queue slots";
  className?: string;
}

/**
 * A row of small blocks, one per slot: plume when busy, a dim ink-500 block when idle. Idle slots
 * are filled rather than outlined so an idle engine still reads as "ten slots, none busy" instead
 * of a row of empty boxes.
 */
export function WorkerMeter({ busy, total, unit = "workers", className }: WorkerMeterProps) {
  const slots = Math.max(total, 0);

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      role="img"
      aria-label={`${busy} of ${slots} ${unit} busy`}
    >
      {Array.from({ length: slots }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn("h-3.5 w-1.5 rounded-[1.5px]", i < busy ? "bg-plume" : "bg-ink-500")}
        />
      ))}
    </div>
  );
}
