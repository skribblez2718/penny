import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, initializePennyState } from "@penny/orchestration/source";

import {
  compactionResultBudget,
  createResumeRefSet,
  fitCompactionSummary,
  parseResumeRefs,
  persistHandoffIndex,
} from "../../index.js";
import {
  HARD_MAX_ESTIMATED_TOKENS,
  RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS,
  createTextToolResult,
  enforceToolResultBudget,
  measureToolResult,
  type ToolResultBudget,
} from "../../../lib/tool-result-budget.js";
import { parseJson, requireArray, requireRecord } from "../../../../lib/tests/test-narrowers.js";

const saved = {
  bytes: process.env.PENNY_TOOL_RESULT_MAX_BYTES,
  characters: process.env.PENNY_TOOL_RESULT_MAX_CHARACTERS,
  tokens: process.env.PENNY_TOOL_RESULT_MAX_TOKENS,
  stateRoot: process.env.PENNY_STATE_ROOT,
  artifactRoot: process.env.PENNY_ARTIFACT_ROOT,
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const [key, value] of Object.entries({
    PENNY_TOOL_RESULT_MAX_BYTES: saved.bytes,
    PENNY_TOOL_RESULT_MAX_CHARACTERS: saved.characters,
    PENNY_TOOL_RESULT_MAX_TOKENS: saved.tokens,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (saved.stateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = saved.stateRoot;
  if (saved.artifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
  else process.env.PENNY_ARTIFACT_ROOT = saved.artifactRoot;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compaction shared final result budget", () => {
  it("cannot be enlarged by giant owner values and fits giant prose", () => {
    process.env.PENNY_TOOL_RESULT_MAX_BYTES = "999999999";
    process.env.PENNY_TOOL_RESULT_MAX_CHARACTERS = "999999999";
    process.env.PENNY_TOOL_RESULT_MAX_TOKENS = "999999999";
    const budget = compactionResultBudget();
    const resumeRefs = {
      version: 2 as const,
      refs: [{ type: "run" as const, run_id: "run-exact" }],
    };
    const fitted = fitCompactionSummary("界".repeat(1_000_000), resumeRefs, budget);

    const measurement = measureToolResult(createTextToolResult({ summary: fitted.summary }));
    expect(() =>
      enforceToolResultBudget(createTextToolResult({ summary: fitted.summary }), budget)
    ).not.toThrow();
    expect(measurement.bytes).toBeLessThanOrEqual(HARD_MAX_ESTIMATED_TOKENS);
    expect(measurement.estimatedTokens * 2).toBeLessThanOrEqual(
      RELEASE_MINIMUM_CONTEXT_HEADROOM_TOKENS
    );
    expect(fitted.summary).toContain("[prose truncated to fit the shared result budget]");
    expect(parseResumeRefs(fitted.summary).refs).toEqual(resumeRefs.refs);
  });

  it("replaces an over-budget exact set with one readable handoff-index ID", () => {
    const root = mkdtempSync(join(tmpdir(), "penny-compaction-budget-index-"));
    temporaryRoots.push(root);
    chmodSync(root, 0o700);
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    process.env.PENNY_STATE_ROOT = join(root, "state");
    delete process.env.PENNY_ARTIFACT_ROOT;
    const state = initializePennyState(projectRoot, { env: process.env });
    using store = new ArtifactStore(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const refs = Array.from({ length: 8 }, (_, index) =>
      store.persist({
        metadata: {
          schema_version: 2,
          run_id: `run-${index}`,
          phase: "phase",
          branch_id: null,
          kind: "agent-output",
          operation_id: `operation-${index}`,
          version: 1,
          producer: "agent:fixture",
          media_type: "text/plain",
          parent_ref: null,
          upstream_refs: [],
        },
        content: `content-${index}`,
      })
    );
    const original = createResumeRefSet([], refs);
    const budget: ToolResultBudget = {
      maxBytes: 512,
      maxCharacters: 512,
      maxEstimatedTokens: 512,
    };
    const omitted = fitCompactionSummary("## Goal\nresume", original, budget);
    expect(omitted.resumeRefs.refs.length).toBeLessThan(original.refs.length);
    const index = persistHandoffIndex({
      sessionId: "budget-session",
      compactionSeq: 1,
      projectRoot,
      resumeRefs: original,
      artifactRefs: refs,
    });
    const indexed = fitCompactionSummary(
      "## Goal\nresume",
      createResumeRefSet([], [index]),
      budget
    );
    expect(parseResumeRefs(indexed.summary).refs).toEqual([
      { type: "artifact", artifact_id: index.artifact_id, digest: index.content_digest },
    ]);
    const body = requireRecord(
      parseJson(store.readById(index.artifact_id).toString("utf8")),
      "handoff index body"
    );
    expect(requireArray(body.records, "handoff index records")).toHaveLength(refs.length);
  });

  it("keeps the versioned refs block structurally valid under a tiny lower cap", () => {
    const budget: ToolResultBudget = {
      maxBytes: 512,
      maxCharacters: 512,
      maxEstimatedTokens: 256,
    };
    const fitted = fitCompactionSummary(
      "## Goal\n" + "x".repeat(10_000),
      {
        version: 2,
        refs: [
          { type: "run", run_id: "run-exact" },
          {
            type: "artifact",
            artifact_id: `art_${"a".repeat(64)}`,
            digest: "b".repeat(64),
          },
        ],
      },
      budget
    );
    expect(() => parseResumeRefs(fitted.summary)).not.toThrow();
    expect(fitted.summary).toContain("run:run-exact");
    expect(fitted.summary).toContain("[/RESUME-REFS]");
  });
});
