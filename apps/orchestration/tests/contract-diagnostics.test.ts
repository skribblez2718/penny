import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { Settings } from "typebox/system";
import { describe, expect, it } from "vitest";

import { ContractValidationError, validateContract } from "../dist/contracts.js";

function rejection(schema: TSchema, value: unknown): ContractValidationError {
  try {
    validateContract(schema, value, "test boundary");
  } catch (error) {
    if (error instanceof ContractValidationError) return error;
    throw error;
  }
  throw new Error("malformed input was accepted");
}

const closed = Type.Object({ known: Type.String() }, { additionalProperties: false });
const secret = "REJECTED_VALUE_MUST_NEVER_APPEAR";

// This is executable disclosure coverage: inspect both Error.message and its issues,
// not just rejection. Raw TypeBox paths/params are deliberately hostile in these cases.
describe("privacy-safe contract diagnostics", () => {
  it("names an unknown safe field without its value or the rejected object", () => {
    const value = { known: secret, unexpected_field: { body: secret } };
    const error = rejection(closed, value);
    expect(error.issues).toEqual(["/: must not have additional properties: unexpected_field"]);
    expect(error.message).toContain("unexpected_field");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(JSON.stringify(value));
  });

  it.each([
    "private/key_material",
    "private~1key_material",
    "private.key_material",
    "private-key-material",
    "private key material",
    "private\nkey_material",
    "private\u001b[31mkey_material",
    "private\u202ekey_material",
    "private🔒key_material",
    "private_" + "x".repeat(256),
    "__proto__",
    "constructor",
    "prototype",
  ])("redacts an entire unsafe or oversized property name (%#)", (key) => {
    const error = rejection(closed, { known: "ok", [key]: secret });
    expect(error.issues).toEqual(["/: must not have additional properties: [redacted]"]);
    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain(secret);
  });

  it("reports nested union/additionalProperties failures without sentinel key leaks", () => {
    const schema = Type.Union([
      Type.Object({ kind: Type.Literal("one"), child: closed }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("two") }, { additionalProperties: false }),
    ]);
    const error = rejection(schema, {
      kind: "one",
      child: { known: "ok", extra_field: secret, "unsafe/key_material": secret },
      extra_field: secret,
    });
    expect(error.issues).toContain(
      "/child: must not have additional properties: extra_field, [redacted]"
    );
    expect(error.message).not.toContain("schema is false");
    expect(error.message).not.toContain("unsafe");
    expect(error.message).not.toContain("key_material");
    expect(error.message).not.toContain(secret);
  });

  it("does not expose record keys through instance paths, even slash-separated safe words", () => {
    const schema = Type.Object({ records: Type.Record(Type.String(), closed) });
    const error = rejection(schema, {
      records: { "private/key_material": { known: 1, extra_field: secret } },
    });
    expect(error.message).toContain("extra_field");
    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain("key_material");
    expect(error.message).not.toContain(secret);
  });

  it("does not forward propertyNames payloads or free-form refinement messages", () => {
    const names = Type.Object({}, { propertyNames: { pattern: "^allowed$" } });
    const namesError = rejection(names, { "private/key_material": secret });
    expect(namesError.message).toContain("propertyNames constraint failed");
    expect(namesError.message).not.toContain("private");
    const refined = Type.Refine(
      Type.String(),
      (value) => value === "ok",
      (value) => value
    );
    // Confirm the library itself carries the rejected value in its diagnostic.
    expect(Value.Errors(refined, secret).some((issue) => issue.message.includes(secret))).toBe(
      true
    );
    expect(rejection(refined, secret).message).not.toContain(secret);
  });

  it("bounds many names and many issues without weakening rejection", () => {
    const value = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, secret])
    );
    // The library defaults to buffering only eight errors. Exercise the formatter
    // independently of that host setting, then restore it for subsequent tests.
    const settings = { ...Settings.Get() };
    try {
      Settings.Set({ maxErrors: 1000 });
      const namesError = rejection(Type.Object({}, { additionalProperties: false }), value);
      expect(namesError.message).toContain("field_7");
      expect(namesError.message).not.toContain("field_8");
      expect(namesError.message).toContain("additional names omitted");
      const many = Type.Object(
        Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [`field_${index}`, Type.String()])
        )
      );
      const malformed = Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [`field_${index}`, 0])
      );
      const error = rejection(many, malformed);
      expect(error.issues.join("; ").length).toBeLessThanOrEqual(4096);
      expect(error.message).toContain("additional validation issues omitted");
      expect(error.message).not.toContain(secret);
    } finally {
      Settings.Set(settings);
    }
  });

  it("retains safe locations and useful required/type failures, with a safe lone sentinel", () => {
    const error = rejection(Type.Object({ child: closed }), { child: { known: 1 } });
    expect(error.issues).toContain("/child/known: must be string");
    expect(rejection(closed, {}).issues).toContain("/: must have required properties known");
    const unsafeKeys = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`private/key_${index}`, secret])
    );
    expect(rejection(Type.Object({}, { additionalProperties: false }), unsafeKeys).issues).toEqual([
      "/: schema is false",
    ]);
    expect(validateContract(closed, { known: "ok" }, "test boundary")).toEqual({ known: "ok" });
  });
});
