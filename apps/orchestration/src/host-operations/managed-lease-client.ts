import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { HostOperationCapacityAuthority } from "./capacity-authority.js";
import {
  NativeTransferCounterSchema,
  ManagedLeaseGrantSchema,
  ManagedWorkerStateSchema,
  type ManagedLeaseGrant,
  type ManagedWorkerState,
} from "./native-capacity-contracts.js";
import type { Static } from "typebox";
import { readNativeObservationFile } from "./native-host-observation.js";

/** Exact private file sidechannel only. No public HTTP callback, generic URL, policy install,
 * retained schema migration or service launch. Publication is fsync+rename into an existing root. */
export function publishManagedLeaseFile(
  file: string,
  value: ManagedLeaseGrant | ManagedWorkerState | Static<typeof NativeTransferCounterSchema>
): void {
  const checked =
    value.schema_id === "penny.managed-lease-grant.v1"
      ? validateSkillSchema(ManagedLeaseGrantSchema, value, "managed lease publication")
      : value.schema_id === "penny.native-transfer-counter.v1"
        ? validateSkillSchema(NativeTransferCounterSchema, value, "native transfer publication")
        : validateSkillSchema(ManagedWorkerStateSchema, value, "managed state publication");
  const bytes = canonicalJson(checked);
  if (
    Buffer.byteLength(bytes) > 16384 ||
    !path.isAbsolute(file) ||
    realpathSync(path.dirname(file)) !== path.dirname(file)
  )
    throw new Error("managed private publication path/size invalid");
  const root = lstatSync(path.dirname(file));
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0)
    throw new Error("managed sidechannel root must be private");
  try {
    const existing = lstatSync(file);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o077) !== 0
    )
      throw new Error("managed sidechannel target unsafe");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temp = path.join(path.dirname(file), `.managed-${randomUUID()}`);
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  let published = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    renameSync(temp, file);
    published = true;
    const directory = openSync(
      path.dirname(file),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(fd);
    if (!published) unlinkSync(temp);
  }
}
/** A private IPC handler can call this helper; never expose it on the voice TLS API.
 * The grant file alone is NOT authority. Every entry/chunk and renewable execution check
 * must consult the live catalog. All alternate synthesis/preview/clone/load routes must
 * use this same service mutex. The concrete service owns cancellation/drain before leave. */
export class ManagedLeaseClient {
  #active: ManagedLeaseGrant | undefined;
  #sequence = 1;
  readonly #used = new Set<string>();
  constructor(
    readonly authority: HostOperationCapacityAuthority,
    readonly binding: { readonly worker_id: string; readonly process_epoch: string }
  ) {
    if (!(authority instanceof HostOperationCapacityAuthority))
      throw new Error("managed client requires concrete catalog authority");
  }
  enter(file: string, operationRequestSha256: string): ManagedLeaseGrant {
    if (this.#active || this.#used.size >= 10000)
      throw new Error("managed client active/admission limit");
    const grant = validateSkillSchema(
      ManagedLeaseGrantSchema,
      readNativeObservationFile(file, 16384),
      "managed client grant"
    );
    if (
      grant.gate_sequence !== this.#sequence ||
      grant.worker_id !== this.binding.worker_id ||
      grant.process_epoch !== this.binding.process_epoch ||
      grant.operation_request_sha256 !== operationRequestSha256 ||
      this.#used.has(grant.operation_record_id)
    )
      throw new Error("managed client request/process/replay conflict");
    this.authority.requireNativeGrant(grant);
    this.#used.add(grant.operation_record_id);
    this.#active = structuredClone(grant);
    this.#sequence += 1;
    return structuredClone(grant);
  }
  requireCurrent(): ManagedLeaseGrant {
    if (!this.#active) throw new Error("managed client compute gate closed");
    this.authority.requireNativeGrant(this.#active);
    return structuredClone(this.#active);
  }
  /** Identity for an actual service byte-counter export after same-owner fence adoption. */
  meterIdentity() {
    const grant = this.requireCurrent();
    return {
      operation_record_id: grant.operation_record_id,
      operation_request_sha256: grant.operation_request_sha256,
      capacity_request_sha256: grant.capacity_request_sha256,
      lease: this.authority.requireNativeGrant(grant),
    };
  }
  leave(): void {
    if (!this.#active) throw new Error("managed client has no active window");
    this.#active = undefined;
    this.#sequence += 1;
  }
  state(input: {
    readonly gate_build_sha256: string;
    readonly observed_at_ms: number;
  }): ManagedWorkerState {
    return validateSkillSchema(
      ManagedWorkerStateSchema,
      {
        schema_id: "penny.managed-worker-state.v1",
        schema_version: 1,
        ...this.binding,
        ...input,
        sequence: this.#sequence,
        state: this.#active
          ? {
              kind: "executing",
              active_calls: 1,
              grant_sha256: sha256(canonicalJson(this.#active)),
            }
          : { kind: "closed", active_calls: 0, grant_sha256: null },
      },
      "managed client gate state"
    );
  }
}
