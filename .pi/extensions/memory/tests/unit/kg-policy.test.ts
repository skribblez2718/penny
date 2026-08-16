import { describe, expect, it, vi } from "vitest";

import {
  CANONICAL_KG_PREDICATES,
  KG_PREDICATE_SCHEMA_VERSION,
  MemoryAdapter,
} from "../../index.js";
import { mcpResponse, requestBody, testConfig } from "../fixtures.js";

function payloadOf(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe("canonical KG predicate policy", () => {
  it("is explicitly versioned and contains the documented canonical vocabulary", () => {
    expect(KG_PREDICATE_SCHEMA_VERSION).toBe(1);
    expect(CANONICAL_KG_PREDICATES).toContain("decided");
    expect(CANONICAL_KG_PREDICATES).toContain("generated_from");
    expect(CANONICAL_KG_PREDICATES).toContain("fixes");
  });

  it.each(["kg_add", "kg_invalidate", "kg_supersede"] as const)(
    "rejects an unknown predicate before HTTP for %s",
    async (operation) => {
      const fetchSpy = vi.fn();
      const adapter = new MemoryAdapter(testConfig(), { fetch: fetchSpy as typeof fetch });
      const params =
        operation === "kg_supersede"
          ? {
              subject: "Penny",
              predicate: "invented_predicate",
              old_object: "old",
              new_object: "new",
            }
          : {
              subject: "Penny",
              predicate: "invented_predicate",
              object: "value",
            };
      const execution = await adapter.execute(operation, params, { callerId: "primary:kg" });
      expect(payloadOf(execution.result).error.code).toBe("MEMPALACE_INVALID");
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it("forwards canonical supersede to the supported upstream operation", async () => {
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      return Promise.resolve(mcpResponse(request.id, { success: true, triple_id: "kg-1" }));
    });
    const adapter = new MemoryAdapter(testConfig(), { fetch: fetchSpy as typeof fetch });
    const execution = await adapter.execute(
      "kg_supersede",
      {
        subject: "Penny",
        predicate: "uses",
        old_object: "old-model",
        new_object: "new-model",
        at: "2026-08-15",
      },
      { callerId: "primary:kg" }
    );
    expect(execution.code).toBe("OK");
    const request = requestBody(fetchSpy.mock.calls[0]![1] as RequestInit);
    expect(request.params.name).toBe("mempalace_kg_supersede");
    expect(request.params.arguments.predicate).toBe("uses");
  });
});
