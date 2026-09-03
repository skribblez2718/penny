import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson } from "../src/checkpointer.js";
import { Checkpointer } from "../src/checkpointer.js";
import type { ArtifactRef } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import { validateGroundedSynthesis } from "../src/skill-contracts/research.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];

function root(label: string): string {
  const value = mkdtempSync(path.join(tmpdir(), `penny-${label}-`));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function identity(runId: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook: "research",
    engine_owner: "typescript" as const,
  };
}

function positiveCore(): unknown {
  const fixtureUrl = new URL("./fixtures/skills/research/positive-vectors.json", import.meta.url);
  const fixture: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("positive vector fixture is not an object");
  }
  if (!("grounded_synthesis" in fixture)) throw new Error("positive core vector is absent");
  return fixture.grounded_synthesis;
}

function persist(input: {
  readonly artifacts: ArtifactStore;
  readonly runId: string;
  readonly operation: string;
  readonly content: string;
  readonly kind: string;
  readonly schemaId?: string;
  readonly schemaVersion?: number;
}): ArtifactRef {
  return input.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: "chain_input",
      branch_id: null,
      kind: input.kind,
      operation_id: input.operation,
      version: 1,
      producer: "skill:prior",
      media_type: "application/json",
      ...(input.schemaId === undefined
        ? {}
        : {
            content_schema: {
              schema_id: input.schemaId,
              schema_version: input.schemaVersion ?? 1,
            },
          }),
      parent_ref: null,
      upstream_refs: [],
    },
    content: input.content,
  });
}

function engineRuntime(projectRoot: string) {
  const artifacts = new ArtifactStore(path.join(projectRoot, "artifacts"));
  const checkpointer = new Checkpointer(path.join(projectRoot, "orchestration-v2.db"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot,
    maxSteps: 96,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: artifacts,
    artifactReader: artifacts,
  });
  return { artifacts, checkpointer, engine };
}

function start(
  engine: OrchestrationEngine,
  projectRoot: string,
  runId: string,
  refs: ReadonlyArray<{ readonly slot: string; readonly ref: ArtifactRef }>,
  constraints: Record<string, boolean | number | string> = { mode: "quick" }
) {
  return engine.handle({
    schema_version: 2,
    action: "start",
    identity: identity(runId),
    goal: "Consume an exact prior Grounded Synthesis.",
    constraints,
    project_root: projectRoot,
    trust_profile: "trusted-interactive",
    input_artifacts: { schema_version: 2, artifacts: refs },
  });
}

