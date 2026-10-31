import path from "node:path";
import { writeFileSync, copyFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import skillExtension from "../../index.js";
import questionnaire from "../../../questionnaire/index.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { requireFunction, requireRecord } from "../../../../lib/tests/test-narrowers.js";
import {
  createQuestionnaireUiHost,
  requireQuestionnaireTool,
  requireQuestionnaireToolResult,
} from "../../../questionnaire/tests/helpers.js";
import {
  CompleteVideogenFixture,
  completeFixture,
} from "../../../../../apps/orchestration/tests/helpers/videogen-complete-fixture.js";
import { videogenStageRequest } from "../../../../../apps/orchestration/tests/helpers/videogen-stage-fixtures.js";
import { FOUNDATION_LIMITS } from "../../../../../apps/orchestration/tests/helpers/videogen-foundation-fixtures.js";
import {
  constructGateDecision,
  validateGatePacket,
} from "../../../../../apps/orchestration/dist/videogen/gates.js";
import {
  executionState,
  slot,
  setSlot,
  saveExecution,
} from "../../../../../apps/orchestration/dist/videogen/execution-state.js";
import {
  candidateDigest,
  currentHumanReviewCandidate,
} from "../../../../../apps/orchestration/dist/videogen/human-review.js";
import {
  resolveTrustedQuestionnaireTransport,
  verifyExecutionOwnerSignature,
} from "../../execution-receipts.js";
import {
  ArtifactRefSchema,
  validateContract,
  type Directive,
} from "../../../../../apps/orchestration/dist/contracts.js";
import { RunContext } from "../../../../../apps/orchestration/dist/context.js";
import { OrchestrationService, skillContractSha256 } from "@penny/orchestration";
import { runtimeRegistrationSha256 } from "../../../../../apps/orchestration/dist/playbooks/runtime-registration-digest.js";
import { VideogenRuntime } from "../../../../../apps/orchestration/dist/videogen/runtime.js";
import type { VideogenRuntimeProvidersV1 } from "../../../../../apps/orchestration/dist/videogen/runtime-config.js";
import { loadVideogenRuntimeFromEnvironment } from "../../../../../apps/orchestration/dist/videogen/runtime-manifest.js";
import {
  ManifestVideogenFixture,
  minimalVideogenManifest,
} from "../../../../../apps/orchestration/tests/helpers/videogen-manifest-fixture.js";
import { humanReviewFixture } from "../../../../../apps/orchestration/tests/helpers/videogen-human-review-fixture.js";

const original = new Map(
  ["PROJECT_ROOT", "PENNY_STATE_ROOT", "PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE"].map((key) => [
    key,
    process.env[key],
  ])
);
afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Real registered skill -> default service -> engine recover -> native UI provider -> actual
// questionnaire UI/editor -> realm signer -> retained submit closure -> real capture/checkpoint.
// All media, prior gates and typed UI answers are explicitly SYNTHETIC; nobody watched a film.
async function harness(f: CompleteVideogenFixture) {
  copyFileSync(
    path.resolve(import.meta.dirname, "../../../../../AGENTS.md"),
    path.join(f.root, "AGENTS.md")
  );
  const x = await completeFixture(f);
  const request = videogenStageRequest();
  let directive: Directive = await x.runner.runUntilBoundary(
    x.engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: f.run_id,
        session_id: f.run_id,
        playbook: "videogen",
        engine_owner: "typescript",
      },
      goal: request.brief,
      constraints: request,
      project_root: path.resolve(import.meta.dirname, "../../../../.."),
      trust_profile: "trusted-interactive",
    })
  );
  for (let i = 0; i < 5; i++) {
    if (directive.action !== "await_user") throw new Error("fixture did not reach a real gate");
    const c = f.checkpointer.loadRunById(f.run_id);
    if (!c) throw new Error("fixture run missing");
    const ref = slot(executionState(c), "packet");
    const packet = validateGatePacket(JSON.parse(f.store.read(ref).toString()), FOUNDATION_LIMITS);
    if (packet.kind === "clarification") break;
    directive = await x.runner.runUntilBoundary(
      x.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: c.identity,
        gate_id: directive.gate_id,
        challenge: directive.challenge,
        response: constructGateDecision(
          packet,
          ref,
          "approve",
          FOUNDATION_LIMITS,
          "synthetic fixture prior gate only"
        ),
      })
    );
  }
  const c = f.checkpointer.loadRunById(f.run_id);
  if (!c || c.stateId !== "clarify") throw new Error("fixture final playback wait missing");
  const master = slot(executionState(c), "master");
  const file = path.join(f.root, "selected-master.mp4");
  writeFileSync(file, f.store.read(master), { mode: 0o600 });
  const device = f.opaque("SYNTHETIC device; no actual playback", "text/plain");
  return { x, file, device, ...nativeTools(f, request.brief, x.providers) };
}
function nativeTools(
  f: CompleteVideogenFixture | ManifestVideogenFixture,
  goal: string,
  providers?: VideogenRuntimeProvidersV1
) {
  process.env.PROJECT_ROOT = f.root;
  process.env.PENNY_STATE_ROOT = f.stateRoot;
  const tools = new Map<string, ReturnType<typeof requireQuestionnaireTool>>();
  const shutdowns: Array<() => unknown> = [];
  const api = createTestExtensionApi({
    onRegisterTool(value) {
      const t = requireQuestionnaireTool(value);
      tools.set(t.name, t);
    },
    onEvent(name, handler) {
      if (name === "session_shutdown") {
        const fn = requireFunction(handler);
        shutdowns.push(() => fn());
      }
    },
  });
  // The real generic factory, not a test ingress resolver or a direct driver call.
  if (providers === undefined) skillExtension(api);
  else skillExtension(api, {}, { videogen: providers });
  questionnaire(api);
  const skill = tools.get("skill"),
    ask = tools.get("questionnaire");
  if (!skill || !ask) throw new Error("actual registered tool absent");
  const ui = createQuestionnaireUiHost(() => {});
  let syntheticTypedAnswer = "";
  let cancelled = false;
  let uiCount = 0;
  const ctx = {
    cwd: f.root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      theme: ui.theme,
      custom(factory: unknown) {
        uiCount++;
        return new Promise<unknown>((done) => {
          const component = requireRecord(
            requireFunction(factory)(ui.tui, ui.theme, undefined, done)
          );
          const handle = requireFunction(component.handleInput);
          // Actual UI selection and actual Editor paste/submit; never manufacture a UI result.
          handle(cancelled ? "\x1b" : "\r");
          if (!cancelled) {
            handle(`\x1b[200~${syntheticTypedAnswer}\x1b[201~`);
            handle("\r");
          }
        });
      },
    },
  };
  const params = { skill_name: "videogen", goal, session_id: f.run_id };
  return {
    ctx,
    tools,
    async start(context: unknown = ctx) {
      return requireQuestionnaireToolResult(
        await skill.execute("review-recover", params, undefined, undefined, context)
      );
    },
    async ask(cap: string, answer: unknown, context: unknown = ctx, cancel = false) {
      syntheticTypedAnswer = JSON.stringify(answer);
      cancelled = cancel;
      return requireQuestionnaireToolResult(
        await ask.execute(
          "review-ui",
          { trustedTransportCapability: cap },
          undefined,
          undefined,
          context
        )
      );
    },
    uiCount: () => uiCount,
    shutdown() {
      for (const fn of shutdowns) fn();
    },
    service: {
      artifacts: f.store,
      checkpointer: f.checkpointer,
      config: { projectId: f.project_id },
    },
  };
}
function capability(result: ReturnType<typeof requireQuestionnaireToolResult>): string {
  const text = result.content.map((b) => b.text).join("\n");
  const cap = /"trustedTransportCapability"\s*:\s*"([A-Za-z0-9_-]{43})"/u.exec(text)?.[1];
  if (!cap) throw new Error(`native tool result omitted capability: ${text}`);
  return cap;
}
function response(
  h: Awaited<ReturnType<typeof harness>>,
  f: CompleteVideogenFixture,
  positive = true
) {
  return {
    schema_id: "penny.videogen-human-review-answers.v1",
    schema_version: 1,
    candidate_digest: candidateDigest(currentHumanReviewCandidate(h.service, f.run_id)),
    reviewer_id: "synthetic-fixture-user",
    reviewer_role: "synthetic fixture only",
    complete_viewing: positive,
    heard_audio: positive,
    image: "pass",
    audio: "pass",
    captions: "pass",
    overall: "pass",
    motion: "pass",
    speech: "pass",
    sync: "pass",
    identity: "pass",
    issues: "SIMULATED UI input only; no human viewing or production approval",
    playback_device_profile_ref: h.device,
  };
}

