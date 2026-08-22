import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { jcsCanonicalize } from "../src/kb/approval-receipts.js";
import { sha256Hex } from "../src/kb/contracts.js";
import { KB_PHASE_TOOL_MATRIX } from "../src/kb/session-tools.js";
import {
  G8_SMOKE_MANIFEST_PATH,
  G8_SMOKE_RESULT_PATH,
  g8SmokeCohortIssueCodes,
  g8SmokeScheduledPairs,
  loadG8SmokeCohortManifest,
  loadG8SmokeResultReceipt,
  parseG8SmokeCohortManifestJcs,
  parseG8SmokeResultReceiptJcs,
  type G8SmokePairReceipt,
  type G8SmokeResultReceipt,
  type G8SmokeScheduledPair,
  type G8SmokeToolMatrix,
} from "./kb-model-smoke-contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const toolMatrix = [
  { phase: "query", tools: [...KB_PHASE_TOOL_MATRIX.query] },
  { phase: "verify", tools: [...KB_PHASE_TOOL_MATRIX.verify] },
] as const satisfies G8SmokeToolMatrix;
const resultReceiptExists = existsSync(path.join(repoRoot, G8_SMOKE_RESULT_PATH));

function phaseMetrics() {
  return {
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    input_tokens: 1,
    output_tokens: 1,
    protocol_error_codes: [],
    tool_errors: 0,
    tool_events: 1,
    total_tokens: 2,
    turn_events: 1,
  };
}

function passingPair(pair: G8SmokeScheduledPair): G8SmokePairReceipt {
  return {
    case_id: pair.case_id,
    execution_count: 1,
    pair_id: pair.pair_id,
    repetition: pair.repetition,
    run_id: `run_kb_model_smoke_${pair.case_id.replace(/-/gu, "_")}_r${pair.repetition}`,
    terminal: { action: "complete", met: true, observed: true, status: "complete" },
    phases: [
      {
        agent: "synthia",
        artifact_lifecycle: "sealed",
        observed: true,
        parent_persistence_matches: true,
        state_id: "query",
        metrics: phaseMetrics(),
      },
      {
        agent: "vera",
        artifact_lifecycle: "sealed",
        observed: true,
        parent_persistence_matches: true,
        state_id: "verify",
        metrics: phaseMetrics(),
      },
    ],
    metrics: {
      bad_answer: false,
      bad_reasons: [],
      candidate_count: 1,
      child_session_files_created: 0,
      duration_ms: 1,
      event_count: 1,
      log_capture_count: 0,
      privacy_incidents: 0,
      protocol_issues: 0,
      receipt_count: 2,
    },
  };
}

function withPayloadDigest(
  receipt: G8SmokeResultReceipt,
  mutate: (value: G8SmokeResultReceipt) => G8SmokeResultReceipt
): G8SmokeResultReceipt {
  const mutated = mutate(structuredClone(receipt));
  const { receipt_payload_sha256: _prior, ...payload } = mutated;
  return {
    ...payload,
    receipt_payload_sha256: sha256Hex(jcsCanonicalize(payload)),
  } as G8SmokeResultReceipt;
}

