import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { loadRuntimeConfig } from "../dist/config.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import {
  PiAgentClient,
  ssotModel,
  type ActiveWorkerRegistrationMetadataV1,
  type InlineExtension,
} from "../dist/model-client.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import {
  ImagegenQualitySummaryV1Schema,
  ImagegenValiditySummaryV1Schema,
  IMAGEGEN_PLAYBOOK_REGISTRATION,
} from "../dist/playbooks/imagegen.js";
import { buildSkillImageOutputPresentation } from "../dist/skill-result-image.js";
import {
  validateImagegenReviewSet,
  type ImageCandidateRevisionV1,
} from "../dist/skill-contracts/imagegen.js";
import { initializePennyState } from "../dist/state/setup.js";
import { requireRecord } from "../tests/helpers/narrowing.js";
import {
  assertImagegenModelSmokeGate,
  criticDeliveryIssueCodes,
  criticReportIssueCodes,
  IMAGEGEN_MODEL_SMOKE_DEFAULT_COUNT,
  IMAGEGEN_MODEL_SMOKE_MAXIMUM_COUNT,
  type ImageDeliveryEvidenceV1,
} from "./imagegen-model-smoke-contract.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const REVIEW_EPOCH = 1;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-imagegen-model-smoke-"));
  roots.push(root);
  return root;
}

function fixturePng(slot: number): Buffer {
  const rgba = Buffer.alloc(16);
  for (let pixel = 0; pixel < 4; pixel += 1) {
    rgba[pixel * 4] = (slot * 40 + pixel) % 256;
    rgba[pixel * 4 + 1] = (slot * 20 + pixel * 3) % 256;
    rgba[pixel * 4 + 2] = (slot * 10 + pixel * 7) % 256;
    rgba[pixel * 4 + 3] = 255;
  }
  return Buffer.from(encodeCanonicalPng({ width: 2, height: 2, rgba }));
}

function imageDeliveryRecorder(worker: string): {
  readonly extension: InlineExtension;
  readonly records: ImageDeliveryEvidenceV1[];
} {
  const records: ImageDeliveryEvidenceV1[] = [];
  const extension: InlineExtension = (pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName !== "artifact_read") return;
      const artifactId = event.input["artifact"];
      if (typeof artifactId !== "string") return;
      for (const item of event.content) {
        if (item.type !== "image") continue;
        records.push({
          worker,
          artifact_id: artifactId,
          mime_type: item.mimeType,
          image_block: true,
        });
      }
    });
  };
  return { extension, records };
}

function criticRegistration(
  phase: "critiquing_candidates_vera" | "critiquing_candidates_carren"
): ActiveWorkerRegistrationMetadataV1 {
  const worker = IMAGEGEN_PLAYBOOK_REGISTRATION.worker;
  if (worker.kind !== "catalog-agent") {
    throw new Error("imagegen registration is not a catalog-agent worker");
  }
  const entry = worker.phases.get(phase);
  if (entry === undefined) throw new Error(`imagegen phase '${phase}' is not registered`);
  const allowedTools = entry.allowed_tools;
  if (allowedTools === undefined) {
    throw new Error(`imagegen phase '${phase}' declares no registration tool subset`);
  }
  return {
    playbook_name: IMAGEGEN_PLAYBOOK_REGISTRATION.name,
    workflow_name: worker.workflow_name,
    guidance: worker.guidance,
    result_transport: worker.result_transport,
    opening_policy: worker.opening_policy,
    model_policy: worker.model_policy,
    allowed_tools: [...allowedTools],
    ...(entry.guidance_state_id === undefined
      ? {}
      : { guidance_state_id: entry.guidance_state_id }),
    ...(entry.requires_image_input === true ? { requires_image_input: true } : {}),
  };
}

