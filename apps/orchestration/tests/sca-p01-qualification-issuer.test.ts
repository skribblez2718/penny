import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  SCA_P01_QUALIFICATION_VARIANT_IDS,
  SCA_P01_REQUIRED_CRITERION_IDS,
  validateScaPhaseQualificationRecordV2,
  validateScaQualificationEvidenceV1,
  type ScaPhaseQualificationRecordV2,
} from "../dist/sca/p01-contracts.js";
import {
  collectP01QualificationEvidenceV2,
  finalizeP01QualificationV2,
  issueP01QualificationV2,
  type P01QualificationIssuerInput,
  type P01QualificationReview,
} from "../dist/sca/p01-qualification-issuer.js";
import { buildP01SourceSnapshotV2 } from "../dist/sca/p01-source-snapshot-builder.js";
import { parseJson } from "./helpers/narrowing.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const phase = "SCA-P01-qualification";
function setup(): {
  store: ArtifactStore;
  input: P01QualificationIssuerInput;
  calls: string[];
  review: () => Promise<P01QualificationReview>;
} {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p01-issuer-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "main.ts"), "export const fixture = true;\n");
  const store = ArtifactStore.provision(path.join(root, "artifacts"), {
    projectId: "prj_11111111111111111111111111111111",
  });
  const snapshot = buildP01SourceSnapshotV2({
    source_root: root,
    store,
    run_id: "qualification-run",
    snapshot_id: "snapshot-1",
    policy: {
      include_paths: ["src"],
      exclude_paths: [],
      max_files: 2,
      max_total_bytes: 1000,
      max_file_bytes: 1000,
      max_walk_entries: 10,
    },
  });
  const cases = SCA_P01_REQUIRED_CRITERION_IDS.flatMap((criterion_id, ci) =>
    SCA_P01_QUALIFICATION_VARIANT_IDS.map((variant_id, vi) => {
      const id = `${String(ci + 1).padStart(2, "0")}-${String(vi + 1).padStart(2, "0")}`;
      return {
        criterion_id,
        variant_id,
        fixture_id: `fixture-${id}`,
        command_id: `command-${id}`,
        job_id: `job-${id}`,
        configuration_sha256: sha256(`configuration-${id}`),
        expected_result: `expected-${id}`,
        fixture_content: Buffer.from(`fixture-bytes-${id}`),
      };
    })
  );
  const calls: string[] = [];
  const review = vi.fn(async () => ({
    authority_id: "review-authority",
    receipt_id: "review-receipt",
    reviewer_identity_id: "reviewer-other",
    reviewer_lineage_id: "review-lineage",
    authority_decision: "authorized" as const,
    decision: "PASS" as const,
    reviewed_at: "2026-01-01T00:00:02Z",
  }));
  const input: P01QualificationIssuerInput = {
    store,
    tenant_id: "tenant-one",
    project_id: "project-one",
    run_id: "qualification-run",
    implementation_revision: "implementation-r1",
    build_identity: "build-one",
    profile_id: "profile-one",
    implementer_identity_id: "implementer-one",
    implementer_lineage_id: "implementer-lineage",
    source_snapshot_ref: snapshot.snapshot_ref,
    implementation_source: Buffer.from("real source bundle"),
    implementation_build: Buffer.from("real build bundle"),
    cases,
    recorded_at: "2026-01-01T00:00:01Z",
    execute: async ({ invocation_id, case: cell }) => {
      calls.push(`${cell.criterion_id}/${cell.variant_id}`);
      return {
        invocation_id,
        observed_result: canonicalJson({
          criterion: cell.criterion_id,
          variant: cell.variant_id,
          invocation_id,
        }),
        status: "PASS",
        log_content: Buffer.from(`log ${invocation_id}`),
        dispatch_measurement: {
          baseline: { model: 7, scanner: 5, application: 3 },
          final: { model: 7, scanner: 5, application: 3 },
          delta: { model: 0, scanner: 0, application: 0 },
        },
      };
    },
    review,
  };
  return { store, input, calls, review };
}
function ref(store: ArtifactStore, kind: string, operation: string) {
  return store.refFor("qualification-run", phase, null, kind, operation, 1);
}
function record(store: ArtifactStore): ScaPhaseQualificationRecordV2 {
  const output = ref(store, "sca-phase-qualification", "p01-qualification");
  if (output === null) throw new Error("missing closure");
  return validateScaPhaseQualificationRecordV2(
    JSON.parse(store.readById(output.artifact_id).toString("utf8"))
  );
}

