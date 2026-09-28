import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validateJobPayload } from "./payload.js";

describe("validateJobPayload", () => {
  it("passes when there is no schema", () => {
    expect(validateJobPayload(undefined, { anything: "goes" })).toStrictEqual({ ok: true });
  });

  it("passes when the payload matches the schema", () => {
    const schema = z.object({ orderId: z.string() });
    expect(validateJobPayload(schema, { orderId: "abc" })).toStrictEqual({ ok: true });
  });

  it("treats an undefined payload as {} against an empty object schema", () => {
    expect(validateJobPayload(z.object({}), undefined)).toStrictEqual({ ok: true });
  });

  it("treats a null payload as {} against an empty object schema", () => {
    expect(validateJobPayload(z.object({}), null)).toStrictEqual({ ok: true });
  });

  it("tolerates extra keys such as delay on a non-strict object schema", () => {
    const schema = z.object({ orderId: z.string() });
    expect(validateJobPayload(schema, { orderId: "abc", delay: 1000 })).toStrictEqual({
      ok: true,
    });
  });

  it("reports the path and message for a top-level invalid field", () => {
    const schema = z.object({ orderId: z.string() });
    const result = validateJobPayload(schema, { orderId: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toStrictEqual([
      { path: "orderId", message: "Invalid input: expected string, received number" },
    ]);
    expect(result.message).toBe("orderId: Invalid input: expected string, received number");
  });

  it("formats nested and array paths with dots and [n] indices", () => {
    const schema = z.object({
      recipient: z.object({ email: z.string().email() }),
      attachments: z.array(z.object({ color: z.string() })),
    });
    const result = validateJobPayload(schema, {
      recipient: { email: "not-an-email" },
      attachments: [{ color: "red" }, { color: 42 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toStrictEqual([
      { path: "recipient.email", message: "Invalid email address" },
      { path: "attachments[1].color", message: "Invalid input: expected string, received number" },
    ]);
    expect(result.message).toBe(
      "recipient.email: Invalid email address; attachments[1].color: Invalid input: expected string, received number",
    );
  });

  it("reports a rootless path when the whole payload fails validation", () => {
    const schema = z.string();
    const result = validateJobPayload(schema, { not: "a string" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toStrictEqual([
      { path: "", message: "Invalid input: expected string, received object" },
    ]);
    expect(result.message).toBe("Invalid input: expected string, received object");
  });
});
