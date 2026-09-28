import type { ZodType } from "zod";

export type Payload = Record<string, unknown>;

/**
 * A limit on how many jobs of a given task may run at once.
 * `limit`: max concurrent executions.
 * `key`: a dotted path into the job payload (e.g. "orderId", "data.userId"); when present, the
 * limit applies per distinct value of that path instead of globally across the whole task.
 */
export type ConcurrencyConfig = { limit: number; key?: string };

export interface TaskEvent<TPayload = Payload> {
  data: TPayload;
  id?: string;
  name: string;
  ts?: number;
}

export interface FunctionContext<TPayload = Payload> {
  event: TaskEvent<TPayload>;
  step: {
    run: <T>(name: string, fn: () => T | Promise<T>) => Promise<T>;
    sleep: (name: string, ms: number) => Promise<void>;
    sleepUntil: (name: string, date: Date | string) => Promise<void>;
    sendEvent: (id: string, event: TaskEvent<void | Payload>) => Promise<void>;
  };
  logger?: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
}

export interface FunctionDefinition<TPayload = Payload> {
  id?: string;
  name: string;
  func: (ctx: FunctionContext<TPayload>) => Promise<unknown>;
  event?: string;
  cron?: string;
  queue?: string;
  /** number = a global limit for the task's code; ConcurrencyConfig = a limit per payload key value (see ConcurrencyConfig). */
  concurrency?: number | ConcurrencyConfig;
  // Runtime contract of the event payload, validated by the engine before running the handler; absent on crons.
  payloadSchema?: ZodType;
  /** Called by the dispatcher once the job is dead-lettered (max attempts or non-retriable). */
  onDeadLetter?: (ctx: {
    payload: TPayload;
    error: string;
    jobId: string;
    attempts: number;
  }) => Promise<void>;
}