it("issues a genuine 44-cell PASS closure with exact stored readback and no package activation", async () => {
  const { store, input, calls, review } = setup();
  try {
    const issued = await issueP01QualificationV2(input);
    expect(calls).toEqual(input.cases.map((cell) => `${cell.criterion_id}/${cell.variant_id}`));
    expect(new Set(calls).size).toBe(44);
    expect(review).toHaveBeenCalledOnce();
    const value = record(store);
    expect(value.status).toBe("PASS");
    expect(value.criteria.flatMap((criterion) => criterion.variants)).toHaveLength(44);
    expect(store.refById(issued.artifact_id)).toEqual(issued);
    expect(JSON.parse(store.readById(issued.artifact_id).toString("utf8"))).toEqual(value);
    expect(value.reviewer_receipt_ref.artifact_id).toBeTruthy();
    const first = value.criteria[0]?.variants[0];
    if (first === undefined) throw new Error("missing first cell");
    const evidence = validateScaQualificationEvidenceV1(
      parseJson(store.readById(first.evidence_ref.artifact_id).toString("utf8"))
    );
    expect(evidence.dispatch_measurement).toEqual({
      baseline: { model: 7, scanner: 5, application: 3 },
      final: { model: 7, scanner: 5, application: 3 },
      delta: { model: 0, scanner: 0, application: 0 },
    });
  } finally {
    store.close();
  }
});

it.each(["missing", "duplicate", "reordered", "unknown", "oversized", "reused-fixture"])(
  "refuses %s matrix before any issuer write or execution",
  async (fault) => {
    const { store, input, calls } = setup();
    try {
      const cases = [...input.cases];
      const first = cases[0];
      if (first === undefined) throw new Error("test matrix missing first case");
      if (fault === "missing") cases.pop();
      if (fault === "duplicate") cases[1] = first;
      if (fault === "reordered") cases.reverse();
      if (fault === "unknown") cases[0] = { ...first, variant_id: "unknown" };
      if (fault === "oversized") cases[0] = { ...first, fixture_content: Buffer.alloc(1_048_577) };
      if (fault === "reused-fixture")
        cases[1] = { ...first, ...cases[1], fixture_content: first.fixture_content };
      await expect(issueP01QualificationV2({ ...input, cases })).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(ref(store, "sca-p01-qualification-profile", "qualification-profile")).toBeNull();
    } finally {
      store.close();
    }
  }
);

it("rejects reused callback tokens/results and preserves earlier evidence without PASS", async () => {
  const { store, input } = setup();
  let firstToken = "";
  const original = input.execute;
  let count = 0;
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        execute: async (args) => {
          count++;
          if (count === 1) firstToken = args.invocation_id;
          const outcome = await original(args);
          if (count === 2 && typeof outcome === "object" && outcome !== null)
            return { ...outcome, invocation_id: firstToken };
          return outcome;
        },
      })
    ).rejects.toThrow(/reused/);
    expect(count).toBe(2);
    expect(ref(store, "sca-qualification-evidence", "evidence-01-01")).not.toBeNull();
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  } finally {
    store.close();
  }
});

