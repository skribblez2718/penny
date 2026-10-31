import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../../orchestration/dist/contracts.js";
import {
  hostOperationDirectiveSha256,
  validateHostOperationCallRecord,
  validateHostOperationResult,
  validateHostOperationReceipt,
} from "../../orchestration/dist/host-operations/contracts.js";
import { scaP03NativeConfinementProjectionV1 } from "../src/p03-docker-runtime.js";
import { validateScaP03AttemptWitnessV1 } from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  scaP03QualificationObservationSha256V2,
  makeScaP03QueryCandidateV2,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { readScaP03ConsumedFixtureEvidenceV1 } from "../src/p03-consumed-fixture-evidence.js";
import { verifyScaP03ConsumedFixtureTranscriptV1 } from "../src/p03-consumed-fixture-transcript.js";
import {
  parseScaP03ConsumedJsonV1,
  decodeScaP03ConsumedBase64V1,
  ScaP03ConsumedEnvelopeReaderV1,
} from "../src/p03-consumed-fixture-custody.js";
import type { ScaP03InitialEvidenceV1 } from "../src/p03-initial-live.js";
import { consumedComponentFixture, consumedResources } from "./p03-consumed-fixture-helper.js";
import { disposeSamplerFixtures } from "./p03-production-sampler-fixture.js";

type Fixture = Awaited<ReturnType<typeof consumedComponentFixture>>;
let fixture: Fixture | undefined;
function f(): Fixture {
  if (fixture === undefined) throw new Error("unit fixture absent");
  return fixture;
}
beforeAll(async () => {
  fixture = await consumedComponentFixture();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  fixture?.close();
  disposeSamplerFixtures();
});
function reader() {
  const x = f();
  vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(x.record);
  return readScaP03ConsumedFixtureEvidenceV1({
    ...x,
    expected_measurement_scope: "deterministic_transport_test",
  });
}
function transcript(evidence = f().evidence) {
  return verifyScaP03ConsumedFixtureTranscriptV1({
    evidence,
    resources: consumedResources,
    operation_record_id: f().record.operation_record_id,
    run_id: f().proposal.run_id,
    request_sha256: f().directive.request_sha256,
  });
}
function observation(e: ScaP03InitialEvidenceV1, index: number, text: string): void {
  const old = e.original_observations[index];
  if (old === undefined) throw new Error("unit observation absent");
  const bytes = Buffer.from(text);
  e.original_observations[index] = {
    ...old,
    output_base64: bytes.toString("base64"),
    output_sha256: sha256(bytes),
    byte_length: bytes.byteLength,
  };
}
function witness(
  e: ScaP03InitialEvidenceV1,
  change: (w: ReturnType<typeof validateScaP03AttemptWitnessV1>) => unknown
): void {
  const w = validateScaP03AttemptWitnessV1(Buffer.from(e.attempt_witness_base64, "base64"));
  const changed = change(w);
  const value = parseScaP03ConsumedJsonV1(Buffer.from(canonicalJson(changed)), 1_048_576);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("unit witness absent");
  const { witness_sha256: ignored, ...unsigned } = Object.fromEntries(Object.entries(value));
  void ignored;
  e.attempt_witness_base64 = Buffer.from(
    canonicalJson({ ...unsigned, witness_sha256: sha256(canonicalJson(unsigned)) })
  ).toString("base64");
}
/** Recommit mutated component envelopes locally; never fabricate an owner E2E result. */
function overlayEvidence(e: ScaP03InitialEvidenceV1, identity = f().directive.identity) {
  const x = f(),
    original = x.record,
    directive = { ...x.directive, identity };
  if (
    original.operation_result_ref === null ||
    original.platform_result_ref === null ||
    original.host_receipt_ref === null
  )
    throw new Error("unit refs absent");
  const entries = new Map<
    string,
    { ref: ArtifactRef; metadata: OutputArtifactMetadata; bytes: Buffer }
  >();
  const add = (ref: ArtifactRef, value: unknown, upstream: ArtifactRef[]) => {
    const metadata = { ...x.store.metadata(ref), upstream_refs: upstream };
    const bytes = Buffer.from(canonicalJson(value));
    const next = previewArtifactRef({ metadata, content: bytes });
    entries.set(next.artifact_id, { ref: next, metadata, bytes });
    return next;
  };
  const resultRef = add(
    original.operation_result_ref,
    e,
    x.store.metadata(original.operation_result_ref).upstream_refs
  );
  const platform = validateHostOperationResult(
    parseScaP03ConsumedJsonV1(x.store.read(original.platform_result_ref), 1_048_576)
  );
  const receipt = validateHostOperationReceipt(
    parseScaP03ConsumedJsonV1(x.store.read(original.host_receipt_ref), 131_072)
  );
  const platformRef = add(
    original.platform_result_ref,
    validateHostOperationResult({ ...platform, identity, operation_result_ref: resultRef }),
    [x.directive.request_ref, resultRef]
  );
  const receiptRef = add(
    original.host_receipt_ref,
    validateHostOperationReceipt({
      ...receipt,
      identity,
      result_sha256: resultRef.content_digest,
      output_bytes: resultRef.byte_length,
    }),
    [x.directive.request_ref, platformRef]
  );
  const nativeRead = x.store.read.bind(x.store),
    nativeMeta = x.store.metadata.bind(x.store),
    nativeRef = x.store.refById.bind(x.store);
  vi.spyOn(x.store, "read").mockImplementation(
    (ref) => entries.get(ref.artifact_id)?.bytes ?? nativeRead(ref)
  );
  vi.spyOn(x.store, "metadata").mockImplementation(
    (ref) => entries.get(ref.artifact_id)?.metadata ?? nativeMeta(ref)
  );
  vi.spyOn(x.store, "refById").mockImplementation((id) => entries.get(id)?.ref ?? nativeRef(id));
  const plan = original.persistence_plan;
  if (plan === null) throw new Error("unit plan absent");
  const record = validateHostOperationCallRecord({
    ...original,
    directive,
    directive_sha256: hostOperationDirectiveSha256(directive),
    operation_result_ref: resultRef,
    platform_result_ref: platformRef,
    host_receipt_ref: receiptRef,
    fetched: {
      schema_version: 1 as const,
      content_sha256: resultRef.content_digest,
      byte_length: resultRef.byte_length,
      item_count: 1,
      poll_count: 0,
    },
    persistence_plan: {
      ...plan,
      operation_result: {
        ...plan.operation_result,
        byte_length: resultRef.byte_length,
        content_sha256: resultRef.content_digest,
      },
    },
  });
  vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(record);
  return () =>
    readScaP03ConsumedFixtureEvidenceV1({
      ...x,
      directive,
      expected_measurement_scope: "deterministic_transport_test",
    });
}

