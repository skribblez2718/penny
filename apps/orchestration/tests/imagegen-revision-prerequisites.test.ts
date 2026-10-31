import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import type { ArtifactRef, RunIdentity } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import { StaticImagegenExportRegistry } from "../dist/imagegen/export-registry.js";
import {
  assertImageSubmittedGraphMatchesProfile,
  buildImageSubmittedGraph,
} from "../dist/imagegen/graph-builder.js";
import {
  COMFY_IMAGEGEN_OPERATION_KIND,
  ComfyImagegenOperationAdapter,
} from "../dist/imagegen/operation-owner.js";
import { ComfyImagegenReadinessAdapter } from "../dist/imagegen/readiness-operation.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import type { HostOperationAdapterV1 } from "../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  HostOperationSimulatedCrashError,
} from "../dist/host-operations/owner.js";
import { validateCanonicalPng } from "../dist/png-media.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../dist/playbooks/imagegen.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import {
  imagegenProfileSha256,
  validateImagegenProfile,
  validateImageSubmittedGraph,
  type ImagegenProfileBodyV1,
  type ImagegenProfileSnapshotV1,
  type ImagegenProfileV1,
  type ImageSubmittedGraphV1,
  type ImagegenGraphV1,
} from "../dist/skill-contracts/imagegen.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import {
  SYNTHETIC_NODE_POLICIES,
  syntheticInventory,
  syntheticProfile,
} from "./helpers/imagegen-fixtures.js";
import { imagegenRevisionHttpFixture } from "./helpers/imagegen-revision-http.js";
import { DeterministicImagegenSmokeModel } from "./helpers/imagegen-smoke-model.js";

function rehash(body: ImagegenProfileBodyV1): ImagegenProfileV1 {
  return { ...body, profile_sha256: imagegenProfileSha256(body) };
}
function snapshot(profile: ImagegenProfileV1): ImagegenProfileSnapshotV1 {
  return {
    schema_id: "penny.imagegen-profile-snapshot.v1",
    schema_version: 1,
    profile,
    approved_profile_sha256: profile.profile_sha256,
    source_graph_sha256: profile.source_graph_sha256,
  };
}
const profileRef: ArtifactRef = {
  schema_version: 2,
  artifact_id: `art_${sha256("profile-ref")}`,
  run_id: "graph-test",
  phase: "intake",
  branch_id: null,
  kind: "imagegen-profile-snapshot",
  operation_id: "snapshot",
  version: 1,
  producer: "test:imagegen",
  media_type: "application/json",
  content_schema: { schema_id: "penny.imagegen-profile-snapshot.v1", schema_version: 1 },
  byte_length: 1,
  content_digest: sha256("profile"),
  store_ref: `artifact://sha256/${sha256("profile")}`,
};
function prepared(profile: ImagegenProfileV1, applyFallback = false): ImageSubmittedGraphV1 {
  return buildImageSubmittedGraph({
    profile_snapshot: snapshot(profile),
    profile_snapshot_ref: profileRef,
    slot: 1,
    revision: 1,
    base_seed: 0xffff_ffff,
    positive_prompt: 'quoted JSON remains data: {"node":"inert"}',
    negative_prompt: "noise",
    apply_fallback: applyFallback,
  });
}
function changedGraph(value: ImageSubmittedGraphV1, graph: ImagegenGraphV1): ImageSubmittedGraphV1 {
  return validateImageSubmittedGraph({
    ...value,
    graph,
    submitted_graph_sha256: sha256(canonicalJson(graph)),
  });
}