it.each(["missing", "inconsistent", "unsafe", "nonzero-scanner", "nonzero-application"])(
  "refuses %s dispatch measurement before closure",
  async (fault) => {
    const { store, input, review } = setup();
    try {
      const original = input.execute;
      await expect(
        collectP01QualificationEvidenceV2({
          ...input,
          execute: async (args) => {
            const outcome = await original(args);
            if (typeof outcome !== "object" || outcome === null)
              throw new Error("invalid test outcome");
            const baseline = { model: 2, scanner: 3, application: 4 };
            return fault === "missing"
              ? { ...outcome, dispatch_measurement: undefined }
              : {
                  ...outcome,
                  dispatch_measurement: {
                    baseline,
                    final: {
                      model: fault === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 : 2,
                      scanner: fault === "nonzero-scanner" ? 4 : 3,
                      application: fault === "nonzero-application" ? 5 : 4,
                    },
                    delta: {
                      model: fault === "inconsistent" ? 1 : 0,
                      scanner: fault === "nonzero-scanner" ? 1 : 0,
                      application: fault === "nonzero-application" ? 1 : 0,
                    },
                  },
                };
          },
        })
      ).rejects.toThrow();
      expect(review).not.toHaveBeenCalled();
      expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
    } finally {
      store.close();
    }
  }
);

it("rejects repeated observed results even with fresh invocation tokens", async () => {
  const { store, input, review } = setup();
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        execute: async ({ invocation_id }) => ({
          invocation_id,
          observed_result: "reused",
          status: "PASS",
          log_content: Buffer.from(`log-${invocation_id}`),
          dispatch_measurement: {
            baseline: { model: 7, scanner: 5, application: 3 },
            final: { model: 7, scanner: 5, application: 3 },
            delta: { model: 0, scanner: 0, application: 0 },
          },
        }),
      })
    ).rejects.toThrow(/reused execution/);
    expect(review).not.toHaveBeenCalled();
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  } finally {
    store.close();
  }
});

it.each(["FAIL", "BLOCKED", "NOT RUN", "dispatch"])(
  "retains non-PASS %s evidence and never calls review",
  async (fault) => {
    const { store, input, review } = setup();
    try {
      await expect(
        issueP01QualificationV2({
          ...input,
          execute: async ({ invocation_id }) => ({
            invocation_id,
            observed_result: `observed-${invocation_id}`,
            status: fault === "dispatch" ? "PASS" : fault,
            log_content: Buffer.from(`log-${invocation_id}`),
            dispatch_measurement: {
              baseline: { model: 7, scanner: 5, application: 3 },
              final: { model: fault === "dispatch" ? 8 : 7, scanner: 5, application: 3 },
              delta: { model: fault === "dispatch" ? 1 : 0, scanner: 0, application: 0 },
            },
          }),
        })
      ).rejects.toThrow();
      // NOT RUN cannot be represented as executed evidence by the V2 evidence validator.
      if (fault === "NOT RUN")
        expect(ref(store, "sca-qualification-evidence", "evidence-01-01")).toBeNull();
      else expect(ref(store, "sca-qualification-evidence", "evidence-01-01")).not.toBeNull();
      expect(review).not.toHaveBeenCalled();
      expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
    } finally {
      store.close();
    }
  }
);

it("requires independent reviewer after all evidence and retains a denial without closure", async () => {
  const { store, input, calls } = setup();
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        review: async ({ evidence_refs }) => {
          expect(evidence_refs).toHaveLength(44);
          expect(ref(store, "sca-qualification-evidence", "evidence-04-11")).not.toBeNull();
          return {
            authority_id: "review-authority",
            receipt_id: "review-receipt",
            reviewer_identity_id: input.implementer_identity_id,
            reviewer_lineage_id: "review-lineage",
            authority_decision: "authorized",
            decision: "PASS",
            reviewed_at: input.recorded_at,
          };
        },
      })
    ).rejects.toThrow(/reviewer/);
    expect(calls).toHaveLength(44);
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  } finally {
    store.close();
  }
});

