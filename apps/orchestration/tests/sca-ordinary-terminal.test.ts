/** Exact diagnostic delivery; real artifact store and engine, offline cognition only. */
import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { canonicalJson } from "../dist/canonical-json.js";
import { TerminalDirectiveSchema, validateContract, type ArtifactRef } from "../dist/contracts.js";
import { OrchestrationService } from "../dist/service.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { ScaSelectionDraftSchema, ScaReviewSchema } from "../dist/sca/ordinary-contracts.js";
import { exactJson, persistScaArtifact } from "../dist/sca/ordinary-artifacts.js";
import { ScaReportProductSchema } from "../dist/sca/ordinary-report.js";
import { ScaOutputManifestSchema, scaTerminalUnresolved } from "../dist/sca/ordinary-terminal.js";
import {
  environment,
  fixtureAdapters,
  PROJECT_ROOT,
  roots,
  ScriptedScaClient,
  start,
} from "./helpers/sca-local-workflow.js";

const delivery = TerminalDirectiveSchema.properties.unresolved;
const limits = validateContract(
  Type.Object({
    maxItems: Type.Integer({ minimum: 1 }),
    items: Type.Object({ maxLength: Type.Integer({ minimum: 1 }) }),
  }),
  delivery,
  "Exported terminal diagnostic limits"
);
const countLimit = limits.maxItems;
const stringLimit = limits.items.maxLength;
const counts = [0, 1, countLimit, countLimit + 1];

function required(refs: readonly ArtifactRef[], kind: string): ArtifactRef {
  const ref = refs.find((entry) => entry.kind === kind);
  if (ref === undefined) throw new Error(`Missing exact ${kind}`);
  return ref;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(mode: "confirmed" | "missing" = "confirmed", gap?: string) {
  const env = environment();
  const client = new (class extends ScriptedScaClient {
    override output(invocation: AgentInvocation): unknown {
      const value = super.output(invocation);
      if (gap === undefined || invocation.stateId !== "selecting_scanner_dependency_leads")
        return value;
      return {
        ...validateContract(ScaSelectionDraftSchema, value, "Original fixture selection"),
        gaps: [gap],
      };
    }
  })(mode);
  const service = new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    env,
    playbookName: "sca",
    modelClient: client,
    hostOperationAdapters: fixtureAdapters(mode),
  });
  client.bindArtifactReader((id) => service.artifacts.readById(id).toString("utf8"));
  try {
    const terminal = await service.execute(start("terminal-delivery"));
    if (terminal.action !== "complete" && terminal.action !== "incomplete")
      throw new Error(canonicalJson(terminal));
    expect(terminal.action).toBe(
      mode === "missing" || gap !== undefined ? "incomplete" : "complete"
    );
    const manifest = exactJson(
      service.artifacts,
      required(terminal.artifacts, "sca-output-manifest"),
      ScaOutputManifestSchema
    );
    const report = exactJson(
      service.artifacts,
      required(terminal.artifacts, "semantic-core"),
      ScaReportProductSchema
    );
    const persist = (kind: string, schemaId: string, value: unknown, upstream: ArtifactRef[]) =>
      persistScaArtifact({
        store: service.artifacts,
        runId: "terminal-delivery",
        phase: "diagnostic-projection",
        kind,
        schemaId,
        content: canonicalJson(value),
        upstream,
      });
    return {
      service,
      terminal,
      manifest,
      report,
      prepare(unresolved: string[], reportGaps: string[] | null = unresolved, bindReport = true) {
        const reportRef =
          reportGaps === null
            ? undefined
            : persist(
                "semantic-core",
                "penny.sca-report.v3",
                validateContract(
                  ScaReportProductSchema,
                  { ...report, status: "INCOMPLETE", gaps: reportGaps },
                  "Diagnostic report"
                ),
                []
              );
        const manifestRef = persist(
          "sca-output-manifest",
          "penny.sca-output-manifest.v1",
          validateContract(
            ScaOutputManifestSchema,
            {
              ...manifest,
              status: "incomplete",
              outputs: reportRef === undefined || !bindReport ? [] : [reportRef],
              unresolved,
            },
            "Diagnostic manifest"
          ),
          reportRef === undefined ? [] : [reportRef]
        );
        return {
          store: service.artifacts,
          manifest: manifestRef,
          ...(reportRef === undefined ? {} : { report: reportRef }),
        };
      },
    };
  } catch (error) {
    service[Symbol.dispose]();
    throw error;
  }
}

