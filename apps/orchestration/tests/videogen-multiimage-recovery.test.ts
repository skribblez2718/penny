import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { OrchestrationService } from "../dist/service.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { StaticImagegenExportRegistry } from "../dist/imagegen/export-registry.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import { ComfyWorkerIdentityRegistry } from "../dist/comfy/worker-identity.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Type } from "typebox";
import { JsonValueSchema, validateContract } from "../dist/contracts.js";
import {
  validateVideogenPrivateConfig,
  type VideogenRuntimeProvidersV1,
} from "../dist/videogen/runtime-config.js";
import { validateImagegenRequest } from "../dist/skill-contracts/imagegen.js";
import { bindGenericChildYamlAuthority } from "../dist/playbooks/registry.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../dist/playbooks/imagegen.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/runtime-registration-digest.js";
import { childExecutionProgressLeaseBinding } from "../dist/liveness-profiles.js";
import { constructGateDecision, validateGatePacket } from "../dist/videogen/gates.js";
import { executionState, slot } from "../dist/videogen/execution-state.js";
import { CompleteVideogenFixture } from "./helpers/videogen-complete-fixture.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import { controlledHttp, controlledProfile, png } from "./helpers/imagegen-controlled-fixture.js";
import { DeterministicImagegenSmokeModel } from "./helpers/imagegen-smoke-model.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import { FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { RightsBindingV1Schema } from "../dist/videogen/rights-ledger.js";
describe("real videogen serial image continuation (synthetic local fixture only)", () => {
  for (const mode of ["revision", "fresh"] as const)
    for (const crash of [false, true])
      it(`imports two exact reviewed ${mode} images${crash ? " across a pre-consume crash/reopen" : ""}`, async () => {
        using f = new CompleteVideogenFixture();
        const http = await controlledHttp(mode === "revision");
        const profile = controlledProfile(http.port, mode === "revision" ? "rectangle" : "fresh"),
          base = setup(f),
          consent = f.opaque("isolated fixture consent"),
          source = f.raw(png(7), "image/png", undefined, f.run_id, "fixture", "reference-image"),
          rights = f.rights(source, "image", [consent]);
        const profiles = new StaticImagegenProfileRegistry({
          profiles: [profile],
          approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
          approved_revision_sha256_by_profile_id: new Map(
            mode === "revision"
              ? [[profile.profile_id, sha256(canonicalJson(profile.revision_capability))]]
              : []
          ),
          node_class_policies: profile.node_classes.map((p) => ({ ...p, schema_version: 1 })),
          default_profile_id: profile.profile_id,
          worker_identities: new ComfyWorkerIdentityRegistry([
            { worker_id: "fixture-worker", endpoints: [profile.endpoint] },
          ]),
        });
        const storage = new SqliteImagegenStorageAdmission({
          directory: path.join(f.root, "image-storage"),
          ceiling_bytes: 64 * 1024 * 1024,
          warning_threshold_bytes: 48 * 1024 * 1024,
        });
        const activation = new SqliteImagegenActivationController({
          directory: path.join(f.root, "image-activation"),
          mode: "enabled",
        });
        const baseAsset = base.providers.config.assets[0];
        if (baseAsset === undefined) throw new Error("fixture asset is missing");
        const ids = ["image1", "image2"],
          allowed = "Make selected area white",
          preserve = ["Preserve geometry outside selected area"];
        const requests = new Map(
          ids.map((id) => [
            id,
            validateImagegenRequest({
              schema_id: "penny.imagegen-request.v1",
              schema_version: 1,
              goal: "Isolated reference revision",
              profile_id: profile.profile_id,
              count: 1,
              seed: 1,
              max_revision_rounds: 0,
              raw_prompt: null,
              dimensions: null,
              export: null,
              asset: {
                schema_id: "penny.image-asset-request.v1",
                schema_version: 1,
                intent_ref: source,
                call_index: 1,
                input:
                  mode === "fresh"
                    ? { kind: "fresh" }
                    : {
                        kind: "revision",
                        source_ref: source,
                        area: { kind: "rectangle", x: 0, y: 0, width: 1, height: 1 },
                      },
              },
            }),
          ])
        );
        const providers: VideogenRuntimeProvidersV1 = {
          ...base.providers,
          config: validateVideogenPrivateConfig({
            ...base.providers.config,
            rights: f.current_rights,
            assets: ids.map((asset_id) => ({
              ...baseAsset,
              asset_id,
              source: mode === "revision" ? "imagegen_revision" : "imagegen_fresh",
              input_refs: mode === "revision" ? [source] : [],
              consent_ref: consent,
              rights_ref: rights,
              allowed_change: allowed,
              preserve_criteria: preserve,
              estimated_meters: [
                { meter: "attempts", reserved: 1 },
                { meter: "cost_microcredits", reserved: 4 },
              ],
            })),
          }),
          image_requests: requests,
          image_calls: new Map(
            ids.map((id) => [id, { profile_sha256: profile.profile_sha256, cost_microcredits: 4 }])
          ),
          imagegen_child: {
            schema_version: 1,
            authorization_id: "operator.controlled-imagegen-child.v1",
            max_nesting_depth: 1,
            max_active_children: 1,
            max_calls: 2,
            project_concurrency_limit: 1,
            asset_ids: ids,
            parent_states: ["image_child"],
            provider_registration_sha256: runtimeRegistrationSha256(
              bindGenericChildYamlAuthority(IMAGEGEN_PLAYBOOK_REGISTRATION, f.root)
            ),
            progress_lease: childExecutionProgressLeaseBinding(),
          },
        };
        const imageModel = new DeterministicImagegenSmokeModel();
        const model = {
          async runAgent(invocation: Parameters<typeof base.client.runAgent>[0]) {
            if (invocation.registration.playbook_name !== "imagegen")
              return base.client.runAgent(invocation);
            const completion = await imageModel.runAgent(invocation);
            if (mode === "fresh" || !["vera", "carren"].includes(invocation.agent))
              return completion;
            const parsed = validateContract(
              Type.Object({ report: Type.Record(Type.String(), JsonValueSchema) }),
              JSON.parse(completion.text.slice("SUMMARY:".length)),
              "fixture image review summary"
            );
            return {
              ...completion,
              text: `SUMMARY:${canonicalJson({ ...parsed, report: { ...parsed.report, revision_review: { allowed_change: { criterion: allowed, verdict: "pass", observation: "Synthetic fixture only" }, preserve_criteria: preserve.map((criterion) => ({ criterion, verdict: "pass", observation: "Synthetic fixture only" })) } } })}`,
            };
          },
        };
        const resultCache = await FileHostOperationResultCache.provision(
          path.join(f.root, "result-cache")
        );
        const options = {
          hostOperationResultCache: resultCache,
          projectRoot: f.root,
          env: { PENNY_STATE_ROOT: f.stateRoot },
          playbookName: "videogen",
          videogen: providers,
          imagegen: {
            profiles,
            storage,
            activation,
            exports: new StaticImagegenExportRegistry([]),
          },
          modelClient: model,
        };
        let service = new OrchestrationService(options);
        try {
          const request = videogenStageRequest(),
            identity = {
              schema_version: 2 as const,
              run_id: f.run_id,
              session_id: f.run_id,
              playbook: "videogen",
              engine_owner: "typescript" as const,
            };
          const g1 = await service.execute({
            schema_version: 2,
            action: "start",
            identity,
            goal: request.brief,
            constraints: request,
            project_root: f.root,
            trust_profile: "hardened-untrusted",
          });
          if (g1.action !== "await_user") throw new Error(canonicalJson(g1));
          const c = service.checkpointer.loadRun(identity),
            ref = slot(executionState(c), "packet"),
            packet = validateGatePacket(
              JSON.parse(service.artifacts.read(ref).toString()),
              FOUNDATION_LIMITS
            );
          expect(packet.presented.filter((p) => p.role === "image-asset-call")).toHaveLength(2);
          const respond = {
            schema_version: 2 as const,
            action: "respond" as const,
            identity,
            gate_id: g1.gate_id,
            challenge: g1.challenge,
            response: constructGateDecision(packet, ref, "approve", FOUNDATION_LIMITS),
          };
          if (crash) {
            const fault = vi
              .spyOn(service.checkpointer, "consumeChildWorkflowCall")
              .mockImplementationOnce(() => {
                throw new Error("injected before image consume");
              });
            try {
              await expect(service.execute(respond)).rejects.toThrow(
                /injected before image consume/
              );
            } finally {
              fault.mockRestore();
            }
            expect(service.checkpointer.childWorkflowCallsForParent(f.run_id)[0]?.lifecycle).toBe(
              "terminal_recorded"
            );
            expect(http.submissions).toHaveLength(1);
            service.close();
            service = new OrchestrationService(options);
          }
          const boundary = await service.execute(
            crash ? { schema_version: 2, action: "recover", identity } : respond
          );
          // No audio was supplied: it must stop at the subsequent strict port, not fake G2.
          expect(boundary.action).toBe("incomplete");
          const calls = service.checkpointer.childWorkflowCallsForParent(f.run_id);
          expect(calls).toHaveLength(2);
          expect(calls.every((x) => x.lifecycle === "consumed")).toBe(true);
          expect(http.submissions).toHaveLength(2);
          const state = executionState(service.checkpointer.loadRun(identity));
          expect(slot(state, "png-image1").media_type).toBe("image/png");
          expect(slot(state, "png-image2").media_type).toBe("image/png");
          if (mode === "fresh") {
            for (const id of ids) {
              const derived = slot(state, `rights-${id}`);
              expect(derived.producer).toBe("host:videogen");
              const value = validateContract(
                RightsBindingV1Schema,
                JSON.parse(service.artifacts.read(derived).toString()),
                "derived fresh image rights"
              );
              expect(value.derived_from_rights_refs).toEqual([slot(state, "story_rights")]);
              expect(value.subject_ref).toEqual(slot(state, `png-${id}`));
            }
          }
        } finally {
          service.close();
          storage.close();
          activation.close();
          await http.close();
        }
      }, 60000);
});