it("preserves completed cells when execution fails and does not retry or review", async () => {
  const { store, input, review } = setup();
  let count = 0;
  const execute = input.execute;
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        execute: async (args) => {
          if (++count === 2) throw new Error("runner unavailable");
          return execute(args);
        },
      })
    ).rejects.toThrow(/runner unavailable/);
    expect(count).toBe(2);
    expect(ref(store, "sca-qualification-evidence", "evidence-01-01")).not.toBeNull();
    expect(ref(store, "sca-qualification-evidence", "evidence-01-02")).toBeNull();
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
    expect(review).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it("preserves all evidence when independent review throws", async () => {
  const { store, input } = setup();
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        review: async () => {
          throw new Error("reviewer unavailable");
        },
      })
    ).rejects.toThrow(/reviewer unavailable/);
    expect(ref(store, "sca-qualification-evidence", "evidence-04-11")).not.toBeNull();
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  } finally {
    store.close();
  }
});

it("retains denied review authority and receipt, never a PASS record", async () => {
  const { store, input } = setup();
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        review: async () => ({
          authority_id: "review-authority",
          receipt_id: "review-receipt",
          reviewer_identity_id: "reviewer-other",
          reviewer_lineage_id: "review-lineage",
          authority_decision: "denied",
          decision: "PASS",
          reviewed_at: input.recorded_at,
        }),
      })
    ).rejects.toThrow(/did not authorize PASS/);
    expect(ref(store, "sca-reviewer-authority", "reviewer-authority")).not.toBeNull();
    expect(ref(store, "sca-review-receipt", "review-receipt")).not.toBeNull();
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  } finally {
    store.close();
  }
});

it("rejects malformed callback data without inventing evidence", async () => {
  const { store, input, review } = setup();
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        execute: async ({ invocation_id }) => ({
          invocation_id,
          status: "PASS",
          observed_result: "claimed",
          log_content: Buffer.from("log"),
          dispatch_measurement: {
            baseline: { model: 7, scanner: 5, application: 3 },
            final: { model: 7, scanner: 5, application: 3 },
            delta: { model: 0, scanner: 0, application: 0 },
          },
          extra: "not admitted",
        }),
      })
    ).rejects.toThrow();
    expect(ref(store, "sca-qualification-evidence", "evidence-01-01")).toBeNull();
    expect(review).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

