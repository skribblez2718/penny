import { lstatSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OrchestrationService } from "../../../../apps/orchestration/dist/service.js";
import { canonicalJson, sha256 } from "../../../../apps/orchestration/dist/canonical-json.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  type ScaP03TrustedInitialProfileV1,
} from "../../../../apps/orchestration/dist/sca/p03-initial-authorization.js";
import {
  SCA_P03_INITIAL_NAME,
  ScaP03InitialTransportV1Schema,
  createScaP03InitialQualificationRegistrationV1,
  readScaP03InitialGate,
} from "../../../../apps/orchestration/dist/sca/p03-initial-qualification.js";
import {
  validateContract,
  type ArtifactRef,
} from "../../../../apps/orchestration/dist/contracts.js";
import {
  registerTrustedQuestionnaireTransport,
  verifyExecutionOwnerSignature,
} from "../../skill/execution-receipts.js";
import { respondToTrustedNativeGateV1 } from "../../skill/trusted-gate-driver.js";

export interface ScaP03NativeOperatorHostV1 {
  /** Constructed by trusted native configuration, NOT environment/client profile fields. */
  readonly service: OrchestrationService;
  readonly authorization: ScaP03InitialAuthorizationV1;
  readonly binding: ScaP03InitialProposalBindingV1;
  readonly state_authority_sha256: string;
}
import { ArtifactStore } from "../../../../apps/orchestration/dist/artifact-store.js";
import { loadRuntimeConfig } from "../../../../apps/orchestration/dist/config.js";
import type { ScaP03InitialNativeHostV1 } from "../../../../apps/sca-service/src/p03-initial-host.js";

/** Usable native composition from explicit host constraints. No model-visible credential,
 * approval boolean, default actor mapping, state provisioning or alternate backend catalog. */
