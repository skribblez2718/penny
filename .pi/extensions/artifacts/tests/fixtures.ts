import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  artifactRefFromEnvelope,
  canonicalArtifactId,
  loadArtifactRuntimeConfig,
} from "../artifact-runtime.js";
import type {
  ArtifactEnvelope,
  ArtifactInvocation,
  ArtifactRef,
  ArtifactRuntimeConfig,
} from "../types.js";

export const FIXED_NOW = Date.parse("2026-08-15T12:00:00.000Z");
export const CURSOR_KEY_HEX = "11".repeat(32);

export interface ArtifactFixture {
  root: string;
  content: Buffer;
  artifact: ArtifactEnvelope;
  invocation: ArtifactInvocation;
  config: ArtifactRuntimeConfig;
  objectPath: string;
  cleanup(): Promise<void>;
}

interface FixtureOptions {
  artifactId?: string;
  artifactRunId?: string;
  callerRunId?: string;
  callerConsumer?: string;
  consumerScope?: string[];
  invocationId?: string;
  phase?: string;
  branchId?: string | null;
  kind?: string;
  operationId?: string;
  version?: number;
  parentRef?: ArtifactRef | null;
  upstreamRefs?: ArtifactRef[];
  expiresAt?: string;
  createObject?: boolean;
  objectContent?: Buffer;
  env?: Record<string, string>;
}

export function createCanonicalRef(
  overrides: Partial<ArtifactRef> &
    Pick<ArtifactRef, "run_id" | "phase" | "kind" | "operation_id" | "version">
): ArtifactRef {
  const digest = overrides.content_digest ?? "a".repeat(64);
  const identity = {
    run_id: overrides.run_id,
    phase: overrides.phase,
    branch_id: overrides.branch_id ?? null,
    kind: overrides.kind,
    operation_id: overrides.operation_id,
    version: overrides.version,
  };
  return {
    schema_version: 1,
    artifact_id: overrides.artifact_id ?? canonicalArtifactId(identity),
    ...identity,
    producer: overrides.producer ?? "agent:producer",
    consumer_scope: overrides.consumer_scope ?? ["state:consumer"],
    media_type: overrides.media_type ?? "text/plain; charset=utf-8",
    byte_length: overrides.byte_length ?? 0,
    content_digest: digest,
    store_ref: overrides.store_ref ?? `artifact://sha256/${digest}`,
  };
}

export async function createArtifactFixture(
  value: string | Buffer,
  options: FixtureOptions = {}
): Promise<ArtifactFixture> {
  const root = await mkdtemp(join(tmpdir(), "penny-artifacts-test-"));
  await chmod(root, 0o700);
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  const shard = join(root, "objects", "sha256", digest.slice(0, 2));
  const objectPath = join(shard, digest.slice(2));
  await mkdir(shard, { recursive: true, mode: 0o700 });
  await Promise.all(
    [join(root, "objects"), join(root, "objects", "sha256"), shard].map((path) =>
      chmod(path, 0o700)
    )
  );
  if (options.createObject !== false) {
    await writeFile(objectPath, options.objectContent ?? content, { mode: 0o600 });
    await chmod(objectPath, 0o600);
  }

  const artifactRunId = options.artifactRunId ?? "run:test";
  const callerConsumer = options.callerConsumer ?? "worker:consumer";
  const identity = {
    run_id: artifactRunId,
    phase: options.phase ?? "implementation",
    branch_id: options.branchId ?? null,
    kind: options.kind ?? "agent-output",
    operation_id: options.operationId ?? "artifact-read-1",
    version: options.version ?? 1,
  };
  const artifact: ArtifactEnvelope = {
    schema_version: 1,
    artifact_id: options.artifactId ?? canonicalArtifactId(identity),
    ...identity,
    producer: "worker:producer",
    consumer_scope: options.consumerScope ?? [callerConsumer],
    created_at: "2026-08-15T11:00:00.000000Z",
    media_type: "text/plain; charset=utf-8",
    byte_length: content.length,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
    parent_ref: options.parentRef ?? null,
    upstream_refs: options.upstreamRefs ?? [],
  };
  const invocation: ArtifactInvocation = {
    schema_version: 1,
    caller: {
      run_id: options.callerRunId ?? artifactRunId,
      consumer_ref: callerConsumer,
      invocation_id: options.invocationId ?? "invocation:test",
    },
    grants: [
      {
        artifact: artifactRefFromEnvelope(artifact),
        expires_at: options.expiresAt ?? "2026-08-15T13:00:00.000Z",
      },
    ],
  };
  const config = loadArtifactRuntimeConfig({
    PENNY_ARTIFACT_ROOT: root,
    PENNY_ARTIFACT_INVOCATION_JSON: JSON.stringify(invocation),
    PENNY_ARTIFACT_CURSOR_HMAC_KEY: CURSOR_KEY_HEX,
    ...options.env,
  });

  return {
    root,
    content,
    artifact,
    invocation,
    config,
    objectPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function parseToolPayload(result: {
  content: Array<{ text: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (!first) throw new Error("Tool result has no text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}
