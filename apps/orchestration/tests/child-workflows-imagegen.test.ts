import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { Checkpointer } from "../dist/checkpointer.js";
import { ProjectRetentionOwner } from "../dist/catalog-session-retention.js";
import { CATALOG_WORKER_SESSION_METADATA } from "../dist/model-client.js";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../dist/canonical-json.js";
import { validateDirective, type RunIdentity } from "../dist/contracts.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { ChildWorkflowRuntimeOwner } from "../dist/child-workflows/owner.js";
import { ImagegenChildRuntimeAuthority } from "../dist/child-workflows/imagegen.js";
import {
  IMAGEGEN_CHILD_OUTPUT,
  type ImagegenChildPolicyV1,
} from "../dist/child-workflows/imagegen-policy.js";
import {
  validateChildWorkflowRequest,
  childWorkflowCallId,
  childWorkflowRunIdentity,
} from "../dist/child-workflows/contracts.js";
import { childExecutionProgressLeaseBinding } from "../dist/liveness-profiles.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../dist/playbooks/imagegen.js";
import { runtimeRegistrationSha256 } from "../dist/playbooks/runtime-registration-digest.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import { validateCanonicalPng } from "../dist/png-media.js";
import { ImageAssetResultV1Schema } from "../dist/imagegen/reference-contracts.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  ControlledFixture,
  controlledHttp,
  controlledProfile,
} from "./helpers/imagegen-controlled-fixture.js";

function identities(parent: RunIdentity, count: number) {
  return Array.from({ length: count }, (_, index) =>
    childWorkflowRunIdentity({
      call_id: childWorkflowCallId({
        parent_run_id: parent.run_id,
        parent_state_id: "asset_prepare",
        call_key: `image-${index + 1}`,
      }),
      parent,
      child_name: "imagegen",
    })
  );
}