export async function createScaP03NativeOperatorHostV1(input: {
  readonly project_root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly approved_state_root: string;
  readonly approved_backend_resource_sha256: string;
  readonly capsule_path: string;
  readonly capsule_sha256: string;
  readonly proposal_ref: ArtifactRef;
  readonly profile: ScaP03TrustedInitialProfileV1;
  readonly p02_owner: ConstructorParameters<typeof ScaP03InitialNativeHostV1>[0]["p02_owner"];
  readonly p02_registry: ConstructorParameters<typeof ScaP03InitialNativeHostV1>[0]["p02_registry"];
  readonly p02_host: ConstructorParameters<typeof ScaP03InitialNativeHostV1>[0]["p02_host"];
}): Promise<ScaP03NativeOperatorHostV1 & Disposable> {
  const config = loadRuntimeConfig(input.project_root, input.env);
  if (
    config.stateRoot !== input.approved_state_root ||
    config.projectId !== input.p02_host.project_id
  )
    throw new Error("p03_native_canonical_state_required");
  const catalog = lstatSync(path.join(config.stateRoot, "catalog.db"));
  const stateAuthority = sha256(
    canonicalJson({
      state_root: config.stateRoot,
      catalog_dev: catalog.dev,
      catalog_ino: catalog.ino,
    })
  );
  const store = ArtifactStore.openExisting(config.artifactRoot, { projectId: config.projectId });
  try {
    const binding = new ScaP03InitialProposalBindingV1(store, input.proposal_ref);
    store.assertBoundProject(binding.proposal.project_id);
    // Collector/parser dependencies load only for explicit native construction, never
    // default tool registration or a model-free unavailable-service session.
    const { ScaP03InitialNativeHostV1 } =
      await import("../../../../apps/sca-service/src/p03-initial-host.js");
    const {
      createScaP03InitialLiveAdapterV1,
      createScaP03InitialUseValidatorV1,
      ScaP03PreLiveInputsV1Schema,
      ScaP03SealedBootstrapInputsV1Schema,
    } = await import("../../../../apps/sca-service/src/p03-initial-live.js");
    const { createScaP03ApprovedInputReaderV1 } =
      await import("../../../../apps/sca-service/src/p03-predecessor-inputs.js");
    const nativeHost = new ScaP03InitialNativeHostV1({ ...input, store });
    const authorization = new ScaP03InitialAuthorizationV1(
      {
        current: () => {
          const current = input.profile.current();
          if (
            current.state_authority_sha256 !== stateAuthority ||
            current.backend_resource_sha256 !== input.approved_backend_resource_sha256 ||
            current.project_id !== config.projectId
          )
            throw new Error("p03_native_profile_binding_invalid");
          return current;
        },
        now: () => input.profile.now(),
        authenticatedInteractivePrincipal: (event) =>
          input.profile.authenticatedInteractivePrincipal(event),
        assertCurrentInputs: (proposal) => {
          binding.assertProposal(proposal);
          input.profile.assertCurrentInputs(proposal);
          nativeHost.assertCapsule(proposal);
          const manifest = proposal.input_refs.filter(
            (ref) =>
              ref.kind ===
              (proposal.effect === "bootstrap_verification"
                ? "sca-p03-sealed-bootstrap-inputs"
                : "sca-p03-pre-live-inputs")
          );
          if (manifest.length !== 1 || manifest[0] === undefined)
            throw new Error("p03_native_pre_live_manifest_required");
          const ref = manifest[0];
          const reader = createScaP03ApprovedInputReaderV1(store, proposal.input_refs);
          const raw = reader.json(ref, "initial_manifest");
          if (proposal.effect === "bootstrap_verification") {
            if (
              canonicalJson(ref) !== canonicalJson(proposal.sealed_bootstrap_inputs_ref) ||
              ref.producer !== "host:sca-p03-initial-authorization" ||
              ref.content_schema?.schema_id !== "penny.sca-p03-sealed-bootstrap-inputs.v1" ||
              ref.content_schema.schema_version !== 1
            )
              throw new Error("p03_native_sealed_ref_invalid");
            const m = validateContract(
              ScaP03SealedBootstrapInputsV1Schema,
              raw,
              "P03 native sealed inputs"
            );
            reader.finish();
            nativeHost.assertSealedInputs(m, proposal);
            return;
          }
          const m = validateContract(
            ScaP03PreLiveInputsV1Schema,
            raw,
            "P03 native pre-live inputs"
          );
          reader.finish();
          nativeHost.assertPredecessorClosure(m, proposal);
          nativeHost.assertCurrentP02(m, proposal);
        },
      },
      { verify: verifyExecutionOwnerSignature },
      binding
    );
    const registration = createScaP03InitialQualificationRegistrationV1({
      authorization,
      binding,
    });
    const adapter = createScaP03InitialLiveAdapterV1({
      store,
      authorization,
      native_host: nativeHost,
      binding,
    });
    const service = new OrchestrationService({
      projectRoot: config.projectRoot,
      env: input.env,
      playbookRegistration: registration,
      enableChildWorkflows: false,
      hostOperationAdapters: new Map([[adapter.adapter_id, adapter]]),
      hostOperationUseValidator: createScaP03InitialUseValidatorV1({
        store,
        authorization,
        binding,
        native_host: nativeHost,
      }),
      modelClient: {
        async runAgent() {
          throw new Error("p03_native_models_forbidden");
        },
      },
    });
    return Object.freeze({
      service,
      authorization,
      binding,
      state_authority_sha256: stateAuthority,
      [Symbol.dispose]() {
        service.close();
        store.close();
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Private operator command, not a fourth broker tool, public registry entry or agent grant.
 * With no host there is deliberately no production ingress, even in an interactive same-UID Pi. */
export function registerScaP03NativeOperatorV1(
  pi: ExtensionAPI,
  host?: ScaP03NativeOperatorHostV1
): void {
  pi.registerCommand("sca-p03-initial", {
    description:
      "Private P03 initial qualification gate. Requires trusted native operator/profile configuration; never final activation or P04 approval.",
    async handler(args, ctx) {
      if (host === undefined) {
        ctx.ui.notify(
          "missing_input: trusted native authenticated operator/profile + canonical backend/state authority composition",
          "error"
        );
        return;
      }
      if (
        ctx.mode !== "tui" ||
        !ctx.hasUI ||
        !(host.service instanceof OrchestrationService) ||
        !(host.authorization instanceof ScaP03InitialAuthorizationV1) ||
        !(host.binding instanceof ScaP03InitialProposalBindingV1) ||
        host.service.engine.registration.name !== SCA_P03_INITIAL_NAME
      ) {
        ctx.ui.notify("P03 trusted native interactive owner unavailable", "error");
        return;
      }
      host.authorization.assertPinnedRef(host.binding.proposal_ref);
      const parts = args.trim().split(/\s+/);
      const signal = ctx.signal ?? new AbortController().signal;
      if (parts[0] === "start" && parts.length === 2 && /^art_[a-f0-9]{64}$/.test(parts[1] ?? "")) {
        const id = parts[1];
        if (id === undefined) throw new Error("p03_native_proposal_required");
        if (id !== host.binding.proposal_ref.artifact_id)
          throw new Error("p03_initial_foreign_proposal");
        const proposalRef = host.service.artifacts.refById(id);
        if (proposalRef === undefined) throw new Error("p03_native_proposal_missing");
        const proposal = host.binding.read(host.service.artifacts, proposalRef);
        host.authorization.assertProposal(proposal);
        host.service.artifacts.assertBoundProject(proposal.project_id);
        if (
          proposal.project_id !== host.service.config.projectId ||
          proposal.state_authority_sha256 !== host.state_authority_sha256
        )
          throw new Error("p03_native_state_authority_mismatch");
        const gate = await host.service.execute(
          {
            schema_version: 2,
            action: "start",
            identity: {
              schema_version: 2,
              run_id: proposal.run_id,
              session_id: `initial:${proposal.invocation_nonce}`,
              playbook: SCA_P03_INITIAL_NAME,
              engine_owner: "typescript",
            },
            goal: "Exact bounded initial P03 qualification only",
            project_root: host.service.config.projectRoot,
            trust_profile: "trusted-interactive",
            constraints: { proposal_ref: proposalRef },
            input_artifacts: {
              schema_version: 2,
              artifacts: [
                { slot: "initial_proposal", ref: proposalRef },
                ...proposal.input_refs.map((ref, i) => ({
                  slot: `proof_${String(i).padStart(3, "0")}`,
                  ref,
                })),
              ],
            },
          },
          signal
        );
        if (gate.action !== "await_user") throw new Error("p03_native_gate_required");
        const run = host.service.checkpointer.loadRunById(proposal.run_id);
        const ref = run?.selectedArtifacts.find((r) => r.kind === "sca-p03-initial-transport");
        if (ref === undefined) throw new Error("p03_native_transport_missing");
        readScaP03InitialGate(host.service.artifacts, proposalRef, ref);
        const raw: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(host.service.artifacts.read(ref))
        );
        const transport = validateContract(
          ScaP03InitialTransportV1Schema,
          raw,
          "P03 native transport"
        );
        if (
          ref.content_digest !== gate.payload_digest ||
          transport.challenge !== gate.challenge ||
          canonicalJson(transport.proposal_ref) !== canonicalJson(proposalRef)
        )
          throw new Error("p03_native_transport_changed");
        const capability = registerTrustedQuestionnaireTransport(transport.questions, {
          runId: proposal.run_id,
          gateId: gate.gate_id,
          challenge: gate.challenge,
          artifactRef: proposalRef,
          transportRef: ref,
          renderedQuestionsDigest: (
            await import("../../skill/execution-receipts.js")
          ).renderedQuestionsDigest(transport.questions),
        });
        if (capability === undefined) throw new Error("p03_native_capability_unavailable");
        pi.sendMessage(
          {
            customType: "sca-p03-initial-gate",
            content: `Invoke questionnaire({trustedTransportCapability:${JSON.stringify(capability)}}), then the operator may run /sca-p03-initial respond ${proposal.run_id}. Ordinary earlier answers are not approval.`,
            display: true,
          },
          { triggerTurn: false }
        );
        return;
      }
      if (parts[0] === "respond" && parts.length === 2) {
        const runId = parts[1];
        if (runId === undefined) throw new Error("p03_native_run_required");
        host.binding.assertRun(runId);
        const run = host.service.checkpointer.loadRunById(runId);
        if (run?.pendingDirective?.action !== "await_user")
          throw new Error("p03_native_pending_required");
        let witness: unknown;
        // Exact signed event bytes may travel through the session, but transcript text/hash never
        // grants authority. Select only the pending run/gate/challenge; domain resume rechecks all refs.
        for (const entry of ctx.sessionManager.getBranch()) {
          if (
            entry.type !== "message" ||
            entry.message.role !== "toolResult" ||
            entry.message.toolName !== "questionnaire"
          )
            continue;
          const details: unknown = entry.message.details;
          if (!record(details) || !Array.isArray(details.trustedHumanEvents)) continue;
          for (const event of details.trustedHumanEvents) {
            if (
              record(event) &&
              event.run_id === runId &&
              event.gate_id === run.pendingDirective.gate_id &&
              event.challenge === run.pendingDirective.challenge &&
              verifyExecutionOwnerSignature(event)
            ) {
              if (witness !== undefined && canonicalJson(witness) !== canonicalJson(event))
                throw new Error("p03_native_conflicting_witnesses");
              witness = event;
            }
          }
        }
        if (witness === undefined) throw new Error("p03_native_exact_interactive_witness_required");
        const result = await respondToTrustedNativeGateV1({
          service: host.service,
          run_id: runId,
          event: witness,
          signal,
        });
        ctx.ui.notify(
          `P03 initial operation boundary: ${result.action}. No formal qualification/activation/P04 permission.`,
          "info"
        );
        return;
      }
      ctx.ui.notify(
        "Usage: /sca-p03-initial start EXACT_PROPOSAL_ARTIFACT_ID | respond EXACT_RUN_ID",
        "error"
      );
    },
  });
}
