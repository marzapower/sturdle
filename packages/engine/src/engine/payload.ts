import type { ZodType } from "zod";

export type PayloadIssue = { path: string; message: string };

export type PayloadValidation =
  { ok: true } | { ok: false; message: string; issues: PayloadIssue[] };

/**
 * Formats a zod issue path (segments of string | number | symbol) into a dotted path with
 * numeric indices rendered as `[n]`, e.g. `attachments[0].color`. The root path is an empty
 * string.
 */
function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }
    const key = typeof segment === "symbol" ? segment.toString() : segment;
    return acc ? `${acc}.${key}` : key;
  }, "");
}

/**
 * Validates a job payload against the schema declared by its definition. No schema means
 * nothing to check. `undefined`/`null` payloads are treated as `{}` (events without data).
 * The payload is never transformed: handlers keep receiving the raw data (unknown keys such
 * as `delay` are tolerated by non-strict object schemas).
 */
export function validateJobPayload(
  schema: ZodType | undefined,
  payload: unknown,
): PayloadValidation {
  if (!schema) {
    return { ok: true };
  }

  const data = payload ?? {};
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true };
  }

  const issues: PayloadIssue[] = result.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));

  const message = issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");

  return { ok: false, message, issues };
}
