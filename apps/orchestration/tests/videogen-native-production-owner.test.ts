import { silentPcmFixture } from "./helpers/videogen-audio-fixtures.js";
import { HOST_RECEIPTED_RESULT_CONTRACT } from "../dist/host-operations/effect-protocol.js";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { sha256, canonicalJson } from "../dist/canonical-json.js";
import {
  ConfinedNativeBindingsSchema,
  ConfinedNativeRunner,
} from "../dist/host-operations/confined-native-runner.js";
import { ConfinedMediaRunner } from "../dist/host-operations/confined-media-runner.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import { KdenliveFixtureRegistry } from "../dist/videogen/kdenlive-registry.js";
import { writeNativeProject } from "../dist/videogen/kdenlive-writer.js";
import { createKdenliveAdapter } from "../dist/videogen/kdenlive-adapter.js";
import { NativeProductProducer } from "../dist/videogen/native-products.js";
import { produceNativePortableManifest } from "../dist/videogen/native-package-producer.js";
import {
  NativeOperationRequestSchema,
  NATIVE_REQUEST_CONTRACT,
  NATIVE_RESULT_CONTRACT,
  NATIVE_PROJECT_CONTRACT,
  NATIVE_RENDER_CONTRACT,
  NativeQualifiedRawResultV1Schema,
} from "../dist/videogen/native-contracts.js";
import { prepareHostEffectArtifacts } from "../dist/host-operations/effect-protocol.js";
import {
  hostOperationPolicyBinding,
  hostOperationLeaseProfileSha256,
  type HostOperationDeclarationV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationRuntimeOwner } from "../dist/host-operations/owner.js";
import {
  readVideogenOwnerSelection,
  selectVideogenRights,
} from "../dist/videogen/owner-selection.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/registry.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { type InvokeHostOperationDirectiveV1 } from "../dist/contracts.js";
import {
  portablePathFor,
  stageFrozenPortablePackage,
  verifyFrozenPortablePackage,
} from "../dist/videogen/portable-package.js";
import { compareNativeMedia } from "../dist/videogen/native-media-comparison.js";
import { readSemantic } from "../dist/videogen/bounds.js";
import { DeliveryOwnerFixture } from "./helpers/videogen-delivery-owner.js";
import { manifestMetadata } from "./helpers/videogen-edit-fixtures.js";
import { saved, XML_LIMITS } from "./helpers/videogen-native-fixtures.js";
import { suppliedCpuBindings, MEDIA_POLICY } from "./helpers/videogen-media-fixtures.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
const bindingPath = process.env["VIDEOGEN_NATIVE_TEST_BINDINGS"],
  assetPath = process.env["VIDEOGEN_NATIVE_TEST_ASSET"],
  outputPath = process.env["VIDEOGEN_NATIVE_TEST_OUTPUT"];
if (process.env["PENNY_VIDEOGEN_NATIVE_CPU"] !== "1")
  throw new Error(
    "Set PENNY_VIDEOGEN_NATIVE_CPU=1 and supply explicit private native/CPU bindings for actual qualification."
  );
