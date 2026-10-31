import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { PROJECT_ID_PATTERN } from "../../orchestration/dist/state/paths.js";
import type { ScaAdapterRegistry } from "./adapters.js";
import { ScaJobStore } from "./job-store.js";
import { createVmBrokerAdapterRegistry } from "./vm-broker-adapter.js";

const MAX_CONFIG_BYTES = 1_048_576;
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const AbsolutePathSchema = Type.String({ minLength: 1, maxLength: 4096 });
const ProducerSchema = Type.String({ minLength: 1, maxLength: 256 });
const PinnedFileSchema = Type.Object(
  {
    path: AbsolutePathSchema,
    sha256: Sha256Schema,
    size_bytes: Type.Integer({ minimum: 1, maximum: 34_359_738_368 }),
  },
  { additionalProperties: false }
);
const AuthoritySchema = Type.Object(
  {
    configProducers: Type.Array(ProducerSchema, { minItems: 1, maxItems: 128 }),
    configDigests: Type.Array(Sha256Schema, { minItems: 1, maxItems: 128 }),
    executionPlanProducers: Type.Array(ProducerSchema, { minItems: 1, maxItems: 128 }),
    graphBindingProducers: Type.Array(ProducerSchema, { minItems: 1, maxItems: 128 }),
    graphProducers: Type.Array(ProducerSchema, { minItems: 1, maxItems: 128 }),
    policyProducers: Type.Array(ProducerSchema, { minItems: 1, maxItems: 128 }),
    policyDigests: Type.Array(Sha256Schema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);

export const ScaVmBrokerProductionConfigV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_root: AbsolutePathSchema,
    job_store_path: AbsolutePathSchema,
    project_id: Type.String({ pattern: PROJECT_ID_PATTERN.source }),
    workspace_parent: AbsolutePathSchema,
    global_lock: AbsolutePathSchema,
    authorization: AuthoritySchema,
    run_job: PinnedFileSchema,
    run_guest: PinnedFileSchema,
    output_protocol: PinnedFileSchema,
    python: PinnedFileSchema,
    genisoimage: PinnedFileSchema,
    cp: PinnedFileSchema,
    qemu: PinnedFileSchema,
    bwrap: PinnedFileSchema,
    systemctl: PinnedFileSchema,
    template: PinnedFileSchema,
  },
  { additionalProperties: false }
);
export type ScaVmBrokerProductionConfigV1 = Readonly<
  Static<typeof ScaVmBrokerProductionConfigV1Schema>
>;

export interface ScaVmBrokerProductionCompositionV1 {
  readonly artifactStore: ArtifactStore;
  readonly jobStore: ScaJobStore;
  readonly adapters: ScaAdapterRegistry;
  close(): void;
}

function privateConfigBytes(configPath: string): Buffer {
  if (
    process.platform !== "linux" ||
    !path.isAbsolute(configPath) ||
    path.normalize(configPath) !== configPath ||
    configPath.includes("\0")
  ) {
    throw new Error("SCA VM production config path must be a normalized absolute Linux path");
  }
  const descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const uid = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size < 1n ||
      stat.size > BigInt(MAX_CONFIG_BYTES) ||
      (stat.mode & 0o777n) !== 0o600n ||
      (uid !== undefined && stat.uid !== BigInt(uid))
    ) {
      throw new Error("SCA VM production config must be an owner-only 0600 regular file");
    }
    const length = Number(stat.size);
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(descriptor, bytes, offset, length - offset, offset);
      if (read === 0) throw new Error("SCA VM production config changed while read");
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, length) !== 0) {
      throw new Error("SCA VM production config grew while read");
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new Error("SCA VM production config changed while read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function absoluteNormalized(value: string, label: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    throw new Error(`SCA VM ${label} must be a normalized absolute path`);
  }
}

export function loadScaVmBrokerProductionConfigV1(
  configPath: string
): ScaVmBrokerProductionConfigV1 {
  const bytes = privateConfigBytes(configPath);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("SCA VM production config is not valid JSON");
  }
  if (
    canonicalJson(value) !== text.trimEnd() ||
    !/^\n?$/u.test(text.slice(text.trimEnd().length))
  ) {
    throw new Error(
      "SCA VM production config must be canonical JSON with at most one final newline"
    );
  }
  const config = validateContract(
    ScaVmBrokerProductionConfigV1Schema,
    value,
    "SCA VM production config"
  );
  absoluteNormalized(config.artifact_root, "artifact root");
  absoluteNormalized(config.job_store_path, "job store path");
  absoluteNormalized(config.workspace_parent, "workspace parent");
  absoluteNormalized(config.global_lock, "global lock");
  for (const [label, pin] of Object.entries({
    run_job: config.run_job,
    run_guest: config.run_guest,
    output_protocol: config.output_protocol,
    python: config.python,
    genisoimage: config.genisoimage,
    cp: config.cp,
    qemu: config.qemu,
    bwrap: config.bwrap,
    systemctl: config.systemctl,
    template: config.template,
  })) {
    absoluteNormalized(pin.path, label);
  }
  return config;
}

export function createScaVmBrokerProductionCompositionV1(
  configPath: string
): ScaVmBrokerProductionCompositionV1 {
  const config = loadScaVmBrokerProductionConfigV1(configPath);
  const artifactStore = ArtifactStore.openExisting(config.artifact_root, {
    projectId: config.project_id,
  });
  let jobStore: ScaJobStore | undefined;
  try {
    const openedJobStore = ScaJobStore.openExisting(config.job_store_path, {
      projectId: config.project_id,
    });
    jobStore = openedJobStore;
    const adapters = createVmBrokerAdapterRegistry({
      artifactStore,
      projectId: config.project_id,
      workspaceParent: config.workspace_parent,
      globalLock: config.global_lock,
      authorization: config.authorization,
      runJob: config.run_job,
      runGuest: config.run_guest,
      outputProtocol: config.output_protocol,
      python: config.python,
      genisoimage: config.genisoimage,
      cp: config.cp,
      qemu: config.qemu,
      bwrap: config.bwrap,
      systemctl: config.systemctl,
      template: config.template,
    });
    let closed = false;
    return Object.freeze({
      artifactStore,
      jobStore: openedJobStore,
      adapters,
      close(): void {
        if (closed) return;
        closed = true;
        try {
          openedJobStore.close();
        } finally {
          artifactStore.close();
        }
      },
    });
  } catch (error) {
    try {
      jobStore?.close();
    } finally {
      artifactStore.close();
    }
    throw error;
  }
}