describe("registered Pi parent human playback runtime path", () => {
  it("reaches the actual UI, records only its signed response through real capture, and leaves clarification/G5 separate", async () => {
    using f = new CompleteVideogenFixture();
    const h = await harness(f);
    try {
      const first = await h.start();
      const cap = capability(first);
      expect(h.tools.size).toBe(3); // existing knowledge_base, skill and questionnaire only
      expect(first.details).toMatchObject({ success: false, state: "clarify" });
      expect(h.uiCount()).toBe(0);
      const opened = await h.ask(cap, {
        master_file_path: h.file,
        playback_device_profile_ref: h.device,
      });
      const next = capability(opened);
      const url = /http:\/\/127\.0\.0\.1:\d+\/review\/[a-f0-9]+\//u.exec(
        opened.content.map((v) => v.text).join("\n")
      )?.[0];
      if (!url) throw new Error("actual viewer URL absent from native tool result");
      expect((await fetch(url)).status).toBe(200);
      expect(await (await fetch(`${url}master.mp4`)).text()).toContain("NOT playable");
      const before = f.checkpointer.loadRunById(f.run_id);
      if (!before) throw new Error("run absent");
      expect(executionState(before).slots.some((s) => s.slot === "playback")).toBe(false);
      const recorded = await h.ask(next, response(h, f));
      expect(recorded.content.map((v) => v.text).join("\n")).toContain(
        "Human playback attestation captured"
      );
      expect(h.uiCount()).toBe(2);
      const events = recorded.details?.trustedHumanEvents;
      if (!Array.isArray(events) || events.length !== 1) throw new Error("UI event absent");
      expect(verifyExecutionOwnerSignature(events[0])).toBe(true);
      const after = f.checkpointer.loadRunById(f.run_id);
      if (!after) throw new Error("captured run absent");
      const playback = slot(executionState(after), "playback");
      expect(JSON.parse(f.store.read(playback).toString())).toMatchObject({
        complete_viewing: true,
        heard_audio: true,
        reviewer_id: "synthetic-fixture-user",
      });
      expect(after.pendingDirective).toEqual(before.pendingDirective);
      expect(after.stateId).toBe("clarify");
      expect(
        f.checkpointer
          .events(f.run_id)
          .filter((e) => e.eventType === "videogen_human_playback_captured")
      ).toHaveLength(1);
      expect(resolveTrustedQuestionnaireTransport(next)).toBeUndefined();
      expect((await h.ask(next, response(h, f))).content[0]?.text).toContain("invalid or stale");
      await expect(fetch(url)).rejects.toThrow();
      expect(capability(first)).toBe(cap);
      // The original engine clarification remains a separate response. Its synthetic reply
      // reaches a new, unanswered G5; the playback UI never supplies that approval.
      const packetRef = slot(executionState(after), "packet");
      const packet = validateGatePacket(
        JSON.parse(f.store.read(packetRef).toString()),
        FOUNDATION_LIMITS
      );
      const waiting = after.pendingDirective;
      if (waiting?.action !== "await_user") throw new Error("original clarification lost");
      const g5 = await h.x.runner.runUntilBoundary(
        h.x.engine.handle({
          schema_version: 2,
          action: "respond",
          identity: after.identity,
          gate_id: waiting.gate_id,
          challenge: waiting.challenge,
          response: constructGateDecision(
            packet,
            packetRef,
            "answer",
            FOUNDATION_LIMITS,
            "synthetic clarification only, NOT G5 approval"
          ),
        })
      );
      expect(g5).toMatchObject({ action: "await_user", state_id: "g5" });
      const atG5 = f.checkpointer.loadRunById(f.run_id);
      if (!atG5) throw new Error("G5 run missing");
      expect(executionState(atG5).slots.some((s) => s.slot === "G5")).toBe(false);
    } finally {
      h.shutdown();
      await h.x.close();
    }
  });

  it("uses the unmodified default factory and private JSON manifest, with actual-setup fields answered in the real UI", async () => {
    using f = new ManifestVideogenFixture();
    const file = path.join(f.root, "private-manifest.json");
    writeFileSync(file, JSON.stringify(minimalVideogenManifest(f)), { mode: 0o600 });
    process.env.PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE = file;
    process.env.PENNY_STATE_ROOT = f.stateRoot;
    // Seed only a clearly synthetic paused candidate; unlike the prior E2E this test does not
    // establish the preceding production graph. Bind it to the actual default service registration.
    const fixture = humanReviewFixture(f);
    const providers = loadVideogenRuntimeFromEnvironment({
      env: process.env,
      store: f.store,
      project_id: f.project_id,
    });
    if (!providers) throw new Error("default private manifest missing");
    {
      using owner = new OrchestrationService({ projectRoot: f.root, playbookName: "videogen" });
      const run = f.checkpointer.loadRunById(f.run_id);
      if (!run) throw new Error("seed missing");
      owner.engine.liveness.bindPolicy(run);
      const state = executionState(run);
      state.config_digest = new VideogenRuntime(
        f.store,
        f.checkpointer,
        f.project_id,
        providers
      ).binding_digest;
      saveExecution(run, state);
      f.checkpointer.saveRun(
        RunContext.fromSnapshot({
          ...run.snapshot(),
          registration_contract_binding: {
            schema_version: 1,
            registration_name: "videogen",
            contract_sha256: skillContractSha256(owner.engine.registration.contract),
            registration_sha256: runtimeRegistrationSha256(owner.engine.registration),
          },
        }),
        "synthetic_default_binding",
        {}
      );
    }
    const h = nativeTools(f, "synthetic review delivery");
    try {
      const first = await h.start();
      const opened = await h.ask(capability(first), {
        master_file_path: fixture.file,
        playback_device_profile: {
          display: "SYNTHETIC display",
          audio_output: "SYNTHETIC output",
          player: "SYNTHETIC browser",
        },
      });
      const text = opened.content.map((v) => v.text).join("\n");
      const url = /http:\/\/127\.0\.0\.1:\d+\/review\/[a-f0-9]+\//u.exec(text)?.[0];
      if (!url) throw new Error("default factory omitted viewer URL");
      const html = await (await fetch(url)).text();
      const json = /id="device">([^<]+)</u.exec(html)?.[1];
      if (!json) throw new Error("pinned device missing");
      const device = validateContract(
        ArtifactRefSchema,
        JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&")),
        "viewer device"
      );
      expect(JSON.parse(f.store.read(device).toString())).toEqual({
        display: "SYNTHETIC display",
        audio_output: "SYNTHETIC output",
        player: "SYNTHETIC browser",
      });
      const result = await h.ask(capability(opened), {
        schema_id: "penny.videogen-human-review-answers.v1",
        schema_version: 1,
        candidate_digest: candidateDigest(currentHumanReviewCandidate(h.service, f.run_id)),
        reviewer_id: "synthetic-default-user",
        reviewer_role: "fixture only",
        complete_viewing: true,
        heard_audio: true,
        image: "pass",
        audio: "pass",
        captions: "pass",
        overall: "pass",
        motion: "pass",
        speech: "pass",
        sync: "pass",
        identity: "pass",
        issues: "SIMULATED UI ONLY, no real film or approval",
        playback_device_profile_ref: device,
      });
      expect(result.content.map((v) => v.text).join("\n")).toContain(
        "Human playback attestation captured"
      );
      const run = f.checkpointer.loadRunById(f.run_id);
      if (!run) throw new Error("run missing");
      expect(slot(executionState(run), "playback").kind).toBe("videogen-playback-review");
      expect(run.stateId).toBe("clarify");
    } finally {
      h.shutdown();
    }
  });

  it.each([
    "negative",
    "abstain",
    "revision",
    "noninteractive",
    "restart",
    "wrong-capability",
    "unsigned-inputs",
  ])("keeps %s blocked on the real registered path", async (mode) => {
    using f = new CompleteVideogenFixture();
    const h = await harness(f);
    try {
      if (mode === "noninteractive") {
        for (const context of [
          { ...h.ctx, mode: "print", hasUI: false },
          { ...h.ctx, mode: "rpc", hasUI: true },
          { ...h.ctx, isProjectTrusted: () => false },
        ]) {
          const noNative = await h.start(context);
          expect(noNative.content.map((v) => v.text).join("\n")).not.toContain(
            "trustedTransportCapability"
          );
        }
        expect(h.uiCount()).toBe(0);
      }
      const first = await h.start();
      const cap = capability(first);
      if (mode === "wrong-capability") {
        const out = await h.ask("x".repeat(43), {});
        expect(out.content[0]?.text).toContain("invalid or stale");
      } else if (mode === "unsigned-inputs") {
        const skill = h.tools.get("skill");
        if (!skill) throw new Error("skill absent");
        await expect(
          skill.execute(
            "unsigned",
            {
              skill_name: "videogen",
              goal: "fixture",
              session_id: f.run_id,
              constraints: { user_response: { approved: true } },
            },
            undefined,
            undefined,
            h.ctx
          )
        ).rejects.toThrow(/existing trusted questionnaire/);
      } else if (mode === "noninteractive") {
        const out = await h.ask(cap, {}, { ...h.ctx, mode: "print", hasUI: false });
        expect(out.details?.needsUserInput).toBe(true);
        expect(h.uiCount()).toBe(0);
      } else if (mode === "restart") {
        h.shutdown();
        expect(resolveTrustedQuestionnaireTransport(cap)).toBeUndefined();
        expect((await h.ask(cap, {})).content[0]?.text).toContain("invalid or stale");
      } else {
        const opened = await h.ask(cap, {
          master_file_path: h.file,
          playback_device_profile_ref: h.device,
        });
        const next = capability(opened);
        const answer = response(h, f, mode !== "negative");
        if (mode === "revision") {
          const c = f.checkpointer.loadRunById(f.run_id);
          if (!c) throw new Error("run missing");
          setSlot(c, executionState(c), "manifest", f.opaque("changed revision"));
          f.checkpointer.saveRun(c, "synthetic_revision", {});
          await expect(h.ask(next, answer)).rejects.toThrow();
        } else {
          const out = await h.ask(next, answer, h.ctx, mode === "abstain");
          expect(out.content.map((v) => v.text).join("\n")).toContain(
            mode === "negative" ? "NOT approved" : "cancelled"
          );
        }
      }
      const current = f.checkpointer.loadRunById(f.run_id);
      if (!current) throw new Error("run missing");
      expect(current.stateId).toBe("clarify");
      expect(executionState(current).slots.some((s) => s.slot === "playback")).toBe(false);
      expect(
        f.checkpointer
          .events(f.run_id)
          .some((e) => e.eventType === "videogen_human_playback_captured")
      ).toBe(false);
    } finally {
      h.shutdown();
      await h.x.close();
    }
  });
});
