import { parseVoiceWireJson, readVoiceSemantic } from "./voice-json.js";
import {
  VoiceStudioProcessObserver,
  type VoiceStudioObservedJobInputV1,
} from "./voice-studio-process-observer.js";
import { verifyHostResultWrapper } from "../host-operations/effect-protocol.js";
import { HostOperationArtifactCustody } from "../host-operations/storage.js";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { types } from "node:util";
import path from "node:path";
import { Type } from "typebox";
import { ArtifactStore } from "../artifact-store.js";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { readSemantic, readExact, sameRef, type FoundationLimitsV1 } from "./bounds.js";
import { readVideogenOwnerSelection, VideogenOwnerSelection } from "./owner-selection.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { VoiceStudioTransport } from "./voice-studio-transport.js";
import {
  VoiceStudioCorrelationV1Schema,
  VoiceStudioChunkPlanV1Schema,
  VoiceStudioReadinessV1Schema,
  VoiceStudioCoverageV1Schema,
  VoiceStudioVoiceV1Schema,
  VoiceStudioNarrationV1Schema,
  VoiceStudioJobV1Schema,
  VoiceStudioRawResultV1Schema,
  type VoiceStudioProfileV1,
  type VoiceStudioCorrelationV1,
  type VoiceStudioJobRequestV1,
  type VoiceStudioNarrationV1,
} from "./voice-studio-contracts.js";