async function fixture(
  options: {
    total?: number;
    cap?: number;
    method?: "fresh" | "rectangle";
    ambiguous?: boolean;
    noAdapter?: boolean;
    providerDigest?: string;
    adapterTransform?: (
      adapter: ImagegenChildRuntimeAuthority,
      host: ConstructorParameters<typeof ImagegenChildRuntimeAuthority>[0]
    ) => ImagegenChildRuntimeAuthority;
  } = {}
) {
  const method = options.method ?? "fresh";
  const http = await controlledHttp(method !== "fresh");
  if (options.ambiguous) http.ambiguousSubmission();
  const parentIdentity: RunIdentity = {
    schema_version: 2,
    run_id: "reference-parent",
    session_id: "fixture-parent",
    playbook: "image-reference-gate-fixture",
    engine_owner: "typescript",
  };
  const children = identities(parentIdentity, 3);
  const first = children[0];
  if (first === undefined) throw new Error("missing first identity");
  const f = new ControlledFixture({ imageRun: first.run_id });
  try {
    const profile = controlledProfile(http.port, method);
    const policy: ImagegenChildPolicyV1 = {
      schema_version: 1,
      authorization_id: "operator.controlled-imagegen-child.v1",
      max_nesting_depth: 1,
      max_active_children: 1,
      max_calls: options.cap ?? 2,
      project_concurrency_limit: 1,
      asset_ids: ["asset"],
      parent_states: ["asset_prepare"],
      provider_registration_sha256:
        options.providerDigest ?? runtimeRegistrationSha256(IMAGEGEN_PLAYBOOK_REGISTRATION),
      progress_lease: childExecutionProgressLeaseBinding(),
    };
    const authorized = f.authorize(profile, method, undefined, {
      policy,
      imageRuns: children.slice(0, 2).map((x) => x.run_id),
      dispatch: (context, original) => {
        const count = context.selectedArtifacts.filter((ref) => ref.kind === "child-result").length;
        if (count >= (options.total ?? 2)) {
          const terminal = validateDirective({
            schema_version: 2,
            action: "incomplete",
            identity: context.identity,
            status: "incomplete",
            met: false,
            result: { imported_images: count },
            artifacts: context.selectedArtifacts,
            unresolved: ["Provider-free child fixture is not a videogen production."],
          });
          context.status = "incomplete";
          context.met = false;
          context.pendingDirective = terminal;
          context.terminalDirective = terminal;
          return terminal;
        }
        const asset = { ...original, call_index: count + 1 };
        const binding = {
          schema_version: 1,
          project_id: f.projectId,
          principal_id: "fixture",
          scope_id: "g1",
          source_policy_id: "fixture-source",
          destination_policy_id: "no-export",
        };
        const request = {
          schema_id: "penny.child-workflow-request.v1",
          schema_version: 1,
          child_name: "imagegen",
          provider_request_schema_id: "penny.imagegen-request.v1",
          provider_request_schema_version: 1,
          provider_request: {
            schema_id: "penny.imagegen-request.v1",
            schema_version: 1,
            goal: "calm blue geometric forms",
            profile_id: profile.profile_id,
            count: 1,
            seed: 42,
            max_revision_rounds: 0,
            raw_prompt: "calm blue geometric forms",
            dimensions: null,
            export: null,
            asset,
          },
          policy_binding: binding,
        };
        const operationId = `image-request-${count + 1}`;
        const requestRef =
          f.store.refFor(
            context.identity.run_id,
            context.stateId,
            null,
            "child-request",
            operationId,
            1
          ) ??
          f.store.persist({
            metadata: {
              schema_version: 2,
              run_id: context.identity.run_id,
              phase: context.stateId,
              branch_id: null,
              kind: "child-request",
              operation_id: operationId,
              version: 1,
              producer: "host:fixture",
              media_type: "application/json",
              content_schema: { schema_id: request.schema_id, schema_version: 1 },
              parent_ref: null,
              upstream_refs: [asset.intent_ref],
            },
            content: canonicalJson(request),
          });
        const next = validateDirective({
          schema_version: 3,
          action: "invoke_child_workflow",
          identity: context.identity,
          state_id: context.stateId,
          call_key: `image-${count + 1}`,
          child_name: "imagegen",
          request_ref: requestRef,
          input_artifacts: {
            schema_version: 2,
            artifacts:
              asset.input.kind === "fresh"
                ? []
                : [
                    { slot: "source_png", ref: asset.input.source_ref },
                    ...(asset.input.area.kind === "mask"
                      ? [{ slot: "mask_png", ref: asset.input.area.mask_ref }]
                      : []),
                  ],
          },
          expected_output: IMAGEGEN_CHILD_OUTPUT,
          policy_binding: binding,
          progress_lease: policy.progress_lease,
        });
        context.pendingDirective = next;
        return next;
      },
    });
    let runtime = await f.runtime(profile, authorized.authority());
    let starts = 0;
    let adapter: ImagegenChildRuntimeAuthority | undefined;
    function compose() {
      const registry = new Map([
        [authorized.registration.name, authorized.registration],
        ["imagegen", IMAGEGEN_PLAYBOOK_REGISTRATION],
      ]);
      const parentEngine = new OrchestrationEngine(f.checkpointer, {
        projectRoot: f.root,
        maxSteps: 100,
        receiptAuthority: f.receipts,
        artifactStore: f.store,
        artifactReader: f.store,
        artifactRevisions: f.store,
        playbookRegistration: authorized.registration,
        playbookRegistry: registry,
      });
      const adapterHost = {
        artifacts: f.store,
        checkpointer: f.checkpointer,
        providers: runtime.providers,
      };
      const concrete = new ImagegenChildRuntimeAuthority(adapterHost);
      adapter = options.adapterTransform?.(concrete, adapterHost) ?? concrete;
      const owner = new ChildWorkflowRuntimeOwner({
        checkpointer: f.checkpointer,
        artifacts: f.store,
        registry,
        projectRoot: f.root,
        executionEnabled: true,
        ...(options.noAdapter
          ? {}
          : {
              imagegenChildren: adapter,
            }),
        engines: {
          create: ({ registration, maxSteps }) => {
            const engine = new OrchestrationEngine(f.checkpointer, {
              projectRoot: f.root,
              maxSteps: maxSteps ?? 100,
              receiptAuthority: f.receipts,
              artifactStore: f.store,
              artifactReader: f.store,
              artifactRevisions: f.store,
              playbookRegistration: registration,
              playbookRegistry: registry,
              imagegen: runtime.providers,
            });
            const start = engine.startReservedChild.bind(engine);
            engine.startReservedChild = (...args) => {
              starts += 1;
              return start(...args);
            };
            return {
              engine,
              maxSteps: maxSteps ?? 100,
              runner: new OrchestrationRunner(
                engine,
                new WorkerExecutor(runtime.model, f.store, {
                  projectRoot: f.root,
                  parallelConcurrency: 2,
                  registration,
                }),
                undefined,
                runtime.owner
              ),
            };
          },
        },
      });
      const runner = new OrchestrationRunner(
        parentEngine,
        new WorkerExecutor(runtime.model, f.store, {
          projectRoot: f.root,
          parallelConcurrency: 2,
          registration: authorized.registration,
        }),
        owner
      );
      return { engine: parentEngine, runner, owner };
    }
    let current = compose();
    return {
      f,
      http,
      authorized,
      children,
      policy,
      engine: () => current.engine,
      adapter: () => {
        if (adapter === undefined) throw new Error("adapter missing");
        return adapter;
      },
      starts: () => starts,
      cancel: () =>
        current.engine.handle({
          schema_version: 2,
          action: "cancel",
          identity: authorized.identity,
          reason: "fixture cancel",
        }),
      run: async () =>
        current.runner.runUntilBoundary(
          current.engine.handle({
            schema_version: 2,
            action: "recover",
            identity: authorized.identity,
          })
        ),
      async reopen() {
        runtime.close();
        f.reopen();
        runtime = await f.runtime(profile, authorized.authority());
        current = compose();
      },
      async close() {
        runtime.close();
        f[Symbol.dispose]();
        await http.close();
      },
    };
  } catch (error) {
    f[Symbol.dispose]();
    await http.close();
    throw error;
  }
}

