import { Logger } from "./logger.js";

/**
 * Engine-level events the host application can subscribe to via `EngineOptions.onEvent`. This is
 * the engine's only integration point for error tracking / observability: the engine itself
 * never talks to a vendor SDK directly.
 */
export type EngineEvent =
  | { type: "job.error"; jobId: string; code: string; attempt: number; error: unknown }
  | { type: "job.dropped"; jobId: string; code: string; reason: "queue-overflow" }
  | { type: "job.dead-lettered"; jobId: string; code: string; attempts: number; error: string }
  | { type: "job.assignment-error"; jobId: string; code: string; error: unknown }
  | { type: "hook.error"; jobId: string; code: string; hook: "onDeadLetter"; error: unknown }
  | { type: "engine.error"; error: unknown; jobId?: string; code?: string };

export type EngineEventListener = (event: EngineEvent) => void;

const log = Logger.ns("Sturdle").tagged("Telemetry");

/**
 * Calls `listener` with `event`, catching and logging (never propagating) whatever the listener
 * itself throws: a broken telemetry hook must never take down job processing.
 */
export function emitEngineEvent(
  listener: EngineEventListener | undefined,
  event: EngineEvent,
): void {
  if (!listener) return;

  try {
    listener(event);
  } catch (error) {
    log.warn("onEvent listener threw", error);
  }
}
