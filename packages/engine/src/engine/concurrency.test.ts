import { describe, expect, it } from "vitest";

import { readPayloadPath, resolveConcurrency } from "./concurrency.js";

describe("readPayloadPath", () => {
  it("reads a flat key", () => {
    expect(readPayloadPath({ orderId: "abc" }, "orderId")).toBe("abc");
  });

  it("reads a nested key", () => {
    expect(readPayloadPath({ data: { userId: "42" } }, "data.userId")).toBe("42");
  });

  it("returns undefined when a segment is missing", () => {
    expect(readPayloadPath({}, "orderId")).toBeUndefined();
    expect(readPayloadPath({ data: {} }, "data.userId")).toBeUndefined();
    expect(readPayloadPath({ data: null }, "data.userId")).toBeUndefined();
  });
});

describe("resolveConcurrency", () => {
  it("returns null when concurrency is not declared", () => {
    expect(resolveConcurrency("send-email", undefined, {})).toBeNull();
  });

  it("resolves a plain number as a global limit keyed by the code", () => {
    expect(resolveConcurrency("send-email", 2, {})).toStrictEqual({
      key: "send-email",
      limit: 2,
    });
  });

  it("resolves { limit, key } into a key that includes the payload value", () => {
    expect(
      resolveConcurrency(
        "orders/orderEmails.sendEmail",
        { limit: 1, key: "orderId" },
        { orderId: "o1" },
      ),
    ).toStrictEqual({ key: "orders/orderEmails.sendEmail:o1", limit: 1 });
  });

  it("resolves { limit, key } with a missing payload value into a key with an empty value", () => {
    expect(resolveConcurrency("send-email", { limit: 1, key: "orderId" }, {})).toStrictEqual({
      key: "send-email:",
      limit: 1,
    });
  });

  it("resolves { limit, key } with a nested payload path", () => {
    expect(
      resolveConcurrency(
        "send-email",
        { limit: 1, key: "data.userId" },
        { data: { userId: "u1" } },
      ),
    ).toStrictEqual({ key: "send-email:u1", limit: 1 });
  });

  it("resolves { limit } without a key as a global limit keyed by the code", () => {
    expect(resolveConcurrency("send-email", { limit: 3 }, {})).toStrictEqual({
      key: "send-email",
      limit: 3,
    });
  });

  it("throws when the limit is not an integer", () => {
    expect(() => resolveConcurrency("send-email", 1.5, {})).toThrow(/send-email/);
    expect(() => resolveConcurrency("send-email", { limit: 1.5 }, {})).toThrow(/send-email/);
  });

  it("throws when the limit is less than 1", () => {
    expect(() => resolveConcurrency("send-email", 0, {})).toThrow(/send-email/);
    expect(() => resolveConcurrency("send-email", { limit: -1 }, {})).toThrow(/send-email/);
  });
});
