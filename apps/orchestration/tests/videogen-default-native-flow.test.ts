import path from "node:path";
import { Type } from "typebox";
import { SourcePreparationResultSchema } from "../dist/videogen/runtime-preparation.js";
import { VideogenRuntimeManifestV1Schema } from "../dist/videogen/runtime-manifest.js";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { OrchestrationService } from "../dist/service.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { type Directive } from "../dist/contracts.js";
import { HostOperationCapacityAuthority } from "../dist/host-operations/capacity-authority.js";
import { validateCapacitySnapshot } from "../dist/host-operations/capacity-contracts.js";
import { verifyHostResultWrapper } from "../dist/host-operations/effect-protocol.js";
import { VIDEOGEN_RUNTIME_MANIFEST_ENV } from "../dist/videogen/runtime-manifest.js";
import {
  NativeBuildResultV1Schema,
  VideogenTerminalV1Schema,
} from "../dist/videogen/stage-contracts.js";
import {
  NativeQualifiedRawResultV1Schema,
  NativeBuildRequestV1Schema,
} from "../dist/videogen/native-contracts.js";
import { PortableManifestV1Schema } from "../dist/videogen/edit-contracts.js";
import { GatePacketV1Schema, gateScopeDigest } from "../dist/videogen/gates.js";
import { executionState, slot } from "../dist/videogen/execution-state.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import {
  DefaultNativeFixture,
  defaultNativeManifest,
} from "./helpers/videogen-default-native-fixture.js";
import { syntheticVideogenInventory } from "./helpers/videogen-fixtures.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import { meters } from "./helpers/capacity-fixtures.js";
import { JsonValueSchema, validateContract } from "../dist/contracts.js";

if (process.env["PENNY_VIDEOGEN_NATIVE_CPU"] !== "1")
  throw new Error(
    "Explicit native/CPU opt-in required. This test performs no GPU/Voice/Comfy jobs."
  );