describe("controlled-revision graph safety prerequisites (not revision support)", () => {
  it.each([
    ["positive_prompt", "negative_prompt"],
    ["width", "height"],
    ["seed", "batch_size"],
    ["filename_prefix", "positive_prompt"],
  ] as const)("rejects digest-correct %s/%s mutation aliases", (role, other) => {
    const profile = syntheticProfile({ port: 8188 });
    const { profile_sha256: _digest, ...body } = profile;
    const unsafe = rehash({
      ...body,
      mutations: { ...body.mutations, [role]: body.mutations[other] },
    });
    expect(() => validateImagegenProfile(unsafe)).toThrow("mutation addresses");
    expect(
      () =>
        new StaticImagegenProfileRegistry({
          profiles: [unsafe],
          approved_profile_sha256_by_id: new Map([[unsafe.profile_id, unsafe.profile_sha256]]),
          node_class_policies: SYNTHETIC_NODE_POLICIES,
        })
    ).toThrow("mutation addresses");
  });

  it("does not let a prompt mutation select an otherwise registered model asset", () => {
    const { profile_sha256: _digest, ...body } = syntheticProfile({ port: 8188 });
    expect(() =>
      validateImagegenProfile(
        rehash({
          ...body,
          mutations: {
            ...body.mutations,
            positive_prompt: { node_id: "4", input_name: "asset" },
          },
        })
      )
    ).toThrow("cannot select registered assets");
  });

  it.each([false, true])(
    "reconstructs an approved graph with fallback=%s and wrapped seed",
    (fallback) => {
      const profile = syntheticProfile({
        port: 8188,
        ...(fallback
          ? {
              fallback: {
                absent_model_id: "asset-primary",
                replacement_asset_id: "asset-fallback",
                fallback_inventory: syntheticInventory("asset-fallback"),
              },
            }
          : {}),
      });
      const submitted = prepared(profile, fallback);
      expect(submitted.effective_seed).toBe(0);
      expect(() =>
        assertImageSubmittedGraphMatchesProfile({
          profile_snapshot: snapshot(profile),
          submitted_graph: submitted,
        })
      ).not.toThrow();
    }
  );

  const attacks: readonly {
    name: string;
    mutate: (value: ImageSubmittedGraphV1) => ImageSubmittedGraphV1;
  }[] = [
    {
      name: "unapproved asset",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "4": {
            class_type: "OutputNode",
            inputs: { ...v.graph["4"]?.inputs, asset: "different-asset" },
          },
        }),
    },
    {
      name: "unapproved node",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          injected: { class_type: "LoadImage", inputs: { image: "unapproved.png" } },
        }),
    },
    {
      name: "extra input",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "2": { class_type: "SamplerNode", inputs: { seed: 0, command: "inert-text" } },
        }),
    },
    {
      name: "changed class",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "2": { class_type: "UnapprovedClass", inputs: { seed: 0 } },
        }),
    },
    {
      name: "batch overflow",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "3": { class_type: "CanvasNode", inputs: { width: 2, height: 2, batch: 2 } },
        }),
    },
    {
      name: "wrong dimensions",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "3": { class_type: "CanvasNode", inputs: { width: 3, height: 2, batch: 1 } },
        }),
    },
    {
      name: "wrong seed",
      mutate: (v) =>
        changedGraph(v, { ...v.graph, "2": { class_type: "SamplerNode", inputs: { seed: 123 } } }),
    },
    {
      name: "changed output prefix",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "4": {
            class_type: "OutputNode",
            inputs: { ...v.graph["4"]?.inputs, prefix: "not-the-prepared-prefix" },
          },
        }),
    },
    {
      name: "metadata reintroduced",
      mutate: (v) =>
        changedGraph(v, {
          ...v.graph,
          "2": { class_type: "SamplerNode", inputs: { seed: 0 }, _meta: { title: "unexpected" } },
        }),
    },
    { name: "wrong source digest", mutate: (v) => ({ ...v, source_graph_sha256: "0".repeat(64) }) },
    {
      name: "wrong fallback ID",
      mutate: (v) => ({
        ...v,
        fallback_disposition: { status: "applied", fallback_id: "not-approved" },
      }),
    },
  ];
  it.each(attacks)("rejects a self-consistent submitted document: $name", ({ mutate }) => {
    const profile = syntheticProfile({
      port: 8188,
      fallback: {
        absent_model_id: "asset-primary",
        replacement_asset_id: "asset-fallback",
        fallback_inventory: syntheticInventory("asset-fallback"),
      },
    });
    const submitted = validateImageSubmittedGraph(mutate(prepared(profile)));
    expect(() =>
      assertImageSubmittedGraphMatchesProfile({
        profile_snapshot: snapshot(profile),
        submitted_graph: submitted,
      })
    ).toThrow();
  });
});

