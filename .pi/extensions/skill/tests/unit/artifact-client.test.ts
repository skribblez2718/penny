import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

import {
  ArtifactClientError,
  artifactIdFor,
  canonicalArtifactJson,
  expectedArtifactRef,
  parseArtifactRef,
  parseOutputArtifactMetadata,
  persistArtifactOutput,
  stableArtifactReceiptId,
  type ArtifactRef,
  type OutputArtifactMetadata,
} from "../../artifact-client.js";
import { getFinalOutput } from "../../../subagent/agent-runner.js";

const PROJECT_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const temporaryRoots: string[] = [];

function metadata(overrides: Partial<OutputArtifactMetadata> = {}): OutputArtifactMetadata {
  return {
    schema_version: 1,
    run_id: "run-ts-client-1",
    phase: "observing",
    branch_id: null,
    kind: "agent-output",
    operation_id: "observe-output-v1",
    version: 1,
    producer: "agent:echo",
    consumer_scope: ["state:synthesizing"],
    media_type: "text/markdown; charset=utf-8",
    parent_ref: null,
    upstream_refs: [],
    ...overrides,
  };
}

function tempArtifactRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-artifact-client-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("skill artifact client", () => {
  it("persists exact UTF-8 bytes through the TypeScript owner and verifies the canonical ref", async () => {
    const root = tempArtifactRoot();
    const output = 'before\u0000after\nmultibyte: ☃\nSUMMARY:{"complete":true}\n';
    const contract = metadata();

    const ref = await persistArtifactOutput({
      metadata: contract,
      output,
      cwd: PROJECT_ROOT,
      env: { ...process.env, PENNY_ARTIFACT_ROOT: root },
    });

    expect(ref).toEqual(expectedArtifactRef(contract, output));
    expect(parseArtifactRef(JSON.parse(canonicalArtifactJson(ref)))).toEqual(ref);
    const objectPath = path.join(
      root,
      "objects",
      "sha256",
      ref.content_digest.slice(0, 2),
      ref.content_digest.slice(2)
    );
    expect(readFileSync(objectPath)).toEqual(Buffer.from(output, "utf8"));
  });

  it("stores exactly the canonical multipart assistant result with matching byte length and digest", async () => {
    const root = tempArtifactRoot();
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "excluded reasoning" },
          { type: "text", text: "first🙂" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          { type: "text", text: "\nsecond漢" },
          { type: "thinking", thinking: "excluded too" },
          { type: "text", text: '\nSUMMARY:{"complete":true}' },
        ],
      },
    ] as any;
    const normalResult = getFinalOutput(messages);
    const contract = metadata();

    const ref = await persistArtifactOutput({
      metadata: contract,
      output: normalResult,
      cwd: PROJECT_ROOT,
      env: { ...process.env, PENNY_ARTIFACT_ROOT: root },
    });
    const objectPath = path.join(
      root,
      "objects",
      "sha256",
      ref.content_digest.slice(0, 2),
      ref.content_digest.slice(2)
    );
    const stored = readFileSync(objectPath);

    expect(normalResult).toBe('first🙂\nsecond漢\nSUMMARY:{"complete":true}');
    expect(stored).toEqual(Buffer.from(normalResult, "utf8"));
    expect(ref.byte_length).toBe(Buffer.byteLength(normalResult, "utf8"));
    expect(ref.content_digest).toBe(createHash("sha256").update(stored).digest("hex"));
  });

  it("fails closed on missing, unknown, mismatched, or noncanonical action metadata", () => {
    const base = metadata() as unknown as Record<string, unknown>;
    const missing = { ...base };
    delete missing.operation_id;
    const unknown = { ...base, model_claimed_ref: "forged" };
    const mismatched = { ...base, producer: "agent:other" };
    const unsortedScope = { ...base, consumer_scope: ["state:z", "state:a"] };

    for (const value of [missing, unknown, unsortedScope]) {
      expect(() => parseOutputArtifactMetadata(value)).toThrowError(ArtifactClientError);
    }
    expect(() =>
      parseOutputArtifactMetadata(mismatched, {
        runId: "run-ts-client-1",
        phase: "observing",
        branchId: null,
        producer: "agent:echo",
        kind: "agent-output",
      })
    ).toThrowError(/trusted action identity/);
  });

  it("derives stable operation identities and rejects forged refs", () => {
    const contract = metadata({ branch_id: "branch-a" });
    const expected = expectedArtifactRef(contract, "exact");
    expect(expected.artifact_id).toBe(artifactIdFor(contract));
    expect(stableArtifactReceiptId(contract)).toBe(stableArtifactReceiptId(contract));

    const forged: ArtifactRef = { ...expected, artifact_id: `art_${"0".repeat(64)}` };
    expect(() => parseArtifactRef(forged)).toThrowError(/artifact_id does not match/);
  });

  it("returns a typed persistence error and does not echo private output", async () => {
    const root = tempArtifactRoot();
    const contract = metadata();
    await persistArtifactOutput({
      metadata: contract,
      output: "first",
      cwd: PROJECT_ROOT,
      env: { ...process.env, PENNY_ARTIFACT_ROOT: root },
    });

    await expect(
      persistArtifactOutput({
        metadata: contract,
        output: "private divergent second output",
        cwd: PROJECT_ROOT,
        env: { ...process.env, PENNY_ARTIFACT_ROOT: root },
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_PERSIST_FAILED" });
    try {
      await persistArtifactOutput({
        metadata: contract,
        output: "private divergent second output",
        cwd: PROJECT_ROOT,
        env: { ...process.env, PENNY_ARTIFACT_ROOT: root },
      });
    } catch (error) {
      expect(String(error)).not.toContain("private divergent second output");
    }
  });
});