describe("historical reader — fabricated FAST component fixture, not owner E2E", () => {
  it("replays canonical operands, 21 cases, inventories, and original native bytes without writes", () => {
    const x = f();
    const writes = [
      vi.spyOn(x.store, "persist"),
      vi.spyOn(x.store, "select"),
      vi.spyOn(x.checkpointer, "transitionHostOperationCall"),
    ];
    const a = reader(),
      b = reader();
    expect(a.evidence.cases).toHaveLength(21);
    expect(a.attempt_witness.executions).toHaveLength(17);
    expect(a.evidence.original_observations).toHaveLength(146);
    expect(a).toMatchObject({
      verification_scope: "historical_consumed_fixture_evidence",
      current_execution_authorization: "not_evaluated",
      evidence: {
        status: "observed",
        measurement_scope: "deterministic_transport_test",
        independent_review: "required",
        formal_qualification_granted: false,
        activation_granted: false,
        p04_dispatch_permitted: false,
      },
    });
    expect(Buffer.from(a.evidence_bytes)).toEqual(x.store.read(a.result_ref));
    expect(Buffer.from(a.attempt_witness_bytes)).toEqual(
      Buffer.from(x.evidence.attempt_witness_base64, "base64")
    );
    expect(a.result_ref).toEqual(x.record.operation_result_ref);
    expect(a.receipt_ref).toEqual(x.record.host_receipt_ref);
    a.evidence_bytes.fill(0);
    a.attempt_witness_bytes.fill(0);
    expect(b.evidence_bytes[0]).not.toBe(0);
    expect(b.attempt_witness_bytes[0]).not.toBe(0);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });
  it("requires exact scope and refuses a missing canonical record before dependent reads", () => {
    const x = f();
    const reads = vi.spyOn(x.store, "read");
    vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(undefined);
    expect(() =>
      readScaP03ConsumedFixtureEvidenceV1({
        ...x,
        expected_measurement_scope: "deterministic_transport_test",
      })
    ).toThrow("p03_consumed_fixture_missing_evidence");
    expect(reads).not.toHaveBeenCalled();
    vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(x.record);
    expect(() =>
      readScaP03ConsumedFixtureEvidenceV1({ ...x, expected_measurement_scope: "live_observed" })
    ).toThrow("p03_consumed_fixture_scope");
  });
  it.each(["session_id", "playbook"] as const)(
    "refuses a consistently recommitted directive/platform/receipt %s splice before body reads",
    (key) => {
      const x = f();
      const identity = { ...x.directive.identity, [key]: `foreign-${key}` };
      // Recompute the directive digest, both envelope refs and the receipt's upstream link.
      // Keep the journal identity true: only the untrusted directive/envelope cohort changes.
      const read = overlayEvidence(x.evidence, identity);
      const record = x.checkpointer.hostOperationCallForDirective(
        x.directive.identity.run_id,
        x.directive.state_id,
        x.directive.attempt,
        x.directive.operation_id
      );
      if (record === undefined) throw new Error("unit recommitted record absent");
      expect(record.identity).toEqual(x.record.identity);
      expect(record.directive).toEqual({ ...x.directive, identity });
      expect(record.directive_sha256).not.toBe(x.record.directive_sha256);
      const reads = vi.spyOn(x.store, "read").mockClear(); // exclude overlay construction
      expect(read).toThrow(/^p03_consumed_fixture_owner_binding$/);
      expect(reads).not.toHaveBeenCalled();
    }
  );
  it.each(["fixture_blocked", "nonce", "input_order", "release"])(
    "rejects locally recommitted %s evidence at semantic checks",
    (defect) => {
      const e = structuredClone(f().evidence);
      if (defect === "fixture_blocked") e.status = "fixture_blocked";
      if (defect === "nonce") e.invocation_nonce = "foreign-nonce";
      if (defect === "input_order") e.input_refs.reverse();
      if (defect === "release") e.query_release_sha256 = sha256("foreign release");
      expect(overlayEvidence(e)).toThrow("p03_consumed_fixture_fixture_consistency");
    }
  );
  it.each(["prepared", "settled", "terminal"] as const)(
    "does not accept %s as consumed",
    (lifecycle) => {
      const x = f();
      vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue({
        ...x.record,
        lifecycle,
      });
      expect(() =>
        readScaP03ConsumedFixtureEvidenceV1({
          ...x,
          expected_measurement_scope: "deterministic_transport_test",
        })
      ).toThrow("p03_consumed_fixture_owner_binding");
    }
  );
  it.each(["operation_result_ref", "platform_result_ref", "host_receipt_ref"] as const)(
    "refuses missing %s",
    (key) => {
      const x = f();
      vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue({
        ...x.record,
        [key]: null,
      });
      expect(() =>
        readScaP03ConsumedFixtureEvidenceV1({
          ...x,
          expected_measurement_scope: "deterministic_transport_test",
        })
      ).toThrow(/p03_consumed_fixture_(owner_binding|missing_evidence)/);
    }
  );
  it("rejects a candidate graph splice after recomputing candidate and observation digests", () => {
    const e = structuredClone(f().evidence),
      entry = e.cases.find((c) => c.observations.length > 0);
    if (entry === undefined) throw new Error("unit candidates absent");
    entry.observations = entry.observations.map((c) => {
      const { candidate_id: ignored, ...rest } = c;
      void ignored;
      return makeScaP03QueryCandidateV2({
        ...rest,
        graph_component_sha256: sha256("unrelated graph"),
      });
    });
    entry.observed_sha256 = scaP03QualificationObservationSha256V2({
      fixture_id: entry.fixture_id,
      fixture_sha256: entry.fixture_sha256,
      query_id: entry.query_id,
      frontend_language: entry.frontend_language,
      release_sha256: e.query_release_sha256,
      blocker_code: entry.blocker_code,
      observations: entry.observations,
    });
    expect(overlayEvidence(e)).toThrow("p03_consumed_fixture_fixture_consistency");
  });
  it("reads expired historical proof without consulting current authority", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.parse(f().proposal.expires_at) + 86_400_000));
      expect(reader().current_execution_authorization).toBe("not_evaluated");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a fully recommitted inventory splice after native witness replay succeeds", () => {
    const e = structuredClone(f().evidence);
    const old = e.original_observations[107];
    if (old === undefined) throw new Error("unit inventory absent");
    const decoded = Buffer.from(Buffer.from(old.output_base64, "base64").toString(), "base64");
    // Valid inventory for the same file/frontend, but without the retained source nodes.
    const altered = Buffer.from(
      decoded
        .toString()
        .split("\n")
        .filter((row) => row.startsWith("META\t") || row.startsWith("FILE\t"))
        .join("\n") + "\n"
    );
    observation(e, 107, altered.toString("base64"));
    witness(e, (w) => ({
      ...w,
      executions: w.executions.map((execution, i) =>
        i === 12 ? { ...execution, readback_sha256: sha256(altered) } : execution
      ),
    }));
    expect(transcript(e).readbacks[0]?.inventory).toEqual(altered);
    expect(overlayEvidence(e)).toThrow("p03_consumed_fixture_fixture_consistency");
  });
  it("refuses unapproved input provenance before body reads", () => {
    const x = f(),
      native = x.store.metadata.bind(x.store),
      foreign = x.record.platform_result_ref;
    if (foreign === null) throw new Error("unit platform absent");
    const target = x.proposal.input_refs[0];
    if (target === undefined) throw new Error("unit proof absent");
    vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(x.record);
    const reads = vi.spyOn(x.store, "read");
    vi.spyOn(x.store, "metadata").mockImplementation((ref) =>
      ref.artifact_id === target.artifact_id
        ? { ...native(ref), upstream_refs: [foreign] }
        : native(ref)
    );
    expect(() =>
      readScaP03ConsumedFixtureEvidenceV1({
        ...x,
        expected_measurement_scope: "deterministic_transport_test",
      })
    ).toThrow("p03_consumed_fixture_provenance");
    expect(reads).not.toHaveBeenCalled();
  });
  it("refuses missing approved artifacts before their bodies", () => {
    const x = f(),
      native = x.store.refById.bind(x.store),
      target = x.proposal.input_refs[0];
    if (target === undefined) throw new Error("unit proof absent");
    vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(x.record);
    const reads = vi.spyOn(x.store, "read");
    vi.spyOn(x.store, "refById").mockImplementation((id) =>
      id === target.artifact_id ? undefined : native(id)
    );
    expect(() =>
      readScaP03ConsumedFixtureEvidenceV1({
        ...x,
        expected_measurement_scope: "deterministic_transport_test",
      })
    ).toThrow("p03_consumed_fixture_missing_evidence");
    expect(reads).not.toHaveBeenCalled();
  });
  it("rejects record drift at the final exact reread", () => {
    const x = f();
    vi.spyOn(x.checkpointer, "hostOperationCallForDirective")
      .mockReturnValueOnce(x.record)
      .mockReturnValue({ ...x.record, progress_event_count: 1 });
    expect(() =>
      readScaP03ConsumedFixtureEvidenceV1({
        ...x,
        expected_measurement_scope: "deterministic_transport_test",
      })
    ).toThrow("p03_consumed_fixture_reread_drift");
  });
  it.each(["fetched", "plan", "lease", "progress"])(
    "refuses owner/accounting %s mismatch",
    (defect) => {
      const x = f();
      let record = structuredClone(x.record);
      if (defect === "fetched" && record.fetched !== null) record.fetched.item_count = 2;
      if (defect === "plan" && record.persistence_plan !== null)
        record.persistence_plan.operation_result.content_sha256 = sha256("wrong plan");
      if (defect === "lease" && record.lease !== null) record.lease.lease_epoch++;
      if (defect === "progress")
        record = { ...record, progress_event_count: record.progress_event_count + 1 };
      vi.spyOn(x.checkpointer, "hostOperationCallForDirective").mockReturnValue(record);
      expect(() =>
        readScaP03ConsumedFixtureEvidenceV1({
          ...x,
          expected_measurement_scope: "deterministic_transport_test",
        })
      ).toThrow("p03_consumed_fixture_owner_binding");
    }
  );
});