describe("SCA terminal exact diagnostic delivery", () => {
  it("preserves nonempty small-list negative terminal delivery through the real engine", async () => {
    const { service, terminal, manifest, report } = await fixture("missing");
    using owner = service;
    expect(terminal.action).toBe("incomplete");
    expect(terminal.met).toBe(false);
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(Value.Check(delivery, report.gaps)).toBe(true);
    expect(terminal.unresolved).toEqual(report.gaps);
    expect(manifest.unresolved).toEqual(report.gaps);
    expect(
      exactJson(
        owner.artifacts,
        required(terminal.artifacts, "semantic-core"),
        ScaReportProductSchema
      )
    ).toEqual(report);
  });

  it("delivers a long original stage gap as an exact pointer without terminal fallback", async () => {
    const gap = "λ".repeat(stringLimit + 1);
    const { service, terminal, manifest, report } = await fixture("confirmed", gap);
    using owner = service;
    const reportRef = required(terminal.artifacts, "semantic-core");
    expect(report.gaps).toContain(`Recorded at selecting_scanner_dependency_leads: ${gap}`);
    expect(Value.Check(delivery, report.gaps)).toBe(false);
    expect(manifest.unresolved).toEqual(report.gaps);
    expect(terminal.unresolved).toHaveLength(1);
    expect(terminal.unresolved[0]).toContain(reportRef.artifact_id);
    expect(terminal.unresolved[0]).toContain(reportRef.content_digest);
    expect(terminal.unresolved[0]).toContain("JSON /gaps");
    expect(exactJson(owner.artifacts, reportRef, ScaReportProductSchema)).toEqual(report);
    expect(report.gaps.join("\n")).not.toMatch(
      /Rejected incomplete stage|Terminal partial annotation/iu
    );
    for (const kind of ["sca-reviewing-report", "sca-verifying-final-product"])
      expect(
        exactJson(owner.artifacts, required(terminal.artifacts, kind), ScaReviewSchema)
          .report_artifact_id
      ).toBe(reportRef.artifact_id);
  });

  it.each(counts)("preserves the exported count boundary (%s entries)", async (count) => {
    const { service, prepare } = await fixture();
    using owner = service;
    // Repetitions, order, whitespace and Unicode must survive; no set/slice summary.
    const unresolved = Array.from({ length: count }, (_, i) => `  gap ${i % 3}: λ\nsecond line.  `);
    const input = prepare(unresolved);
    const before = owner.artifacts.readById(input.manifest.artifact_id);
    const delivered = scaTerminalUnresolved(input);
    if (Value.Check(delivery, unresolved)) expect(delivered).toEqual(unresolved);
    else {
      const ref = input.report;
      if (ref === undefined) throw new Error("Missing exact report");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain(ref.artifact_id);
      expect(delivered[0]).toContain(ref.content_digest);
      expect(delivered[0]).toContain("JSON /gaps");
    }
    expect(Value.Check(delivery, delivered)).toBe(true);
    expect(exactJson(owner.artifacts, input.manifest, ScaOutputManifestSchema).unresolved).toEqual(
      unresolved
    );
    expect(owner.artifacts.readById(input.manifest.artifact_id)).toEqual(before);
  });

  it("uses the exported per-string boundary without truncation", async () => {
    const { service, prepare } = await fixture();
    using owner = service;
    const atLimit = ["λ".repeat(stringLimit)];
    expect(scaTerminalUnresolved(prepare(atLimit))).toEqual(atLimit);
    const unresolved = ["λ".repeat(stringLimit + 1)];
    const input = prepare(unresolved);
    const delivered = scaTerminalUnresolved(input);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("JSON /gaps");
    expect(Value.Check(delivery, delivered)).toBe(true);
    expect(exactJson(owner.artifacts, input.manifest, ScaOutputManifestSchema).unresolved).toEqual(
      unresolved
    );
  });

  it.each(["redacted", "reordered", "multiplicity", "absent", "unbound"] as const)(
    "retains the exact manifest when report diagnostics are %s",
    async (variant) => {
      const { service, prepare } = await fixture();
      using owner = service;
      const unresolved = Array.from({ length: countLimit + 1 }, (_, i) => `gap ${i}: exact λ.  `);
      const reportGaps =
        variant === "absent"
          ? null
          : variant === "redacted"
            ? ["[WITHHELD]"]
            : variant === "reordered"
              ? [...unresolved].reverse()
              : variant === "unbound"
                ? unresolved
                : unresolved.concat("gap 0: exact λ.  ");
      const input = prepare(unresolved, reportGaps, variant !== "unbound");
      const delivered = scaTerminalUnresolved(input);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain(input.manifest.artifact_id);
      expect(delivered[0]).toContain(input.manifest.content_digest);
      expect(delivered[0]).toContain("JSON /unresolved");
      expect(Value.Check(delivery, delivered)).toBe(true);
      expect(
        exactJson(owner.artifacts, input.manifest, ScaOutputManifestSchema).unresolved
      ).toEqual(unresolved);
    }
  );

  it("rejects unknown manifest fields and corrupt exact reference metadata", async () => {
    const { service, prepare } = await fixture();
    using owner = service;
    const input = prepare(Array.from({ length: countLimit + 1 }, () => "same exact gap"));
    const manifest = exactJson(owner.artifacts, input.manifest, ScaOutputManifestSchema);
    expect(Value.Check(ScaOutputManifestSchema, { ...manifest, extra: true })).toBe(false);
    expect(() =>
      scaTerminalUnresolved({ ...input, manifest: { ...input.manifest, byte_length: 0 } })
    ).toThrow("metadata mismatch");
    const ref = input.report;
    if (ref === undefined) throw new Error("Missing exact report");
    expect(() =>
      scaTerminalUnresolved({ ...input, report: { ...ref, content_digest: "0".repeat(64) } })
    ).toThrow("metadata mismatch");
  });
});
