/** Host-owned validation feedback. Never quotes rejected model bytes or private configuration. */
import { Type, type TSchema, type Static } from "typebox";
import { Value } from "typebox/value";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import type { ParsedScaSourceCorpusV1 } from "./active-compliance.js";
import { resolveRange } from "./ordinary-artifacts.js";
import { scaP11HasSensitiveContent } from "./p11-redaction.js";
import {
  ScaPointerSchema,
  ScaSelectionSchema,
  ScaSelectionDraftSchema,
  ScaHypothesesSchema,
  ScaChallengeSchema,
  ScaActionsSchema,
  ScaDispositionsSchema,
  ScaLearningSchema,
  ScaReportDraftSchema,
  ScaReviewConsistencySchema,
  type ScaPointer,
  type ScaSelection,
  type ScaHypotheses,
  type ScaActions,
  type ScaEvidence,
  type ScaDispositions,
  type ScaPreparation,
} from "./ordinary-contracts.js";
const closed = { additionalProperties: false } as const;
const RangeSchema = Type.Object(
  {
    path: ScaPointerSchema.properties.path,
    start_line: ScaPointerSchema.properties.start_line,
    end_line: ScaPointerSchema.properties.end_line,
  },
  closed
);
export const ScaStageFailureSchema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("schema_invalid"),
      Type.Literal("review_consistency"),
      Type.Literal("representation_validation"),
      Type.Literal("id_accounting"),
      Type.Literal("citation_range"),
      Type.Literal("citation_quote"),
      Type.Literal("input_binding"),
      Type.Literal("evidence_binding"),
    ]),
    location: Type.String({ minLength: 1, maxLength: 1024 }),
    expected_ids: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 512 }),
    expected_pointer: Type.Union([ScaPointerSchema, Type.Null()]),
    allowed_ranges: Type.Array(RangeSchema, { maxItems: 64 }),
    review_consistency: Type.Optional(ScaReviewConsistencySchema),
  },
  closed
);
export type ScaStageFailure = Static<typeof ScaStageFailureSchema>;
export const ScaSemanticDiagnosticSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    state: Type.String({ minLength: 1, maxLength: 128 }),
    rejected_artifact: ArtifactRefSchema,
    original_input_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 32 }),
    predecessor_diagnostic: Type.Union([ArtifactRefSchema, Type.Null()]),
    rejection_ordinal: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    // Historical two-revision diagnostics remain readable. New diagnostics expose
    // the actual operator allowance, or null when no count policy was supplied.
    revision_limit: Type.Union([
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      Type.Null(),
    ]),
    failure: ScaStageFailureSchema,
  },
  closed
);
export class ScaStageRejection extends Error {
  readonly failure: ScaStageFailure;
  constructor(
    code: ScaStageFailure["code"],
    location: string,
    extra: Partial<Omit<ScaStageFailure, "code" | "location">> = {}
  ) {
    super(`SCA ${code} at ${location}`);
    this.failure = validateContract(
      ScaStageFailureSchema,
      { code, location, expected_ids: [], expected_pointer: null, allowed_ranges: [], ...extra },
      "SCA minimized stage diagnostic"
    );
  }
}
/** Structural rejection locations use only registered property names and numeric indices.
 * Unknown property names/values and parser error text are never reflected into feedback. */
export function validateScaStageShape(schema: TSchema, value: unknown): void {
  if (Value.Check(schema, value)) return;
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    for (const [key, raw] of Object.entries(node)) {
      const child: unknown = raw;
      if (key === "properties" && child !== null && typeof child === "object")
        for (const name of Object.keys(child)) names.add(name);
      visit(child);
    }
  };
  visit(schema);
  const error = [...Value.Errors(schema, value)][0];
  const parts = (error?.instancePath ?? "").split("/").filter(Boolean);
  const safe: string[] = [];
  for (const part of parts) {
    if (!names.has(part) && !/^\d+$/u.test(part)) break;
    safe.push(part);
  }
  throw new ScaStageRejection("schema_invalid", `/${safe.join("/")}`);
}
export function exactScaIds(
  actual: readonly string[],
  expected: readonly string[],
  location: string
): void {
  const actualIds = new Set(actual),
    expectedIds = new Set(expected);
  if (
    actualIds.size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((id) => !expectedIds.has(id))
  )
    throw new ScaStageRejection("id_accounting", location, {
      // Feedback is bounded; the full immutable preparation index remains an original input.
      // This bounds only diagnostic suggestions, never source coverage or acceptance.
      expected_ids: expected.filter((id) => !actualIds.has(id)).slice(0, 512),
    });
}
type Range = Static<typeof RangeSchema>;
/** Pure, explicit model-authorized projection against the host-selected exact preparation.
 * The caller verifies preparationRef/bytes before entry. Never infers a deferral or reason. */
