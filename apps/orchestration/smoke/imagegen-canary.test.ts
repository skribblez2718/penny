import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Directive } from "../dist/contracts.js";
import {
  ImagegenActivationDeniedError,
  imagegenActivationRequestSha256,
  type ImagegenActivationAdmissionInputV1,
  type ImagegenActivationAdmissionReceiptV1,
  type ImagegenActivationCleanupReceiptV1,
  type ImagegenActivationController,
  type ImagegenActivationStatusV1,
} from "../dist/imagegen/activation.js";
import { loadImagegenRuntimeFromEnvironment } from "../dist/imagegen/runtime-config.js";
import type { ImagegenStartAdmissionProvidersV1 } from "../dist/imagegen/types.js";
import { PLAYBOOK_REGISTRY, resolvePlaybook } from "../dist/playbooks/registry.js";
import { buildSkillImageOutputPresentation } from "../dist/skill-result-image.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import { validateImageSlotLedger } from "../dist/imagegen/slot-ledger.js";
import { OrchestrationService } from "../dist/service.js";
import {
  ImagegenManifestV1Schema,
  validateImageValidationReceipt,
} from "../dist/skill-contracts/imagegen.js";
import { initializePennyState } from "../dist/state/setup.js";
import {
  assertImagegenCanaryGate,
  imagegenCanaryIssueCodes,
  IMAGEGEN_CANARY_CANARY_ID,
  IMAGEGEN_CANARY_CONSTRAINTS,
  IMAGEGEN_CANARY_GOAL,
  IMAGEGEN_CANARY_MANIFEST_ENV,
  type ImagegenCanaryObservationV1,
} from "./imagegen-canary-contract.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const CANARY_ID = IMAGEGEN_CANARY_CANARY_ID;
const RUN_ID = "run-production-activation-canary";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be text`);
  return value;
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

class RecordingActivationController implements ImagegenActivationController {
  readonly admissions: ImagegenActivationAdmissionReceiptV1[] = [];
  readonly cleanups: ImagegenActivationCleanupReceiptV1[] = [];

  constructor(private readonly inner: ImagegenActivationController) {}

  get mode(): ImagegenActivationController["mode"] {
    return this.inner.mode;
  }

  status(): ImagegenActivationStatusV1 {
    return this.inner.status();
  }

  admit(input: ImagegenActivationAdmissionInputV1): ImagegenActivationAdmissionReceiptV1 {
    const receipt = this.inner.admit(input);
    this.admissions.push(receipt);
    return receipt;
  }

  finalizeRun(input: {
    readonly run_id: string;
    readonly outcome: import("../dist/imagegen/activation.js").ImagegenActivationOutcomeV1;
  }): ImagegenActivationCleanupReceiptV1 | undefined {
    const receipt = this.inner.finalizeRun(input);
    if (receipt !== undefined) this.cleanups.push(receipt);
    return receipt;
  }
}

async function denialCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ImagegenActivationDeniedError) return error.code;
    throw error;
  }
  return "not_denied";
}

function startRequest(runId: string, goal: string): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: "imagegen",
      engine_owner: "typescript",
    },
    goal,
    constraints: IMAGEGEN_CANARY_CONSTRAINTS,
    project_root: PROJECT_ROOT,
    trust_profile: "trusted-interactive",
  };
}

function kindCount(artifacts: readonly ArtifactRef[], kind: string): number {
  return artifacts.filter((ref) => ref.kind === kind).length;
}

describe("opt-in one-shot production activation canary", () => {
  it(
    "admits exactly one host-bound canary through the production registry and denies ordinary starts",
    async () => {
      assertImagegenCanaryGate(process.env);
      const operatorManifestFile = process.env[IMAGEGEN_CANARY_MANIFEST_ENV];
      if (operatorManifestFile === undefined) {
        throw new Error(
          `Set ${IMAGEGEN_CANARY_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
        );
      }
      const operatorManifestBytes = readFileSync(operatorManifestFile);
      const operatorManifest = requireRecord(
        parseJson(operatorManifestBytes.toString("utf8")),
        "operator imagegen runtime manifest"
      );
      const defaultProfileId = requireString(
        operatorManifest["default_profile_id"],
        "operator manifest default_profile_id"
      );
      const approvals = requireRecord(
        operatorManifest["approved_profile_sha256_by_id"],
        "operator manifest profile approvals"
      );
      const profileSha256 = requireString(
        approvals[defaultProfileId],
        `approved digest for profile '${defaultProfileId}'`
      );

      const root = mkdtempSync(path.join(tmpdir(), "penny-imagegen-canary-"));
      roots.push(root);
      const stateRoot = path.join(root, "state");
      mkdirSync(stateRoot, { mode: 0o700 });

      // A temporary, owner-only manifest copy in canary mode bound to the exact fixed request
      // digest and approved profile digest. The operator manifest is read but never written.
      const canaryManifestFile = path.join(root, "runtime-canary.json");
      const canaryManifest = {
        ...operatorManifest,
        activation: {
          mode: "canary",
          canary: {
            canary_id: CANARY_ID,
            request_sha256: imagegenActivationRequestSha256({
              goal: IMAGEGEN_CANARY_GOAL,
              constraints: IMAGEGEN_CANARY_CONSTRAINTS,
            }),
            profile_sha256: profileSha256,
          },
        },
      };
      writeFileSync(canaryManifestFile, JSON.stringify(canaryManifest), { mode: 0o600 });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PENNY_STATE_ROOT: stateRoot,
        PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: canaryManifestFile,
        PI_OBSERVABILITY_AUTO_START: "false",
        PI_OBSERVABILITY_ENABLED: "false",
      };
      initializePennyState(PROJECT_ROOT, { env });
      const previousStateRoot = process.env.PENNY_STATE_ROOT;
      process.env.PENNY_STATE_ROOT = stateRoot;

      const loaded = loadImagegenRuntimeFromEnvironment({ env, state_root: stateRoot });
      if (loaded === undefined) throw new Error("canary runtime manifest did not load");
      const activation = new RecordingActivationController(loaded.providers.activation);
      const providers: ImagegenStartAdmissionProvidersV1 = {
        ...loaded.providers,
        activation,
      };

      let service: OrchestrationService | undefined;
      try {
        // Omit `modelClient` so the service builds the real PiAgentClient and resolves the SSOT
        // Vera/Carren image-capable models; omit `playbookRegistration` so the exact-name ingress
        // resolves through the actual production PLAYBOOK_REGISTRY.
        service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          playbookName: "imagegen",
          imagegen: providers,
          hostOperationAdapters: loaded.adapters,
        });
        const canaryService = service;
        expect(canaryService.engine.registration.name).toBe("imagegen");
        const registration = resolvePlaybook("imagegen");
        if (registration === undefined || registration.worker.kind !== "catalog-agent") {
          throw new Error("production imagegen registration is not an ordinary catalog worker");
        }
        // The real SSOT critics must be admitted with image input, never a text-only substitute.
        for (const phase of ["critiquing_candidates_vera", "critiquing_candidates_carren"]) {
          if (registration.worker.phases.get(phase)?.requires_image_input !== true) {
            throw new Error(`production imagegen phase '${phase}' does not require image input`);
          }
        }

        const ordinaryDeniedCode = await denialCode(() =>
          canaryService.execute(
            startRequest("run-canary-ordinary-denied", "an unrelated ordinary scene")
          )
        );

        const terminal: Directive = await canaryService.execute(
          startRequest(RUN_ID, IMAGEGEN_CANARY_GOAL)
        );
        if (terminal.action !== "complete") {
          throw new Error(`production canary terminated as '${terminal.action}'`);
        }
        const completion = canaryService.checkpointer.completionAdmission(RUN_ID);

        const imageRef = terminal.artifacts.find((ref) => ref.kind === "generated-image");
        if (imageRef === undefined) throw new Error("canary generated image is absent");
        const manifestRef = terminal.artifacts.find((ref) => ref.kind === "imagegen-manifest");
        if (manifestRef === undefined) throw new Error("canary manifest is absent");
        const manifest = validateContract(
          ImagegenManifestV1Schema,
          parseJson(canaryService.artifacts.readById(manifestRef.artifact_id).toString("utf8")),
          "ImagegenManifestV1"
        );
        const ledgerRef = terminal.artifacts.find((ref) => ref.kind === "image-slot-ledger");
        const ledger =
          ledgerRef === undefined
            ? undefined
            : validateImageSlotLedger(
                parseJson(canaryService.artifacts.readById(ledgerRef.artifact_id).toString("utf8"))
              );
        const validationRef = terminal.artifacts.find(
          (ref) => ref.kind === "image-validation-receipt"
        );
        const validation =
          validationRef === undefined
            ? undefined
            : validateImageValidationReceipt(
                parseJson(
                  canaryService.artifacts.readById(validationRef.artifact_id).toString("utf8")
                )
              );
        const presentation = buildSkillImageOutputPresentation({
          skill_name: "imagegen",
          ref: imageRef,
          bytes: canaryService.artifacts.readById(imageRef.artifact_id),
        });

        const replayDeniedCode = await denialCode(() =>
          canaryService.execute(startRequest("run-canary-replay", IMAGEGEN_CANARY_GOAL))
        );

        const observation: ImagegenCanaryObservationV1 = {
          production_registry_has_imagegen: PLAYBOOK_REGISTRY.has("imagegen"),
          ordinary_start_denied: ordinaryDeniedCode !== "not_denied",
          ordinary_denied_code: ordinaryDeniedCode,
          canary_admission_decision: activation.admissions[0]?.decision ?? "missing",
          canary_consumed_run_matches: activation.admissions.some(
            (receipt) =>
              receipt.decision === "admitted_canary" &&
              receipt.run_id === RUN_ID &&
              receipt.canary_id === CANARY_ID
          ),
          replay_denied: replayDeniedCode !== "not_denied",
          replay_denied_code: replayDeniedCode,
          terminal_action: terminal.action,
          terminal_met: terminal.met,
          completion_origin: completion?.origin_state ?? "missing",
          selected_image_present:
            manifest.selected_image_ref.artifact_id === imageRef.artifact_id &&
            presentation.content.some((block) => block.type === "image"),
          review_epochs_complete:
            manifest.review_epoch === 1 &&
            kindCount(terminal.artifacts, "image-validity-report") === 1 &&
            kindCount(terminal.artifacts, "image-quality-report") === 1,
          cleanup_outcome: activation.cleanups[0]?.outcome ?? "missing",
          operator_manifest_unchanged:
            readFileSync(operatorManifestFile).equals(operatorManifestBytes),
          ordinary_mode_still_disabled: activation.mode === "canary",
        };

        expect(ledger?.slots[0]?.state).toBe("accepted");
        expect(validation?.status).toBe("valid");
        expect(canaryService.engine.registration.ingress).toBe("skill");
        expect(resolvePlaybook("imagegen")?.ingress).toBe("skill");
        expect(imagegenCanaryIssueCodes(observation)).toEqual([]);
      } finally {
        service?.close();
        loaded.close();
        if (previousStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
        else process.env.PENNY_STATE_ROOT = previousStateRoot;
      }
    },
    30 * 60_000
  );
});
