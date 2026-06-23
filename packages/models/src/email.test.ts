import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEmail } from "@drfed/models/email";

describe("normalizeEmail()", () => {
  it("with valid email", () => {
    assert.deepEqual(normalizeEmail("test@example.com"), "test@example.com");
    assert.deepEqual(
      normalizeEmail("  test@example.com  "),
      "test@example.com",
    );
    assert.deepEqual(normalizeEmail("Test@EXAMPLE.COM"), "Test@example.com");
    assert.deepEqual(
      normalizeEmail("user@中文.example"),
      "user@xn--fiq228c.example",
    );
  });

  it("with null and undefined", () => {
    assert.deepEqual(normalizeEmail(null), null);
    assert.deepEqual(normalizeEmail(undefined), undefined);
  });

  it("with invalid email", () => {
    assert.throws(
      () => normalizeEmail("invalid"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
    assert.throws(
      () => normalizeEmail("@example.com"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
    assert.throws(
      () => normalizeEmail("test@"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
    assert.throws(
      () => normalizeEmail("test@example@com"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
  });
});
