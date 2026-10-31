import { describe, expect, it } from "vitest";
import { PhaseResultProjectionV1Schema } from "../dist/phase-result-projection.js";

import { researchSummarySchema } from "../dist/playbooks/research.js";
import { PRODUCE_PLAYBOOK_REGISTRATION } from "../dist/playbooks/produce.js";
import {
  resolvePlaybook,
  runtimeRegistrationSha256,
  validateRegistrationContract,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { validateContract } from "../dist/contracts.js";
import { normalizeTrustedRoutingCompletion, parsePersistedRoutingSummary } from "../dist/worker.js";

describe("registration-owned phase result projection", () => {
  it("admits only confidence and phase details, never a target or completion authority", () => {
    for (const invalid of [
      { confidence: "CERTAIN", details: {}, target_state: "complete" },
      { confidence: "CERTAIN", details: {}, met: true },
      { confidence: "CERTAIN", details: {}, fresh_verification: true },
      { confidence: "invalid", details: {} },
      { details: {} },
    ])
      expect(() =>
        validateContract(PhaseResultProjectionV1Schema, invalid, "projection output")
      ).toThrow();
  });

  it("leaves SCA and ordinary unopted phase transport declarations untouched", () => {
    for (const name of ["research", "plan", "sca"]) {
      const registration = resolvePlaybook(name);
      if (registration === undefined || registration.worker.kind !== "catalog-agent")
        throw new Error("catalog registration absent");
      expect(registration.worker.result_transport).toBe("persisted_summary");
      for (const phase of registration.worker.phases.values())
        expect(Object.hasOwn(phase, "result_projection")).toBe(false);
    }
  });

  it.each([
    "missing_declaration",
    "missing_implementation",
    "wrong_state",
    "wrong_agent",
    "wrong_registration",
    "wrong_schema",
    "extra_declaration",
    "guarded",
  ])("refuses %s projection authority before worker execution", (mode) => {
    const base = PRODUCE_PLAYBOOK_REGISTRATION;
    if (base.worker.kind !== "catalog-agent") throw new Error("catalog worker absent");
    const phases = new Map(base.worker.phases);
    const phase = phases.get("verifying_artifact");
    if (phase?.result_projection === undefined) throw new Error("projector absent");
    const projector = {
      ...phase.result_projection,
      declaration: { ...phase.result_projection.declaration },
    };
    if (mode === "missing_declaration") Reflect.deleteProperty(projector, "declaration");
    if (mode === "missing_implementation") Reflect.deleteProperty(projector, "project");
    if (mode === "wrong_state") projector.declaration.state_id = "critiquing_artifact";
    if (mode === "wrong_agent") projector.declaration.agent = "carren";
    if (mode === "wrong_registration") projector.declaration.registration_name = "plan";
    if (mode === "wrong_schema")
      projector.declaration.result_schema_id = "penny.produce.approach-summary.v1";
    if (mode === "extra_declaration")
      Object.assign(projector.declaration, { target_state: "complete" });
    phases.set("verifying_artifact", {
      ...phase,
      result_projection: projector,
      ...(mode === "guarded"
        ? { provider_opening_guard: "sca_p04_payload_disclosure_v1" as const }
        : {}),
    });
    const changed: PlaybookRegistration = { ...base, worker: { ...base.worker, phases } };
    expect(() => validateRegistrationContract(changed)).toThrow();
  });

  it("binds projection presence/version into identity without changing unopted transport", () => {
    const base = PRODUCE_PLAYBOOK_REGISTRATION;
    if (base.worker.kind !== "catalog-agent") throw new Error("catalog worker absent");
    const phases = new Map(base.worker.phases);
    const phase = phases.get("verifying_artifact");
    if (phase?.result_projection === undefined) throw new Error("projector absent");
    const { result_projection: projection, ...unopted } = phase;
    phases.set("verifying_artifact", unopted);
    const withoutProjection: PlaybookRegistration = { ...base, worker: { ...base.worker, phases } };
    expect(runtimeRegistrationSha256(withoutProjection)).not.toBe(runtimeRegistrationSha256(base));
    phases.set("verifying_artifact", {
      ...phase,
      result_projection: {
        ...projection,
        declaration: { ...projection.declaration, schema_id: "penny.future-review-projection.v1" },
      },
    });
    expect(runtimeRegistrationSha256({ ...base, worker: { ...base.worker, phases } })).not.toBe(
      runtimeRegistrationSha256(base)
    );
    expect(parsePersistedRoutingSummary("PRODUCE_REVIEW:{}")).toBeUndefined();
  });

  it("does not grant the catalog projection seam to host-private phases", () => {
    const base = resolvePlaybook("knowledge-base");
    const produce = PRODUCE_PLAYBOOK_REGISTRATION;
    if (
      base === undefined ||
      base.worker.kind !== "host-private" ||
      produce.worker.kind !== "catalog-agent"
    )
      throw new Error("worker kinds absent");
    const projection = produce.worker.phases.get("verifying_artifact")?.result_projection;
    if (projection === undefined) throw new Error("projector absent");
    const phases = new Map(
      [...base.worker.phases].map(
        ([state, phase]) => [state, { ...phase, result_projection: projection }] as const
      )
    );
    const changed: PlaybookRegistration = { ...base, worker: { ...base.worker, phases } };
    expect(() => validateRegistrationContract(changed)).toThrow(/host-private/u);
  });
});

describe("persisted assistant SUMMARY routing", () => {
  it("separates transport confidence before exact phase validation", () => {
    const routing = parsePersistedRoutingSummary(
      'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}'
    );
    expect(routing).toEqual({
      confidence: "PROBABLE",
      details: { explore_complete: true },
    });
    expect(() =>
      validateContract(researchSummarySchema("researching"), routing?.details, "Echo summary")
    ).not.toThrow();
  });

  it("preserves unknown semantic fields for the closed state schema to reject", () => {
    const routing = parsePersistedRoutingSummary(
      'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"PROBABLE","future_metadata":{"retained":true}}'
    );
    expect(routing).toEqual({
      confidence: "PROBABLE",
      details: {
        explore_complete: true,
        future_metadata: { retained: true },
      },
    });
    expect(() =>
      validateContract(researchSummarySchema("researching"), routing?.details, "Echo summary")
    ).toThrow(/additional properties/u);
  });

  it("ignores prose backticks while requiring one exact unique final SUMMARY line", () => {
    expect(
      parsePersistedRoutingSummary(
        'complete stage bytes\nSUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}\n'
      )
    ).toEqual({ confidence: "CERTAIN", details: { explore_complete: true } });
    expect(
      parsePersistedRoutingSummary(
        'Inline `code` stays prose.\n```json\n{"stage":"complete"}\n```\nSUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}'
      )
    ).toEqual({ confidence: "CERTAIN", details: { explore_complete: true } });
    expect(
      parsePersistedRoutingSummary(
        '```json\n{"stage":"complete"}\nSUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}\n```'
      )
    ).toBeUndefined();
    expect(
      parsePersistedRoutingSummary(
        'prose\n`SUMMARY:{"explore_complete":true,"confidence":"CERTAIN"}`'
      )
    ).toBeUndefined();
    expect(
      parsePersistedRoutingSummary(
        'SUMMARY:{"explore_complete":true,"confidence":"PROBABLE"}\ntrailing prose'
      )
    ).toBeUndefined();
    expect(
      parsePersistedRoutingSummary(
        'SUMMARY:{"explore_complete":true}\nSUMMARY:{"explore_complete":true}'
      )
    ).toBeUndefined();
    expect(parsePersistedRoutingSummary('SUMMARY:{"explore_complete":true}\n\n')).toBeUndefined();
  });

  it("accepts horizontal framing whitespace without relaxing the unique final JSON line", () => {
    for (const separator of ["", " ", "\t", " \t "]) {
      expect(
        parsePersistedRoutingSummary(
          `SUMMARY:${separator}{"explore_complete":true,"confidence":"PROBABLE"}`
        )
      ).toEqual({ confidence: "PROBABLE", details: { explore_complete: true } });
    }
    for (const text of [
      'SUMMARY: \n{"explore_complete":true}',
      'SUMMARY: {"explore_complete":true} trailing prose',
      'SUMMARY: {"explore_complete":true}\n\n',
      'SUMMARY: {"explore_complete":true}\nSUMMARY:{"explore_complete":true}',
      ' SUMMARY: {"explore_complete":true}',
      'SUMMARY: {"confidence":"INVALID"}',
    ]) {
      expect(parsePersistedRoutingSummary(text)).toBeUndefined();
    }
  });

  it("keeps missing-confidence compatibility but rejects invalid confidence", () => {
    expect(parsePersistedRoutingSummary('SUMMARY:{"explore_complete":true}')).toEqual({
      confidence: "UNCERTAIN",
      details: { explore_complete: true },
    });
    expect(parsePersistedRoutingSummary("complete bytes")).toBeUndefined();
    expect(parsePersistedRoutingSummary("SUMMARY:not-json")).toBeUndefined();
    expect(parsePersistedRoutingSummary('SUMMARY:{"confidence":"INVALID"}')).toBeUndefined();
  });

  it("normalizes trusted completions and rejects conflicting confidence", () => {
    expect(
      normalizeTrustedRoutingCompletion({
        confidence: "CERTAIN",
        details: { explore_complete: true, confidence: "CERTAIN" },
      })
    ).toEqual({ confidence: "CERTAIN", details: { explore_complete: true } });
    expect(
      normalizeTrustedRoutingCompletion({
        confidence: "CERTAIN",
        details: { explore_complete: true, confidence: "PROBABLE" },
      })
    ).toBeUndefined();
  });
});