describe("explicit controlled imagegen child adapter", () => {
  it.each([{ noAdapter: true }, { providerDigest: "a".repeat(64) }])(
    "requires concrete opt-in and the exact registered child digest: %j",
    async (options) => {
      const x = await fixture(options);
      try {
        await expect(x.run()).rejects.toThrow(
          /construction-bound adapter|registration.*unauthorized/u
        );
        expect(x.starts()).toBe(0);
        expect(x.http.submissions).toHaveLength(0);
        expect(
          x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)
        ).toHaveLength(0);
      } finally {
        await x.close();
      }
    }
  );

  it("keeps a terminal parent/child cohort pinned while a consumed host effect is quarantined", async () => {
    const x = await fixture({ total: 1, ambiguous: true });
    try {
      expect(await x.run()).toMatchObject({ action: "incomplete", met: false });
      const call = x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0];
      if (call === undefined) throw new Error("child missing");
      const effects = x.f.checkpointer.hostOperationCallsForRun(call.child_identity.run_id);
      expect(
        effects.some(
          (effect) =>
            effect.lifecycle === "consumed" &&
            effect.disposition?.lease_disposition === "quarantined"
        )
      ).toBe(true);
      using pin = new Checkpointer(join(x.f.root, "control.db"), undefined, {
        projectId: x.f.projectId,
        maxRetainedRuns: 0,
      });
      expect(pin.pruneTerminalRuns()).toEqual([]);
      await x.reopen();
      expect(pin.pruneTerminalRuns()).toEqual([]);
      expect(x.http.submissions).toHaveLength(1);
      expect(x.starts()).toBe(1);
    } finally {
      await x.close();
    }
  });

  it("imports two serial native reviewed PNGs through the real child/host owners", async () => {
    const x = await fixture();
    try {
      expect(await x.run()).toMatchObject({ action: "incomplete", result: { imported_images: 2 } });
      expect(x.starts()).toBe(2);
      expect(x.http.submissions).toHaveLength(2);
      const calls = x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id);
      expect(calls.map((call) => call.lifecycle)).toEqual(["consumed", "consumed"]);
      const parent = x.f.checkpointer.loadRun(x.authorized.identity);
      for (const call of calls) {
        if (call.output_artifact === null) throw new Error("child result missing");
        const value = validateSkillSchema(
          ImageAssetResultV1Schema,
          JSON.parse(x.f.store.read(call.output_artifact).toString("utf8")),
          "asset result"
        );
        expect(value.origin).toBe("fresh");
        validateCanonicalPng(x.f.store.read(value.png_ref));
        expect(value.png_ref.run_id).toBe(call.child_identity.run_id);
        expect(parent.selectedArtifacts).toEqual(
          expect.arrayContaining([value.png_ref, value.validity_ref, value.quality_ref])
        );
        expect(value.render_receipt_ref).not.toBeNull();
      }
    } finally {
      await x.close();
    }
  });

  it("imports the controlled-revision native port with source, mask, raw, operation and dual-review lineage", async () => {
    const x = await fixture({ total: 1, method: "rectangle" });
    try {
      expect(await x.run()).toMatchObject({ action: "incomplete", result: { imported_images: 1 } });
      const call = x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0];
      if (call?.output_artifact === null || call?.output_artifact === undefined)
        throw new Error("missing revision result");
      const result = validateSkillSchema(
        ImageAssetResultV1Schema,
        JSON.parse(x.f.store.read(call.output_artifact).toString("utf8")),
        "revision result"
      );
      expect(result).toMatchObject({ origin: "revision" });
      for (const ref of [
        result.source_ref,
        result.mask_ref,
        result.raw_ref,
        result.transformation_ref,
        result.render_receipt_ref,
        result.validity_ref,
        result.quality_ref,
      ]) {
        expect(ref).not.toBeNull();
        if (ref !== null)
          expect(x.f.checkpointer.loadRun(x.authorized.identity).selectedArtifacts).toContainEqual(
            ref
          );
      }
      expect(result.upload_refs).toHaveLength(2);
      expect(x.http.submissions).toHaveLength(1);
    } finally {
      await x.close();
    }
  });

  it("does not consume a captured child after its G1 rights are revoked", async () => {
    const x = await fixture();
    try {
      const crash = vi
        .spyOn(x.f.checkpointer, "consumeChildWorkflowCall")
        .mockImplementationOnce(() => {
          throw new Error("injected before consume");
        });
      await expect(x.run()).rejects.toThrow(/injected before consume/u);
      crash.mockRestore();
      x.f.rights.splice(0);
      x.f.commitRights();
      await expect(x.run()).rejects.toThrow(/current rights missing/u);
      expect(x.starts()).toBe(1);
      expect(x.http.submissions).toHaveLength(1);
      expect(
        x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0]?.lifecycle
      ).toBe("terminal_recorded");
      expect(
        x.f.checkpointer
          .loadRun(x.authorized.identity)
          .selectedArtifacts.filter((ref) => ref.kind === "child-result")
      ).toHaveLength(0);
    } finally {
      await x.close();
    }
  });

  it.each([2, 3])(
    "refuses an unauthorized third call before child start/effect (registered allowance %i)",
    async (cap) => {
      const x = await fixture({ total: 3, cap });
      try {
        await expect(x.run()).rejects.toThrow(
          cap === 2 ? /call allowance/u : /unapproved image call/u
        );
        expect(x.starts()).toBe(2);
        expect(x.http.submissions).toHaveLength(2);
        expect(
          x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)
        ).toHaveLength(2);
        const third = x.children[2];
        if (third === undefined) throw new Error("third ID missing");
        expect(x.f.checkpointer.runExists(third.run_id)).toBe(false);
      } finally {
        await x.close();
      }
    }
  );

  it("pins a live child/session cohort and eventually evicts the whole settled control/session cohort atomically", async () => {
    const x = await fixture();
    try {
      const crash = vi
        .spyOn(x.f.checkpointer, "consumeChildWorkflowCall")
        .mockImplementationOnce(() => {
          throw new Error("injected before consume");
        });
      await expect(x.run()).rejects.toThrow(/injected before consume/u);
      crash.mockRestore();
      const sessionRoot = join(x.f.root, "cohort-sessions");
      const agent = "vera";
      mkdirSync(join(sessionRoot, agent), { recursive: true, mode: 0o700 });
      const ids = [
        x.authorized.identity.run_id,
        ...x.children.slice(0, 2).map((identity) => identity.run_id),
      ];
      const files = ids.map((runId) => {
        const file = join(sessionRoot, agent, `${runId}.jsonl`);
        const timestamp = "2026-10-16T00:00:00.000Z";
        writeFileSync(
          file,
          `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: runId, timestamp, cwd: x.f.root })}\n${JSON.stringify(
            {
              type: "custom",
              customType: CATALOG_WORKER_SESSION_METADATA,
              id: `entry-${runId}`,
              parentId: null,
              timestamp,
              data: {
                schema_version: 1,
                project_id: x.f.projectId,
                run_id: runId,
                workflow_session_id: "fixture-parent",
                state_id: "verifying_images",
                branch_id: null,
                attempt: 1,
                worker_id: `worker-${runId}`,
                agent,
                purpose: "phase",
              },
            }
          )}\n`,
          { mode: 0o600 }
        );
        return file;
      });
      // The future child joins the durable cohort only when its second call starts.
      const futureFile = files.pop();
      const futureId = ids.pop();
      if (futureFile === undefined || futureId === undefined)
        throw new Error("future child session missing");
      // Pinning uses existing control rows, not session-name discovery or extra persistence.
      using pin = new Checkpointer(join(x.f.root, "control.db"), undefined, {
        projectId: x.f.projectId,
        maxRetainedRuns: 0,
      });
      expect(pin.pruneTerminalRuns()).toEqual([]);
      expect(files.every((file) => existsSync(file))).toBe(true);
      await x.reopen();
      expect(await x.run()).toMatchObject({ action: "incomplete", result: { imported_images: 2 } });
      const calls = x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id);
      const output = calls[0]?.output_artifact;
      if (output === null || output === undefined) throw new Error("retained output missing");
      const retainedBytes = x.f.store.read(output);
      const result = new ProjectRetentionOwner(pin, {
        projectId: x.f.projectId,
        sessionRoot,
      }).run();
      expect(new Set(result.evictedRunIds)).toEqual(new Set([...ids, futureId]));
      expect(result.removedSessionFiles).toBe(3);
      expect([...files, futureFile].every((file) => !existsSync(file))).toBe(true);
      for (const id of [...ids, futureId]) expect(pin.hasRunById(id)).toBe(false);
      expect(x.f.store.read(output)).toEqual(retainedBytes);
    } finally {
      await x.close();
    }
  });

  it.each(["G1", "rights", "approved-intent"] as const)(
    "does not resurrect %s revoked between native import preparation and consume",
    async (loss) => {
      const x = await fixture();
      try {
        const consume = x.f.checkpointer.consumeChildWorkflowCall.bind(x.f.checkpointer);
        const fault = vi
          .spyOn(x.f.checkpointer, "consumeChildWorkflowCall")
          .mockImplementationOnce((input) => {
            if (loss === "G1") x.f.revokeApproval();
            else if (loss === "approved-intent") x.f.revokeApprovedIntents();
            else {
              x.f.rights.splice(0);
              x.f.commitRights();
            }
            return consume(input);
          });
        await expect(x.run()).rejects.toThrow(/parent selections/u);
        fault.mockRestore();
        expect(x.starts()).toBe(1);
        expect(x.http.submissions).toHaveLength(1);
        await x.reopen();
        await expect(x.run()).rejects.toThrow();
        expect(x.starts()).toBe(1);
        expect(x.http.submissions).toHaveLength(1);
        expect(
          x.f.checkpointer
            .events(x.authorized.identity.run_id)
            .filter((event) => event.eventType === "child_workflow_consumed")
        ).toHaveLength(0);
      } finally {
        await x.close();
      }
    }
  );

  it("fences cancellation between prepared continuation and atomic consume, then safely evicts the settled cancelled cohort", async () => {
    const x = await fixture();
    try {
      const consume = x.f.checkpointer.consumeChildWorkflowCall.bind(x.f.checkpointer);
      const fault = vi
        .spyOn(x.f.checkpointer, "consumeChildWorkflowCall")
        .mockImplementationOnce((input) => {
          expect(x.cancel()).toMatchObject({ action: "cancelled" });
          return consume(input);
        });
      await expect(x.run()).rejects.toThrow(/pending parent|exact pending/u);
      fault.mockRestore();
      expect(x.f.checkpointer.loadRun(x.authorized.identity).status).toBe("cancelled");
      expect(x.starts()).toBe(1);
      expect(x.http.submissions).toHaveLength(1);
      await x.reopen();
      expect(await x.run()).toMatchObject({ action: "cancelled", met: false });
      expect(x.starts()).toBe(1);
      expect(
        x.f.checkpointer
          .events(x.authorized.identity.run_id)
          .filter((event) => event.eventType === "child_workflow_consumed")
      ).toHaveLength(0);
      using retention = new Checkpointer(join(x.f.root, "control.db"), undefined, {
        projectId: x.f.projectId,
        maxRetainedRuns: 0,
      });
      expect(retention.pruneTerminalRuns()).toHaveLength(2);
    } finally {
      await x.close();
    }
  });

  it.each(["before_result", "before_record"] as const)(
    "recovers a durable child terminal after a %s capture crash without repeating the effect",
    async (boundary) => {
      const x = await fixture();
      try {
        const persist = x.f.store.persist.bind(x.f.store);
        const transition = x.f.checkpointer.transitionChildWorkflowCall.bind(x.f.checkpointer);
        const resultFault = vi.spyOn(x.f.store, "persist").mockImplementation((input) => {
          if (boundary === "before_result" && input.metadata.kind === "child-result")
            throw new Error("injected before result capture");
          return persist(input);
        });
        const recordFault = vi
          .spyOn(x.f.checkpointer, "transitionChildWorkflowCall")
          .mockImplementation((input) => {
            if (boundary === "before_record" && input.next.lifecycle === "terminal_recorded")
              throw new Error("injected before record capture");
            return transition(input);
          });
        await expect(x.run()).rejects.toThrow(/injected before (?:result|record) capture/u);
        resultFault.mockRestore();
        recordFault.mockRestore();
        const call = x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0];
        if (call === undefined) throw new Error("missing interrupted child");
        expect(call.lifecycle).toBe("running");
        expect(x.f.checkpointer.loadRun(call.child_identity).terminalDirective?.action).toBe(
          "complete"
        );
        expect(x.starts()).toBe(1);
        expect(x.http.submissions).toHaveLength(1);
        await x.reopen();
        expect(await x.run()).toMatchObject({
          action: "incomplete",
          result: { imported_images: 2 },
        });
        expect(x.starts()).toBe(2);
        expect(x.http.submissions).toHaveLength(2);
        const parent = x.f.checkpointer.loadRun(x.authorized.identity);
        const results = parent.selectedArtifacts.filter((ref) => ref.kind === "child-result");
        expect(results).toHaveLength(2);
        expect(new Set(results.map((ref) => ref.artifact_id)).size).toBe(2);
        expect(
          x.f.checkpointer
            .events(x.authorized.identity.run_id)
            .filter((event) => event.eventType === "child_workflow_consumed")
        ).toHaveLength(2);
      } finally {
        await x.close();
      }
    }
  );

  it("adopts a captured terminal after reopen without another child start or remote submission", async () => {
    const x = await fixture();
    try {
      const crash = vi
        .spyOn(x.f.checkpointer, "consumeChildWorkflowCall")
        .mockImplementationOnce(() => {
          throw new Error("injected before consume");
        });
      await expect(x.run()).rejects.toThrow(/injected before consume/u);
      crash.mockRestore();
      expect(
        x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0]?.lifecycle
      ).toBe("terminal_recorded");
      expect(x.starts()).toBe(1);
      await x.reopen();
      expect(await x.run()).toMatchObject({ action: "incomplete", result: { imported_images: 2 } });
      expect(x.starts()).toBe(2);
      expect(x.http.submissions).toHaveLength(2);
      expect(
        x.f.checkpointer
          .events(x.authorized.identity.run_id)
          .filter((e) => e.eventType === "child_workflow_consumed")
      ).toHaveLength(2);
      expect(await x.run()).toMatchObject({ action: "incomplete" });
      expect(x.starts()).toBe(2);
    } finally {
      await x.close();
    }
  });
});