it("rejects noncanonical source ref before qualification work", async () => {
  const { store, input, calls } = setup();
  const noncanonical = { ...input.source_snapshot_ref, extra: "ambiguous" };
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        source_snapshot_ref: noncanonical,
      })
    ).rejects.toThrow(/additional properties/);
    expect(calls).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("rejects tampered source ref before qualification work", async () => {
  const { store, input, calls } = setup();
  try {
    await expect(
      issueP01QualificationV2({
        ...input,
        source_snapshot_ref: { ...input.source_snapshot_ref, content_digest: sha256("fake") },
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  } finally {
    store.close();
  }
});

it("collects a closed serializable draft without invoking review or minting PASS; reopens for independent finalize and adopts identical replay", async () => {
  const { store, input, review } = setup();
  const draft = await collectP01QualificationEvidenceV2(input);
  const artifactRoot = store.root;
  expect(review).not.toHaveBeenCalled();
  expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  expect(ref(store, "sca-review-receipt", "review-receipt")).toBeNull();
  expect(draft.criteria.flatMap((criterion) => criterion.variants)).toHaveLength(44);
  expect(store.refById(draft.draft_ref.artifact_id)).toEqual(draft.draft_ref);
  store.close();
  const reopened = ArtifactStore.openExisting(artifactRoot, {
    projectId: "prj_11111111111111111111111111111111",
  });
  try {
    const serialized: unknown = parseJson(JSON.stringify(draft));
    const obtained = await review();
    const issued = await finalizeP01QualificationV2({
      store: reopened,
      draft: serialized,
      review: obtained,
    });
    expect(record(reopened).status).toBe("PASS");
    expect(record(reopened).recorded_at).toBe(obtained.reviewed_at);
    expect(
      await finalizeP01QualificationV2({ store: reopened, draft: serialized, review: obtained })
    ).toEqual(issued);
    expect(
      reopened.lastVersion(
        input.run_id,
        phase,
        null,
        "sca-phase-qualification",
        "p01-qualification"
      )
    ).toBe(1);
    await expect(
      finalizeP01QualificationV2({
        store: reopened,
        draft: serialized,
        review: { ...obtained, receipt_id: "another-review" },
      })
    ).rejects.toThrow(/conflicting/);
    expect(
      reopened.lastVersion(
        input.run_id,
        phase,
        null,
        "sca-phase-qualification",
        "p01-qualification"
      )
    ).toBe(1);
  } finally {
    reopened.close();
  }
});

it.each([
  "identity",
  "run",
  "criteria",
  "ref",
  "extra",
  "oversized",
  "overlap-identity",
  "overlap-lineage",
  "early-review",
])("refuses altered draft or reviewer %s before PASS", async (fault) => {
  const { store, input, review } = setup();
  try {
    const draft = await collectP01QualificationEvidenceV2(input);
    const value = await review();
    const changed: unknown = parseJson(JSON.stringify(draft));
    if (
      typeof changed !== "object" ||
      changed === null ||
      !("criteria" in changed) ||
      !Array.isArray(changed.criteria)
    )
      throw new Error("invalid test draft");
    if (fault === "identity") Object.assign(changed, { implementer_identity_id: "other" });
    if (fault === "run") Object.assign(changed, { run_id: "other-run" });
    if (fault === "extra") Object.assign(changed, { reviewer_receipt_ref: draft.draft_ref });
    if (fault === "oversized") Object.assign(changed, { tenant_id: "x".repeat(100_000) });
    if (fault === "ref")
      Object.assign(changed, { implementation_ref: draft.qualification_profile_ref });
    if (fault === "criteria") Object.assign(changed, { criteria: [...draft.criteria].reverse() });
    const supplied =
      fault === "overlap-identity"
        ? { ...value, reviewer_identity_id: draft.implementer_lineage_id }
        : fault === "overlap-lineage"
          ? { ...value, reviewer_lineage_id: draft.implementer_identity_id }
          : fault === "early-review"
            ? { ...value, reviewed_at: "2025-12-31T00:00:00Z" }
            : value;
    const callback = vi.fn(async () => supplied);
    await expect(
      finalizeP01QualificationV2({ store, draft: changed, review_callback: callback })
    ).rejects.toThrow();
    if (!fault.startsWith("overlap") && fault !== "early-review")
      expect(callback).not.toHaveBeenCalled();
    expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
  } finally {
    store.close();
  }
});

it.each(["log-tampered", "evidence-tampered", "fixture-missing"])(
  "refuses %s transitive bytes before calling review",
  async (fault) => {
    const { store, input, review } = setup();
    try {
      const draft = await collectP01QualificationEvidenceV2(input);
      const cell = draft.criteria[0]?.variants[0];
      if (cell === undefined) throw new Error("missing test cell");
      const raw: unknown = JSON.parse(
        store.readById(cell.evidence_ref.artifact_id).toString("utf8")
      );
      const evidence = validateScaQualificationEvidenceV1(raw);
      const chosen =
        fault === "log-tampered"
          ? evidence.log_content_ref
          : fault === "fixture-missing"
            ? evidence.fixture_content_ref
            : cell.evidence_ref;
      const objectPath = path.join(
        store.root,
        "objects",
        "sha256",
        chosen.content_digest.slice(0, 2),
        chosen.content_digest.slice(2)
      );
      if (fault === "fixture-missing") unlinkSync(objectPath);
      else writeFileSync(objectPath, "tampered bytes");
      const callback = vi.fn(review);
      await expect(
        finalizeP01QualificationV2({ store, draft, review_callback: callback })
      ).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect(ref(store, "sca-phase-qualification", "p01-qualification")).toBeNull();
    } finally {
      store.close();
    }
  }
);