describe("P2 pre-model research request and import admission", () => {
  it("admits an exact canonical GroundedSynthesisV1 import", () => {
    const projectRoot = root("typed-import");
    const { artifacts, checkpointer, engine } = engineRuntime(projectRoot);
    const core = validateGroundedSynthesis(positiveCore());
    const ref = persist({
      artifacts,
      runId: "prior-run",
      operation: "canonical-core",
      content: canonicalJson(core),
      kind: "semantic-core",
      schemaId: "penny.grounded-synthesis.v1",
    });
    const directive = start(engine, projectRoot, "typed-target", [
      { slot: "prior_grounded_synthesis", ref },
    ]);
    expect(directive.action).toBe("invoke_agent");
    expect(checkpointer.runExists("typed-target")).toBe(true);
    if (directive.action === "invoke_agent") {
      expect(directive.input_artifacts.artifacts.map((binding) => binding.ref)).toContainEqual(ref);
    }
    checkpointer.close();
    artifacts.close();
  });

  it("rejects noncanonical bytes, wrong version, wrong kind, and envelope/render/receipt substitution", () => {
    const projectRoot = root("typed-negative");
    const { artifacts, checkpointer, engine } = engineRuntime(projectRoot);
    const core = validateGroundedSynthesis(positiveCore());
    const cases = [
      persist({
        artifacts,
        runId: "prior-pretty",
        operation: "pretty-core",
        content: JSON.stringify(core, null, 2),
        kind: "semantic-core",
        schemaId: "penny.grounded-synthesis.v1",
      }),
      persist({
        artifacts,
        runId: "prior-version",
        operation: "version-core",
        content: canonicalJson(core),
        kind: "semantic-core",
        schemaId: "penny.grounded-synthesis.v1",
        schemaVersion: 2,
      }),
      persist({
        artifacts,
        runId: "prior-kind",
        operation: "kind-core",
        content: canonicalJson(core),
        kind: "product-receipt",
        schemaId: "penny.grounded-synthesis.v1",
      }),
      persist({
        artifacts,
        runId: "prior-envelope",
        operation: "envelope",
        content: "{}",
        kind: "terminal-envelope",
        schemaId: "penny.research-product-envelope.v1",
      }),
      persist({
        artifacts,
        runId: "prior-render",
        operation: "render",
        content: "{}",
        kind: "deterministic-render",
        schemaId: "penny.deterministic-render-ref.v1",
      }),
      persist({
        artifacts,
        runId: "prior-receipt",
        operation: "receipt",
        content: "{}",
        kind: "product-receipt",
        schemaId: "penny.product-receipt.v1",
      }),
    ];
    for (const [index, ref] of cases.entries()) {
      const runId = `typed-negative-${index}`;
      expect(() => start(engine, projectRoot, runId, [{ slot: `input-${index}`, ref }])).toThrow();
      expect(checkpointer.runExists(runId)).toBe(false);
    }
    checkpointer.close();
    artifacts.close();
  });

  it("rejects missing and duplicate port substitutions before creating a run", () => {
    const projectRoot = root("typed-missing");
    const foreignRoot = root("typed-foreign");
    const { artifacts, checkpointer, engine } = engineRuntime(projectRoot);
    const foreign = new ArtifactStore(path.join(foreignRoot, "artifacts"));
    const ref = persist({
      artifacts: foreign,
      runId: "foreign-run",
      operation: "foreign-core",
      content: canonicalJson(validateGroundedSynthesis(positiveCore())),
      kind: "semantic-core",
      schemaId: "penny.grounded-synthesis.v1",
    });
    expect(() => start(engine, projectRoot, "missing-core", [{ slot: "input-1", ref }])).toThrow(
      /absent from the manifest/
    );
    expect(checkpointer.runExists("missing-core")).toBe(false);

    const local = persist({
      artifacts,
      runId: "local-run",
      operation: "local-core",
      content: canonicalJson(validateGroundedSynthesis(positiveCore())),
      kind: "semantic-core",
      schemaId: "penny.grounded-synthesis.v1",
    });
    expect(() =>
      start(engine, projectRoot, "duplicate-ref", [
        { slot: "first", ref: local },
        { slot: "second", ref: local },
      ])
    ).toThrow(/refs.*unique/);
    expect(checkpointer.runExists("duplicate-ref")).toBe(false);
    expect(() =>
      start(engine, projectRoot, "duplicate-slot", [
        { slot: "same", ref: local },
        { slot: "same", ref: { ...local, artifact_id: `art_${"f".repeat(64)}` } },
      ])
    ).toThrow(/slots.*unique/);
    expect(checkpointer.runExists("duplicate-slot")).toBe(false);
    foreign.close();
    checkpointer.close();
    artifacts.close();
  });

  it("rejects malformed typed requests before run mutation", () => {
    const projectRoot = root("request-negative");
    const { artifacts, checkpointer, engine } = engineRuntime(projectRoot);
    expect(() => start(engine, projectRoot, "unknown-request", [], { surprise: true })).toThrow(
      /unknown/
    );
    expect(() =>
      start(engine, projectRoot, "rigor-request", [], { rigor_escalation: true })
    ).toThrow(/not a supported/);
    expect(checkpointer.runExists("unknown-request")).toBe(false);
    expect(checkpointer.runExists("rigor-request")).toBe(false);
    checkpointer.close();
    artifacts.close();
  });
});