function criticTask(
  agent: "vera" | "carren",
  candidates: readonly ImageCandidateRevisionV1[]
): string {
  const projected = canonicalJson(candidates);
  const common =
    'Read every needed exact input_artifact with artifact_read before judging. Generated-image artifacts are delivered as image content by artifact_read and must be inspected visually. Do not discover predecessors through memory, repository search, /tmp, or name-only references. Emit the required domain-product line followed by exactly one final SUMMARY JSON object matching the registered phase schema. Every findings entry has exactly these keys and types: {"finding_id":"opaque-id","slot":0,"revision":0,"code":"opaque-code","detail":"bounded actionable text","blocking":true}; no other finding keys are allowed. Each candidate.finding_ids contains only finding_id values from findings for that same slot and revision.';
  if (agent === "vera") {
    return `${common}\n\nMECHANICALLY_PROJECTED_CURRENT_CANDIDATES:${projected}\nVerify visual validity and exact brief compliance for every current candidate. Return one ImageValidityReportV1 for review_epoch=${REVIEW_EPOCH}. Candidate coverage must be exact. Every blocking finding must be assigned to its slot and approval is true exactly when that candidate has no blocking finding. This qualification supplies only the exact generated-image artifacts as the complete evidence set; the brief is 'a calm wordless blue geometric composition'.`;
  }
  return `${common}\n\nMECHANICALLY_PROJECTED_CURRENT_CANDIDATES:${projected}\nCritique aesthetic quality and brief fidelity for every current candidate. Return one ImageQualityReportV1 for review_epoch=${REVIEW_EPOCH}, with exact candidate coverage and a total ranking containing every current candidate exactly once. Every blocking finding must be assigned to its slot and approval is true exactly when that candidate has no blocking finding. This qualification supplies only the exact generated-image artifacts as the complete evidence set; the brief is 'a calm wordless blue geometric composition'.`;
}

function parseSummary(text: string): unknown {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && line.startsWith("SUMMARY:")) {
      return JSON.parse(line.slice("SUMMARY:".length));
    }
  }
  throw new Error(
    `critic response lacks a final SUMMARY line (bytes=${Buffer.byteLength(text, "utf8")}, tail=${JSON.stringify(text.slice(-500))})`
  );
}

function revisionKey(candidate: ImageCandidateRevisionV1): string {
  return `${candidate.slot}|${candidate.revision}|${candidate.image_artifact_id}|${candidate.image_sha256}`;
}

interface ModelSmokeSet {
  readonly label: string;
  readonly count: number;
  readonly refs: readonly ArtifactRef[];
  readonly candidates: readonly ImageCandidateRevisionV1[];
}

function persistFixtureSet(input: {
  readonly store: ArtifactStore;
  readonly label: string;
  readonly count: number;
}): ModelSmokeSet {
  const refs: ArtifactRef[] = [];
  const candidates: ImageCandidateRevisionV1[] = [];
  for (let slot = 0; slot < input.count; slot += 1) {
    const ref = input.store.persist({
      metadata: {
        schema_version: 2,
        run_id: `run-imagegen-model-smoke-${input.label}`,
        phase: "generating_candidate",
        branch_id: null,
        kind: "generated-image",
        operation_id: `imagegen-model-smoke-${input.label}-slot-${slot}-revision-0`,
        version: 1,
        producer: "host:imagegen-model-smoke",
        media_type: "image/png",
        parent_ref: null,
        upstream_refs: [],
      },
      content: fixturePng(slot),
    });
    refs.push(ref);
    candidates.push({
      slot,
      revision: 0,
      image_artifact_id: ref.artifact_id,
      image_sha256: ref.content_digest,
    });
  }
  return { label: input.label, count: input.count, refs, candidates };
}