describe("real native owner/CPU/package production, synthetic content and rights (not release admission)", () => {
  it("mints qualified references only after settled native work and freezes a complete portable closure", async () => {
    if (!bindingPath || !assetPath || !outputPath)
      throw new Error("explicit native test paths required");
    const binding = validateSkillSchema(
      ConfinedNativeBindingsSchema,
      JSON.parse(readFileSync(bindingPath, "utf8")),
      "native test binding"
    );
    const video = readFileSync(assetPath);
    const lp = {
      profile_id: "native-production-fixture",
      profile_version: 1 as const,
      duration_ms: 120000,
      renew_after_ms: 10000,
      queue_inactivity_ms: 30000,
    };
    const declaration: HostOperationDeclarationV1 = {
      schema_version: 1,
      operation_kind: "kdenlive_build_verify",
      adapter_id: "native-production-fixture",
      backend_binding_id: "local-fixture",
      request: NATIVE_REQUEST_CONTRACT,
      result: NATIVE_RESULT_CONTRACT,
      capability_classes: ["artifact_store"],
      lease_profile: { ...lp, profile_sha256: hostOperationLeaseProfileSha256(lp) },
      operation_inactivity_ms: 120000,
      max_request_bytes: 16384,
      max_input_artifacts: 7,
      max_input_bytes: 16777216,
      max_output_artifacts: 6,
      effect_protocol: "request_intent_v1",
      receipt_citing_result: HOST_RECEIPTED_RESULT_CONTRACT,
      max_output_bytes: 72000000,
      max_progress_events: 16,
      max_pre_acceptance_retries: 0,
      recovery_semantics: "atomic_local_publication_v1",
      cancellation_semantics: "local_abort_only_v1",
      output_contracts: [NATIVE_PROJECT_CONTRACT, NATIVE_RENDER_CONTRACT],
    };
    const fontPath = process.env["VIDEOGEN_NATIVE_TEST_FONT"];
    if (fontPath === undefined) throw new Error("explicit active font fixture required");
    const ass = Buffer.from(
      saved("caption.ass")
        .toString()
        .replace("00:00:02.00,00:00:07.00", "00:00:00.00,00:00:03.00")
        .replace("Arial", "DejaVu Sans")
    );
    const tone = silentPcmFixture();
    for (let i = 0; i < 8000; i++)
      tone.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), 44 + i * 2);
    using f = new DeliveryOwnerFixture(declaration, undefined, {
      native_mp4: video,
      native_voice: tone,
      native_caption: { ass_bytes: ass, font_bytes: readFileSync(fontPath) },
    });
    const runner = new ConfinedNativeRunner(binding);
    const editor = runner.editorDigest;
    if (!editor) throw new Error("editor pin missing");
    const fixturePins = validateSkillSchema(
      Type.Array(
        Type.Object(
          { path: Type.String(), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
          { additionalProperties: false }
        ),
        { maxItems: 32 }
      ),
      JSON.parse(process.env["VIDEOGEN_NATIVE_TEST_FIXTURES"] ?? "[]"),
      "native fixture pins"
    );
    const extraFixtures = fixturePins.map((pin) => {
      const bytes = readFileSync(pin.path);
      if (sha256(bytes) !== pin.sha256) throw new Error("native fixture drift");
      return { bytes, sha256: pin.sha256 };
    });
    const r = new KdenliveFixtureRegistry({
      editor_build_digest: editor,
      mlt_build_digest:
        binding.runtime_files.find((f) => f.target.endsWith("/libmlt-7.so.7.41.0"))?.sha256 ?? "",
      limits: XML_LIMITS,
      fixtures: [
        ...["single.kdenlive", "caption.kdenlive", "ordered.kdenlive"].map((n) => ({
          bytes: saved(n),
          sha256: sha256(saved(n)),
        })),
        ...extraFixtures,
      ],
    });
    const voice = {
      source_ref: f.e.audio.source.media_ref,
      relative_path: portablePathFor(f.e.audio.source.media_ref, "voice_stem"),
      bytes: f.store.read(f.e.audio.source.media_ref),
      duration_frames: 25,
    };
    const captions = [
      {
        source_ref: f.e.caption,
        relative_path: portablePathFor(f.e.caption, "caption_source"),
        bytes: f.store.read(f.e.caption),
        duration_frames: 0,
      },
      {
        source_ref: f.e.style,
        relative_path: portablePathFor(f.e.style, "documentation"),
        bytes: f.store.read(f.e.style),
        duration_frames: 0,
      },
      {
        source_ref: f.e.font,
        relative_path: portablePathFor(f.e.font, "documentation"),
        bytes: f.store.read(f.e.font),
        duration_frames: 0,
      },
    ];
    const asset = {
      source_ref: f.e.video,
      relative_path: portablePathFor(f.e.video, "original_video"),
      bytes: video,
      duration_frames: 50,
    };
    const written = writeNativeProject({
      registry: r,
      fixture_digest: sha256(saved("single.kdenlive")),
      edit: f.e.edit,
      assets: [asset, voice, ...captions],
      limits: f.e.host.limits,
      max_frames: 10000,
    });
    writeFileSync(outputPath + "/owner-generated.kdenlive", written.bytes);
    const processPolicy = {
      max_input_bytes: 16777216,
      max_output_bytes: 16777216,
      max_writable_bytes: 268435456,
      max_writable_inodes: 4096,
      max_diagnostic_bytes: 1048576,
      inactivity_ms: 90000,
      max_elapsed_ms: 120000,
      address_space_bytes: 3221225472,
      cpu_seconds: 90,
      max_processes: 65536,
      max_open_files: 256,
    };
    const initial = await runner.runObserved({
      verb: "render_compare",
      files: [
        { relative_path: "project.kdenlive", bytes: written.bytes },
        asset,
        voice,
        ...captions,
      ],
      policy: processPolicy,
      signal: new AbortController().signal,
    });
    const master = f.raw(initial.bytes, "video/mp4");
    f.rights(master, "video");
    const selection = readVideogenOwnerSelection(f.binding.owner),
      g4 = selection.gate.current_approvals.find((a) => a.gate_id === "G4");
    if (!g4) throw new Error("G4 missing");
    const budget = f.json(
      {
        schema_id: "penny.videogen-budget-reservation.v1",
        schema_version: 1,
        reservation_id: "native-production-fixture",
        subject_id: "shot",
        scope_gate_ref: g4.decision_ref,
        operation_kind: "kdenlive_build_verify",
        state: "held",
        reason: "applied",
        created_at_utc: "2026-01-01T00:00:00Z",
        expires_at_utc: "2027-01-01T00:00:00Z",
        policy_refs: {
          queue: f.opaque("queue"),
          inactivity: f.opaque("inactivity"),
          cleanup: f.opaque("cleanup"),
        },
        meters: [
          { meter: "attempts", unit: "count", reserved: 1, consumed: 0 },
          { meter: "stored_bytes", unit: "byte", reserved: 100000000, consumed: 0 },
        ],
      },
      "penny.videogen-budget-reservation.v1"
    );
    const build = f.json(
      {
        schema_id: "penny.videogen-native-build-request.v1",
        schema_version: 1,
        edit_ref: f.e.edit_ref,
        accepted_master_ref: master,
        assets: [
          { source_ref: f.e.video, role: "video", relative_path: asset.relative_path },
          { source_ref: voice.source_ref, role: "voice", relative_path: voice.relative_path },
          ...captions.map((c) => ({
            source_ref: c.source_ref,
            role: "caption_dependency",
            relative_path: c.relative_path,
          })),
        ],
        fixture_digest: sha256(saved("single.kdenlive")),
        editor_build_digest: r.editor_build_digest,
        mlt_build_digest: r.mlt_build_digest,
        feature_subset_digest: r.digest,
        output_root_selector: "native-output",
        limits: {
          max_xml_bytes: 262144,
          max_assets: 8,
          max_duration_frames: 10000,
          max_normalize_ms: 120000,
        },
      },
      "penny.videogen-native-build-request.v1"
    );

    const registration = {
      ...f.registration,
      host_operations: {
        schema_version: 1 as const,
        max_active_per_run: 1 as const,
        declarations: [declaration],
      },
    };
    const effect = prepareHostEffectArtifacts({
      store: f.store,
      identity: {
        project_id: f.project_id,
        run_id: f.run_id,
        state_id: "delivery-fixture",
        visit: 1,
        attempt: 1,
        kind: "kdenlive_build_verify",
        slot: "native",
        scope_ref: g4.decision_ref,
        predecessor_ref: f.e.edit_ref,
      },
      request_contract: NATIVE_REQUEST_CONTRACT,
      request_schema: NativeOperationRequestSchema,
      request: {
        schema_id: NATIVE_REQUEST_CONTRACT.schema_id,
        schema_version: 1,
        native_build_request_ref: build,
      },
      input_refs: [
        build,
        master,
        f.e.video,
        voice.source_ref,
        ...captions.map((c) => c.source_ref),
      ],
      budget_reservation_ref: budget,
      expected_output_contract_ref: f.json(
        NATIVE_RESULT_CONTRACT,
        "penny.videogen-expected-native-output.v1"
      ),
    });
    const d: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: f.context.identity,
      state_id: "delivery-fixture",
      attempt: 1,
      ...effect,
      operation_kind: "kdenlive_build_verify",
      registration_sha256: runtimeRegistrationSha256(registration),
      request_sha256: effect.request_ref.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "native-build", ref: build },
          { slot: "master", ref: master },
          { slot: "asset-0", ref: f.e.video },
          { slot: "asset-1", ref: voice.source_ref },
          ...captions.map((c, i) => ({ slot: `asset-${i + 2}`, ref: c.source_ref })),
        ],
      },
      expected_result: NATIVE_RESULT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(declaration, f.backend),
    };
    const c = f.checkpointer.loadRunById(f.run_id);
    if (!c) throw new Error("run missing");
    c.selectedArtifacts.push(
      budget,
      build,
      master,
      ...captions
        .map((c) => c.source_ref)
        .filter(
          (ref) => !c.selectedArtifacts.some((selected) => selected.artifact_id === ref.artifact_id)
        )
    );
    selectVideogenRights(c, f.current_rights);
    c.transition(d.state_id);
    c.pendingDirective = d;
    f.checkpointer.saveRun(c, "native_production_fixture_prepared", {});
    const cpu = new ConfinedMediaRunner(suppliedCpuBindings(f.root).bindings);
    const cpuPolicy = {
      ...MEDIA_POLICY,
      max_width: 512,
      max_height: 288,
      max_pixels: 512 * 288,
      max_frames: 175,
      max_input_bytes: 16777216,
      max_output_bytes: 134217728,
      max_decoded_bytes: 134217728,
      max_samples: 480000,
      max_elapsed_ms: 30000,
    };
    const adapter = createKdenliveAdapter({
      owner: f.binding.owner,
      host: f.binding.host,
      runner,
      registry: r,
      process_policy: processPolicy,
      comparison: { runner: cpu, policy: cpuPolicy },
      output_root_selector: "native-output",
      adapter_id: declaration.adapter_id,
      backend_binding_id: declaration.backend_binding_id,
      backend_key_sha256: f.backend,
    });
    const engine = new OrchestrationEngine(f.checkpointer, {
      projectRoot: f.root,
      maxSteps: 200,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactStore: f.store,
      artifactReader: f.store,
      artifactRevisions: f.store,
      playbookRegistration: registration,
    });
    const owner = new HostOperationRuntimeOwner({
      projectId: f.project_id,
      checkpointer: f.checkpointer,
      artifacts: f.store,
      leaseAuthority: f.leases,
      adapters: new Map([
        [
          adapter.adapter_id,
          {
            ...adapter,
            async run(context: Parameters<typeof adapter.run>[0]) {
              try {
                return await adapter.run(context);
              } catch (error) {
                writeFileSync(
                  outputPath + "/native-adapter-error.txt",
                  String(error) + "\n" + (error instanceof Error ? String(error.cause) : "")
                );
                if (
                  error instanceof Error &&
                  typeof error.cause === "object" &&
                  error.cause !== null
                ) {
                  const cause = error.cause;
                  if ("canonical_project" in cause && Buffer.isBuffer(cause.canonical_project))
                    writeFileSync(
                      outputPath + "/native-refused-canonical.kdenlive",
                      cause.canonical_project
                    );
                  if ("reason" in cause)
                    writeFileSync(outputPath + "/native-adapter-error.txt", String(cause.reason));
                }
                throw error;
              }
            },
          },
        ],
      ]),
      useValidator: adapter,
    });
    const dispatched = await owner.dispatch(engine, d);
    writeFileSync(
      outputPath + "/native-dispatch.json",
      JSON.stringify(
        { dispatched, records: f.checkpointer.hostOperationCallsForRun(f.run_id) },
        null,
        2
      )
    );
    const record = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    if (!record?.operation_result_ref) throw new Error("settled native operation missing");
    expect(["settled", "consumed"]).toContain(record.lifecycle);
    const raw = readSemantic({
      ...f.e.host,
      ref: record.operation_result_ref,
      schema: NativeQualifiedRawResultV1Schema,
      schema_id: NATIVE_RESULT_CONTRACT.schema_id,
    });
    expect(raw.status).toBe("qualified");
    const producer = new NativeProductProducer({
      project_id: f.project_id,
      store: f.store,
      checkpointer: f.checkpointer,
      leases: f.leases,
      limits: f.e.host.limits,
      registration_sha256: runtimeRegistrationSha256(registration),
      declaration,
      backend_key_sha256: f.backend,
      registry: r,
    });
    const products = producer.produce(record.operation_record_id, f.e.host);
    expect(producer.produce(record.operation_record_id, f.e.host)).toEqual(products);
    f.rights(products.normalized_project_ref, "text");
    for (const asset of products.required_assets)
      if (!f.current_rights.some((r) => r.subject_ref.artifact_id === asset.source_ref.artifact_id))
        f.rights(asset.source_ref, "text");
    const environmentFiles = [
      ...new Set(
        raw.phases.flatMap((p) => p.processes.flatMap((p) => p.plugins.map((p) => p.sha256)))
      ),
    ].map((digest, i) => {
      const pin = binding.runtime_files.find((f) => f.sha256 === digest);
      if (!pin) throw new Error("plugin pin missing");
      return {
        id: `plugin_${i}`,
        ref: f.raw(readFileSync(pin.source), "application/octet-stream"),
      };
    });
    environmentFiles.push({ id: "font_main", ref: f.e.font });
    for (const file of environmentFiles)
      if (!f.current_rights.some((r) => r.subject_ref.artifact_id === file.ref.artifact_id))
        f.rights(file.ref, "text");
    const quant = f.p.manifest.files.find(
        (f) => f.producer_ref.content_schema?.schema_id === "penny.videogen-edit-quantization.v1"
      )?.producer_ref,
      doc = f.p.manifest.files.find(
        (file) => file.relative_path === f.p.manifest.instructions_relative_path
      )?.producer_ref;
    if (!quant || !doc) throw new Error("package operands missing");
    const manifestInput = {
      producer,
      operation_record_id: record.operation_record_id,
      host: {
        ...f.e.host,
        package_policy: { max_files: 500, max_file_bytes: 33554432, max_payload_bytes: 268435456 },
      },
      edit_ref: f.e.edit_ref,
      package_id: "native_fixture_package",
      credits_ref: f.p.manifest.credits_ref,
      provenance_ref: f.p.manifest.provenance_ref,
      feature_subset_ref: f.p.subset,
      quantization_ref: quant,
      instructions_ref: doc,
      environment: {
        editor_build: r.editor_build_digest,
        mlt_build: r.mlt_build_digest,
        os_arch: `${process.platform}_${process.arch}`,
        decoder_build: cpu.runtimeDigest,
        encoder_build: runner.rendererDigest ?? "",
        config_digest: raw.phases[0]?.runtime_sha256 ?? "",
        dependencies: environmentFiles.map((f) => ({
          id: f.id,
          digest: f.ref.content_digest,
          packaged: true,
        })),
      },
      environment_files: environmentFiles,
    };
    const result = produceNativePortableManifest(manifestInput);
    expect(() => producer.produce("nonexistent-operation", f.e.host)).toThrow();
    const alias = f.json(f.e.edit, "penny.videogen-edit-decision.v1");
    expect(() => produceNativePortableManifest({ ...manifestInput, edit_ref: alias })).toThrow(
      /exact edit reference/
    );
    expect(() =>
      produceNativePortableManifest({
        ...manifestInput,
        environment_files: environmentFiles.slice(1),
      })
    ).toThrow(/font\/plugin/);
    const revoked = manifestInput.host.current_rights.map((r) =>
      r.subject_ref.artifact_id === products.normalized_project_ref.artifact_id
        ? { ...r, status: "revoked" as const }
        : r
    );
    expect(() =>
      produceNativePortableManifest({
        ...manifestInput,
        host: { ...manifestInput.host, current_rights: revoked },
      })
    ).toThrow();
    const changedProject = Buffer.from(written.bytes.toString().replace("-6dB", "-3dB"));
    if (changedProject.equals(written.bytes)) throw new Error("active gain fixture absent");
    const changedGain = await runner.runObserved({
      verb: "render_compare",
      files: [
        { relative_path: "project.kdenlive", bytes: changedProject },
        asset,
        voice,
        ...captions,
      ],
      policy: processPolicy,
      signal: new AbortController().signal,
    });
    await expect(
      compareNativeMedia({
        runner: cpu,
        policy: cpuPolicy,
        limits: f.e.host.limits,
        master: initial.bytes,
        render: changedGain.bytes,
        width: 512,
        height: 288,
        frame_rate: f.e.edit.canvas.fps,
        duration_frames: written.readback.duration_frames,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/full frame\/sample\/timing mismatch/);
    const changedCaption = Buffer.from(
      ass.toString().replace("REOPENED SYNTHETIC CAPTION", "DIFFERENT CAPTION")
    );
    if (changedCaption.equals(ass)) throw new Error("active caption fixture absent");
    const captionDrift = await runner.runObserved({
      verb: "render_compare",
      files: [
        { relative_path: "project.kdenlive", bytes: written.bytes },
        asset,
        voice,
        ...captions.map((c) =>
          c.source_ref.artifact_id === f.e.caption.artifact_id ? { ...c, bytes: changedCaption } : c
        ),
      ],
      policy: processPolicy,
      signal: new AbortController().signal,
    });
    await expect(
      compareNativeMedia({
        runner: cpu,
        policy: cpuPolicy,
        limits: f.e.host.limits,
        master: initial.bytes,
        render: captionDrift.bytes,
        width: 512,
        height: 288,
        frame_rate: f.e.edit.canvas.fps,
        duration_frames: written.readback.duration_frames,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/full frame\/sample\/timing mismatch/);
    const unadmittedFont = Buffer.from(
      ass
        .toString()
        .replace("REOPENED SYNTHETIC CAPTION", "{\\fnOther Font}REOPENED SYNTHETIC CAPTION")
    );
    await expect(
      runner.runObserved({
        verb: "render_compare",
        files: [
          { relative_path: "project.kdenlive", bytes: written.bytes },
          asset,
          voice,
          ...captions.map((c) =>
            c.source_ref.artifact_id === f.e.caption.artifact_id
              ? { ...c, bytes: unadmittedFont }
              : c
          ),
        ],
        policy: processPolicy,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/driver\/sandbox failed/);
    const staged = stageFrozenPortablePackage({
      host: {
        ...f.e.host,
        package_policy: { max_files: 500, max_file_bytes: 33554432, max_payload_bytes: 268435456 },
      },
      manifest: result.manifest,
      staging_parent: f.root,
      output_metadata: manifestMetadata(f, "native_fixture_manifest"),
    });
    verifyFrozenPortablePackage({
      host: {
        ...f.e.host,
        package_policy: { max_files: 500, max_file_bytes: 33554432, max_payload_bytes: 268435456 },
      },
      manifest_ref: staged.manifest_ref,
      staging_root: staged.staging_root,
    });
    expect(result.manifest.files.length).toBeGreaterThan(3);
    expect(raw.comparison.video_frames).toBe(75);
    expect(
      raw.phases.every(
        (p) =>
          p.fonts.length === 1 &&
          p.caption !== null &&
          p.processes.every((p) => p.plugins.length > 0)
      )
    ).toBe(true);
    writeFileSync(outputPath + "/owner-native-raw.json", canonicalJson(raw));
    writeFileSync(outputPath + "/owner-native-products.json", canonicalJson(products));
    writeFileSync(outputPath + "/owner-portable-manifest.json", result.canonical_bytes);
  }, 480000);
});
