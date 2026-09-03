import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializePennyState } from "@penny/orchestration/source";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  persistArtifactOutput,
  readArtifactById,
  type ArtifactRef,
} from "../../artifact-client.js";
import type { InputArtifactsV2 } from "../../input-artifacts.js";
import type { SkillResult } from "../../skill-utils.js";
import { createTestExtensionApi, isRecord } from "../../../../lib/tests/test-narrowers.js";

interface ServiceCapture {
  readonly runId: string;
  readonly input: InputArtifactsV2 | undefined;
  readonly inputContents: readonly string[];
  readonly output: string;
  readonly outputRef: ArtifactRef;
}

interface RegisteredSkillTool {
  readonly name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: {
      readonly cwd: string;
      readonly isProjectTrusted: () => boolean;
      readonly ui: { readonly theme: { fg(): string }; readonly notify: () => void };
    }
  ): Promise<{ readonly details: SkillResult }>;
}

const { serviceCaptures } = vi.hoisted(() => ({
  serviceCaptures: [] as ServiceCapture[],
}));

vi.mock("@penny/orchestration/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration/source")>();
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  return {
    ...actual,
    OrchestrationService: class implements Disposable {
      readonly artifacts: InstanceType<typeof actual.ArtifactStore>;
      readonly checkpointer = {
        loadRunById: (_runId: string) => undefined,
        events: (_runId: string) => [{ payload: { agent: "skribble" } }],
      };

      constructor(options: { readonly projectRoot: string; readonly env?: NodeJS.ProcessEnv }) {
        const state = actual.resolvePennyRuntimeState(options.projectRoot, { env: options.env });
        this.artifacts = actual.ArtifactStore.openExisting(state.paths.artifacts.root, {
          projectId: state.projectId,
        });
      }

      async execute(requestValue: unknown): Promise<unknown> {
        if (!record(requestValue) || requestValue.action !== "start") {
          throw new Error("matrix service accepts only start requests");
        }
        const identity = requestValue.identity;
        if (!record(identity) || typeof identity.run_id !== "string") {
          throw new Error("matrix service start identity is invalid");
        }
        const input =
          requestValue.input_artifacts === undefined
            ? undefined
            : actual.validateContract(
                actual.InputArtifactsSchema,
                requestValue.input_artifacts,
                "matrix input artifacts"
              );
        const refs = input?.artifacts.map((binding) => binding.ref) ?? [];
        const inputContents = refs.map((ref) => this.artifacts.read(ref).toString("utf8"));
        const output = `TERMINAL:${identity.run_id}🙂\n${inputContents.join("\n---exact-input---\n")}`;
        const outputRef = this.artifacts.persist({
          metadata: {
            schema_version: 2,
            run_id: identity.run_id,
            phase: "report_writing",
            branch_id: null,
            kind: "agent-output",
            operation_id: `matrix-terminal:${identity.run_id}`,
            version: 1,
            producer: "agent:skribble",
            media_type: "text/plain; charset=utf-8",
            parent_ref: null,
            upstream_refs: refs,
          },
          content: output,
        });
        serviceCaptures.push({
          runId: identity.run_id,
          input,
          inputContents,
          output,
          outputRef,
        });
        return {
          schema_version: 2,
          action: "complete",
          identity,
          state_id: "report_writing",
          status: "complete",
          met: true,
          result: { met: true, output_artifact_ref: outputRef },
          artifacts: [outputRef],
          unresolved: [],
        };
      }

      close(): void {
        this.artifacts.close();
      }

      [Symbol.dispose](): void {
        this.close();
      }
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Spacer: class {},
  Text: class {},
}));

const roots: string[] = [];
const previousEnvironment = {
  stateRoot: process.env.PENNY_STATE_ROOT,
  projectRoot: process.env.PROJECT_ROOT,
  artifactRoot: process.env.PENNY_ARTIFACT_ROOT,
};
let projectRoot = "";
let registeredTool: RegisteredSkillTool | undefined;

function isRegisteredSkillTool(value: unknown): value is RegisteredSkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}

function context() {
  return {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui: { theme: { fg: () => "" }, notify: () => undefined },
  };
}

function skillTool(): RegisteredSkillTool {
  if (registeredTool === undefined) throw new Error("skill tool was not registered");
  return registeredTool;
}

