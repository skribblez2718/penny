/**
 * Integration: the model-owned prose path and the LOAN fallback/ablation
 * branch of the session_before_compact handler.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../index.js";
import type { GenerateModelSummaryInput, SummarizerCtx } from "../../summarizer.js";
import { createMockCompactionPi, type CompactionEvent } from "../fixtures/compaction-pi.js";
import {
  HARD_MAX_ESTIMATED_TOKENS,
  HARD_MAX_RESULT_BYTES,
  HARD_MAX_RESULT_CHARACTERS,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  createTextToolResult,
  fitsToolResultBudget,
  measureToolResult,
  resolveToolResultBudget,
} from "../../../lib/tool-result-budget.js";

type GenerateModelSummary = (
  input: GenerateModelSummaryInput,
  context: SummarizerCtx
) => Promise<{ prose: string; model: string } | null>;

const generateModelSummaryMock = vi.fn<GenerateModelSummary>();
let sandbox: string;
let projectRoot: string;
const previousStateRoot = process.env.PENNY_STATE_ROOT;
const previousArtifactRoot = process.env.PENNY_ARTIFACT_ROOT;

vi.mock("../../checkpointer.js", () => ({
  readExactCheckpoints: vi.fn(() => ({ runs: [], artifactRefs: [], issues: [] })),
}));
vi.mock("../../pending.js", () => ({ detectPendingState: vi.fn(async () => null) }));
vi.mock("../../summarizer.js", () => ({
  // renderGroundedDigest is called by index during buildArtifact.
  renderGroundedDigest: vi.fn(() => "grounded digest"),
  generateModelSummary: (input: GenerateModelSummaryInput, context: SummarizerCtx) =>
    generateModelSummaryMock(input, context),
}));

function mockEvent(): CompactionEvent {
  return {
    preparation: {
      firstKeptEntryId: "fk-1",
      tokensBefore: 15000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      previousSummary: undefined,
      messagesToSummarize: [
        { role: "user", content: "Refactor the token estimator module please" },
      ],
      turnPrefixMessages: [],
    },
    branchEntries: [{ type: "session", sessionId: "sess-1" }],
    reason: "threshold",
    signal: new AbortController().signal,
  };
}

const ctx = () => ({
  cwd: projectRoot,
  model: { provider: "anthropic", id: "claude-x" },
  modelRegistry: {
    find: () => undefined,
    getApiKeyAndHeaders: async () => ({ ok: false }),
  },
});

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "penny-compaction-model-test-"));
  projectRoot = path.join(sandbox, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
  delete process.env.PENNY_ARTIFACT_ROOT;
  initializePennyState(projectRoot, { env: process.env });
});

afterEach(() => {
  generateModelSummaryMock.mockReset();
  delete process.env.PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY;
  if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = previousStateRoot;
  if (previousArtifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
  else process.env.PENNY_ARTIFACT_ROOT = previousArtifactRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("model-owned prose path", () => {
  it("uses the model prose and appends code-owned RESUME-REFS", async () => {
    generateModelSummaryMock.mockResolvedValueOnce({
      prose: "## Goal\nRefactor the token estimator\n## Critical Context\n- uses tiktoken",
      model: "anthropic/claude-x",
    });
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);
    const result = await pi.emitRequired(mockEvent(), ctx());

    expect(result.compaction.summary).toContain("Refactor the token estimator");
    expect(result.compaction.details.summary_source).toBe("model");
    expect(result.compaction.details.summary_model).toBe("anthropic/claude-x");
    expect(result.compaction.details.prose_summary).toContain("## Goal");
    // artifact.goal is kept consistent with the model's brief.
    expect(result.compaction.details.goal).toBe("Refactor the token estimator");
  });

  it("bounds a giant multibyte envelope through the registered compaction hook", async () => {
    generateModelSummaryMock.mockResolvedValueOnce({
      prose: [
        "## Goal",
        "Bound the registered compaction result",
        "## Critical Context",
        `- ${'escaped-"-\\-🙂漢字/'.repeat(100_000)}`,
      ].join("\n"),
      model: "anthropic/claude-x",
    });
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);
    const result = await pi.emitRequired(mockEvent(), ctx());
    const modelVisibleResult = createTextToolResult({ summary: result.compaction.summary });
    const measurement = measureToolResult(modelVisibleResult);
    const budget = resolveToolResultBudget({});

    expect(fitsToolResultBudget(measurement, budget)).toBe(true);
    expect(measurement.bytes).toBeLessThanOrEqual(HARD_MAX_RESULT_BYTES);
    expect(measurement.characters).toBeLessThanOrEqual(HARD_MAX_RESULT_CHARACTERS);
    expect(measurement.estimatedTokens).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
    expect(measurement.estimatedTokens * 2).toBeLessThanOrEqual(
      RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS
    );
    expect(result.compaction.summary).toContain(
      "[prose truncated to fit the shared result budget]"
    );
    expect(result.compaction.details.metadata.result_budget).toMatchObject({
      serialized_bytes: measurement.bytes,
      estimated_tokens: measurement.estimatedTokens,
      reserve_invariant_preserved: true,
    });
    expect(result.compaction.details.metadata.compaction_correlation).toEqual({
      status: "not_evaluated",
      keys: ["session:sess-1"],
    });
  });

  it("falls back to the deterministic prose when the model path fails", async () => {
    generateModelSummaryMock.mockResolvedValueOnce(null);
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);
    const result = await pi.emitRequired(mockEvent(), ctx());

    expect(result).toBeDefined();
    expect(result.compaction.details.summary_source).toBe("deterministic_fallback");
    expect(result.compaction.summary).toContain("## Goal");
    // Deterministic goal comes from the newest substantive user message.
    expect(result.compaction.details.goal).toBe("Refactor the token estimator module please");
  });

  it("yields to Pi's default (returns undefined) when model fails AND the loan is ablated", async () => {
    process.env.PENNY_ABLATE_COMPACTION_DETERMINISTIC_SUMMARY = "1";
    generateModelSummaryMock.mockResolvedValueOnce(null);
    const pi = createMockCompactionPi();
    compactionExtension(pi.api);
    const result = await pi.emit(mockEvent(), ctx());

    expect(result).toBeUndefined();
  });
});
