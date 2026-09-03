import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { orchestrationDurableStateCodec } from "../src/durable-state.js";

const PROJECT_ROOT = "/workspace";
const FIXTURE_ROOT = new URL("./fixtures/orchestration-durable-state/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), "utf8").trimEnd();
}

function fixtureValue(name: string): unknown {
  return JSON.parse(fixture(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

describe("TS-210 orchestration durable-state codec", () => {
  it("round-trips the frozen research writer bytes as a true pre-protocol snapshot", () => {
    const expected = fixture("research-pending.context.v2.json");
    const decoded = orchestrationDurableStateCodec.decodeSnapshot(
      fixtureValue("research-pending.context.v2.json")
    );

    expect(decoded.playbook_state.kind).toBe("research");
    expect(decoded.completion_protocol_version).toBeUndefined();
    expect(canonicalJson(orchestrationDurableStateCodec.encodeSnapshot(decoded))).toBe(expected);
  });

  it("round-trips the frozen path-free KB writer bytes through the KB variant", () => {
    const expected = fixture("knowledge-base-compose.context.v1.json");
    const decoded = orchestrationDurableStateCodec.decodeCheckpoint(
      fixtureValue("knowledge-base-compose.context.v1.json"),
      { playbook: "knowledge-base", projectRoot: PROJECT_ROOT }
    );

    if (decoded.playbook_state.kind !== "knowledge-base") {
      throw new Error("KB fixture did not decode as knowledge-base state");
    }
    expect(decoded.completion_protocol_version).toBeUndefined();
    expect(decoded.playbook_state.data.phases?.ingest?.counts.claim_count).toBe(2);
    const snapshot = orchestrationDurableStateCodec.encodeSnapshot(decoded);
    expect(canonicalJson(orchestrationDurableStateCodec.encodeCheckpoint(snapshot))).toBe(expected);
  });

  it("persists completion protocol v1 in new research and path-free KB snapshots", () => {
    const researchValue = requiredRecord(
      fixtureValue("research-pending.context.v2.json"),
      "research fixture"
    );
    const research = orchestrationDurableStateCodec.decodeSnapshot({
      ...researchValue,
      completion_protocol_version: 1,
    });
    expect(
      orchestrationDurableStateCodec.encodeSnapshot(research).completion_protocol_version
    ).toBe(1);

    const kbValue = requiredRecord(
      fixtureValue("knowledge-base-compose.context.v1.json"),
      "KB fixture"
    );
    const kb = orchestrationDurableStateCodec.decodeCheckpoint(
      { ...kbValue, completion_protocol_version: 1 },
      { playbook: "knowledge-base", projectRoot: PROJECT_ROOT }
    );
    const encodedKb = requiredRecord(
      orchestrationDurableStateCodec.encodeCheckpoint(
        orchestrationDurableStateCodec.encodeSnapshot(kb)
      ),
      "encoded KB checkpoint"
    );
    expect(encodedKb.completion_protocol_version).toBe(1);
    expect(encodedKb).not.toHaveProperty("project_root");
  });

  it("rejects unsupported completion protocol versions", () => {
    const research = requiredRecord(
      fixtureValue("research-pending.context.v2.json"),
      "research fixture"
    );
    expect(() =>
      orchestrationDurableStateCodec.decodeSnapshot({
        ...research,
        completion_protocol_version: 2,
      })
    ).toThrow("checkpoint context failed schema validation");

    const kb = requiredRecord(fixtureValue("knowledge-base-compose.context.v1.json"), "KB fixture");
    expect(() =>
      orchestrationDurableStateCodec.decodeCheckpoint(
        { ...kb, completion_protocol_version: 2 },
        { playbook: "knowledge-base", projectRoot: PROJECT_ROOT }
      )
    ).toThrow("checkpoint context failed schema validation");
  });

  it("preserves the established open playbook-data policy without opening top-level state", () => {
    const value = requiredRecord(
      fixtureValue("knowledge-base-compose.context.v1.json"),
      "KB fixture"
    );
    const playbookData = requiredRecord(value.playbook_data, "KB playbook_data");
    playbookData.future_metadata = { generation: 3, retained: true };

    const decoded = orchestrationDurableStateCodec.decodeCheckpoint(value, {
      playbook: "knowledge-base",
      projectRoot: PROJECT_ROOT,
    });
    const encoded = requiredRecord(
      orchestrationDurableStateCodec.encodeCheckpoint(
        orchestrationDurableStateCodec.encodeSnapshot(decoded)
      ),
      "encoded KB checkpoint"
    );
    const encodedPlaybookData = requiredRecord(encoded.playbook_data, "encoded KB playbook_data");
    expect(encodedPlaybookData.future_metadata).toEqual({ generation: 3, retained: true });

    const withTopLevelExtra = { ...value, future_state: true };
    expect(() =>
      orchestrationDurableStateCodec.decodeCheckpoint(withTopLevelExtra, {
        playbook: "knowledge-base",
        projectRoot: PROJECT_ROOT,
      })
    ).toThrow("KB durable projection fields or version are invalid");
  });

  it("rejects malformed known KB metadata and guards the typed accessor by discriminant", () => {
    const malformed = requiredRecord(
      fixtureValue("knowledge-base-compose.context.v1.json"),
      "KB fixture"
    );
    const playbookData = requiredRecord(malformed.playbook_data, "KB playbook_data");
    playbookData.source_ids = [7];
    expect(() =>
      orchestrationDurableStateCodec.decodeCheckpoint(malformed, {
        playbook: "knowledge-base",
        projectRoot: PROJECT_ROOT,
      })
    ).toThrow("checkpoint knowledge-base playbook_data failed schema validation");

    const writable = RunContext.fromCheckpoint(
      fixtureValue("knowledge-base-compose.context.v1.json"),
      { playbook: "knowledge-base", projectRoot: PROJECT_ROOT }
    );
    writable.playbookData.source_ids = [7];
    expect(() => writable.snapshot()).toThrow(
      "checkpoint knowledge-base playbook_data failed schema validation"
    );

    const research = RunContext.fromSnapshot(fixtureValue("research-pending.context.v2.json"));
    expect(() => research.knowledgeBaseData).toThrow("is not a knowledge-base run");
  });
});