describe("concrete child adapter adversaries", () => {
  for (const attack of ["own", "prototype", "proxy", "forgery", "subclass"] as const)
    it(`refuses ${attack} adapter after G1 removal without child reservation`, async () => {
      const startDescriptor = Object.getOwnPropertyDescriptor(
        ImagegenChildRuntimeAuthority.prototype,
        "startParts"
      );
      const outputDescriptor = Object.getOwnPropertyDescriptor(
        ImagegenChildRuntimeAuthority.prototype,
        "output"
      );
      const x = await fixture({
        total: 1,
        adapterTransform: (adapter, host) => {
          const parent = host.checkpointer.loadRunById("reference-parent");
          const directive = parent?.pendingDirective;
          if (directive?.action !== "invoke_child_workflow")
            throw new Error("child fixture directive missing");
          const request = validateChildWorkflowRequest(
            JSON.parse(host.artifacts.read(directive.request_ref).toString())
          );
          const parts = adapter.startParts(
            request,
            directive,
            {
              schema_version: 1,
              authorization_id: "operator.controlled-imagegen-child.v1",
              max_nesting_depth: 1,
              max_active_children: 1,
              max_calls: 2,
              project_concurrency_limit: 1,
              asset_ids: ["asset"],
              parent_states: ["asset_prepare"],
              provider_registration_sha256: runtimeRegistrationSha256(
                IMAGEGEN_PLAYBOOK_REGISTRATION
              ),
              progress_lease: childExecutionProgressLeaseBinding(),
            },
            IMAGEGEN_PLAYBOOK_REGISTRATION
          );
          const overrides = { startParts: () => parts, output: () => [] };
          if (attack === "own") {
            for (const [key, value] of Object.entries(overrides))
              Reflect.defineProperty(adapter, key, { value });
            return adapter;
          }
          if (attack === "prototype") {
            Reflect.defineProperty(ImagegenChildRuntimeAuthority.prototype, "startParts", {
              value: overrides.startParts,
            });
            Reflect.defineProperty(ImagegenChildRuntimeAuthority.prototype, "output", {
              value: overrides.output,
            });
            return adapter;
          }
          if (attack === "proxy")
            return new Proxy(adapter, {
              get: (target, key, receiver): unknown =>
                key === "startParts"
                  ? overrides.startParts
                  : key === "output"
                    ? overrides.output
                    : Reflect.get(target, key, receiver),
            });
          if (attack === "forgery") {
            const fake: unknown = Object.create(ImagegenChildRuntimeAuthority.prototype);
            if (!(fake instanceof ImagegenChildRuntimeAuthority))
              throw new Error("forgery setup missing");
            for (const [key, value] of Object.entries(overrides))
              Reflect.defineProperty(fake, key, { value });
            return fake;
          }
          // Constructor rejection is also a valid denial; tested separately below after hardening.
          class Fake extends ImagegenChildRuntimeAuthority {
            override startParts() {
              return parts;
            }
            override output() {
              return [];
            }
          }
          try {
            return new Fake(host);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            return adapter;
          }
        },
      });
      try {
        x.f.revokeApproval();
        await expect(x.run()).rejects.toThrow();
        expect(x.starts()).toBe(0);
        expect(x.http.requests).toHaveLength(0);
        expect(
          x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)
        ).toHaveLength(0);
      } finally {
        await x.close();
        if (startDescriptor !== undefined)
          Reflect.defineProperty(
            ImagegenChildRuntimeAuthority.prototype,
            "startParts",
            startDescriptor
          );
        if (outputDescriptor !== undefined)
          Reflect.defineProperty(
            ImagegenChildRuntimeAuthority.prototype,
            "output",
            outputDescriptor
          );
      }
    });
  it("does not let an own output override import a captured child after G1 removal", async () => {
    const x = await fixture({ total: 1 });
    try {
      const crash = vi
        .spyOn(x.f.checkpointer, "consumeChildWorkflowCall")
        .mockImplementationOnce(() => {
          throw new Error("injected before consume");
        });
      await expect(x.run()).rejects.toThrow(/injected before consume/u);
      crash.mockRestore();
      Reflect.defineProperty(x.adapter(), "output", { value: () => [] });
      x.f.revokeApproval();
      await expect(x.run()).rejects.toThrow();
      expect(x.starts()).toBe(1);
      expect(x.http.submissions).toHaveLength(1);
      expect(
        x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0]?.lifecycle
      ).toBe("terminal_recorded");
      expect(
        x.f.checkpointer
          .loadRun(x.authorized.identity)
          .selectedArtifacts.filter((x) => x.kind === "child-result")
      ).toHaveLength(0);
    } finally {
      await x.close();
    }
  });
});

