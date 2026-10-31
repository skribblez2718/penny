import { randomUUID } from "node:crypto";
import type { ScaP03WorkspaceRegistryCallbacksV1 } from "./p03-bootstrap-workspaces.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  SCA_P03_ATTEMPT_WITNESS_V1_SCHEMA,
  validateScaP03AttemptWitnessV1,
  type ScaP03AttemptWitnessV1,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";

type Execution = ScaP03AttemptWitnessV1["executions"][number];
/** Host-owned diagnostic capture. Its methods never issue cleanup, review, or attestation evidence. */
export class ScaP03HostWitnessSinkV1 {
  private readonly executions: Execution[] = [];
  private readonly workspaces: string[] = [];
  private activeWorkspace = false;
  private absent = true;
  private ended = false;
  private readonly started = new Date().toISOString();
  readonly attempt_id = randomUUID();
  workspaceDigest(): string {
    return sha256(canonicalJson(this.workspaces));
  }
  executionNames(): readonly string[] {
    return this.executions.map((entry) => entry.name);
  }
  constructor(
    private readonly input: Pick<
      ScaP03AttemptWitnessV1,
      "run_id" | "candidate_sha256" | "identity"
    >,
    private readonly registry?: ScaP03WorkspaceRegistryCallbacksV1
  ) {}
  startWorkspace(identity: string): void {
    if (this.activeWorkspace || this.ended || this.workspaces.length >= 256)
      throw new Error("p03_witness_state_invalid");
    if (this.registry !== undefined) {
      const value: unknown = JSON.parse(identity);
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "dev,ino,path" ||
        !("path" in value) ||
        typeof value.path !== "string" ||
        !("dev" in value) ||
        typeof value.dev !== "number" ||
        !("ino" in value) ||
        typeof value.ino !== "number" ||
        canonicalJson(value) !== identity
      )
        throw new Error("p03_witness_workspace_identity_invalid");
      this.registry.register(this.attempt_id, { path: value.path, dev: value.dev, ino: value.ino });
    }
    this.workspaces.push(sha256(identity));
    this.activeWorkspace = true;
  }
  create(name: string, argv: readonly string[]): void {
    if (
      !this.activeWorkspace ||
      this.ended ||
      this.executions.length >= 256 ||
      this.executions.some((entry) => entry.name === name)
    )
      throw new Error("p03_witness_limit_or_state");
    this.executions.push({
      ordinal: this.executions.length,
      name,
      id: null,
      create_sha256: sha256(canonicalJson(argv)),
      created: false,
      started: false,
      exec_completed: false,
      requires_readback: false,
      inspect_sha256: null,
      confinement_sha256: null,
      confinement_projection: null,
      command_sha256: null,
      response_sha256: null,
      readback_sha256: null,
      removed: false,
      absence_observed: false,
      disposition: "create_reply_lost",
    });
  }
  private update(name: string, patch: Partial<Execution>): void {
    const index = this.executions.findIndex((entry) => entry.name === name);
    const existing = this.executions[index];
    if (this.ended || existing === undefined || index < 0)
      throw new Error("p03_witness_state_invalid");
    this.executions[index] = { ...existing, ...patch };
  }
  id(name: string, id: string): void {
    this.update(name, { id, created: true, disposition: "failed" });
  }
  inspect(name: string, raw: string, projection: string | null): void {
    this.update(name, {
      inspect_sha256: sha256(raw),
      confinement_sha256: projection === null ? null : sha256(projection),
      confinement_projection: projection,
    });
  }
  startContainer(name: string): void {
    this.update(name, { started: true });
  }
  command(name: string, argv: readonly string[], requiresReadback: boolean): void {
    this.update(name, {
      requires_readback: requiresReadback,
      command_sha256: sha256(canonicalJson(argv)),
    });
  }
  response(name: string, raw: string): void {
    this.update(name, { response_sha256: sha256(raw), exec_completed: true });
  }
  readback(name: string, bytes: Uint8Array): void {
    this.update(name, { readback_sha256: sha256(bytes) });
  }
  removal(name: string, absent: boolean): void {
    const existing = this.executions.find((entry) => entry.name === name);
    if (existing === undefined) throw new Error("p03_witness_state_invalid");
    this.update(name, {
      removed: absent,
      absence_observed: absent,
      disposition: !absent ? "failed" : existing.id === null ? "create_reply_lost" : "completed",
    });
  }
  finishWorkspace(absent: boolean): void {
    this.absent = this.absent && absent;
    this.activeWorkspace = false;
  }
  /** An incomplete attempt remains a diagnostic; it cannot be finalized as a completed witness. */
  finalize(disposition: "completed" | "failed" | "cancelled"): Uint8Array {
    if (this.ended) throw new Error("p03_witness_state_invalid");
    if (
      disposition === "completed" &&
      (this.workspaces.length === 0 ||
        this.executions.length === 0 ||
        this.activeWorkspace ||
        !this.absent ||
        this.executions.some(
          (entry) =>
            entry.disposition !== "completed" ||
            !entry.created ||
            !entry.started ||
            !entry.exec_completed ||
            !entry.removed ||
            !entry.absence_observed ||
            entry.id === null ||
            entry.inspect_sha256 === null ||
            entry.confinement_sha256 === null ||
            entry.confinement_projection === null ||
            entry.command_sha256 === null ||
            entry.response_sha256 === null ||
            (entry.requires_readback && entry.readback_sha256 === null)
        ))
    )
      throw new Error("p03_witness_incomplete");
    if (
      this.registry !== undefined &&
      this.workspaces.length > 0 &&
      this.registry.digest(this.attempt_id) !== this.workspaceDigest()
    )
      throw new Error("p03_witness_registry_drift");
    const draft = {
      schema_id: SCA_P03_ATTEMPT_WITNESS_V1_SCHEMA,
      schema_version: 1 as const,
      attempt_id: this.attempt_id,
      ...this.input,
      workspace_sha256: this.workspaceDigest(),
      started_at: this.started,
      ended_at: new Date().toISOString(),
      executions: this.executions,
      workspace_absent: this.absent && !this.activeWorkspace,
      disposition,
    };
    const bytes = Buffer.from(
      canonicalJson({ ...draft, witness_sha256: sha256(canonicalJson(draft)) })
    );
    validateScaP03AttemptWitnessV1(bytes);
    this.ended = true;
    return bytes;
  }
}
