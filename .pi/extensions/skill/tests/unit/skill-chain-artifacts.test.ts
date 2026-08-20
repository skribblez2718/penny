import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore, type OutputArtifactMetadata } from "@penny/orchestration/source";

import { readArtifactOutput } from "../../artifact-client.js";
import { persistSkillChainHandoff, skillChainInput } from "../../skill-chain-artifacts.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CHAIN_RUN = "chain-00000000-0000-4000-8000-000000000002";
const TARGET_RUN = "research-00000000-0000-4000-8000-000000000003";
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "penny-skill-chain-artifact-"));
  roots.push(value);
  return value;
}

function persistTerminal(artifactRoot: string, metadata: OutputArtifactMetadata, output: string) {
  using store = new ArtifactStore(artifactRoot);
  return store.persist({ metadata, content: output });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("skill-chain exact terminal handoff", () => {
  it("imports exact large multibyte terminal bytes into the next TypeScript run", async () => {
    const artifactRoot = root();
    const env = { ...process.env, PENNY_ARTIFACT_ROOT: artifactRoot };
    const output = `TERMINAL-EXACT\n${"🙂漢é".repeat(12_000)}`;
    const terminalMetadata: OutputArtifactMetadata = {
      schema_version: 1,
      run_id: "skill-run-terminal",
      phase: "report_writing",
      branch_id: null,
      kind: "agent-output",
      operation_id: "terminal-operation",
      version: 1,
      producer: "agent:skribble",
      consumer_scope: ["state:report_writing"],
      media_type: "text/markdown; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    };
    const terminalRef = persistTerminal(artifactRoot, terminalMetadata, output);
    const handoffRef = await persistSkillChainHandoff({
      chainRunId: CHAIN_RUN,
      completedStepIndex: 0,
      targetRunId: TARGET_RUN,
      skillName: "research",
      terminalRef,
      projectRoot: PROJECT_ROOT,
      env,
    });
    const input = skillChainInput({ targetRunId: TARGET_RUN, handoffRef });

    expect(handoffRef.run_id).toBe(TARGET_RUN);
    expect(handoffRef.phase).toBe("chain_input");
    expect(handoffRef.content_digest).toBe(terminalRef.content_digest);
    expect(handoffRef.byte_length).toBe(terminalRef.byte_length);
    expect(input.run_id).toBe(TARGET_RUN);
    expect(input.artifacts[0]?.ref).toEqual(handoffRef);
    expect((await readArtifactOutput({ ref: handoffRef, env })).toString("utf8")).toBe(output);
  });

  it("fails before handoff when the terminal object is missing and rejects wrong-run grants", async () => {
    const artifactRoot = root();
    const env = { ...process.env, PENNY_ARTIFACT_ROOT: artifactRoot };
    const terminalMetadata: OutputArtifactMetadata = {
      schema_version: 1,
      run_id: "skill-run-missing",
      phase: "report_writing",
      branch_id: null,
      kind: "agent-output",
      operation_id: "missing-terminal-operation",
      version: 1,
      producer: "agent:skribble",
      consumer_scope: ["state:report_writing"],
      media_type: "text/markdown; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    };
    const terminalRef = persistTerminal(artifactRoot, terminalMetadata, "removed");
    unlinkSync(
      join(
        artifactRoot,
        "objects",
        "sha256",
        terminalRef.content_digest.slice(0, 2),
        terminalRef.content_digest.slice(2)
      )
    );

    await expect(
      persistSkillChainHandoff({
        chainRunId: CHAIN_RUN,
        completedStepIndex: 0,
        targetRunId: TARGET_RUN,
        skillName: "research",
        terminalRef,
        projectRoot: PROJECT_ROOT,
        env,
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });

    expect(() => skillChainInput({ targetRunId: TARGET_RUN, handoffRef: terminalRef })).toThrow(
      /directive run/
    );
  });
});