describe("controlled child import use-time fences", () => {
  for (const loss of ["G1", "rights"] as const)
    it(`rechecks ${loss} after continuation preparation and before import commit`, async () => {
      const x = await fixture({ total: 1 });
      try {
        const prepare = x.engine().prepareChildWorkflowContinuation.bind(x.engine());
        const hook = vi
          .spyOn(x.engine(), "prepareChildWorkflowContinuation")
          .mockImplementationOnce((input) => {
            const prepared = prepare(input);
            if (loss === "G1") x.f.revokeApproval();
            else {
              x.f.rights.splice(0);
              x.f.commitRights();
            }
            return prepared;
          });
        await expect(x.run()).rejects.toThrow(/current G1|current rights/u);
        hook.mockRestore();
        expect(x.starts()).toBe(1);
        expect(x.http.submissions).toHaveLength(1);
        expect(
          x.f.checkpointer.childWorkflowCallsForParent(x.authorized.identity.run_id)[0]?.lifecycle
        ).toBe("terminal_recorded");
        expect(
          x.f.checkpointer
            .loadRun(x.authorized.identity)
            .selectedArtifacts.filter((x) => x.kind === "child-result")
        ).toHaveLength(0);
      } finally {
        await x.close();
      }
    });
  it("rejects swapped retained adapter providers instead of rebinding its authority", async () => {
    let retained: ConstructorParameters<typeof ImagegenChildRuntimeAuthority>[0] | undefined;
    const x = await fixture({
      total: 1,
      adapterTransform: (adapter, host) => {
        retained = host;
        return adapter;
      },
    });
    try {
      if (retained === undefined) throw new Error("adapter host missing");
      x.f.revokeApproval();
      const assets = retained.providers.assets;
      if (assets === undefined) throw new Error("asset missing");
      Reflect.set(retained, "providers", { ...retained.providers, assets: new Proxy(assets, {}) });
      await expect(x.run()).rejects.toThrow();
      expect(x.starts()).toBe(0);
      expect(x.http.requests).toHaveLength(0);
    } finally {
      await x.close();
    }
  });
});

