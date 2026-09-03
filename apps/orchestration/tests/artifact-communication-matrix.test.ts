import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { currentArtifactRef } from "../src/artifact-store.js";
import { canonicalJson } from "../src/checkpointer.js";
import type { ArtifactRef } from "../src/contracts.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import { OrchestrationService } from "../src/service.js";
import {
  validateCanonicalGroundedSynthesisBytes,
  validateResearchSemanticDraft,
} from "../src/skill-contracts/research.js";
import { initializePennyState } from "../src/state/index.js";

interface ObservedInvocation {
  readonly agent: string;
  readonly stateId: string;
  readonly task: string;
  readonly inputRefs: readonly ArtifactRef[];
  readonly inputBytes: readonly Buffer[];
  readonly output: string;
}

class ExactByteResearchClient implements ModelClient {
  readonly observed: ObservedInvocation[] = [];

  constructor(private readonly readExact: (ref: ArtifactRef) => Buffer) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const inputBytes = invocation.inputArtifacts.map((ref) => this.readExact(ref));
    const completion = this.completion(invocation, inputBytes);
    this.observed.push({
      agent: invocation.agent,
      stateId: invocation.stateId,
      task: invocation.task,
      inputRefs: [...invocation.inputArtifacts],
      inputBytes,
      output: completion.text,
    });
    return completion;
  }

  private semanticDraft(invocation: AgentInvocation, inputBytes: readonly Buffer[]) {
    const entries = invocation.inputArtifacts.map((ref, index) => ({
      ref,
      bytes: inputBytes[index],
    }));
    const evidenceEntries = entries
      .filter(({ ref }) => ref.phase === "researching" && ref.kind === "agent-output")
      .sort((left, right) =>
        `${left.ref.branch_id ?? ""}/${left.ref.operation_id}/${left.ref.artifact_id}`.localeCompare(
          `${right.ref.branch_id ?? ""}/${right.ref.operation_id}/${right.ref.artifact_id}`
        )
      );
    const evidence = evidenceEntries.map((entry, index) => {
      if (entry.bytes === undefined) throw new Error("matrix evidence bytes are absent");
      const excerpt = entry.bytes.toString("utf8").split("\n")[0]?.trim();
      if (excerpt === undefined || excerpt.length === 0) {
        throw new Error("matrix evidence excerpt is absent");
      }
      return {
        source_index: index,
        evidence_artifact_slot: index,
        locator: `matrix-${index + 1}`,
        excerpt,
        relation: "supports" as const,
      };
    });
    return validateResearchSemanticDraft({
      schema_id: "penny.research-semantic-draft.v1",
      schema_version: 1,
      title: "Exact artifact matrix",
      executive_summary: "Exact cross-run and fan-in bytes reached the semantic core.",
      claims: [
        {
          statement: "The exact artifact matrix completed.",
          claim_kind: "fact",
          support_status: "supported",
          confidence: 1,
          evidence_indexes: evidence.map((_item, index) => index),
          qualifications: [],
        },
      ],
      sources: evidence.map((_item, index) => ({
        source_kind: "primary",
        role: "evidentiary",
        tier: 1,
        title: `Matrix source ${index + 1}`,
        locator: `https://example.invalid/matrix/${index + 1}`,
      })),
      evidence,
      contradictions: [],
      unresolved_gaps: [],
      irreducible_uncertainties: [],
      sections: [
        {
          heading: "Matrix",
          body: "The exact evidence fan is preserved in provenance.",
          claim_indexes: [0],
          evidence_indexes: evidence.map((_item, index) => index),
        },
      ],
    });
  }

  private completion(invocation: AgentInvocation, inputBytes: readonly Buffer[]): AgentCompletion {
    switch (invocation.stateId) {
      case "planning":
        return {
          text: 'PLAN🙂\nfirst sub-query\nsecond sub-query\nSUMMARY:{"confidence":"CERTAIN","plan_steps":["first sub-query","second sub-query"],"plan_complete":true,"mode":"standard"}',
          confidence: "CERTAIN",
          details: {
            plan_steps: ["first sub-query", "second sub-query"],
            plan_complete: true,
            mode: "standard",
          },
        };
      case "researching":
        return {
          text: `RESEARCH漢\n${invocation.task}\nINPUTS:${inputBytes
            .map((bytes) => bytes.toString("base64"))
            .join("|")}\nSUMMARY:{"confidence":"PROBABLE","explore_complete":true}`,
          confidence: "PROBABLE",
          details: { explore_complete: true },
        };
      case "synthesizing": {
        const draft = this.semanticDraft(invocation, inputBytes);
        return {
          text: `${canonicalJson(draft)}\nSUMMARY:{"confidence":"PROBABLE","synthesis_complete":true}`,
          confidence: "PROBABLE",
          details: { synthesis_complete: true },
        };
      }
      case "validating":
        return {
          text: `VERIFIED\n${inputBytes.map((bytes) => bytes.toString("base64")).join("|")}\nSUMMARY:{"confidence":"CERTAIN","verdict":"PASS","unsupported_claims":[],"evidence":[{"claim":"matrix","source":"exact-artifact"}]}`,
          confidence: "CERTAIN",
          details: {
            verdict: "PASS",
            unsupported_claims: [],
            evidence: [{ claim: "matrix", source: "exact-artifact" }],
          },
        };
      default:
        throw new Error(`unexpected matrix state '${invocation.stateId}'`);
    }
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function requireObserved(client: ExactByteResearchClient, stateId: string): ObservedInvocation {
  const observed = client.observed.find((invocation) => invocation.stateId === stateId);
  if (observed === undefined) throw new Error(`state '${stateId}' was not invoked`);
  return observed;
}

describe("production skill artifact communication matrix", () => {
  it("preserves exact bytes across explicit cross-run inputs, parallel stages, downstream Synthia, and terminal output", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "penny-artifact-matrix-skill-"));
    roots.push(sandbox);
    chmodSync(sandbox, 0o700);
    const projectRoot = path.join(sandbox, "project");
    const stateRoot = path.join(sandbox, "state");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: stateRoot };
    initializePennyState(projectRoot, { env });

    const serviceHolder: { current?: OrchestrationService } = {};
    const client = new ExactByteResearchClient((ref) => {
      const current = serviceHolder.current;
      if (current === undefined) throw new Error("matrix service is not initialized");
      return current.artifacts.read(ref);
    });
    const service = new OrchestrationService({ projectRoot, env, modelClient: client });
    serviceHolder.current = service;
    try {
      const firstBytes = Buffer.from("cross-run-A🙂\nraw bytes", "utf8");
      const secondBytes = Buffer.from("cross-run-B漢\u0000tail", "utf8");
      const first = service.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "prior-run-a",
          phase: "terminal",
          branch_id: null,
          kind: "agent-output",
          operation_id: "prior-operation-a",
          version: 1,
          producer: "agent:annie",
          media_type: "text/plain; charset=utf-8",
          parent_ref: null,
          upstream_refs: [],
        },
        content: firstBytes,
      });
      const second = service.artifacts.persist({
        metadata: {
          schema_version: 2,
          run_id: "prior-run-b",
          phase: "terminal",
          branch_id: null,
          kind: "agent-output",
          operation_id: "prior-operation-b",
          version: 1,
          producer: "agent:vera",
          media_type: "text/plain; charset=utf-8",
          parent_ref: null,
          upstream_refs: [],
        },
        content: secondBytes,
      });

      const runId = "skill-artifact-matrix";
      const terminal = await service.execute({
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: "skill-artifact-matrix-session",
          playbook: "research",
          engine_owner: "typescript",
        },
        goal: "prove exact artifact communication",
        constraints: { mode: "standard", max_sub_queries: 2, max_fan_width: 2 },
        project_root: projectRoot,
        trust_profile: "trusted-interactive",
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "cross-run-a", ref: first },
            { slot: "cross-run-b", ref: second },
          ],
        },
      });

      expect(terminal.action).toBe("complete");
      if (terminal.action !== "complete") throw new Error("matrix skill did not complete");
      const planning = requireObserved(client, "planning");
      expect(new Set(planning.inputRefs.map((ref) => ref.artifact_id))).toEqual(
        new Set([first.artifact_id, second.artifact_id])
      );
      expect(new Set(planning.inputBytes.map((bytes) => bytes.toString("base64")))).toEqual(
        new Set([firstBytes.toString("base64"), secondBytes.toString("base64")])
      );

      const research = client.observed.filter((invocation) => invocation.stateId === "researching");
      expect(research).toHaveLength(2);
      const synthesis = requireObserved(client, "synthesizing");
      expect(synthesis.agent).toBe("synthia");
      const synthesisResearchInputs = synthesis.inputRefs
        .map((ref, index) => ({ ref, bytes: synthesis.inputBytes[index] }))
        .filter(({ ref }) => ref.phase === "researching");
      expect(synthesisResearchInputs).toHaveLength(2);
      expect(new Set(synthesisResearchInputs.map(({ bytes }) => bytes?.toString("utf8")))).toEqual(
        new Set(research.map((invocation) => invocation.output))
      );
      expect(synthesis.inputRefs.some((ref) => ref.kind === "research-request")).toBe(true);

      const run = service.checkpointer.loadRunById(runId);
      if (run === undefined) throw new Error("completed matrix run is absent");
      const expectedOutputs = new Map<string, string[]>();
      for (const invocation of client.observed) {
        const outputs = expectedOutputs.get(invocation.stateId) ?? [];
        outputs.push(invocation.output);
        expectedOutputs.set(invocation.stateId, outputs);
      }
      for (const [phase, expected] of expectedOutputs) {
        const refs = run.selectedArtifacts.filter(
          (ref) => ref.phase === phase && ref.kind === "agent-output"
        );
        expect(refs, `selected refs for ${phase}`).toHaveLength(expected.length);
        expect(new Set(refs.map((ref) => service.artifacts.read(ref).toString("utf8")))).toEqual(
          new Set(expected)
        );
      }

      const synthesisRef = run.selectedArtifacts.find((ref) => ref.phase === "synthesizing");
      if (synthesisRef === undefined) throw new Error("synthesis artifact is absent");
      expect(
        service.artifacts
          .metadata(synthesisRef)
          .upstream_refs.map((ref) => ref.artifact_id)
          .sort()
      ).toEqual(synthesis.inputRefs.map((ref) => ref.artifact_id).sort());

      const terminalRefValue = terminal.result.output_artifact_ref;
      if (terminalRefValue === null || terminalRefValue === undefined) {
        throw new Error("terminal exact output ref is absent");
      }
      const terminalRef = currentArtifactRef(terminalRefValue, "matrix terminal ref");
      expect(service.artifacts.read(synthesisRef)).toEqual(Buffer.from(synthesis.output, "utf8"));
      expect(terminalRef.phase).toBe("sealing_core");
      expect(terminalRef.kind).toBe("semantic-core");
      const core = validateCanonicalGroundedSynthesisBytes(
        service.artifacts.read(terminalRef),
        terminalRef
      );
      expect(core.provenance.synthesis_source_artifact.artifact_id).toBe(synthesisRef.artifact_id);
      const researchRefs = run.selectedArtifacts.filter(
        (ref) => ref.phase === "researching" && ref.kind === "agent-output"
      );
      expect(new Set(core.provenance.evidence_artifacts.map((ref) => ref.artifact_id))).toEqual(
        new Set(researchRefs.map((ref) => ref.artifact_id))
      );
      const requestRef = run.selectedArtifacts.find(
        (ref) => ref.phase === "intake" && ref.kind === "research-request"
      );
      if (requestRef === undefined) throw new Error("admitted request artifact is absent");
      expect(
        service.artifacts.metadata(terminalRef).upstream_refs.map((ref) => ref.artifact_id)
      ).toEqual([
        requestRef.artifact_id,
        synthesisRef.artifact_id,
        ...core.provenance.evidence_artifacts.map((ref) => ref.artifact_id),
      ]);
    } finally {
      service.close();
    }
  });
});