describe("ordered native transcript and retained-witness consistency", () => {
  it("accepts created then running inspections, canonical-vs-raw hashes, inherited labels/env and native JAVA/tmpfs", () => {
    const result = transcript();
    const before = f().evidence.original_observations[4],
      after = f().evidence.original_observations[6],
      execution = result.attempt_witness.executions[0];
    if (before === undefined || after === undefined || execution === undefined)
      throw new Error("unit inspections absent");
    const raw = Buffer.from(after.output_base64, "base64");
    const running = parseScaP03ConsumedJsonV1(raw, consumedResources.command_output_bytes, false);
    expect(
      parseScaP03ConsumedJsonV1(
        Buffer.from(before.output_base64, "base64"),
        consumedResources.command_output_bytes,
        false
      )
    ).toMatchObject({ State: { Status: "created", Running: false } });
    expect(running).toMatchObject({ State: { Status: "running", Running: true } });
    expect(after.output_sha256).toBe(sha256(raw));
    expect(execution.inspect_sha256).toBe(sha256(canonicalJson(running)));
    expect(execution.inspect_sha256).not.toBe(after.output_sha256);
    expect(result.readbacks).toHaveLength(3);
    expect(new Set(result.attempt_witness.executions.map((e) => e.id)).size).toBe(1);
    expect(new Set(result.readbacks.map((r) => sha256(r.graph))).size).toBe(1);
  });
  it.each([
    { name: "already running", state: { Status: "running", Running: true } },
    { name: "running status only", state: { Status: "running", Running: false } },
    { name: "running flag only", state: { Status: "created", Running: true } },
    { name: "exited", state: { Status: "exited", Running: false } },
    { name: "missing status", state: { Running: false } },
    { name: "missing running flag", state: { Status: "created" } },
    { name: "non-boolean running flag", state: { Status: "created", Running: "false" } },
    { name: "null state", state: null },
  ])("rejects $name pre-start state with a recomputed first inspection", ({ state }) => {
    const e = structuredClone(f().evidence);
    const before = e.original_observations[4];
    if (before === undefined) throw new Error("unit first inspection absent");
    const inspected = parseScaP03ConsumedJsonV1(
      Buffer.from(before.output_base64, "base64"),
      consumedResources.command_output_bytes,
      false
    );
    if (inspected === null || typeof inspected !== "object" || Array.isArray(inspected))
      throw new Error("unit inspection object absent");
    observation(e, 4, JSON.stringify({ ...inspected, State: state }, null, 2) + "\n");
    expect(e.original_observations.filter((_, i) => i !== 4)).toEqual(
      f().evidence.original_observations.filter((_, i) => i !== 4)
    );
    expect(e.attempt_witness_base64).toBe(f().evidence.attempt_witness_base64);
    expect(() => transcript(e)).toThrow(/^p03_consumed_fixture_witness_consistency$/);
  });
  it("still refuses a non-running final inspection after recomputing its witness commitments", () => {
    const e = structuredClone(f().evidence);
    const after = e.original_observations[6];
    if (after === undefined) throw new Error("unit final inspection absent");
    const inspected = parseScaP03ConsumedJsonV1(
      Buffer.from(after.output_base64, "base64"),
      consumedResources.command_output_bytes,
      false
    );
    if (inspected === null || typeof inspected !== "object" || Array.isArray(inspected))
      throw new Error("unit inspection object absent");
    const stopped = { ...inspected, State: { Status: "created", Running: false } };
    observation(e, 6, JSON.stringify(stopped, null, 2) + "\n");
    const projection = scaP03NativeConfinementProjectionV1(stopped);
    witness(e, (w) => ({
      ...w,
      executions: w.executions.map((execution, i) =>
        i === 0
          ? {
              ...execution,
              inspect_sha256: sha256(canonicalJson(stopped)),
              confinement_projection: projection,
              confinement_sha256: sha256(projection),
            }
          : execution
      ),
    }));
    expect(() => transcript(e)).toThrow(/^p03_consumed_fixture_witness_consistency$/);
  });
  it.each([
    "base64",
    "missing",
    "extra",
    "ordinal",
    "length",
    "hash",
    "absence",
    "inspection_order",
    "image_order",
    "resource",
    "java",
    "inventory",
  ])("rejects transcript %s with recomputed local observation commitments", (defect) => {
    const e = structuredClone(f().evidence),
      o = e.original_observations;
    const first = o[0];
    if (first === undefined) throw new Error("unit observation absent");
    if (defect === "base64") first.output_base64 += "\n";
    if (defect === "missing") o.splice(10, 1);
    if (defect === "extra") o.push({ ...first, ordinal: o.length + 1 });
    if (defect === "ordinal") first.ordinal = 2;
    if (defect === "length") first.byte_length++;
    if (defect === "hash") first.output_sha256 = sha256("wrong");
    if (defect === "absence") observation(e, 9, "foreign-container\n");
    if (defect === "inspection_order") {
      const before = o[4],
        after = o[6];
      if (before === undefined || after === undefined) throw new Error("unit inspection absent");
      observation(e, 4, Buffer.from(after.output_base64, "base64").toString());
      observation(e, 6, Buffer.from(before.output_base64, "base64").toString());
    }
    if (defect === "image_order") {
      const before = o[4];
      if (before === undefined) throw new Error("unit inspect absent");
      observation(e, 3, Buffer.from(before.output_base64, "base64").toString());
    }
    if (defect === "resource" || defect === "java") {
      const before = o[4];
      if (before === undefined) throw new Error("unit inspect absent");
      const text = Buffer.from(before.output_base64, "base64").toString();
      observation(
        e,
        4,
        defect === "resource"
          ? text.replace('"Memory": 1073741824', '"Memory": 1024')
          : text.replace("JAVA_TOOL_OPTIONS=-Xmx536870912", "JAVA_TOOL_OPTIONS=-Xmx1")
      );
    }
    if (defect === "inventory")
      observation(e, 107, Buffer.from("unrelated inventory").toString("base64"));
    expect(() => transcript(e)).toThrow(/p03_consumed_fixture_(bytes|witness_consistency)/);
  });
  it.each(["candidate", "runtime_package", "deployment", "projection", "response", "readback"])(
    "rejects witness %s splice despite a valid recomputed self-digest",
    (defect) => {
      const e = structuredClone(f().evidence);
      witness(e, (w) => {
        if (defect === "candidate") return { ...w, candidate_sha256: sha256("foreign request") };
        if (defect === "runtime_package")
          return {
            ...w,
            identity: { ...w.identity, runtime_package_sha256: w.identity.deployment_sha256 },
          };
        if (defect === "deployment")
          return {
            ...w,
            identity: { ...w.identity, deployment_sha256: f().proposal.deployment_sha256 },
          };
        return {
          ...w,
          executions: w.executions.map((execution, i) => {
            if (defect === "projection" && i === 0)
              return {
                ...execution,
                confinement_projection: "{}",
                confinement_sha256: sha256("{}"),
              };
            if (defect === "response" && i === 0)
              return { ...execution, response_sha256: sha256("foreign response") };
            if (defect === "readback" && i === 11) {
              const o = e.original_observations[98];
              if (o === undefined) throw new Error("unit graph readback absent");
              return { ...execution, readback_sha256: o.output_sha256 };
            }
            return execution;
          }),
        };
      });
      expect(() => transcript(e)).toThrow("p03_consumed_fixture_witness_consistency");
    }
  );
});