describe("child adapter exact concrete owners", () => {
  it("refuses foreign project owners at construction and foreign parent/project scope before reserve", async () => {
    using foreign = new ControlledFixture();
    const x = await fixture({
      total: 1,
      adapterTransform: (adapter, host) => {
        expect(
          () => new ImagegenChildRuntimeAuthority({ ...host, artifacts: foreign.store })
        ).toThrow(/different concrete owners/u);
        expect(
          () => new ImagegenChildRuntimeAuthority({ ...host, checkpointer: foreign.checkpointer })
        ).toThrow(/different concrete owners/u);
        expect(
          () =>
            new ImagegenChildRuntimeAuthority({ ...host, artifacts: new Proxy(host.artifacts, {}) })
        ).toThrow(/different concrete owners/u);
        const directive = host.checkpointer.loadRunById("reference-parent")?.pendingDirective;
        if (directive?.action !== "invoke_child_workflow")
          throw new Error("child directive missing");
        const request = validateChildWorkflowRequest(
          JSON.parse(host.artifacts.read(directive.request_ref).toString())
        );
        const policy: ImagegenChildPolicyV1 = {
          schema_version: 1,
          authorization_id: "operator.controlled-imagegen-child.v1",
          max_nesting_depth: 1,
          max_active_children: 1,
          max_calls: 2,
          project_concurrency_limit: 1,
          asset_ids: ["asset"],
          parent_states: ["asset_prepare"],
          provider_registration_sha256: runtimeRegistrationSha256(IMAGEGEN_PLAYBOOK_REGISTRATION),
          progress_lease: childExecutionProgressLeaseBinding(),
        };
        for (const changed of [
          { ...directive, identity: { ...directive.identity, run_id: "different-parent" } },
          {
            ...directive,
            policy_binding: { ...directive.policy_binding, project_id: foreign.projectId },
          },
        ])
          expect(() =>
            adapter.startParts(request, changed, policy, IMAGEGEN_PLAYBOOK_REGISTRATION)
          ).toThrow(/different parent or project/u);
        return adapter;
      },
    });
    try {
      x.f.revokeApproval();
      await expect(x.run()).rejects.toThrow(/G1/u);
      expect(x.starts()).toBe(0);
      expect(x.http.requests).toHaveLength(0);
    } finally {
      await x.close();
    }
  });
});
