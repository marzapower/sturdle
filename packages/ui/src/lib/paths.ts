// Relative imports only: this package has no path alias, and consumers render every link
// with a plain `<a href>` built from these strings (no router dependency).

export const TASKS_PATH = "/tasks";
export const JOBS_PATH = "/jobs";

/** A job's detail page. */
export function jobPath(id: string): string {
  return `${JOBS_PATH}/${encodeURIComponent(id)}`;
}

/**
 * A task's detail page. Task codes can contain slashes (e.g. "billing/invoice.sync"); each
 * "/"-separated segment is encoded on its own so the slashes themselves stay literal in the
 * path, matching a splat route that reads them back with `taskCodeFromSplat`.
 */
export function taskPath(code: string): string {
  return `${TASKS_PATH}/${code.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Reads back a task code from a `/tasks/*` splat param on a router that decodes the whole
 * pathname (per "/"-separated segment) before handing back the splat — so the value this
 * function receives is already decoded, and decoding it again would corrupt a code
 * containing a literal `%` (e.g. `taskPath("foo%bar")` -> `/tasks/foo%25bar` -> the router
 * hands back `"foo%bar"`; a second `decodeURIComponent` would throw on the bare `%ba`).
 * A trailing slash (an empty last segment) is stripped, matching how `taskPath` never
 * produces one.
 */
export function taskCodeFromSplat(splat: string | undefined): string | null {
  if (!splat) return null;
  const code = splat.endsWith("/") ? splat.slice(0, -1) : splat;
  return code || null;
}