describe("full default JSON G1→G5→real local delivery, actual native/CPU with synthetic prerequisites", () => {
  it("recovers settled native custody, verifies dual products and replays delivery without rerunning work; cancellation grants nothing", async () => {
    let live: OrchestrationService | undefined;
    using f = new DefaultNativeFixture();
    let posts = 0;
    let media = Buffer.alloc(0);
    const server = createServer((req, res) => {
      const json = (value: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(canonicalJson(value));
      };
      if (req.url === "/system_stats") json({ ready: true });
      else if (req.url === "/object_info") json(syntheticVideogenInventory());
      else if (req.url === "/prompt") {
        req.resume();
        posts++;
        json({ prompt_id: `fixture-${posts}`, number: posts, node_errors: {} });
      } else if (req.url?.startsWith("/history/")) {
        const id = req.url.slice("/history/".length);
        json({
          [id]: {
            status: { completed: true, status_str: "success" },
            outputs: {
              "7": {
                images: [{ filename: "video.mp4", subfolder: "video/penny", type: "output" }],
              },
            },
          },
        });
      } else if (req.url?.startsWith("/view?")) {
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": media.length });
        res.end(media);
      } else res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("local fixture address missing");
      const pluginWire = process.env["VIDEOGEN_NATIVE_TEST_PLUGIN_INVENTORY"];
      const pluginInventory =
        pluginWire === undefined
          ? undefined
          : validateContract(
              Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
                minItems: 1,
                maxItems: 4096,
              }),
              JSON.parse(pluginWire),
              "explicit test package resources; not qualification evidence"
            );
      const built = defaultNativeManifest(f, address.port, pluginInventory);
      const runtimeManifest = validateContract(
        VideogenRuntimeManifestV1Schema,
        {
          ...built.manifest,
          adapters: built.manifest.adapters.map((value) => {
            const a = validateContract(
              Type.Object({
                kind: Type.String(),
                binding: Type.Record(Type.String(), JsonValueSchema),
              }),
              value,
              "test adapter projection"
            );
            return a.kind === "media_decode_extract"
              ? { ...a, binding: { ...a.binding, source_preparation: true } }
              : a;
          }),
          recipes: built.manifest.recipes.flatMap((value) => {
            const r = validateContract(
              Type.Object({ kind: Type.String(), stage: Type.String() }),
              value,
              "test recipe projection"
            );
            return r.kind === "media_decode_extract" && (r.stage === "draft" || r.stage === "final")
              ? [
                  {
                    ...r,
                    fields: {
                      schema_id: "penny.videogen-native-media-request.v1",
                      schema_version: 1,
                      subject_id: "shot1",
                      preparation: {
                        kind: "avc_import",
                        width: 512,
                        height: 288,
                        frame_count: 75,
                        fps: 25,
                        max_bytes: 16777216,
                      },
                    },
                    operands: [
                      { field: "media_ref", slot: "clip-shot1" },
                      { field: "source_result_ref", slot: "source-result-shot1" },
                      { field: "source_receipt_ref", slot: "source-receipt-shot1" },
                      { field: "decode_policy_ref", slot: "decode_policy" },
                    ],
                    input_bindings: [
                      { slot: "media", source_slot: "clip-shot1" },
                      { slot: "source-result", source_slot: "source-result-shot1" },
                      { slot: "source-receipt", source_slot: "source-receipt-shot1" },
                      { slot: "decode-policy", source_slot: "decode_policy" },
                    ],
                  },
                  r,
                ]
              : [r];
          }),
        },
        "whole default flow including canonical source preparation"
      );
      media = Buffer.from(built.video);
      const filename = path.join(f.root, "runtime.json");
      writeFileSync(filename, canonicalJson(runtimeManifest), { mode: 0o600 });
      // A complete closed JSON bootstrap, also retained privately for operator inspection.
      const output = process.env["VIDEOGEN_NATIVE_TEST_OUTPUT"];
      if (!output) throw new Error("explicit private output required");
      writeFileSync(
        path.join(output, "default-runtime-template.json"),
        canonicalJson(runtimeManifest),
        { mode: 0o600 }
      );
      HostOperationCapacityAuthority.configure(f.stateRoot, built.capacity.policy);
      const client = setup(f).client,
        env = {
          PENNY_STATE_ROOT: f.stateRoot,
          [VIDEOGEN_RUNTIME_MANIFEST_ENV]: filename,
          PENNY_MAX_STEPS: "500",
        };
      const identity = {
        schema_version: 2 as const,
        run_id: f.run_id,
        session_id: f.run_id,
        playbook: "videogen",
        engine_owner: "typescript" as const,
      };
      let crashNative = true,
        crashConsume = true,
        crashDelivery = true;
      const open = () =>
        new OrchestrationService({
          projectRoot: f.root,
          env,
          playbookName: "videogen",
          modelClient: client,
          hostOperationFault(point, kind) {
            if (point === "after_persist") {
              const record = f.checkpointer
                .hostOperationCallsForRun(f.run_id)
                .find(
                  (j) => j.operation_kind === kind && j.lifecycle !== "consumed" && j.lease !== null
                );
              if (!record?.lease) throw new Error("synthetic meter exact live fence missing");
              const demand = built.capacity.demands.find((d) => d.operation_kind === kind);
              if (!demand) throw new Error("synthetic demand missing");
              const request = {
                schema_id: "penny.host-capacity-request.v1",
                schema_version: 1,
                project_id: f.project_id,
                operation_record_id: record.operation_record_id,
                binding_id: demand.binding_id,
                demands: demand.demands,
              };
              const snapshot = validateCapacitySnapshot({
                schema_id: "penny.host-capacity-snapshot.v1",
                schema_version: 1,
                operation_record_id: record.operation_record_id,
                request_sha256: sha256(canonicalJson(request)),
                lease: record.lease,
                source_revision: 1,
                evidence_sha256: sha256("SYNTHETIC TEST METER ONLY, NOT hardware observation"),
                kind: "final",
                readings: demand.demands.map((d) => ({
                  resource_id: d.resource_id,
                  meters: meters(1),
                })),
              });
              writeFileSync(built.capacity.measurement_file, canonicalJson(snapshot), {
                mode: 0o600,
              });
            }
            if (point === "after_wrapper" && kind === "kdenlive_build_verify" && crashNative) {
              crashNative = false;
              throw new HostOperationSimulatedCrashError(point);
            }
            if (point === "before_consume" && kind === "kdenlive_build_verify" && crashConsume) {
              crashConsume = false;
              throw new HostOperationSimulatedCrashError(point);
            }
            if (point === "after_wrapper" && kind === "local_delivery" && crashDelivery) {
              crashDelivery = false;
              throw new HostOperationSimulatedCrashError(point);
            }
          },
        });
      const request = {
        ...videogenStageRequest(),
        brief: "SYNTHETIC FULL-FLOW TEST. Not production qualification or performed narration.",
        format_intent: {
          ...videogenStageRequest().format_intent,
          width: 512,
          height: 288,
          fps: { numerator: 25, denominator: 1 },
          captions_required: true,
        },
        constraints: {
          duration: { numerator: 3, denominator: 1 },
          max_scenes: 1,
          max_shots: 1,
          max_storage_bytes: 2000000000,
          max_cost_units: 100,
          max_attempts: 100,
        },
      };
      let boundary: Directive;
      {
        live = open();
        boundary = await live.execute({
          schema_version: 2,
          action: "start",
          identity,
          goal: request.brief,
          constraints: request,
          project_root: f.root,
          trust_profile: "hardened-untrusted",
        });
      }
      writeFileSync(
        path.join(output, "default-flow-start.json"),
        canonicalJson({ boundary, snapshot: f.checkpointer.loadRun(identity).snapshot() }),
        { mode: 0o600 }
      );
      if (boundary.action !== "await_user") throw new Error(canonicalJson(boundary));
      const gates: string[] = [];
      for (let steps = 0; steps < 12 && boundary.action === "await_user"; steps++) {
        // Ordinary boundaries remain live; crashes below close and reopen the SQLite owner.
        const service = live;
        if (!service) throw new Error("service missing");
        expect(await service.execute({ schema_version: 2, action: "recover", identity })).toEqual(
          boundary
        );
        const c = f.checkpointer.loadRun(identity),
          s = executionState(c),
          packetRef = slot(s, "packet"),
          packet = validateContract(
            GatePacketV1Schema,
            JSON.parse(f.store.read(packetRef).toString()),
            "gate"
          );
        if (packet.gate_id === "clarify") {
          expect(c.stateId).toBe("clarify");
          expect(s.return_state).toBe("master_critique");
          const master = slot(s, "master"),
            attestation = f.opaque(
              "SYNTHETIC TEST RESPONSE. No independent human viewing occurred. NOT release qualification.",
              "text/plain"
            );
          const playback = f.json(
            {
              schema_id: "penny.videogen-playback-review.v1",
              schema_version: 1,
              target_ref: master,
              target_digest: master.content_digest,
              reviewer_kind: "human",
              reviewer_id: "synthetic-test-human",
              playback_device_profile_ref: attestation,
              complete_viewing: true,
              heard_audio: true,
              observations: [
                {
                  time: { numerator: 0, denominator: 1 },
                  criterion: "synthetic_only",
                  verdict: "pass",
                  note: "Controlled test prerequisite, not real human playback.",
                },
              ],
              motion_verdict: "pass",
              speech_verdict: "pass",
              sync_verdict: "pass",
              identity_verdict: "pass",
              recorded_at_utc: new Date().toISOString(),
              attestation_ref: attestation,
            },
            "penny.videogen-playback-review.v1"
          );
          service.captureVideogenPlaybackForRun(f.run_id, playback);
        } else gates.push(packet.gate_id);
        const decision = {
          schema_id: "penny.videogen-gate-decision.v1",
          schema_version: 1,
          run_id: f.run_id,
          gate_id: packet.gate_id,
          packet_ref: packetRef,
          challenge: packet.challenge,
          choice: packet.gate_id === "clarify" ? "answer" : "approve",
          ...(packet.gate_id === "clarify"
            ? {
                refinement_text:
                  "Synthetic fixture evidence captured; not production qualification.",
              }
            : { resulting_scope_digest: gateScopeDigest(packet, packetRef) }),
        };
        try {
          boundary = await service.execute({
            schema_version: 2,
            action: "respond",
            identity,
            gate_id: boundary.gate_id,
            challenge: boundary.challenge,
            response: decision,
          });
        } catch (error) {
          const journals = f.checkpointer.hostOperationCallsForRun(f.run_id);
          writeFileSync(
            path.join(output, "default-flow-error.json"),
            canonicalJson({
              error: String(error),
              journals,
              snapshot: f.checkpointer.loadRun(identity).snapshot(),
            }),
            { mode: 0o600 }
          );
          if (!(error instanceof HostOperationSimulatedCrashError)) throw error;
          service.close();
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              live = open();
              boundary = await live.execute({ schema_version: 2, action: "recover", identity });
              break;
            } catch (next) {
              live?.close();
              if (!(next instanceof HostOperationSimulatedCrashError)) throw next;
              if (attempt === 2) throw next;
            }
          }
        }
        if (boundary.action === "error" || boundary.action === "incomplete") {
          writeFileSync(
            path.join(output, "default-flow-error.json"),
            canonicalJson({
              boundary,
              journals: f.checkpointer.hostOperationCallsForRun(f.run_id),
              snapshot: f.checkpointer.loadRun(identity).snapshot(),
            }),
            { mode: 0o600 }
          );
          throw new Error(canonicalJson(boundary));
        }
      }
      expect(gates).toEqual(["G1", "G2", "G3", "G4", "G5"]);
      expect(boundary).toMatchObject({ action: "complete", met: true });
      const c = f.checkpointer.loadRun(identity),
        s = executionState(c),
        terminal = validateContract(
          VideogenTerminalV1Schema,
          JSON.parse(f.store.read(slot(s, "terminal")).toString()),
          "terminal"
        ),
        native = validateContract(
          NativeBuildResultV1Schema,
          JSON.parse(f.store.read(slot(s, "native")).toString()),
          "native"
        ),
        manifest = validateContract(
          PortableManifestV1Schema,
          JSON.parse(f.store.read(slot(s, "manifest")).toString()),
          "package"
        );
      expect(terminal.master_ref).toEqual(slot(s, "master"));
      expect(terminal.package_manifest_ref).toEqual(slot(s, "manifest"));
      expect(manifest.native_project.sha256).toBe(native.normalized_project_ref.content_digest);
      expect(manifest.files.length).toBeGreaterThan(100);
      expect(posts).toBe(2);
      const journals = f.checkpointer.hostOperationCallsForRun(f.run_id);
      expect(journals).toHaveLength(13);
      const preparations = journals
        .filter(
          (j) => j.operation_kind === "media_decode_extract" && j.operation_result_ref !== null
        )
        .map((j) => {
          if (!j.operation_result_ref) throw new Error("settled media raw missing");
          const value: unknown = JSON.parse(f.store.read(j.operation_result_ref).toString("utf8"));
          return value;
        })
        .filter(
          (value: unknown) => value !== null && typeof value === "object" && "preparation" in value
        )
        .map((value: unknown) =>
          validateContract(SourcePreparationResultSchema, value, "settled normalized output")
        );
      expect(preparations).toHaveLength(2);
      for (const prepared of preparations) {
        expect(prepared.preparation.kind).toBe("avc_import");
        expect(prepared.transform_receipt).toMatchObject({ lossless: false });
        expect(prepared.prepared_sha256).not.toBe(prepared.source_ref.content_digest);
        expect(f.store.read(prepared.source_ref)).toEqual(media);
      }
      const finalPrepared = preparations[1];
      if (!finalPrepared) throw new Error("final canonical evidence missing");
      expect(slot(s, "clip-shot1").content_digest).toBe(finalPrepared.prepared_sha256);
      expect(slot(s, "raw-clip-shot1").content_digest).toBe(sha256(media));
      expect(crashNative).toBe(false);
      expect(crashConsume).toBe(false);
      expect(crashDelivery).toBe(false);
      for (const j of journals) {
        expect(j.lifecycle).toBe("consumed");
        expect(j.disposition?.outcome).toBe("completed");
        verifyHostResultWrapper(f.store, j);
      }
      const nativeJournal = journals.find((j) => j.operation_kind === "kdenlive_build_verify");
      if (!nativeJournal?.operation_result_ref) throw new Error("native journal missing");
      const raw = validateContract(
          NativeQualifiedRawResultV1Schema,
          JSON.parse(f.store.read(nativeJournal.operation_result_ref).toString()),
          "native raw"
        ),
        build = validateContract(
          NativeBuildRequestV1Schema,
          JSON.parse(f.store.read(slot(s, "native_request")).toString()),
          "native operand"
        );
      expect(raw.accepted_master_ref).toEqual(slot(s, "master"));
      expect(build.accepted_master_ref).toEqual(slot(s, "master"));
      expect(raw.comparison.video_frames).toBe(75);
      const roots = readdirSync(built.destination);
      expect(roots).toHaveLength(1);
      const root = path.join(built.destination, roots[0] ?? "", "products");
      for (const file of manifest.files)
        expect(sha256(readFileSync(path.join(root, "package", file.relative_path)))).toBe(
          file.sha256
        );
      live?.close();
      {
        using service = open();
        expect(await service.execute({ schema_version: 2, action: "recover", identity })).toEqual(
          boundary
        );
        expect(
          await service.execute({ schema_version: 2, action: "status", identity })
        ).toBeDefined();
      }
      expect(posts).toBe(2);
      expect(readdirSync(built.destination)).toEqual(roots);
      writeFileSync(
        path.join(output, "default-flow-verified.json"),
        canonicalJson({
          terminal,
          boundary,
          gates,
          native,
          comparison: raw.comparison,
          manifest,
          journals,
        }),
        { mode: 0o600 }
      );
      // A fresh full start can be cancelled at G1; no extra host operation or publication occurs.
      const cancelled = {
        ...identity,
        run_id: "cancelled_default_native",
        session_id: "cancelled_default_native",
      };
      {
        using service = open();
        const gate = await service.execute({
          schema_version: 2,
          action: "start",
          identity: cancelled,
          goal: request.brief,
          constraints: request,
          project_root: f.root,
          trust_profile: "hardened-untrusted",
        });
        expect(gate.action).toBe("await_user");
        const result = await service.execute({
          schema_version: 2,
          action: "cancel",
          identity: cancelled,
        });
        expect(result.action).toBe("cancelled");
      }
      expect(f.checkpointer.hostOperationCallsForRun(cancelled.run_id)).toEqual([]);
      expect(posts).toBe(2);
    } finally {
      live?.close();
      server.close();
      await once(server, "close");
    }
  }, 1200000);
});