describe("predeclared stable G8 qwen smoke cohort", () => {
  it("strict-loads one exact-JCS manifest with the frozen review bindings", () => {
    const loaded = loadG8SmokeCohortManifest(repoRoot);
    expect(loaded.sha256).toBe("37145abe042b717ce07a49211e613dd0afb4e9543966e2c57eed51545cf76847");
    expect(loaded.bytes).toBe(jcsCanonicalize(loaded.manifest));
    expect(loaded.manifest).toEqual({
      bad_answer_ceiling: 0,
      case_ids: ["sqlite-query", "typebox-query", "cross-query"],
      cohort_id: "g8-qwen3.8-stable-final-carren",
      fixture: {
        path: "apps/orchestration/tests/fixtures/kb-retrieval.json",
        sha256: "c3d91aa0c414a0ebc68499e8a476b5d829e5434f2bf14595f9d35651bc02dc29",
      },
      model: "ollama/qwen3.8:latest",
      per_phase_timeout_ms: 300_000,
      post_start_exclusions: 0,
      post_start_retries: 0,
      privacy_incident_ceiling: 0,
      repetitions: 2,
      scheduled_pair_count: 6,
      schema_version: 1,
      thinking_level: "off",
    });
    expect(readFileSync(path.join(repoRoot, G8_SMOKE_MANIFEST_PATH), "utf8")).toBe(loaded.bytes);
  });

  it("rejects duplicate members, non-JCS bytes, unknown keys, and every frozen binding drift", () => {
    const { manifest, bytes } = loadG8SmokeCohortManifest(repoRoot);
    expect(() =>
      parseG8SmokeCohortManifestJcs(
        bytes.replace('{"bad_answer_ceiling":0', '{"bad_answer_ceiling":0,"bad_answer_ceiling":0')
      )
    ).toThrow(/duplicate/u);
    expect(() => parseG8SmokeCohortManifestJcs(JSON.stringify(manifest, null, 2))).toThrow(
      /exact JCS/u
    );
    const mutations: unknown[] = [
      { ...manifest, extra: true },
      { ...manifest, model: "ollama/another-model" },
      { ...manifest, thinking_level: "low" },
      { ...manifest, per_phase_timeout_ms: 299_999 },
      { ...manifest, repetitions: 1 },
      { ...manifest, scheduled_pair_count: 5 },
      { ...manifest, post_start_exclusions: 1 },
      { ...manifest, post_start_retries: 1 },
      { ...manifest, bad_answer_ceiling: 1 },
      { ...manifest, privacy_incident_ceiling: 1 },
      { ...manifest, case_ids: ["sqlite-query", "typebox-query"] },
      { ...manifest, fixture: { ...manifest.fixture, sha256: "0".repeat(64) } },
    ];
    for (const mutation of mutations) {
      expect(() => parseG8SmokeCohortManifestJcs(jcsCanonicalize(mutation))).toThrow();
    }
  });

  it("schedules all and only six case/repetition pairs once in frozen order", () => {
    const { manifest } = loadG8SmokeCohortManifest(repoRoot);
    expect(g8SmokeScheduledPairs(manifest)).toEqual([
      { pair_id: "sqlite-query#1", case_id: "sqlite-query", repetition: 1 },
      { pair_id: "sqlite-query#2", case_id: "sqlite-query", repetition: 2 },
      { pair_id: "typebox-query#1", case_id: "typebox-query", repetition: 1 },
      { pair_id: "typebox-query#2", case_id: "typebox-query", repetition: 2 },
      { pair_id: "cross-query#1", case_id: "cross-query", repetition: 1 },
      { pair_id: "cross-query#2", case_id: "cross-query", repetition: 2 },
    ]);
  });

  it("fails closed on missing/duplicate, nonterminal, bad, privacy, exclusion, or retry evidence", () => {
    const { manifest } = loadG8SmokeCohortManifest(repoRoot);
    const passing = g8SmokeScheduledPairs(manifest).map(passingPair);
    expect(
      g8SmokeCohortIssueCodes({ manifest, pairs: passing, excludedPairs: 0, retries: 0 })
    ).toEqual([]);

    const duplicate = passing.map((pair, index) => (index === 5 ? passing[0]! : pair));
    expect(
      g8SmokeCohortIssueCodes({ manifest, pairs: duplicate, excludedPairs: 1, retries: 1 })
    ).toEqual([
      "missing_or_duplicate_pair",
      "pair_contract_failure",
      "post_start_exclusion_detected",
      "post_start_retry_detected",
    ]);

    const failing = passing.map((pair, index) =>
      index === 0
        ? {
            ...pair,
            terminal: { ...pair.terminal, observed: false },
            metrics: { ...pair.metrics, bad_answer: true, privacy_incidents: 1 },
          }
        : pair
    );
    expect(
      g8SmokeCohortIssueCodes({ manifest, pairs: failing, excludedPairs: 0, retries: 0 })
    ).toEqual([
      "nonterminal_pair",
      "pair_contract_failure",
      "bad_answer_ceiling_exceeded",
      "privacy_incident_ceiling_exceeded",
    ]);
  });
});

describe.skipIf(!resultReceiptExists)("actual ignored G8 qwen smoke receipt", () => {
  it("strict-parses the exact JCS receipt and matching SHA sidecar", () => {
    const loaded = loadG8SmokeResultReceipt(repoRoot, toolMatrix);
    expect(loaded.sha256).toBe("a0890c5dd528deb527fed2ff6ee89c2cec13f581b7e9d56fef2dbd413e50a313");
    expect(loaded.bytes).toBe(jcsCanonicalize(loaded.receipt));
    expect(loaded.receipt.pairs.map((pair) => pair.pair_id)).toEqual(
      g8SmokeScheduledPairs(loadG8SmokeCohortManifest(repoRoot).manifest).map(
        (pair) => pair.pair_id
      )
    );
  });

  it("rejects forged incomplete, met:false, and empty-phase receipts after digest recomputation", () => {
    const loaded = loadG8SmokeResultReceipt(repoRoot, toolMatrix);
    const { manifest } = loadG8SmokeCohortManifest(repoRoot);
    const forged = [
      withPayloadDigest(loaded.receipt, (receipt) => {
        receipt.pairs[0]!.terminal.action = "incomplete";
        receipt.pairs[0]!.terminal.status = "incomplete";
        receipt.pairs[0]!.terminal.met = false;
        return receipt;
      }),
      withPayloadDigest(loaded.receipt, (receipt) => {
        receipt.pairs[0]!.terminal.met = false;
        return receipt;
      }),
      withPayloadDigest(loaded.receipt, (receipt) => {
        receipt.pairs[0]!.phases = [];
        return receipt;
      }),
    ];
    for (const receipt of forged) {
      expect(() =>
        parseG8SmokeResultReceiptJcs(jcsCanonicalize(receipt), manifest, toolMatrix)
      ).toThrow(/pair contract/u);
    }
  });

  it("rejects a forged manifest binding even when both payload digests are recomputed", () => {
    const loaded = loadG8SmokeResultReceipt(repoRoot, toolMatrix);
    const { manifest } = loadG8SmokeCohortManifest(repoRoot);
    const forged = withPayloadDigest(loaded.receipt, (receipt) => {
      receipt.manifest_matrix[0].sha256 = "f".repeat(64);
      return receipt;
    });
    expect(() =>
      parseG8SmokeResultReceiptJcs(jcsCanonicalize(forged), manifest, toolMatrix)
    ).toThrow(/manifest binding/u);
  });

  it("rejects non-JCS receipt bytes independently of schema and payload digest", () => {
    const loaded = loadG8SmokeResultReceipt(repoRoot, toolMatrix);
    const { manifest } = loadG8SmokeCohortManifest(repoRoot);
    expect(() =>
      parseG8SmokeResultReceiptJcs(JSON.stringify(loaded.receipt, null, 2), manifest, toolMatrix)
    ).toThrow(/exact JCS/u);
  });
});