describe("opt-in imagegen multimodal critic live smoke", () => {
  it(
    "delivers the default three-image and maximum-ten sets to both registered critics and renders the selected image",
    async () => {
      assertImagegenModelSmokeGate(process.env);

      const root = temporaryRoot();
      const stateRoot = path.join(root, "state");
      mkdirSync(stateRoot, { mode: 0o700 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PENNY_STATE_ROOT: stateRoot,
        PI_OBSERVABILITY_AUTO_START: "false",
        PI_OBSERVABILITY_ENABLED: "false",
      };
      initializePennyState(PROJECT_ROOT, { env });
      const previousStateRoot = process.env.PENNY_STATE_ROOT;
      process.env.PENNY_STATE_ROOT = stateRoot;

      const config = loadRuntimeConfig(PROJECT_ROOT, env);
      const store = ArtifactStore.openExisting(config.artifactRoot, {
        projectId: config.projectId,
      });
      const catalogSessions = { projectId: config.projectId, root: config.subagentSessionRoot };
      const sets = [
        persistFixtureSet({
          store,
          label: "default",
          count: IMAGEGEN_MODEL_SMOKE_DEFAULT_COUNT,
        }),
        persistFixtureSet({
          store,
          label: "maximum",
          count: IMAGEGEN_MODEL_SMOKE_MAXIMUM_COUNT,
        }),
      ];

      try {
        for (const set of sets) {
          const reports = new Map<string, unknown>();
          for (const [agent, phase] of [
            ["vera", "critiquing_candidates_vera"],
            ["carren", "critiquing_candidates_carren"],
          ] as const) {
            const agentDoc = readFileSync(
              path.join(PROJECT_ROOT, ".pi", "agents", `${agent}.md`),
              "utf8"
            );
            const model = ssotModel(agentDoc);
            if (model === undefined) {
              throw new Error(`agent '${agent}' SSOT declares no model identity`);
            }
            const recorder = imageDeliveryRecorder(agent);
            const client = new PiAgentClient({
              catalogSessions,
              workerExtensions: [recorder.extension],
            });
            const admitted: Array<{ provider: string; model: string }> = [];
            const completion = await client.runAgent({
              agent,
              stateId: "critiquing_candidates",
              task: criticTask(agent, set.candidates),
              projectRoot: PROJECT_ROOT,
              trustProfile: "hardened-untrusted",
              inputArtifacts: set.refs,
              workflowSession: {
                run_id: `${set.label}-${agent}`,
                workflow_session_id: `session-${set.label}-${agent}`,
                branch_id: agent,
                attempt: 1,
                worker_id: `worker-${set.label}-${agent}`,
                purpose: "phase",
              },
              registration: criticRegistration(phase),
              modelOverride: model,
              admitResolvedModel: (resolved) => {
                admitted.push(resolved);
              },
            });
            expect(admitted).toHaveLength(1);

            const parsedSummary = requireRecord(parseSummary(completion.text), `${agent} summary`);
            const { confidence: _confidence, ...summaryDetails } = parsedSummary;
            const summary = validateContract(
              agent === "vera" ? ImagegenValiditySummaryV1Schema : ImagegenQualitySummaryV1Schema,
              summaryDetails,
              `${agent} ${set.label} summary`
            );
            reports.set(agent, summary.report);

            expect(
              criticDeliveryIssueCodes({
                worker: agent,
                expected_artifact_ids: set.refs.map((ref) => ref.artifact_id),
                delivered_artifact_ids: recorder.records.map((record) => record.artifact_id),
                delivered_mime_types: recorder.records.map((record) => record.mime_type),
              })
            ).toEqual([]);
          }

          const validity = reports.get("vera");
          const quality = reports.get("carren");
          if (validity === undefined || quality === undefined) {
            throw new Error(`imagegen ${set.label} critic reports are incomplete`);
          }
          const reviewed = validateImagegenReviewSet({
            expected: set.candidates,
            validity,
            quality,
          });
          const expectedKeys = set.candidates.map(revisionKey);
          expect(
            criticReportIssueCodes({
              worker: "vera",
              expected_epoch: REVIEW_EPOCH,
              report_epoch: reviewed.validity.review_epoch,
              expected_revision_keys: expectedKeys,
              reported_revision_keys: reviewed.validity.candidates.map((entry) =>
                revisionKey(entry.candidate)
              ),
            })
          ).toEqual([]);
          expect(
            criticReportIssueCodes({
              worker: "carren",
              expected_epoch: REVIEW_EPOCH,
              report_epoch: reviewed.quality.review_epoch,
              expected_revision_keys: expectedKeys,
              reported_revision_keys: reviewed.quality.candidates.map((entry) =>
                revisionKey(entry.candidate)
              ),
              ranked_revision_keys: reviewed.quality.ranking.map(revisionKey),
            })
          ).toEqual([]);

          const winner = reviewed.quality.ranking[0];
          if (winner === undefined) throw new Error(`imagegen ${set.label} ranking is empty`);
          const selectedRef = set.refs.find((ref) => ref.artifact_id === winner.image_artifact_id);
          if (selectedRef === undefined) {
            throw new Error(`imagegen ${set.label} selected image is not a fixture artifact`);
          }
          const presentation = buildSkillImageOutputPresentation({
            skill_name: "imagegen",
            ref: selectedRef,
            bytes: store.readById(selectedRef.artifact_id),
          });
          const metadata = presentation.content[0];
          const image = presentation.content[1];
          if (metadata?.type !== "text" || image?.type !== "image") {
            throw new Error(
              `imagegen ${set.label} parent result lacks metadata plus image content`
            );
          }
          expect(JSON.parse(metadata.text)).toMatchObject({
            type: "skill_image_output",
            skill_name: "imagegen",
            artifact_ref: { artifact_id: selectedRef.artifact_id },
            content_digest: selectedRef.content_digest,
          });
          expect(metadata.text).not.toContain(
            store.readById(selectedRef.artifact_id).toString("base64")
          );
          expect(image.mimeType).toBe("image/png");
        }
      } finally {
        store.close();
        if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
        else process.env.PENNY_STATE_ROOT = previousStateRoot;
      }
    },
    30 * 60_000
  );
});
