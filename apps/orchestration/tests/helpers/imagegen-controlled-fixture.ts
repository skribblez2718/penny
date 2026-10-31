import type { ImagegenChildPolicyV1 } from "../../dist/child-workflows/imagegen-policy.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { ComfyWorkerIdentityRegistry } from "../../dist/comfy/worker-identity.js";
import type { ArtifactRef, Directive, JsonValue, RunIdentity } from "../../dist/contracts.js";
import { validateDirective } from "../../dist/contracts.js";
import type { RunContext } from "../../dist/context.js";
import { OrchestrationEngine } from "../../dist/engine.js";
import type { PlaybookCore } from "../../dist/playbooks/playbook.js";
import type { PlaybookRegistration } from "../../dist/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../../dist/playbooks/research.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../../dist/playbooks/imagegen.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import { ProjectCatalog } from "../../dist/state/catalog.js";
import { HostOperationLeaseAuthority } from "../../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  type HostOperationRuntimeOwnerOptions,
} from "../../dist/host-operations/owner.js";
import type { HostOperationAdapterV1 } from "../../dist/host-operations/contracts.js";
import { FileHostOperationResultCache } from "../../dist/host-operations/result-cache.js";
import {
  initializeVideogenOwnerSelection,
  selectVideogenRights,
  VideogenOwnerSelection,
} from "../../dist/videogen/owner-selection.js";
import { ImageAssetAuthority } from "../../dist/imagegen/asset-authority.js";
import { ImageInputUploadAdapter } from "../../dist/imagegen/input-upload.js";
import { StaticImagegenProfileRegistry } from "../../dist/imagegen/profile-registry.js";
import { ComfyImagegenOperationAdapter } from "../../dist/imagegen/operation-owner.js";
import { ComfyImagegenReadinessAdapter } from "../../dist/imagegen/readiness-operation.js";
import { SqliteImagegenActivationController } from "../../dist/imagegen/activation.js";
import { SqliteImagegenStorageAdmission } from "../../dist/imagegen/storage-admission.js";
import { StaticImagegenExportRegistry } from "../../dist/imagegen/export-registry.js";
import { encodeCanonicalPng } from "../../dist/png-media.js";
import {
  imagegenProfileSha256,
  validateImagegenProfile,
  type ImagegenProfileV1,
} from "../../dist/skill-contracts/imagegen.js";
import {
  ImageAssetCallV1Schema,
  validateImageAssetRequest,
  type ImageAssetRequestV1,
} from "../../dist/imagegen/reference-contracts.js";
import { validateSkillSchema } from "../../dist/skill-contracts/common.js";
import {
  checkGatePacket,
  constructGateDecision,
  type GateBindingHostV1,
  type CurrentGateApprovalV1,
  type GatePacketV1,
} from "../../dist/videogen/gates.js";
import {
  type AssetIntentV1,
  validateAssetIntent,
} from "../../dist/videogen/foundation-contracts.js";
import type { CurrentRightsV1 } from "../../dist/videogen/rights-ledger.js";
import { OrchestrationRunner, WorkerExecutor } from "../../dist/worker.js";
import { FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";
import {
  SYNTHETIC_NODE_POLICIES,
  syntheticInventory,
  syntheticProfile,
} from "./imagegen-fixtures.js";
import { DeterministicImagegenSmokeModel } from "./imagegen-smoke-model.js";

export const png = (v: number) =>
  encodeCanonicalPng({
    width: 2,
    height: 2,
    rgba: Uint8Array.from([v, v, v, 255, v, v, v, 255, v, v, v, 255, v, v, v, 255]),
  });
const inputPolicy = {
  schema_version: 1 as const,
  class_type: "CanonicalInput",
  execution_class: "registered_input" as const,
  inputs: [
    {
      input_name: "image",
      value_type: "string" as const,
      semantic: "canonical_png_input" as const,
    },
  ],
};
export function controlledProfile(
  port: number,
  method: "fresh" | "whole" | "mask" | "rectangle",
  polarity: "white_edit" | "black_edit" = "white_edit"
): ImagegenProfileV1 {
  const p = syntheticProfile({ port });
  if (method === "fresh") return p;
  const mask = method !== "whole",
    graph = {
      ...p.source_graph,
      "5": { class_type: "CanonicalInput", inputs: { image: "" } },
      ...(mask ? { "6": { class_type: "CanonicalInput", inputs: { image: "" } } } : {}),
    };
  const { profile_sha256: _old, ...old } = p;
  const body = {
    ...old,
    source_graph: graph,
    source_graph_sha256: sha256(canonicalJson(graph)),
    node_classes: [
      ...p.node_classes,
      {
        class_type: inputPolicy.class_type,
        execution_class: inputPolicy.execution_class,
        inputs: inputPolicy.inputs,
      },
    ],
    required_inventory: {
      ...p.required_inventory,
      class_types: [...p.required_inventory.class_types, "CanonicalInput"],
      object_info_sha256: sha256(
        canonicalJson({
          ...syntheticInventory(),
          CanonicalInput: { inputs: { image: ["STRING"] } },
        })
      ),
    },
    revision_capability: {
      schema_id: "penny.image-revision-capability.v1" as const,
      schema_version: 1 as const,
      method: mask ? ("inpaint" as const) : ("img2img" as const),
      implementation_sha256: sha256("synthetic input implementation; not deployed qualification"),
      source_port: { node_id: "5", input_name: "image" },
      mask_port: mask ? { node_id: "6", input_name: "image" } : null,
      backend_mask_polarity: mask ? polarity : null,
      input_subfolder: "fixture-inputs",
    },
  };
  return validateImagegenProfile({ ...body, profile_sha256: imagegenProfileSha256(body) });
}
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(canonicalJson(value));
}
export async function controlledHttp(revision: boolean) {
  let observe: ((request: string) => void) | undefined;
  const requests: string[] = [],
    uploads: Buffer[] = [],
    submissions: string[] = [],
    remote = new Map<string, Buffer>();
  let inputDrift = false,
    descriptorDrift = false,
    submissionUnknown = false;
  const output = png(255);
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    observe?.(`${req.method} ${req.url}`);
    if (req.url === "/system_stats") return json(res, { ready: true });
    if (req.url === "/object_info")
      return json(res, {
        ...syntheticInventory(),
        ...(revision ? { CanonicalInput: { inputs: { image: ["STRING"] } } } : {}),
      });
    if (req.url === "/upload/image" || req.url === "/prompt") {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on("data", (chunk: Buffer) => {
        n += chunk.length;
        if (n > 131072) req.destroy();
        else chunks.push(chunk);
      });
      req.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (req.url === "/prompt") {
          submissions.push(bytes.toString());
          json(
            res,
            submissionUnknown
              ? { accepted: true }
              : { prompt_id: "controlled-prompt", number: 1, node_errors: {} }
          );
        } else {
          uploads.push(bytes);
          const text = bytes.toString("latin1"),
            filename = /filename="([a-f0-9]{64}\.png)"/u.exec(text)?.[1];
          const subfolder = /name="subfolder"\r\n\r\n([^\r]*)/u.exec(text)?.[1];
          if (filename === undefined || subfolder === undefined)
            throw new Error("fixture malformed multipart");
          const start = bytes.indexOf(Buffer.from("\r\n\r\n")) + 4,
            end = bytes.indexOf(Buffer.from("\r\n--"), start);
          remote.set(filename, bytes.subarray(start, end));
          json(res, { name: filename, subfolder, type: "input" });
        }
      });
      return;
    }
    if (req.url === "/history/controlled-prompt")
      return json(res, {
        "controlled-prompt": {
          status: { completed: true, status_str: "success" },
          outputs: {
            "4": {
              images: [
                {
                  filename: descriptorDrift ? "changed.png" : "output.png",
                  subfolder: "",
                  type: "output",
                },
              ],
            },
          },
        },
      });
    if (req.url?.startsWith("/view?")) {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      const bytes =
        q.get("type") === "input"
          ? inputDrift
            ? png(33)
            : remote.get(q.get("filename") ?? "")
          : output;
      if (bytes === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(bytes);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture port missing");
  return {
    onRequest(callback: (request: string) => void) {
      observe = callback;
    },
    port: address.port,
    requests,
    uploads,
    submissions,
    remote,
    output,
    ambiguousSubmission() {
      submissionUnknown = true;
    },
    driftInput() {
      inputDrift = true;
    },
    driftDescriptor() {
      descriptorDrift = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    },
  };
}

export class ControlledFixture implements Disposable {
  readonly root = mkdtempSync(join(tmpdir(), "penny-imagegen-controlled-"));
  readonly stateRoot = join(this.root, "state");
  readonly projectId: string;
  store: ArtifactStore;
  checkpointer: Checkpointer;
  readonly receipts: ReceiptAuthority;
  readonly rights: CurrentRightsV1[] = [];
  readonly approvals: CurrentGateApprovalV1[] = [];
  readonly approved: ArtifactRef[] = [];
  readonly parentRun: string;
  readonly imageRun: string;
  private sequence = 0;
  constructor(runs: { parentRun?: string; imageRun?: string } = {}) {
    this.parentRun = runs.parentRun ?? "reference-parent";
    this.imageRun = runs.imageRun ?? "reference-image";
    mkdirSync(this.stateRoot, { mode: 0o700 });
    const catalog = new ProjectCatalog(this.stateRoot, { create: true });
    this.projectId = catalog.registerProject(this.root).projectId;
    catalog.close();
    this.store = ArtifactStore.provision(join(this.root, "artifacts"), {
      projectId: this.projectId,
    });
    this.checkpointer = Checkpointer.provision(join(this.root, "control.db"), undefined, {
      projectId: this.projectId,
    });
    this.receipts = ReceiptAuthority.provision(join(this.root, "receipt.key"));
  }
  ref(
    value: unknown,
    schema?: string,
    kind = "reference-fixture",
    media = "application/json"
  ): ArtifactRef {
    return this.store.persist({
      metadata: {
        schema_version: 2,
        run_id: this.parentRun,
        phase: "fixture",
        branch_id: null,
        kind,
        operation_id: `fixture-${++this.sequence}`,
        version: 1,
        producer: "host:reference-fixture",
        media_type: media,
        ...(schema === undefined
          ? {}
          : { content_schema: { schema_id: schema, schema_version: 1 } }),
        parent_ref: null,
        upstream_refs: [],
      },
      content: value instanceof Uint8Array ? value : canonicalJson(value),
    });
  }
  clear(subject: ArtifactRef, consent: ArtifactRef) {
    const provenance = this.ref(
      {
        schema_id: "penny.videogen-provenance-binding.v1",
        schema_version: 1,
        subject_ref: subject,
        source_refs: [],
        producer_receipt_ref: this.ref("fixture receipt; not qualification"),
      },
      "penny.videogen-provenance-binding.v1"
    );
    const rights = this.ref(
      {
        schema_id: "penny.videogen-rights-binding.v1",
        schema_version: 1,
        subject_ref: subject,
        subject_kind: subject.media_type === "image/png" ? "image" : "text",
        revision: 1,
        provenance_ref: provenance,
        license_ref: this.ref("fixture license"),
        consent_refs: [consent],
        allowed_uses: ["source", "preview"],
        territories: ["fixture"],
        credits: ["fixture"],
        valid_from_utc: "2026-01-01T00:00:00Z",
        expires_at_utc: "2027-01-01T00:00:00Z",
      },
      "penny.videogen-rights-binding.v1"
    );
    this.rights.push({ subject_ref: subject, rights_ref: rights, revision: 1, status: "cleared" });
    return rights;
  }
  authorize(
    profile: ImagegenProfileV1,
    method: "fresh" | "whole" | "mask" | "rectangle",
    alter?: (asset: ImageAssetRequestV1) => ImageAssetRequestV1,
    child?: {
      readonly policy: ImagegenChildPolicyV1;
      readonly imageRuns: readonly string[];
      readonly dispatch: (context: RunContext, asset: ImageAssetRequestV1) => Directive;
    }
  ) {
    const consent = this.ref("consent fixture"),
      story = this.ref("story fixture");
    const source = this.ref(png(7), undefined, "reference-image", "image/png");
    const mask = this.ref(
      encodeCanonicalPng({
        width: 2,
        height: 2,
        rgba: Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
      }),
      undefined,
      "reference-mask",
      "image/png"
    );
    const rights = this.clear(method === "fresh" ? story : source, consent);
    if (method === "mask") this.clear(mask, consent);
    const intent = validateAssetIntent(
      {
        schema_id: "penny.videogen-asset-intent.v1",
        schema_version: 1,
        asset_id: "asset",
        purpose: "first_frame",
        story_ref: story,
        source: method === "fresh" ? "imagegen_fresh" : "imagegen_revision",
        input_refs: method === "fresh" ? [] : [source, ...(method === "mask" ? [mask] : [])],
        allowed_change: "Make the selected area white",
        preserve_criteria: ["Preserve source geometry outside the edit"],
        consent_ref: consent,
        rights_ref: rights,
        estimated_meters: [
          { meter: "attempts", reserved: child?.imageRuns.length ?? 1 },
          { meter: "cost_microcredits", reserved: 5 * (child?.imageRuns.length ?? 1) },
        ],
        attempt_limit: child?.imageRuns.length ?? 1,
        scope_status: "proposed",
      },
      FOUNDATION_LIMITS
    );
    const intentRef = this.ref(intent, intent.schema_id);
    let asset = validateImageAssetRequest({
      schema_id: "penny.image-asset-request.v1",
      schema_version: 1,
      intent_ref: intentRef,
      call_index: 1,
      input:
        method === "fresh"
          ? { kind: "fresh" }
          : {
              kind: "revision",
              source_ref: source,
              area:
                method === "whole"
                  ? { kind: "whole" }
                  : method === "mask"
                    ? { kind: "mask", mask_ref: mask }
                    : { kind: "rectangle", x: 0, y: 0, width: 1, height: 1 },
            },
    });
    if (alter !== undefined) asset = alter(asset);
    const call = validateSkillSchema(
      ImageAssetCallV1Schema,
      {
        schema_id: "penny.image-asset-call.v1",
        schema_version: 1,
        asset,
        image_run_id: this.imageRun,
        profile_sha256: profile.profile_sha256,
        max_renders: 1,
        cost_microcredits: 5,
      },
      "fixture call"
    );
    const callRef = this.ref(call, call.schema_id);
    const additionalCalls = (child?.imageRuns.slice(1) ?? []).map((runId, index) =>
      this.ref(
        {
          ...call,
          image_run_id: runId,
          asset: { ...asset, call_index: index + 2 },
        },
        call.schema_id
      )
    );
    const packet: GatePacketV1 = {
      schema_id: "penny.videogen-gate-packet.v1",
      schema_version: 1,
      run_id: this.parentRun,
      challenge: "current-g1",
      producer_state: "g1",
      presented: [
        { role: "story", ref: story, revision: 1 },
        { role: "asset-intent", ref: intentRef, revision: 1 },
        { role: "image-asset-call", ref: callRef, revision: 1 },
        ...additionalCalls.map((ref) => ({ role: "image-asset-call", ref, revision: 1 })),
      ],
      prior_decisions: [],
      change_summary: "fixture bounded preview",
      affected_shot_ids: [],
      limitations: ["offline protocol only"],
      rights_refs: [rights],
      review_evidence_refs: [],
      questions: ["Approve fixture?"],
      kind: "approval",
      gate_id: "G1",
      effect_scope: {
        kinds: ["child_imagegen"],
        subject_ids: ["asset"],
        meters: [
          { meter: "attempts", limit: child?.imageRuns.length ?? 1 },
          { meter: "cost_microcredits", limit: 5 * (child?.imageRuns.length ?? 1) },
        ],
      },
      choices: ["approve", "refine", "deny"],
    };
    const packetRef = this.ref(packet, packet.schema_id);
    const gate: GateBindingHostV1 = {
      store: this.store,
      checkpointer: this.checkpointer,
      project_id: this.projectId,
      run_id: this.parentRun,
      limits: FOUNDATION_LIMITS,
      admitted_destination_id: "fixture",
      current_presented: packet.presented,
      current_approvals: this.approvals,
    };
    const identity: RunIdentity = {
      schema_version: 2,
      run_id: this.parentRun,
      session_id: "fixture-parent",
      playbook: "image-reference-gate-fixture",
      engine_owner: "typescript",
    };
    const core: PlaybookCore = {
      initialize: (ctx: RunContext) => {
        initializeVideogenOwnerSelection(ctx, {
          project_id: this.projectId,
          limits: FOUNDATION_LIMITS,
          admitted_destination_id: "fixture",
          territory: "fixture",
        });
        selectVideogenRights(ctx, this.rights);
        checkGatePacket(gate, packet);
        ctx.transition("g1");
        ctx.status = "awaiting_user";
        ctx.selectedArtifacts = [packetRef, ...packet.presented.map((x) => x.ref)];
        const d = validateDirective({
          schema_version: 2,
          action: "await_user",
          identity: ctx.identity,
          state_id: "g1",
          gate_id: "g1-engine",
          challenge: packet.challenge,
          payload_digest: packetRef.content_digest,
          questions: [{ id: "approve", prompt: "Fixture approval" }],
        });
        ctx.pendingDirective = d;
        return d;
      },
      dispatch: (ctx) => {
        if (child !== undefined) return child.dispatch(ctx, asset);
        if (ctx.pendingDirective === null) throw new Error("fixture pending missing");
        return ctx.pendingDirective;
      },
      resume: (ctx: RunContext, response: JsonValue) => {
        const decisionRef = this.ref(response, "penny.videogen-gate-decision.v1");
        const approved: AssetIntentV1 = {
          ...intent,
          scope_status: "approved",
          gate_scope_ref: decisionRef,
        };
        const approvedRef = this.ref(approved, approved.schema_id);
        this.approved.push(approvedRef);
        ctx.selectedArtifacts.push(decisionRef, approvedRef);
        ctx.status = "running";
        ctx.transition("asset_prepare");
        const d = validateDirective({
          schema_version: 2,
          action: "status",
          identity: ctx.identity,
          status: ctx.status,
          state_id: ctx.stateId,
          terminal: false,
          met: false,
        });
        ctx.pendingDirective = d;
        return child === undefined ? d : child.dispatch(ctx, asset);
      },
      cancel: (ctx, reason) => {
        const terminal = validateDirective({
          schema_version: 2,
          action: "cancelled",
          identity: ctx.identity,
          status: "cancelled",
          met: false,
          result: { reason },
          artifacts: ctx.selectedArtifacts,
          unresolved: [reason],
        });
        ctx.status = "cancelled";
        ctx.met = false;
        ctx.pendingDirective = terminal;
        ctx.terminalDirective = terminal;
        return terminal;
      },
      acceptSummary: () => {
        throw new Error("no fixture worker");
      },
      rebindPendingDirective: (ctx) => ctx.pendingDirective,
    };
    const contract = {
      ...RESEARCH_SKILL_CONTRACT,
      name: identity.playbook,
      repair_routing: { schema_version: 1 as const, routes: [] },
      completion_gate: {
        ...RESEARCH_SKILL_CONTRACT.completion_gate,
        schema_version: 2 as const,
        allowed_terminal_origins: ["asset_prepare"],
        required_visited_states: [],
        required_receipt_predicates: [],
        unresolved_policy: { mode: "max_count" as const, max_count: 0 },
      },
    };
    const registration: PlaybookRegistration = {
      name: identity.playbook,
      ...(child === undefined ? {} : { imagegen_child: child.policy }),
      contract,
      ingress: "dedicated_tool",
      liveness: {
        resolver_id: contract.budget_policy.resolver_id,
        resolve: () => undefined,
        thinking_policy: "agent_ssot",
      },
      worker: {
        kind: "none",
        workflow_name: identity.playbook,
        guidance: contract.guidance,
        guidance_required: true,
        result_transport: "host_typed",
        opening_policy: "none",
        model_policy: "none",
        phases: new Map<string, never>(),
      },
      completionReceiptPredicates: new Map(),
      construct: () => core,
    };
    const engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 200,
      receiptAuthority: this.receipts,
      artifactStore: this.store,
      artifactReader: this.store,
      playbookRegistry: new Map([[registration.name, registration]]),
      playbookName: registration.name,
    });
    let started = engine.handle({
      schema_version: 2,
      action: "start",
      identity,
      goal: "fixture current approval",
      constraints: {},
      project_root: this.root,
      trust_profile: "trusted-interactive",
    });
    if (started.action === "await_user" && started.gate_id === "completion_checkpoint")
      started = engine.handle({
        schema_version: 2,
        action: "respond",
        identity,
        gate_id: started.gate_id,
        challenge: started.challenge,
        response: "fixture only",
      });
    if (started.action !== "await_user") throw new Error("G1 fixture did not wait");
    const decision = constructGateDecision(packet, packetRef, "approve", FOUNDATION_LIMITS);
    engine.handle({
      schema_version: 2,
      action: "respond",
      identity,
      gate_id: started.gate_id,
      challenge: started.challenge,
      response: decision,
    });
    const decisionRef = this.checkpointer
      .loadRunById(this.parentRun)
      ?.selectedArtifacts.find((x) => x.content_schema?.schema_id === decision.schema_id);
    if (decisionRef === undefined) throw new Error("committed fixture decision missing");
    this.approvals.push({
      gate_id: "G1",
      engine_gate_id: "g1-engine",
      challenge: packet.challenge,
      packet_ref: packetRef,
      decision_ref: decisionRef,
    });
    const authorityHost = () => ({
      gate: { ...gate, store: this.store, checkpointer: this.checkpointer },
      rights: {
        store: this.store,
        project_id: this.projectId,
        run_id: this.parentRun,
        limits: FOUNDATION_LIMITS,
        now_utc: new Date().toISOString(),
        territory: "fixture",
        current_rights: this.rights,
        cross_run_edges: [],
      },
      approved_intent_refs: this.approved,
    });
    const owner = () =>
      new VideogenOwnerSelection({
        store: this.store,
        checkpointer: this.checkpointer,
        project_id: this.projectId,
        run_id: this.parentRun,
      });
    const authority = () => new ImageAssetAuthority(owner());
    return {
      asset,
      source,
      mask,
      intent,
      intentRef,
      authority,
      authorityHost,
      owner,
      gate,
      callRef,
      registration,
      identity,
    };
  }
  commitRights() {
    const ctx = this.checkpointer.loadRunById(this.parentRun);
    if (ctx === null || ctx === undefined) throw new Error("owner fixture missing");
    selectVideogenRights(ctx, this.rights);
    this.checkpointer.saveRun(ctx, "fixture_rights_selected", {});
  }
  revokeApproval() {
    const refs = this.approvals.splice(0).flatMap((x) => [x.packet_ref, x.decision_ref]);
    this.removeSelections(refs);
  }
  revokeApprovedIntents() {
    this.removeSelections(this.approved.splice(0));
  }
  private removeSelections(refs: readonly ArtifactRef[]) {
    const ctx = this.checkpointer.loadRunById(this.parentRun);
    if (ctx === null || ctx === undefined) throw new Error("owner fixture missing");
    ctx.selectedArtifacts = ctx.selectedArtifacts.filter(
      (x) => !refs.some((y) => y.artifact_id === x.artifact_id)
    );
    this.checkpointer.saveRun(ctx, "fixture_selections_removed", {});
  }
  reopen() {
    this.store.close();
    this.checkpointer.close();
    this.store = new ArtifactStore(join(this.root, "artifacts"), { projectId: this.projectId });
    this.checkpointer = new Checkpointer(join(this.root, "control.db"), undefined, {
      projectId: this.projectId,
    });
  }
  async runtime(
    profile: ImagegenProfileV1,
    assets: ImageAssetAuthority,
    fault?: HostOperationRuntimeOwnerOptions["fault"]
  ) {
    const profiles = new StaticImagegenProfileRegistry({
      profiles: [profile],
      approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
      node_class_policies: [
        ...SYNTHETIC_NODE_POLICIES,
        ...(profile.revision_capability === undefined ? [] : [inputPolicy]),
      ],
      default_profile_id: profile.profile_id,
      worker_identities: new ComfyWorkerIdentityRegistry([
        { worker_id: "fixture-physical-worker", endpoints: [profile.endpoint] },
      ]),
      approved_revision_sha256_by_profile_id:
        profile.revision_capability === undefined
          ? new Map()
          : new Map([[profile.profile_id, sha256(canonicalJson(profile.revision_capability))]]),
    });
    const storage = new SqliteImagegenStorageAdmission({
      directory: join(this.root, "storage"),
      ceiling_bytes: 64 * 1024 * 1024,
      warning_threshold_bytes: 48 * 1024 * 1024,
    });
    const activation = new SqliteImagegenActivationController({
      directory: join(this.root, "activation"),
      mode: "enabled",
    });
    const providers = {
      profiles,
      storage,
      activation,
      exports: new StaticImagegenExportRegistry([]),
      assets,
    };
    const engine = new OrchestrationEngine(this.checkpointer, {
      projectRoot: this.root,
      maxSteps: 100,
      receiptAuthority: this.receipts,
      artifactStore: this.store,
      artifactReader: this.store,
      artifactRevisions: this.store,
      playbookRegistration: IMAGEGEN_PLAYBOOK_REGISTRATION,
      imagegen: providers,
    });
    const leases = new HostOperationLeaseAuthority(this.stateRoot),
      generation = new ComfyImagegenOperationAdapter({
        profiles,
        storage,
        assets,
        cache_results: true,
      }),
      readiness = new ComfyImagegenReadinessAdapter({ profiles, assets, cache_results: true });
    let upload: ImageInputUploadAdapter;
    try {
      upload = new ImageInputUploadAdapter({ profiles, assets, storage });
    } catch (error) {
      leases.close();
      storage.close();
      activation.close();
      throw error;
    }
    const cache = await FileHostOperationResultCache.provision(join(this.root, "cache"));
    const owner = new HostOperationRuntimeOwner({
      projectId: this.projectId,
      checkpointer: this.checkpointer,
      artifacts: this.store,
      leaseAuthority: leases,
      adapters: new Map<string, HostOperationAdapterV1>([
        [generation.adapter_id, generation],
        [readiness.adapter_id, readiness],
        [upload.adapter_id, upload],
      ]),
      ...(fault === undefined ? {} : { fault }),
      resultCache: cache,
    });
    const model = new DeterministicImagegenSmokeModel();
    const run = model.runAgent.bind(model);
    model.runAgent = async (invocation) => {
      const completion = await run(invocation);
      if (["vera", "carren"].includes(invocation.agent)) {
        const ctx = this.checkpointer.loadRunById(this.imageRun),
          state = ctx?.playbookData;
        const request =
          state !== undefined &&
          state !== null &&
          typeof state === "object" &&
          !Array.isArray(state)
            ? state.request
            : undefined;
        if (
          request !== undefined &&
          request !== null &&
          typeof request === "object" &&
          !Array.isArray(request) &&
          request.asset !== undefined
        ) {
          const asset = validateImageAssetRequest(request.asset);
          if (asset.input.kind === "revision") {
            const intent = validateAssetIntent(
              JSON.parse(this.store.read(asset.intent_ref).toString()),
              FOUNDATION_LIMITS
            );
            const parsed: unknown = JSON.parse(completion.text.slice("SUMMARY:".length));
            if (
              parsed === null ||
              typeof parsed !== "object" ||
              !("report" in parsed) ||
              parsed.report === null ||
              typeof parsed.report !== "object"
            )
              throw new Error("fixture critic report missing");
            return {
              ...completion,
              text:
                "SUMMARY:" +
                canonicalJson({
                  ...parsed,
                  report: {
                    ...parsed.report,
                    revision_review: {
                      allowed_change: {
                        criterion: intent.allowed_change,
                        verdict: "pass",
                        observation: "Deterministic fixture only, not visual qualification",
                      },
                      preserve_criteria: intent.preserve_criteria.map((criterion) => ({
                        criterion,
                        verdict: "pass",
                        observation: "Deterministic fixture only",
                      })),
                    },
                  },
                }),
            };
          }
        }
      }
      return completion;
    };
    const workers = new WorkerExecutor(model, this.store, {
      projectRoot: this.root,
      parallelConcurrency: 2,
      registration: IMAGEGEN_PLAYBOOK_REGISTRATION,
    });
    const runner = new OrchestrationRunner(engine, workers, undefined, owner);
    const identity: RunIdentity = {
      schema_version: 2,
      run_id: this.imageRun,
      session_id: "reference-image-session",
      playbook: "imagegen",
      engine_owner: "typescript",
    };
    return {
      engine,
      runner,
      owner,
      providers,
      model,
      identity,
      start: (asset: ImageAssetRequestV1): Directive =>
        engine.handle({
          schema_version: 2,
          action: "start",
          identity,
          goal: "calm blue geometric forms",
          constraints: {
            schema_version: 1,
            count: 1,
            seed: 42,
            max_revision_rounds: 0,
            raw_prompt: "calm blue geometric forms",
            asset,
          },
          project_root: this.root,
          trust_profile: "hardened-untrusted",
        }),
      close() {
        leases.close();
        storage.close();
        activation.close();
      },
    };
  }
  [Symbol.dispose]() {
    this.store.close();
    this.checkpointer.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