it("bounds JSON before recursion and refuses ambiguous JSON, invalid UTF-8, and base64", () => {
  for (const bytes of [Buffer.from('{"a":1,"a":1}'), Buffer.from('{ "a":1}'), Buffer.from([0xff])])
    expect(() => parseScaP03ConsumedJsonV1(bytes, 1024)).toThrow("p03_consumed_fixture_bytes");
  expect(() =>
    parseScaP03ConsumedJsonV1(Buffer.from("[".repeat(65) + "0" + "]".repeat(65)), 1024)
  ).toThrow("p03_consumed_fixture_bounds");
  expect(() => parseScaP03ConsumedJsonV1(Buffer.alloc(1025), 1024)).toThrow(
    "p03_consumed_fixture_bounds"
  );
  expect(() => decodeScaP03ConsumedBase64V1("Zh==", 4)).toThrow("p03_consumed_fixture_bytes");
});

it.each(["ref", "metadata", "bytes"])("independently detects final envelope %s drift", (defect) => {
  const x = f(),
    r = x.record;
  if (
    r.operation_result_ref === null ||
    r.platform_result_ref === null ||
    r.host_receipt_ref === null
  )
    throw new Error("unit refs absent");
  const controls = x.directive.input_artifacts.artifacts.slice(0, 3).map((v) => v.ref);
  const reader = new ScaP03ConsumedEnvelopeReaderV1(x.store, [
    ...controls,
    r.operation_result_ref,
    r.platform_result_ref,
    r.host_receipt_ref,
  ]);
  for (const ref of [
    ...controls,
    r.operation_result_ref,
    r.platform_result_ref,
    r.host_receipt_ref,
  ])
    reader.exact(ref, 16_777_216, x.store.metadata(ref).upstream_refs, x.proposal.input_refs);
  if (defect === "ref") vi.spyOn(x.store, "refById").mockReturnValue(undefined);
  if (defect === "metadata") {
    const native = x.store.metadata.bind(x.store);
    vi.spyOn(x.store, "metadata").mockImplementation((ref) => ({
      ...native(ref),
      upstream_refs: [],
    }));
  }
  if (defect === "bytes") vi.spyOn(x.store, "read").mockReturnValue(Buffer.from("changed"));
  expect(() => reader.finish()).toThrow("p03_consumed_fixture_reread_drift");
});
