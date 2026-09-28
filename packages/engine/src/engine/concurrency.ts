import type { ConcurrencyConfig } from "../types.js";

export interface ResolvedConcurrency {
  key: string;
  limit: number;
}

/**
 * Reads a dotted path ("a.b") from a plain object. Returns undefined as soon as any segment along
 * the path is missing (the value at that point is undefined, or is not a plain-enough object to
 * keep walking into).
 */
export function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = payload;

  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function assertValidLimit(code: string, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `Invalid concurrency limit for "${code}": limit must be an integer >= 1, got ${limit}`,
    );
  }
}

/**
 * Resolves a task's declared `concurrency` (see FunctionDefinition) into a concrete key and
 * limit, given the job's payload:
 * - a plain number n: global limit for the task, key = the task's own code
 * - { limit, key }: per-value limit, key = `${code}:${String(value ?? "")}` where value is read
 *   from the payload at the dotted path `key`
 * - { limit } (no key): global limit for the task, key = the task's own code
 * - undefined: no constraint, returns null
 * Throws when a declared limit is not an integer >= 1.
 */
export function resolveConcurrency(
  code: string,
  concurrency: number | ConcurrencyConfig | undefined,
  payload: Record<string, unknown>,
): ResolvedConcurrency | null {
  if (concurrency === undefined) {
    return null;
  }

  if (typeof concurrency === "number") {
    assertValidLimit(code, concurrency);
    return { key: code, limit: concurrency };
  }

  assertValidLimit(code, concurrency.limit);

  if (concurrency.key === undefined) {
    return { key: code, limit: concurrency.limit };
  }

  const value = readPayloadPath(payload, concurrency.key);
  // The payload value at an arbitrary dotted path can be anything; the key only needs a stable
  // textual form of it (any value stringifies deterministically, even if not human-friendly).
  return { key: `${code}:${String(value ?? "")}`, limit: concurrency.limit };
}