export function materializeScaSelectionDraft(input: {
  state: "selecting_scanner_dependency_leads" | "selecting_underdetected_no_alert_surfaces";
  value: unknown;
  preparation: ScaPreparation;
  preparationRef: ArtifactRef;
}): ScaSelection {
  validateScaStageShape(ScaSelectionDraftSchema, input.value);
  const draft = validateContract(ScaSelectionDraftSchema, input.value, "Selection draft");
  const scanner = input.state === "selecting_scanner_dependency_leads";
  const location = scanner ? "/selections+deferred" : "/selections/ranges/path+deferred";
  const expected = scanner
    ? input.preparation.leads.map((lead) => lead.id)
    : input.preparation.files.map((file) => file.path);
  // Duplicate preparation identities or repeated lead claims cannot define a unique remainder.
  exactScaIds(expected, [...new Set(expected)], "/preparation");
  const leadIds = draft.selections.flatMap((selection) => selection.lead_ids);
  exactScaIds(leadIds, [...new Set(leadIds)], "/selections/lead_ids");
  const selectedIds = scanner
    ? leadIds
    : [...new Set(draft.selections.flatMap((selection) => selection.ranges.map((r) => r.path)))];
  const explicit = [...selectedIds, ...draft.deferred.map((entry) => entry.id)];
  const explicitIds = new Set(explicit);
  const declaration = draft.defer_remainder;
  if (declaration !== undefined) {
    if (
      declaration.preparation_artifact_id !== input.preparationRef.artifact_id ||
      declaration.preparation_sha256 !== input.preparationRef.content_digest ||
      declaration.scope !== (scanner ? "leads" : "files")
    )
      throw new ScaStageRejection("input_binding", "/defer_remainder");
    // Check foreign IDs, duplicates and selected/deferred overlap BEFORE complementing.
    exactScaIds(
      explicit,
      expected.filter((id) => explicitIds.has(id)),
      location
    );
  }
  const selection = {
    schema_version: draft.schema_version,
    selections: draft.selections,
    deferred: [
      ...draft.deferred,
      ...(declaration === undefined
        ? []
        : expected
            .filter((id) => !explicitIds.has(id))
            .map((id) => ({ id, reason: declaration.reason }))),
    ],
    gaps: draft.gaps,
  };
  // No truncation or canonical size-limit relaxation, including for large file indexes.
  validateScaStageShape(ScaSelectionSchema, selection);
  exactScaIds([...selectedIds, ...selection.deferred.map((entry) => entry.id)], expected, location);
  return validateContract(ScaSelectionSchema, selection, "Canonical selection");
}
export interface ScaStageValidationInputs {
  state: string;
  schema: TSchema;
  value: unknown;
  corpus: ParsedScaSourceCorpusV1;
  preparation: ScaPreparation;
  preparationRef: ArtifactRef;
  selections: ScaSelection[];
  hypotheses?: ScaHypotheses;
  actions?: ScaActions;
  evidence?: ScaEvidence;
  dispositions?: ScaDispositions;
  applicationIds: string[];
  learningIds: string[];
}
/** Pure preflight: no writes, transitions, content mutation, candidate removal or normalization. */
export function validateScaCognitiveStage(input: ScaStageValidationInputs): void {
  const { state, value, corpus } = input;
  validateScaStageShape(input.schema, value);
  const focused = input.selections.flatMap((x) => x.selections);
  const permitted = focused.flatMap((x) => x.ranges);
  const checkRange = (range: Range, location: string): ScaPointer => {
    try {
      return resolveRange(corpus, range);
    } catch {
      const file = corpus.files.get(range.path);
      const path = file === undefined ? undefined : range.path;
      throw new ScaStageRejection("citation_range", location, {
        allowed_ranges:
          path === undefined
            ? []
            : [
                {
                  path,
                  start_line: 1,
                  end_line: Math.min(file?.text.split(/\r?\n/u).length ?? 1, 257),
                },
              ],
      });
    }
  };
  const pointer = (p: ScaPointer, location: string, ranges = permitted): void => {
    // Never disclose bytes not already admitted in this stage's exact inputs.
    if (
      !ranges.some(
        (r) => r.path === p.path && r.start_line <= p.start_line && r.end_line >= p.end_line
      )
    )
      throw new ScaStageRejection("input_binding", location, {
        allowed_ranges: ranges.slice(0, 64),
      });
    const expected = checkRange(p, location);
    if (expected.exact_quote !== p.exact_quote)
      throw new ScaStageRejection("citation_quote", location, {
        expected_pointer: scaP11HasSensitiveContent(expected.exact_quote) ? null : expected,
      });
  };
  if (
    state === "selecting_scanner_dependency_leads" ||
    state === "selecting_underdetected_no_alert_surfaces"
  ) {
    const v = materializeScaSelectionDraft({ ...input, state });
    exactScaIds(
      v.selections.map((x) => x.id),
      [...new Set(v.selections.map((x) => x.id))],
      "/selections"
    );
    v.selections.forEach((s, i) => {
      s.ranges.forEach((r, j) => checkRange(r, `/selections/${i}/ranges/${j}`));
      if (s.lead_ids.some((id) => !input.preparation.leads.some((l) => l.id === id)))
        throw new ScaStageRejection("id_accounting", `/selections/${i}/lead_ids`);
    });
    if (state === "selecting_scanner_dependency_leads")
      exactScaIds(
        [...new Set(v.selections.flatMap((x) => x.lead_ids)), ...v.deferred.map((x) => x.id)],
        input.preparation.leads.map((x) => x.id),
        "/selections+deferred"
      );
    else {
      exactScaIds(
        [...focused.map((x) => x.id), ...v.selections.map((x) => x.id)],
        [...new Set([...focused.map((x) => x.id), ...v.selections.map((x) => x.id)])],
        "/selections"
      );
      // Selection ranges may overlap within a file, but deferrals must be explicit and disjoint.
      exactScaIds(
        [
          ...new Set(v.selections.flatMap((x) => x.ranges.map((r) => r.path))),
          ...v.deferred.map((x) => x.id),
        ],
        input.preparation.files.map((x) => x.path),
        "/selections/ranges/path+deferred"
      );
    }
  } else if (state === "forming_hypotheses") {
    const v = validateContract(ScaHypothesesSchema, value, "Hypotheses");
    exactScaIds(
      [
        ...new Set(v.hypotheses.flatMap((x) => x.selection_ids)),
        ...v.unformed.map((x) => x.selection_id),
      ],
      focused.map((x) => x.id),
      "/hypotheses/selection_ids+unformed"
    );
    exactScaIds(
      v.hypotheses.map((x) => x.id),
      [...new Set(v.hypotheses.map((x) => x.id))],
      "/hypotheses"
    );
    v.hypotheses.forEach((h, i) => {
      exactScaIds(h.selection_ids, [...new Set(h.selection_ids)], `/hypotheses/${i}/selection_ids`);
      const ranges = focused.filter((x) => h.selection_ids.includes(x.id)).flatMap((x) => x.ranges);
      h.support.forEach((p, j) => pointer(p, `/hypotheses/${i}/support/${j}`, ranges));
    });
  } else if (state === "challenging_hypotheses") {
    const v = validateContract(ScaChallengeSchema, value, "Challenges");
    exactScaIds(
      v.challenges.map((x) => x.hypothesis_id),
      input.hypotheses?.hypotheses.map((x) => x.id) ?? [],
      "/challenges"
    );
    v.challenges.forEach((c, i) =>
      c.counterevidence.forEach((p, j) => pointer(p, `/challenges/${i}/counterevidence/${j}`))
    );
  } else if (state === "selecting_evidence_actions") {
    const v = validateContract(ScaActionsSchema, value, "Actions");
    exactScaIds(
      [...new Set(v.actions.map((x) => x.hypothesis_id))],
      input.hypotheses?.hypotheses.map((x) => x.id) ?? [],
      "/actions/hypothesis_id"
    );
    exactScaIds(
      v.actions.map((x) => x.id),
      [...new Set(v.actions.map((x) => x.id))],
      "/actions"
    );
    v.actions.forEach((a, i) => {
      a.ranges.forEach((r, j) => checkRange(r, `/actions/${i}/ranges/${j}`));
      if (
        a.application_plan_id !== undefined &&
        (a.kind !== "application_test" || !input.applicationIds.includes(a.application_plan_id))
      )
        throw new ScaStageRejection("input_binding", `/actions/${i}/application_plan_id`, {
          expected_ids: input.applicationIds,
        });
    });
  } else if (state === "adjudicating_evidence") {
    const v = validateContract(ScaDispositionsSchema, value, "Dispositions");
    exactScaIds(
      v.dispositions.map((x) => x.hypothesis_id),
      input.hypotheses?.hypotheses.map((x) => x.id) ?? [],
      "/dispositions"
    );
    v.dispositions.forEach((d, i) => {
      const location = `/dispositions/${i}`;
      const ownActions =
        input.actions?.actions.filter((a) => a.hypothesis_id === d.hypothesis_id) ?? [];
      if (
        new Set(d.action_ids).size !== d.action_ids.length ||
        d.action_ids.some((id) => !ownActions.some((a) => a.id === id))
      )
        throw new ScaStageRejection("id_accounting", `${location}/action_ids`, {
          expected_ids: ownActions.map((x) => x.id),
        });
      const observations =
        input.evidence?.results.filter(
          (r) =>
            r.hypothesis_id === d.hypothesis_id &&
            r.status === "completed" &&
            d.action_ids.includes(r.action_id)
        ) ?? [];
      const ranges = observations.flatMap((x) => x.pointers);
      for (const field of ["evidence", "counterevidence"] as const)
        d[field].forEach((p, j) => {
          // Union coverage may span adjacent captured observations.
          const sorted = ranges
            .filter((r) => r.path === p.path)
            .sort((a, b) => a.start_line - b.start_line);
          let next = p.start_line;
          for (const r of sorted) {
            if (r.start_line > next) break;
            next = Math.max(next, r.end_line + 1);
          }
          if (next <= p.end_line)
            throw new ScaStageRejection("evidence_binding", `${location}/${field}/${j}`, {
              allowed_ranges: ranges
                .map(({ path, start_line, end_line }) => ({ path, start_line, end_line }))
                .slice(0, 64),
            });
          pointer(p, `${location}/${field}/${j}`, [p]);
        });
      if (
        (d.disposition === "confirmed_code" || d.disposition === "refuted") &&
        ((d.disposition === "confirmed_code" ? d.evidence : d.counterevidence).length === 0 ||
          d.action_ids.length === 0 ||
          d.action_ids.some((id) => !observations.some((r) => r.action_id === id)))
      )
        throw new ScaStageRejection("evidence_binding", location);
      if (
        d.disposition === "duplicate" &&
        (d.duplicate_of === null ||
          d.duplicate_of === d.hypothesis_id ||
          !v.dispositions.some(
            (x) => x.hypothesis_id === d.duplicate_of && x.disposition !== "duplicate"
          ))
      )
        throw new ScaStageRejection("id_accounting", `${location}/duplicate_of`);
    });
  } else if (state === "assessing_learning") {
    const v = validateContract(ScaLearningSchema, value, "Learning");
    const eligible =
      input.dispositions?.dispositions
        .filter((d) => d.disposition === "confirmed_code")
        .map((d) => d.hypothesis_id) ?? [];
    exactScaIds(
      v.outcomes.map((x) => x.hypothesis_id),
      eligible,
      "/outcomes"
    );
    if ((eligible.length === 0) !== (v.no_eligible_findings_reason !== null))
      throw new ScaStageRejection("input_binding", "/no_eligible_findings_reason");
    const ids = v.outcomes.flatMap((x) => (x.validation_id === undefined ? [] : [x.validation_id]));
    if (new Set(ids).size !== ids.length || ids.some((id) => !input.learningIds.includes(id)))
      throw new ScaStageRejection("id_accounting", "/outcomes/validation_id", {
        expected_ids: input.learningIds,
      });
  } else if (state === "materializing_report") {
    const v = validateContract(ScaReportDraftSchema, value, "Report draft");
    const reportable =
      input.dispositions?.dispositions
        .filter((d) =>
          ["confirmed_code", "probable", "theoretical", "inconclusive"].includes(d.disposition)
        )
        .map((d) => d.hypothesis_id) ?? [];
    exactScaIds(
      v.findings.map((x) => x.hypothesis_id),
      reportable,
      "/findings"
    );
    const ranges = [...permitted, ...(input.evidence?.results.flatMap((r) => r.pointers) ?? [])];
    v.findings.forEach((f, i) => {
      f.code_analysis.forEach((a, j) =>
        pointer(a.pointer, `/findings/${i}/code_analysis/${j}/pointer`, ranges)
      );
      f.metric_evidence.forEach((m, j) =>
        m.evidence.forEach((p, k) =>
          pointer(p, `/findings/${i}/metric_evidence/${j}/evidence/${k}`, ranges)
        )
      );
    });
    v.chains.forEach((c, i) => {
      if (c.hypothesis_ids.some((id) => !reportable.includes(id)))
        throw new ScaStageRejection("id_accounting", `/chains/${i}/hypothesis_ids`);
      c.evidence.forEach((p, j) => pointer(p, `/chains/${i}/evidence/${j}`, ranges));
    });
  }
  // Reviews have their own exact report/evidence/check semantics in the playbook.
}