describe("fresh regression through real imagegen engine, owner, canonical store and HTTP adapters", () => {
  it.each([false, true])(
    "reviews the current PNG, with restart after accepted prompt=%s",
    async (restart) => {
      const root = mkdtempSync(join(tmpdir(), "penny-imagegen-revision-prerequisite-"));
      const backend = await imagegenRevisionHttpFixture();
      const stateRoot = join(root, "state");
      mkdirSync(stateRoot, { mode: 0o700 });
      const catalog = new ProjectCatalog(stateRoot, { create: true });
      const projectId = catalog.registerProject(root).projectId;
      catalog.close();
      const profile = syntheticProfile({ port: backend.port });
      const profiles = new StaticImagegenProfileRegistry({
        profiles: [profile],
        approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
        node_class_policies: SYNTHETIC_NODE_POLICIES,
        default_profile_id: profile.profile_id,
      });
      const model = new DeterministicImagegenSmokeModel();
      function open(create: boolean) {
        const artifacts = create
          ? ArtifactStore.provision(join(root, "artifacts"), { projectId })
          : new ArtifactStore(join(root, "artifacts"), { projectId });
        const checkpointer = create
          ? Checkpointer.provision(join(root, "orchestration.db"), undefined, { projectId })
          : new Checkpointer(join(root, "orchestration.db"), undefined, { projectId });
        const storage = new SqliteImagegenStorageAdmission({
          directory: join(root, "storage"),
          ceiling_bytes: 32 * 1024 * 1024,
          warning_threshold_bytes: 24 * 1024 * 1024,
          mode: create ? "provision" : "existing",
        });
        const activation = new SqliteImagegenActivationController({
          directory: join(root, "activation"),
          mode: "enabled",
        });
        const engine = new OrchestrationEngine(checkpointer, {
          projectRoot: root,
          maxSteps: 64,
          receiptAuthority: create
            ? ReceiptAuthority.provision(join(root, "receipt.key"))
            : ReceiptAuthority.loadExisting(join(root, "receipt.key")),
          artifactStore: artifacts,
          artifactReader: artifacts,
          artifactRevisions: artifacts,
          playbookRegistration: IMAGEGEN_PLAYBOOK_REGISTRATION,
          imagegen: {
            profiles,
            storage,
            activation,
            exports: new StaticImagegenExportRegistry([]),
          },
        });
        const leases = new HostOperationLeaseAuthority(stateRoot);
        const generation = new ComfyImagegenOperationAdapter({ profiles, storage });
        const readiness = new ComfyImagegenReadinessAdapter({ profiles });
        const owner = new HostOperationRuntimeOwner({
          projectId,
          checkpointer,
          artifacts,
          leaseAuthority: leases,
          adapters: new Map<string, HostOperationAdapterV1>([
            [generation.adapter_id, generation],
            [readiness.adapter_id, readiness],
          ]),
          fault: (point, kind) => {
            if (
              create &&
              restart &&
              kind === COMFY_IMAGEGEN_OPERATION_KIND &&
              point === "after_remote_checkpoint"
            )
              throw new HostOperationSimulatedCrashError(point);
          },
        });
        const workers = new WorkerExecutor(model, artifacts, {
          projectRoot: root,
          parallelConcurrency: 2,
          registration: IMAGEGEN_PLAYBOOK_REGISTRATION,
        });
        const runner = new OrchestrationRunner(engine, workers, undefined, owner);
        let closed = false;
        return {
          engine,
          runner,
          artifacts,
          checkpointer,
          close: () => {
            if (closed) return;
            closed = true;
            leases.close();
            storage.close();
            activation.close();
            checkpointer.close();
            artifacts.close();
          },
        };
      }
      let active = open(true);
      const identity: RunIdentity = {
        schema_version: 2,
        run_id: "run-imagegen-http",
        session_id: "session-imagegen-http",
        playbook: "imagegen",
        engine_owner: "typescript",
      };
      try {
        const started = active.engine.handle({
          schema_version: 2,
          action: "start",
          identity,
          goal: "Create a calm wordless blue geometric image",
          constraints: {
            schema_version: 1,
            count: 1,
            seed: 42,
            max_revision_rounds: 0,
            raw_prompt: "calm blue geometric forms",
          },
          project_root: root,
          trust_profile: "hardened-untrusted",
        });
        if (restart) {
          await expect(active.runner.runUntilBoundary(started)).rejects.toBeInstanceOf(
            HostOperationSimulatedCrashError
          );
          const pending = active.checkpointer.loadRunById(identity.run_id)?.pendingDirective;
          if (pending?.action !== "invoke_host_operation")
            throw new Error("expected durable generation directive");
          const record = active.checkpointer.hostOperationCallForDirective(
            identity.run_id,
            pending.state_id,
            pending.attempt,
            pending.operation_id
          );
          expect(record).toMatchObject({
            lifecycle: "submitted",
            remote_correlation_id: "fixture-prompt",
          });
          expect(backend.submissions).toHaveLength(1);
          active.close();
          active = open(false);
        }
        const terminal = await active.runner.runUntilBoundary(
          restart
            ? active.engine.handle({ schema_version: 2, action: "recover", identity })
            : started
        );
        expect(terminal).toMatchObject({ action: "complete", met: true });
        if (terminal.action !== "complete") throw new Error("expected current reviewed PNG");
        const image = terminal.artifacts.find((ref) => ref.kind === "generated-image");
        if (image === undefined) throw new Error("missing canonical image");
        expect(terminal.result.output_artifact_ref).toEqual(image);
        const bytes = active.artifacts.readById(image.artifact_id);
        validateCanonicalPng(bytes);
        expect(bytes).toEqual(Buffer.from(backend.png));
        expect(model.states).toEqual([
          "framing:annie",
          "composing:synthia",
          "critiquing_candidates:vera",
          "critiquing_candidates:carren",
        ]);
        expect(backend.submissions).toHaveLength(1);
        const graphRef = terminal.artifacts.find((ref) => ref.kind === "image-submitted-graph");
        if (graphRef === undefined) throw new Error("missing submitted graph");
        const graph = validateImageSubmittedGraph(
          JSON.parse(active.artifacts.readById(graphRef.artifact_id).toString("utf8"))
        );
        expect(JSON.parse(backend.submissions[0] ?? "null")).toMatchObject({ prompt: graph.graph });
        expect(active.checkpointer.completionAdmission(identity.run_id)?.origin_state).toBe(
          "admitting_product"
        );
      } finally {
        active.close();
        await backend.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