async function seed(runId: string, operationId: string, content: string): Promise<ArtifactRef> {
  return persistArtifactOutput({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "terminal",
      branch_id: null,
      kind: "agent-output",
      operation_id: operationId,
      version: 1,
      producer: "agent:fixture",
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
    output: content,
    cwd: projectRoot,
    env: process.env,
  });
}

async function expectExact(ref: ArtifactRef, expected: string): Promise<void> {
  const read = await readArtifactById({
    artifactId: ref.artifact_id,
    projectRoot,
    env: process.env,
  });
  expect(read.ref).toEqual(ref);
  expect(read.content).toEqual(Buffer.from(expected, "utf8"));
}

beforeEach(async () => {
  vi.clearAllMocks();
  serviceCaptures.length = 0;
  registeredTool = undefined;
  const sandbox = mkdtempSync(path.join(tmpdir(), "penny-skill-chain-artifact-matrix-"));
  roots.push(sandbox);
  chmodSync(sandbox, 0o700);
  projectRoot = path.join(sandbox, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
  process.env.PROJECT_ROOT = projectRoot;
  delete process.env.PENNY_ARTIFACT_ROOT;
  delete process.env.PENNY_SKILL_CHAIN_STATE_ROOT;
  initializePennyState(projectRoot, { env: process.env });

  const extension = await import("../../index.js");
  extension.default(
    createTestExtensionApi({
      onRegisterTool(definition) {
        if (isRegisteredSkillTool(definition)) registeredTool = definition;
      },
    })
  );
});

afterEach(() => {
  if (previousEnvironment.stateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = previousEnvironment.stateRoot;
  if (previousEnvironment.projectRoot === undefined) delete process.env.PROJECT_ROOT;
  else process.env.PROJECT_ROOT = previousEnvironment.projectRoot;
  if (previousEnvironment.artifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
  else process.env.PENNY_ARTIFACT_ROOT = previousEnvironment.artifactRoot;
  delete process.env.PENNY_SKILL_CHAIN_STATE_ROOT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill-chain artifact communication matrix", () => {
  it("combines the exact predecessor with explicit per-step inputs and preserves terminal bytes", async () => {
    const firstSeedContent = "skill explicit A🙂";
    const secondSeedContent = "skill explicit B漢\u0000tail";
    const [firstSeed, secondSeed] = await Promise.all([
      seed("skill-prior-run-a", "skill-prior-operation-a", firstSeedContent),
      seed("skill-prior-run-b", "skill-prior-operation-b", secondSeedContent),
    ]);

    const response = await skillTool().execute(
      "skill-chain-matrix",
      {
        chain: [
          {
            skill_name: "research",
            goal: "first exact stage",
            session_id: "skill-chain-stage-one",
            input_artifacts: [firstSeed.artifact_id],
          },
          {
            skill_name: "research",
            goal: "consume {previous} and the explicit second input",
            session_id: "skill-chain-stage-two",
            input_artifacts: [secondSeed.artifact_id],
          },
        ],
      },
      undefined,
      undefined,
      context()
    );

    expect(response.details).toMatchObject({ success: true, mode: "chain", state: "complete" });
    expect(serviceCaptures).toHaveLength(2);
    const first = serviceCaptures[0];
    const second = serviceCaptures[1];
    if (first === undefined || second === undefined) {
      throw new Error("skill-chain service captures are incomplete");
    }
    expect(first.runId).toBe("skill-chain-stage-one");
    expect(first.input?.artifacts.map((binding) => binding.slot)).toEqual(["caller-input-0001"]);
    expect(first.input?.artifacts.map((binding) => binding.ref)).toEqual([firstSeed]);
    expect(first.inputContents).toEqual([firstSeedContent]);
    await expectExact(first.outputRef, first.output);

    expect(second.runId).toBe("skill-chain-stage-two");
    expect(second.input?.artifacts.map((binding) => binding.slot)).toEqual([
      "previous-skill-terminal-output",
      "caller-input-0001",
    ]);
    expect(second.input?.artifacts.map((binding) => binding.ref)).toEqual([
      first.outputRef,
      secondSeed,
    ]);
    expect(second.inputContents).toEqual([first.output, secondSeedContent]);
    await expectExact(second.outputRef, second.output);

    const terminalRef = response.details.output_artifact_ref;
    if (terminalRef === undefined) throw new Error("skill-chain terminal ref is absent");
    expect(terminalRef).toEqual(second.outputRef);
    await expectExact(terminalRef, second.output);
  });
});