const ISSUER = "host:videogen-voice-observation-owner";
const closed = { additionalProperties: false } as const;
const Receipt = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-voice-observation-receipt.v1"),
    schema_version: Type.Literal(1),
    kind: Type.Union([Type.Literal("readiness"), Type.Literal("coverage")]),
    profile_ref: ArtifactRefSchema,
    raw_ref: ArtifactRefSchema,
    observation_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    ledger_ref: ArtifactRefSchema,
    budget_ref: ArtifactRefSchema,
    transport_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    qualification: Type.Literal("not_assessed"),
  },
  closed
);
const Raw = Type.Object(
  {
    // A host-side process observation export, NOT a new Voice Studio HTTP endpoint. The existing
    // service does not export these fields. Without an independently operated exporter, refuse.
    readiness: VoiceStudioReadinessV1Schema,
    coverage: Type.Array(VoiceStudioCoverageV1Schema, { maxItems: 1000 }),
  },
  closed
);
const CollectedRaw = Type.Object(
  {
    process_snapshot: Raw,
    transport: Type.Union([
      Type.Object(
        {
          voice: VoiceStudioVoiceV1Schema,
          sample_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        closed
      ),
      Type.Object({ job: VoiceStudioJobV1Schema, narration: VoiceStudioNarrationV1Schema }, closed),
    ]),
  },
  closed
);
interface VoiceStudioObservationCommonBindingsV1 {
  readonly owner: VideogenOwnerSelection;
  readonly profile_ref: ArtifactRef;
  readonly profile: VoiceStudioProfileV1;
  readonly transport: unknown;
  readonly on_bytes?: (bytes: number) => void;
}
export type VoiceStudioObservationSourceV1 =
  | { readonly process_snapshot_path: string; readonly process_observer?: never }
  | {
      readonly process_observer: VoiceStudioProcessObserver;
      readonly process_snapshot_path?: never;
    };
export type VoiceStudioObservationBindingsV1 = VoiceStudioObservationCommonBindingsV1 &
  VoiceStudioObservationSourceV1;
const concrete = new WeakSet<object>();
/** Concrete collection custody. No observation map, producer override, registration or PASS callback.
 * Source exports are corroborated with actual bounded HTTP reads. Immutable raw bytes and a fixed
 * owner receipt are checkpoint-selected together. This proves collection, NOT exporter truth or
 * physical service qualification; deployments without that independent source must not bind it. */
export class VoiceStudioObservationCollector {
  readonly #b: VoiceStudioObservationBindingsV1;
  readonly #client: VoiceStudioTransport;
  readonly #transportDigest: string;
  readonly #issued = new Map<string, ArtifactRef>();
  readonly #project: string;
  readonly #run: string;
  constructor(b: VoiceStudioObservationBindingsV1) {
    if (new.target !== VoiceStudioObservationCollector || types.isProxy(b.owner))
      throw new Error("concrete voice observation collector required");
    if ((b.process_observer === undefined) === (b.process_snapshot_path === undefined))
      throw new Error("exactly one voice process observation source required");
    b.process_observer?.requireBinding(
      b.profile_ref,
      b.profile,
      new VoiceStudioTransport(b.transport, b.profile.limits).config.mode
    );
    const h = readVideogenOwnerSelection(b.owner);
    this.#project = h.gate.project_id;
    this.#run = h.gate.run_id;
    this.#b = Object.freeze({ ...b, profile: structuredClone(b.profile) });
    this.#client = new VoiceStudioTransport(b.transport, b.profile.limits, b.on_bytes);
    this.#transportDigest = sha256(canonicalJson(this.#client.config));
    concrete.add(this);
    Object.freeze(this);
  }
  static require(
    value: unknown,
    owner: VideogenOwnerSelection,
    profile: ArtifactRef,
    transport: unknown
  ): VoiceStudioObservationCollector {
    if (
      typeof value !== "object" ||
      value === null ||
      !concrete.has(value) ||
      !(value instanceof VoiceStudioObservationCollector) ||
      value.#b.owner !== owner ||
      !sameRef(value.#b.profile_ref, profile) ||
      value.#transportDigest !== sha256(canonicalJson(transport))
    )
      throw new Error("same concrete voice observation collector/owner required");
    return value;
  }
  /** Same-process store reconnection only. This transfers private collection custody, never
   * caller refs/maps. A true process restart needs settled voice owner evidence for coverage and
   * fresh readiness collection; unreceipted ambiguity stays held. */
  rebindOwner(owner: VideogenOwnerSelection): VoiceStudioObservationCollector {
    const h = readVideogenOwnerSelection(owner);
    if (h.gate.project_id !== this.#project || h.gate.run_id !== this.#run)
      throw new Error("voice observation rebind project/run mismatch");
    const next = new VoiceStudioObservationCollector({ ...this.#b, owner });
    for (const ref of this.#issued.values()) {
      readExact(h.gate.store, h.gate.project_id, ref, h.gate.limits.max_json_bytes);
      next.#issued.set(ref.artifact_id, ref);
    }
    return next;
  }
  private current() {
    const seed = readVideogenOwnerSelection(this.#b.owner);
    const context = seed.gate.checkpointer.loadRunById(seed.gate.run_id);
    const h = readVideogenOwnerSelection(this.#b.owner),
      { gate } = h;
    if (
      !context ||
      context.terminalDirective !== null ||
      ["complete", "incomplete", "error", "cancelled"].includes(context.status)
    )
      throw new Error("voice observation active parent required");
    const selected = context.selectedArtifacts;
    const gate_ref = gate.current_approvals.find((a) => a.gate_id === "G1")?.decision_ref;
    const ledgerRefs = selected.filter(
      (r) => r.content_schema?.schema_id === "penny.videogen-dependency-ledger.v1"
    );
    const budgetRefs = selected.filter(
      (r) => r.content_schema?.schema_id === "penny.videogen-budget-reservation.v1"
    );
    const ledger_ref = ledgerRefs[0],
      budget_ref = budgetRefs[0];
    if (
      !gate_ref ||
      ledgerRefs.length !== 1 ||
      !ledger_ref ||
      budgetRefs.length !== 1 ||
      !budget_ref
    )
      throw new Error("voice observation current G1/ledger/budget required");
    return { ...h, context, gate_ref, ledger_ref, budget_ref };
  }
  private snapshot(limits: FoundationLimitsV1, input?: VoiceStudioObservedJobInputV1) {
    if (this.#b.process_observer) {
      const snapshot = this.#b.process_observer.snapshot(input);
      return {
        raw: validateSkillSchema(Raw, snapshot.raw, "voice native process snapshot"),
        text: canonicalJson({
          fingerprint: snapshot.fingerprint,
          raw: {
            ...snapshot.raw,
            readiness: { ...snapshot.raw.readiness, observed_at_ms: 0, expires_at_ms: 0 },
            coverage: snapshot.raw.coverage.map((c) => ({ ...c, observed_at_ms: 0 })),
          },
        }),
      };
    }
    const source = this.#b.process_snapshot_path;
    if (!path.isAbsolute(source) || realpathSync(source) !== source)
      throw new Error("voice process observation source unavailable");
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = fstatSync(fd);
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.uid !== process.getuid?.() ||
        (s.mode & 0o077) !== 0 ||
        s.size > limits.max_json_bytes
      )
        throw new Error("voice process observation source unsafe");
      const bytes = Buffer.alloc(s.size + 1);
      let n = 0;
      while (n < bytes.length) {
        const count = readSync(fd, bytes, n, bytes.length - n, null);
        if (!count) break;
        n += count;
      }
      const after = fstatSync(fd);
      if (
        n !== s.size ||
        after.size !== s.size ||
        after.mtimeMs !== s.mtimeMs ||
        after.ctimeMs !== s.ctimeMs
      )
        throw new Error("voice process observation changed during collection");
      const text = bytes.subarray(0, n).toString("utf8"),
        value: unknown = JSON.parse(text);
      const raw = validateSkillSchema(Raw, value, "voice host process snapshot");
      if (canonicalJson(raw) !== text) throw new Error("noncanonical voice process observation");
      return { raw, text };
    } finally {
      closeSync(fd);
    }
  }
  private persist(
    store: ArtifactStore,
    run: string,
    phase: string,
    kind: string,
    schema: string,
    content: string,
    upstream: ArtifactRef[]
  ) {
    const operation = `voice-observation:${sha256(canonicalJson({ content, upstream }))}`;
    const existing = store.refFor(run, phase, null, kind, operation, 1);
    const ref =
      existing ??
      store.persist({
        metadata: {
          schema_version: 2,
          run_id: run,
          phase,
          branch_id: null,
          kind,
          operation_id: operation,
          version: 1,
          producer: ISSUER,
          media_type: "application/json",
          content_schema: { schema_id: schema, schema_version: 1 },
          parent_ref: null,
          upstream_refs: upstream,
        },
        content,
      });
    if (
      ref.producer !== ISSUER ||
      !store.read(ref).equals(Buffer.from(content)) ||
      canonicalJson(store.metadata(ref).upstream_refs) !== canonicalJson(upstream)
    )
      throw new Error("voice observation custody conflict");
    return ref;
  }
  async collect(
    kind: "readiness" | "coverage",
    signal: AbortSignal,
    input?: {
      readonly correlation: VoiceStudioCorrelationV1;
      readonly request: VoiceStudioJobRequestV1;
      readonly narration: VoiceStudioNarrationV1;
    }
  ): Promise<ArtifactRef> {
    signal.throwIfAborted();
    const before = this.current(),
      { gate } = before,
      b = this.#b;
    const observedInput = input
      ? {
          ...input,
          plan: readSemantic({
            ...gate,
            ref: input.request.chunk_plan_ref,
            schema: VoiceStudioChunkPlanV1Schema,
            schema_id: "penny.videogen-voice-studio-chunk-plan.v1",
          }),
        }
      : undefined;
    const source = this.snapshot(gate.limits, observedInput);
    const snapshot_sha256 = sha256(canonicalJson(before.context.snapshot()));
    const checkCurrentSource = (): void => {
      signal.throwIfAborted();
      if (
        snapshot_sha256 !== sha256(canonicalJson(this.current().context.snapshot())) ||
        this.snapshot(gate.limits, observedInput).text !== source.text
      )
        throw new Error("voice observation current source changed during collection");
    };
    let observation, transport;
    if (kind === "readiness") {
      const voice = validateSkillSchema(
        VoiceStudioVoiceV1Schema,
        await this.#client.json("GET", `/api/voices/${b.profile.voice_id}`, signal),
        "observed voice"
      );
      checkCurrentSource();
      const sample = await this.#client.wav(
        `/api/voices/${b.profile.voice_id}/sample`,
        signal,
        true
      );
      if (
        sha256(canonicalJson(voice)) !== b.profile.voice_sha256 ||
        sha256(sample) !== b.profile.sample_sha256
      )
        throw new Error("voice observation transport identity drift");
      observation = source.raw.readiness;
      transport = { voice, sample_sha256: sha256(sample) };
    } else {
      if (!input) throw new Error("voice coverage correlation required");
      const { correlation: c } = input;
      const job = validateSkillSchema(
        VoiceStudioJobV1Schema,
        await this.#client.json("GET", `/api/tts/jobs/${c.job_id}`, signal),
        "observed job"
      );
      checkCurrentSource();
      const narration = validateSkillSchema(
        VoiceStudioNarrationV1Schema,
        await this.#client.json("GET", `/api/narrations/${c.narration_item_id}`, signal),
        "observed narration"
      );
      const matches = source.raw.coverage.filter(
        (e) => canonicalJson(e.correlation) === canonicalJson(c)
      );
      observation = matches[0];
      if (
        matches.length !== 1 ||
        !observation ||
        canonicalJson(narration) !== canonicalJson(input.narration) ||
        job.job_id !== c.job_id ||
        job.narration_item_id !== c.narration_item_id ||
        job.status !== "completed" ||
        job.errored !== 0 ||
        job.completed !== job.total_chunks ||
        job.completed !== observation.chunks.length
      )
        throw new Error("voice observation raw snapshot/transport correlation drift");
      transport = { job, narration };
    }
    checkCurrentSource();
    const after = this.current();
    if (
      snapshot_sha256 !== sha256(canonicalJson(after.context.snapshot())) ||
      this.snapshot(gate.limits, observedInput).text !== source.text
    )
      throw new Error("voice observation current source changed during collection");
    const rawContent = canonicalJson({ process_snapshot: source.raw, transport });
    const raw_ref = this.persist(
      gate.store,
      gate.run_id,
      before.context.stateId,
      "videogen-voice-observation-raw",
      "penny.videogen-voice-observation-raw.v1",
      rawContent,
      [b.profile_ref]
    );
    const observation_ref = this.persist(
      gate.store,
      gate.run_id,
      before.context.stateId,
      `videogen-voice-${kind}`,
      observation.schema_id,
      canonicalJson(observation),
      [raw_ref]
    );
    const receipt = validateSkillSchema(
      Receipt,
      {
        schema_id: "penny.videogen-voice-observation-receipt.v1",
        schema_version: 1,
        kind,
        profile_ref: b.profile_ref,
        raw_ref,
        observation_ref,
        gate_ref: before.gate_ref,
        ledger_ref: before.ledger_ref,
        budget_ref: before.budget_ref,
        transport_sha256: this.#transportDigest,
        qualification: "not_assessed",
      },
      "voice observation receipt"
    );
    const ref = this.persist(
      gate.store,
      gate.run_id,
      before.context.stateId,
      "videogen-voice-observation-receipt",
      receipt.schema_id,
      canonicalJson(receipt),
      [
        raw_ref,
        observation_ref,
        b.profile_ref,
        receipt.gate_ref,
        receipt.ledger_ref,
        receipt.budget_ref,
      ]
    );
    this.#issued.set(ref.artifact_id, ref);
    after.context.selectedArtifacts = after.context.selectedArtifacts.filter((r) => {
      if (r.content_schema?.schema_id !== "penny.videogen-voice-observation-receipt.v1")
        return true;
      const old = readSemantic({ ...gate, ref: r, schema: Receipt, schema_id: receipt.schema_id });
      if (old.kind !== kind) return true;
      if (kind === "readiness") return false;
      const e = readSemantic({
        ...gate,
        ref: old.observation_ref,
        schema: VoiceStudioCoverageV1Schema,
        schema_id: "penny.videogen-voice-studio-coverage.v1",
      });
      return canonicalJson(e.correlation) !== canonicalJson(input?.correlation);
    });
    // Current host-owned selection, not caller maps. Keep accepted historical observations as
    // retention dependencies; selection is keyed by exact receipt operands, never latest producer.
    for (const r of [raw_ref, observation_ref, ref])
      if (!after.context.selectedArtifacts.some((x) => sameRef(x, r)))
        after.context.selectedArtifacts.push(r);
    checkCurrentSource();
    gate.checkpointer.saveRun(after.context, "voice_observation_collected", {
      observation_receipt_id: ref.artifact_id,
    });
    return observation_ref;
  }
  selected(kind: "readiness" | "coverage", correlation?: VoiceStudioCorrelationV1): ArtifactRef {
    const current = this.current(),
      { gate } = current;
    const matches = current.context.selectedArtifacts
      .filter((r) => r.content_schema?.schema_id === "penny.videogen-voice-observation-receipt.v1")
      .map((ref) => ({
        ref,
        value: readSemantic({
          ...gate,
          ref,
          schema: Receipt,
          schema_id: "penny.videogen-voice-observation-receipt.v1",
        }),
      }))
      .filter(({ ref, value: v }) => {
        if (
          ref.producer !== ISSUER ||
          ref.run_id !== gate.run_id ||
          v.kind !== kind ||
          !sameRef(v.profile_ref, this.#b.profile_ref) ||
          v.transport_sha256 !== this.#transportDigest ||
          !sameRef(v.gate_ref, current.gate_ref) ||
          !sameRef(v.ledger_ref, current.ledger_ref) ||
          !sameRef(v.budget_ref, current.budget_ref)
        )
          return false;
        if (
          !current.context.selectedArtifacts.some((r) => sameRef(r, v.raw_ref)) ||
          !current.context.selectedArtifacts.some((r) => sameRef(r, v.observation_ref))
        )
          return false;
        const collected = readVoiceSemantic({
          ...gate,
          ref: v.raw_ref,
          schema: CollectedRaw,
          schema_id: "penny.videogen-voice-observation-raw.v1",
        });
        if (
          canonicalJson(gate.store.metadata(v.observation_ref).upstream_refs) !==
            canonicalJson([v.raw_ref]) ||
          canonicalJson(gate.store.metadata(ref).upstream_refs) !==
            canonicalJson([
              v.raw_ref,
              v.observation_ref,
              v.profile_ref,
              v.gate_ref,
              v.ledger_ref,
              v.budget_ref,
            ])
        )
          return false;
        const observation = gate.store.read(v.observation_ref).toString();
        if (
          kind === "readiness"
            ? canonicalJson(collected.process_snapshot.readiness) !== observation
            : !collected.process_snapshot.coverage.some((e) => canonicalJson(e) === observation)
        )
          return false;
        if (kind === "coverage") {
          const e = readSemantic({
            ...gate,
            ref: v.observation_ref,
            schema: VoiceStudioCoverageV1Schema,
            schema_id: "penny.videogen-voice-studio-coverage.v1",
          });
          return canonicalJson(e.correlation) === canonicalJson(correlation);
        }
        return true;
      });
    // On a process restart only the existing voice owner journal can vouch for old coverage.
    // A copied fixed producer/receipt is not an issuance proof. Readiness must be recollected.
    const admitted = matches.filter(
      ({ ref, value }) =>
        this.#issued.has(ref.artifact_id) ||
        (kind === "coverage" &&
          gate.checkpointer.hostOperationCallsForRun(gate.run_id).some(
            (j) =>
              j.operation_kind === "voice_job" &&
              ["settled", "consumed"].includes(j.lifecycle) &&
              j.host_receipt_ref !== null &&
              j.operation_result_ref !== null &&
              j.disposition?.outcome === "completed" &&
              (() => {
                const record = HostOperationArtifactCustody.fromArtifactStore(
                  gate.store
                ).verifyForProject(gate.project_id, j);
                verifyHostResultWrapper(gate.store, record);
                const valueRaw = readVoiceSemantic({
                  ...gate,
                  ref: j.operation_result_ref,
                  schema: VoiceStudioRawResultV1Schema,
                  schema_id: "penny.videogen-voice-studio-raw-result.v1",
                });
                return sameRef(valueRaw.coverage_ref, value.observation_ref);
              })()
          ))
    );
    if (admitted.length !== 1 || !admitted[0])
      throw new Error("voice current concrete observation custody unavailable");
    if (kind === "readiness" && this.#b.process_observer) {
      const ready = readSemantic({
        ...gate,
        ref: admitted[0].value.observation_ref,
        schema: VoiceStudioReadinessV1Schema,
        schema_id: "penny.videogen-voice-studio-readiness.v1",
      });
      const jobs = gate.checkpointer
        .hostOperationCallsForRun(gate.run_id)
        .filter((j) => j.operation_kind === "voice_job" && j.remote_correlation_id !== null)
        .map((j) =>
          validateSkillSchema(
            VoiceStudioCorrelationV1Schema,
            parseVoiceWireJson(Buffer.from(j.remote_correlation_id ?? "")),
            "owned voice job correlation"
          )
        )
        .filter(
          (c) =>
            c.profile_sha256 === this.#b.profile_ref.content_digest &&
            c.process_epoch === ready.process_epoch
        )
        .map((c) => c.job_id);
      this.#b.process_observer.assertCurrentReady(ready, jobs);
    }
    return admitted[0].value.observation_ref;
  }
}
Object.freeze(VoiceStudioObservationCollector.prototype);
Object.freeze(VoiceStudioObservationCollector);
