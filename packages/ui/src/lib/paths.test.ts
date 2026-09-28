import { describe, expect, it } from "vitest";

import { jobPath, JOBS_PATH, taskCodeFromSplat, taskPath, TASKS_PATH } from "./paths.js";

describe("jobPath", () => {
  it("prefixes the jobs path and encodes the id", () => {
    expect(jobPath("abc-123")).toBe(`${JOBS_PATH}/abc-123`);
  });

  it("encodes characters that would otherwise break the URL", () => {
    expect(jobPath("id with spaces")).toBe(`${JOBS_PATH}/id%20with%20spaces`);
  });
});

describe("taskPath", () => {
  it("prefixes the tasks path for a plain code", () => {
    expect(taskPath("send-email")).toBe(`${TASKS_PATH}/send-email`);
  });

  it("preserves slashes between segments", () => {
    expect(taskPath("billing/invoice.sync")).toBe(`${TASKS_PATH}/billing/invoice.sync`);
  });

  it("encodes each segment on its own, dots included", () => {
    expect(taskPath("a b/c.d")).toBe(`${TASKS_PATH}/a%20b/c.d`);
  });
});

describe("taskCodeFromSplat", () => {
  // A router that decodes the URL before handing back the splat (see the doc comment on
  // taskCodeFromSplat) means the splat this function receives is already the decoded code,
  // not a slice of the encoded URL.

  it("returns a plain code unchanged", () => {
    expect(taskCodeFromSplat("send-email")).toBe("send-email");
  });

  it("returns a code with slashes unchanged", () => {
    expect(taskCodeFromSplat("billing/invoice.sync")).toBe("billing/invoice.sync");
  });

  it("returns a code with spaces and dots unchanged", () => {
    expect(taskCodeFromSplat("a b/c.d")).toBe("a b/c.d");
  });

  it("does not double-decode a literal % in the code", () => {
    const code = "foo%bar";
    expect(taskPath(code)).toBe(`${TASKS_PATH}/foo%25bar`);
    // A router decodes "foo%25bar" back to "foo%bar" before this function ever sees it.
    expect(taskCodeFromSplat(code)).toBe(code);
  });

  it("strips a trailing slash", () => {
    expect(taskCodeFromSplat("billing/invoice.sync/")).toBe("billing/invoice.sync");
  });

  it("returns null for an empty splat", () => {
    expect(taskCodeFromSplat("")).toBeNull();
  });

  it("returns null for an undefined splat", () => {
    expect(taskCodeFromSplat(undefined)).toBeNull();
  });
});
