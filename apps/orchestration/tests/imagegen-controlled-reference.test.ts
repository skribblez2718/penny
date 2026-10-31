import {
  readVideogenOwnerSelection,
  VideogenOwnerSelection,
} from "../dist/videogen/owner-selection.js";
import { describe, it, expect } from "vitest";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { decodePng, encodeCanonicalPng } from "../dist/png-media.js";
import { compositeRevision, editMask } from "../dist/imagegen/reference-media.js";
import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer } from "../dist/checkpointer.js";
import {
  ImageAssetAuthority,
  admitSuppliedImage,
  assertImageAssetOwners,
} from "../dist/imagegen/asset-authority.js";
import {
  ImageRevisionTransformationV1Schema,
  ImageAssetResultV1Schema,
  validateImageInputUploadReceipt,
  validateImageAssetRequest,
} from "../dist/imagegen/reference-contracts.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import { RightsBindingV1Schema } from "../dist/videogen/rights-ledger.js";
import {
  ControlledFixture,
  controlledHttp,
  controlledProfile,
  png,
} from "./helpers/imagegen-controlled-fixture.js";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("required test evidence missing");
  return value;
}
function areaAsset(f: ControlledFixture, area: unknown) {
  const ref = f.ref("unit media fixture only");
  return validateImageAssetRequest({
    schema_id: "penny.image-asset-request.v1",
    schema_version: 1,
    intent_ref: ref,
    call_index: 1,
    input: { kind: "revision", source_ref: ref, area },
  });
}
describe("controlled reference media semantics", () => {
  it("makes exact outside pixels source-owned and keeps whole-image preservation semantic", () => {
    using f = new ControlledFixture();
    const source = png(7),
      raw = png(255),
      mask = editMask(source, areaAsset(f, { kind: "rectangle", x: 0, y: 0, width: 1, height: 1 }));
    expect(mask).not.toBeNull();
    const composite = compositeRevision(source, raw, must(mask));
    expect(composite.outside).toBe(3);
    const pixels = decodePng(composite.bytes).rgba;
    expect([...pixels]).toEqual([255, 255, 255, 255, 7, 7, 7, 255, 7, 7, 7, 255, 7, 7, 7, 255]);
    expect(compositeRevision(source, raw, null)).toMatchObject({ outside: 0 });
    expect(compositeRevision(source, raw, null).bytes).toEqual(raw);
  });
  it("rejects soft/alpha masks, incorrect canvases, and out-of-canvas rectangles", () => {
    using f = new ControlledFixture();
    for (const sample of [
      [127, 127, 127, 255],
      [255, 255, 255, 0],
      [255, 0, 255, 255],
    ]) {
      const bad = encodeCanonicalPng({
        width: 2,
        height: 2,
        rgba: Uint8Array.from([...sample, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
      });
      expect(() =>
        editMask(png(7), areaAsset(f, { kind: "mask", mask_ref: f.ref("mask unit fixture") }), bad)
      ).toThrow();
    }
    expect(() =>
      editMask(png(7), areaAsset(f, { kind: "rectangle", x: 2, y: 0, width: 1, height: 1 }))
    ).toThrow();
    expect(() =>
      compositeRevision(
        png(7),
        encodeCanonicalPng({ width: 1, height: 1, rgba: Uint8Array.from([1, 1, 1, 255]) }),
        null
      )
    ).toThrow();
  });
});
describe("real engine controlled-reference offline evidence", () => {
  for (const method of ["fresh", "whole", "mask", "rectangle"] as const)
    it(`completes current G1 ${method} through upload/render/dual-review`, async () => {
      using f = new ControlledFixture();
      const http = await controlledHttp(method !== "fresh");
      let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
      try {
        const profile = controlledProfile(http.port, method, "black_edit"),
          approval = f.authorize(profile, method);
        runtime = await f.runtime(profile, approval.authority());
        const reviews: string[] = [];
        const old = runtime.model.runAgent.bind(runtime.model);
        runtime.model.runAgent = async (invocation) => {
          if (["vera", "carren"].includes(invocation.agent)) {
            const current = invocation.inputArtifacts.filter((x) => x.kind === "generated-image");
            expect(current).toHaveLength(1);
            reviews.push(must(current[0]).content_digest);
            if (method !== "fresh")
              expect(invocation.inputArtifacts).toContainEqual(approval.source);
          }
          return old(invocation);
        };
        const end = await runtime.runner.runUntilBoundary(runtime.start(approval.asset));
        expect(end).toMatchObject({ action: "complete", met: true });
        const ctx = must(f.checkpointer.loadRunById(f.imageRun));
        const pngRef = must(ctx.selectedArtifacts.find((x) => x.kind === "generated-image"));
        expect(reviews).toEqual([pngRef.content_digest, pngRef.content_digest]);
        expect(http.submissions).toHaveLength(1);
        expect(http.uploads).toHaveLength(method === "fresh" ? 0 : method === "whole" ? 1 : 2);
        const submission: unknown = JSON.parse(must(http.submissions[0]));
        const final = f.store.read(pngRef);
        if (method === "mask" || method === "rectangle") {
          expect([...decodePng(final).rgba]).toEqual([
            255, 255, 255, 255, 7, 7, 7, 255, 7, 7, 7, 255, 7, 7, 7, 255,
          ]);
          const maskUpload = must(
            ctx.selectedArtifacts
              .filter((x) => x.kind === "image-input-upload-receipt")
              .map((ref) =>
                validateImageInputUploadReceipt(JSON.parse(f.store.read(ref).toString()))
              )
              .find((x) => x.request.role === "mask")
          );
          expect(submission).toMatchObject({
            prompt: {
              "6": { inputs: { image: `fixture-inputs/${maskUpload.verified_sha256}.png` } },
            },
          });
        } else expect(Buffer.from(final)).toEqual(Buffer.from(http.output));
        if (method !== "fresh") {
          expect(submission).toMatchObject({
            prompt: {
              "5": { inputs: { image: `fixture-inputs/${approval.source.content_digest}.png` } },
            },
          });
          expect(ctx.selectedArtifacts.some((x) => x.kind === "image-raw-result")).toBe(true);
          const transformRef = must(
            ctx.selectedArtifacts.find((x) => x.kind === "image-revision-transformation")
          );
          const t = validateSkillSchema(
            ImageRevisionTransformationV1Schema,
            JSON.parse(f.store.read(transformRef).toString()),
            "transformation evidence"
          );
          expect(t.outside_pixels_verified).toBe(method !== "whole" ? 3 : 0);
          expect(t.final_sha256).toBe(pngRef.content_digest);
          const uploads = ctx.selectedArtifacts.filter(
            (x) => x.kind === "image-input-upload-receipt"
          );
          for (const ref of uploads)
            expect(
              validateImageInputUploadReceipt(JSON.parse(f.store.read(ref).toString()))
                .verified_sha256
            ).toMatch(/^[a-f0-9]{64}$/u);
        }
        const resultRef = must(ctx.selectedArtifacts.find((x) => x.kind === "image-asset-result"));
        expect(
          validateSkillSchema(
            ImageAssetResultV1Schema,
            JSON.parse(f.store.read(resultRef).toString()),
            "asset result"
          ).origin
        ).toBe(method === "fresh" ? "fresh" : "revision");
      } finally {
        runtime?.close();
        await http.close();
      }
    });
  for (const faultPoint of ["after_remote_checkpoint", "after_fetch"] as const)
    it(`recovers render ${faultPoint} without duplicate accepted work`, async () => {
      using f = new ControlledFixture();
      const http = await controlledHttp(true);
      let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
      try {
        const profile = controlledProfile(http.port, "mask"),
          approval = f.authorize(profile, "mask");
        let tripped = false;
        runtime = await f.runtime(profile, approval.authority(), (point, kind) => {
          if (point === faultPoint && kind === "imagegen.comfyui-generate.v1" && !tripped) {
            tripped = true;
            throw new HostOperationSimulatedCrashError(point);
          }
        });
        await expect(
          runtime.runner.runUntilBoundary(runtime.start(approval.asset))
        ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
        runtime.close();
        runtime = undefined;
        f.reopen();
        runtime = await f.runtime(profile, approval.authority());
        const resume = runtime.engine.handle({
          schema_version: 2,
          action: "recover",
          identity: runtime.identity,
        });
        const end = await runtime.runner.runUntilBoundary(resume);
        expect(end).toMatchObject({ action: "complete", met: true });
        expect(http.submissions).toHaveLength(1);
        expect(http.uploads).toHaveLength(2);
      } finally {
        runtime?.close();
        await http.close();
      }
    });
  it("rejects input readback drift before POST prompt", async () => {
    using f = new ControlledFixture();
    const http = await controlledHttp(true);
    let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
    try {
      const profile = controlledProfile(http.port, "whole"),
        a = f.authorize(profile, "whole");
      runtime = await f.runtime(profile, a.authority());
      const old = runtime.owner.dispatch.bind(runtime.owner);
      runtime.owner.dispatch = async (...args) => {
        if (args[1].operation_kind === "imagegen.comfyui-generate.v1") http.driftInput();
        return old(...args);
      };
      const end = await runtime.runner.runUntilBoundary(runtime.start(a.asset));
      expect(end).not.toMatchObject({ action: "complete", met: true });
      expect(http.submissions).toHaveLength(0);
    } finally {
      runtime?.close();
      await http.close();
    }
  });
  it("rejects recovery descriptor drift with no duplicate POST prompt", async () => {
    using f = new ControlledFixture();
    const http = await controlledHttp(true);
    let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
    try {
      const profile = controlledProfile(http.port, "whole"),
        a = f.authorize(profile, "whole");
      let tripped = false;
      runtime = await f.runtime(profile, a.authority(), (point, kind) => {
        if (point === "after_fetch" && kind === "imagegen.comfyui-generate.v1" && !tripped) {
          tripped = true;
          throw new HostOperationSimulatedCrashError(point);
        }
      });
      await expect(runtime.runner.runUntilBoundary(runtime.start(a.asset))).rejects.toThrow();
      runtime.close();
      runtime = undefined;
      f.reopen();
      http.driftDescriptor();
      runtime = await f.runtime(profile, a.authority());
      const end = await runtime.runner.runUntilBoundary(
        runtime.engine.handle({ schema_version: 2, action: "recover", identity: runtime.identity })
      );
      expect(end).not.toMatchObject({ action: "complete", met: true });
      expect(http.submissions).toHaveLength(1);
    } finally {
      runtime?.close();
      await http.close();
    }
  });
  for (const bad of [
    "source-digest",
    "profile",
    "rights",
    "consent",
    "gate",
    "approved-intent",
    "max-renders",
    "nth-call",
    "wrong-role",
    "mask-overflow",
    "method",
  ] as const)
    it(`fails ${bad} admission with zero backend HTTP`, async () => {
      using f = new ControlledFixture();
      const http = await controlledHttp(true);
      let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
      try {
        const profile = controlledProfile(http.port, "whole"),
          a = f.authorize(profile, "whole");
        let asset = a.asset;
        if (bad === "nth-call") asset = validateImageAssetRequest({ ...asset, call_index: 2 });
        if (bad === "wrong-role")
          asset = validateImageAssetRequest({
            ...asset,
            input: {
              kind: "revision",
              source_ref: f.ref(png(7), undefined, "reference-mask", "image/png"),
              area: { kind: "whole" },
            },
          });
        if (bad === "mask-overflow")
          asset = validateImageAssetRequest({
            ...asset,
            input: {
              kind: "revision",
              source_ref: a.source,
              area: { kind: "rectangle", x: 2, y: 0, width: 1, height: 1 },
            },
          });
        if (bad === "method")
          asset = validateImageAssetRequest({
            ...asset,
            input: {
              kind: "revision",
              source_ref: a.source,
              area: { kind: "mask", mask_ref: a.mask },
            },
          });
        if (bad === "source-digest")
          asset = validateImageAssetRequest({
            ...asset,
            input: {
              kind: "revision",
              source_ref: { ...a.source, content_digest: "0".repeat(64) },
              area: { kind: "whole" },
            },
          });
        if (bad === "rights") {
          f.rights[0] = { ...must(f.rights[0]), status: "revoked" };
          f.commitRights();
        }
        if (bad === "gate") f.revokeApproval();
        if (bad === "approved-intent") f.revokeApprovedIntents();
        const authority = a.authority();
        if (bad === "profile" || bad === "max-renders")
          expect(() =>
            authority.check(
              asset,
              f.imageRun,
              bad === "profile" ? "0".repeat(64) : profile.profile_sha256,
              bad === "max-renders" ? 2 : 1
            )
          ).toThrow();
        else if (bad === "consent") {
          const original = must(f.rights[0]);
          const binding = validateSkillSchema(
            RightsBindingV1Schema,
            JSON.parse(f.store.read(original.rights_ref).toString()),
            "rights evidence"
          );
          const replacement = f.ref(
            { ...binding, revision: 2, consent_refs: [] },
            binding.schema_id
          );
          f.rights[0] = { ...original, rights_ref: replacement, revision: 2 };
          f.commitRights();
          runtime = await f.runtime(profile, authority);
          expect(() => must(runtime).start(asset)).toThrow();
        } else {
          runtime = await f.runtime(profile, authority);
          expect(() => must(runtime).start(asset)).toThrow();
        }
        expect(http.requests).toHaveLength(0);
      } finally {
        runtime?.close();
        await http.close();
      }
    });
  for (const method of ["mask", "rectangle"] as const)
    it(`refuses approved ${method} unsupported capability/area before HTTP`, async () => {
      using f = new ControlledFixture();
      const http = await controlledHttp(true);
      let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
      try {
        const profile = controlledProfile(http.port, "whole"),
          a = f.authorize(profile, method, (asset) =>
            method === "rectangle"
              ? validateImageAssetRequest({
                  ...asset,
                  input: {
                    kind: "revision",
                    source_ref:
                      asset.input.kind === "revision" ? asset.input.source_ref : asset.intent_ref,
                    area: { kind: "rectangle", x: 2, y: 0, width: 1, height: 1 },
                  },
                })
              : asset
          );
        runtime = await f.runtime(profile, a.authority());
        expect(() => must(runtime).start(a.asset)).toThrow();
        expect(http.requests).toHaveLength(0);
      } finally {
        runtime?.close();
        await http.close();
      }
    });
  for (const point of ["after_remote_checkpoint", "after_fetch"] as const)
    it(`recovers upload ${point} without a new upload name or POST`, async () => {
      using f = new ControlledFixture();
      const http = await controlledHttp(true);
      let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
      try {
        const profile = controlledProfile(http.port, "whole"),
          a = f.authorize(profile, "whole");
        let tripped = false;
        runtime = await f.runtime(profile, a.authority(), (phase, kind) => {
          if (phase === point && kind === "imagegen.comfyui-upload-input.v1" && !tripped) {
            tripped = true;
            throw new HostOperationSimulatedCrashError(phase);
          }
        });
        await expect(
          runtime.runner.runUntilBoundary(runtime.start(a.asset))
        ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
        runtime.close();
        runtime = undefined;
        f.reopen();
        runtime = await f.runtime(profile, a.authority());
        const end = await runtime.runner.runUntilBoundary(
          runtime.engine.handle({
            schema_version: 2,
            action: "recover",
            identity: runtime.identity,
          })
        );
        expect(end).toMatchObject({ action: "complete", met: true });
        expect(http.uploads).toHaveLength(1);
        expect(http.submissions).toHaveLength(1);
      } finally {
        runtime?.close();
        await http.close();
      }
    });
  it("ambiguous accepted upload is quarantined and never uploaded again", async () => {
    using f = new ControlledFixture();
    const http = await controlledHttp(true);
    let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
    try {
      const profile = controlledProfile(http.port, "whole"),
        a = f.authorize(profile, "whole");
      let tripped = false;
      runtime = await f.runtime(profile, a.authority(), (point, kind) => {
        if (
          point === "after_submit_before_remote_checkpoint" &&
          kind === "imagegen.comfyui-upload-input.v1" &&
          !tripped
        ) {
          tripped = true;
          throw new HostOperationSimulatedCrashError(point);
        }
      });
      await expect(runtime.runner.runUntilBoundary(runtime.start(a.asset))).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      runtime.close();
      runtime = undefined;
      f.reopen();
      runtime = await f.runtime(profile, a.authority());
      const end = await runtime.runner.runUntilBoundary(
        runtime.engine.handle({ schema_version: 2, action: "recover", identity: runtime.identity })
      );
      expect(end).toMatchObject({ action: "incomplete", met: false });
      expect(http.uploads).toHaveLength(1);
      expect(http.submissions).toHaveLength(0);
    } finally {
      runtime?.close();
      await http.close();
    }
  });
  it("missing semantic preserve/change assessment cannot pass dual review", async () => {
    using f = new ControlledFixture();
    const http = await controlledHttp(true);
    let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
    try {
      const profile = controlledProfile(http.port, "whole"),
        a = f.authorize(profile, "whole");
      runtime = await f.runtime(profile, a.authority());
      const run = runtime.model.runAgent.bind(runtime.model);
      runtime.model.runAgent = async (invocation) => {
        const completion = await run(invocation);
        if (!["vera", "carren"].includes(invocation.agent)) return completion;
        const value: unknown = JSON.parse(completion.text.slice("SUMMARY:".length));
        if (
          value === null ||
          typeof value !== "object" ||
          !("report" in value) ||
          value.report === null ||
          typeof value.report !== "object" ||
          !("revision_review" in value.report)
        )
          throw new Error("test review missing");
        const { revision_review: _review, ...report } = value.report;
        return { ...completion, text: "SUMMARY:" + JSON.stringify({ ...value, report }) };
      };
      const end = await runtime.runner.runUntilBoundary(runtime.start(a.asset));
      expect(end).toMatchObject({ action: "incomplete", met: false });
      expect(http.submissions).toHaveLength(1);
    } finally {
      runtime?.close();
      await http.close();
    }
  });
  it("supplied admission is exact, current-rights and read-only (no child/render)", () => {
    using f = new ControlledFixture();
    const profile = controlledProfile(12345, "whole"),
      a = f.authorize(profile, "whole");
    const before = f.checkpointer.loadRunById(f.imageRun);
    const suppliedIntent = f.ref({ ...a.intent, source: "supplied" }, a.intent.schema_id);
    const input = {
      store: f.store,
      owner: a.owner(),
      source_ref: a.source,
      rights_ref: a.intent.rights_ref,
      consent_ref: a.intent.consent_ref,
      intent_ref: suppliedIntent,
    };
    const admitted = admitSuppliedImage(input);
    expect(admitted.png_ref).toEqual(a.source);
    expect(f.checkpointer.loadRunById(f.imageRun)).toEqual(before);
    f.rights[0] = { ...must(f.rights[0]), status: "revoked" };
    f.commitRights();
    expect(() => admitSuppliedImage(input)).toThrow();
  });
});

describe("concrete asset capability adversaries", () => {
  for (const attack of [
    "own",
    "prototype",
    "subclass",
    "proxy",
    "transparent-proxy",
    "forgery",
    "host-port",
  ] as const)
    it(`rejects ${attack} after creation then G1 removal, before any HTTP/model/effect`, async () => {
      using f = new ControlledFixture();
      const http = await controlledHttp(false);
      let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
      try {
        const profile = controlledProfile(http.port, "fresh"),
          a = f.authorize(profile, "fresh");
        const host = a.authorityHost();
        const original = new ImageAssetAuthority(a.owner());
        const allowed = original.check(a.asset, f.imageRun, profile.profile_sha256, 1);
        const allowedApproval = must(f.approvals[0]);
        let authority = original;
        const descriptor = Object.getOwnPropertyDescriptor(ImageAssetAuthority.prototype, "check");
        try {
          if (attack === "own") Reflect.defineProperty(original, "check", { value: () => allowed });
          if (attack === "prototype")
            Reflect.defineProperty(ImageAssetAuthority.prototype, "check", {
              value: () => allowed,
              configurable: true,
            });
          if (attack === "proxy")
            authority = new Proxy(original, {
              get: (target, key, receiver): unknown =>
                key === "check" ? () => allowed : Reflect.get(target, key, receiver),
            });
          if (attack === "transparent-proxy") authority = new Proxy(original, {});
          if (attack === "forgery") {
            const forged: unknown = Object.create(ImageAssetAuthority.prototype);
            if (!(forged instanceof ImageAssetAuthority)) throw new Error("forgery setup failed");
            Reflect.defineProperty(forged, "check", { value: () => allowed });
            authority = forged;
          }
          f.revokeApproval();
          let denied = false;
          let prompted = 0;
          try {
            if (attack === "subclass") {
              class Counterfeit extends ImageAssetAuthority {
                override check() {
                  return allowed;
                }
              }
              authority = new Counterfeit(host);
            }
            if (attack === "host-port")
              host.gate = { ...a.gate, current_approvals: [allowedApproval] };
            expect(authority).toBeInstanceOf(ImageAssetAuthority);
            runtime = await f.runtime(profile, authority);
            const run = runtime.model.runAgent.bind(runtime.model);
            runtime.model.runAgent = (...args) => {
              prompted++;
              return run(...args);
            };
            const end = await runtime.runner.runUntilBoundary(runtime.start(a.asset));
            denied = end.action !== "complete";
          } catch {
            denied = true;
          }
          expect(denied).toBe(true);
          expect(prompted).toBe(0);
          expect(f.checkpointer.runExists(f.imageRun)).toBe(false);
          expect(http.requests).toHaveLength(0);
          expect(http.uploads).toHaveLength(0);
          expect(http.submissions).toHaveLength(0);
        } finally {
          if (descriptor !== undefined)
            Reflect.defineProperty(ImageAssetAuthority.prototype, "check", descriptor);
        }
      } finally {
        runtime?.close();
        await http.close();
      }
    });

  for (const method of ["fresh", "whole"] as const)
    for (const boundary of method === "fresh"
      ? (["before-readiness", "ready-await", "accepted"] as const)
      : (["before-readiness", "ready-await", "upload-await", "accepted"] as const))
      it(`rechecks ${method} current authority at ${boundary}`, async () => {
        using f = new ControlledFixture();
        const http = await controlledHttp(method !== "fresh");
        let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
        try {
          const profile = controlledProfile(http.port, method),
            a = f.authorize(profile, method);
          const authority = a.authority();
          const historical = authority.check(a.asset, f.imageRun, profile.profile_sha256, 1);
          runtime = await f.runtime(profile, authority);
          const start = runtime.start(a.asset);
          let tripped = false;
          if (boundary === "before-readiness") {
            f.revokeApproval();
            tripped = true;
          }
          let requestsAtRevoke = 0;
          http.onRequest((request) => {
            if (
              !tripped &&
              ((boundary === "ready-await" && request === "GET /system_stats") ||
                (boundary === "upload-await" && request === "POST /upload/image") ||
                (boundary === "accepted" && request === "POST /prompt"))
            ) {
              f.revokeApproval();
              Reflect.defineProperty(authority, "check", { value: () => historical });
              tripped = true;
              requestsAtRevoke = http.requests.length;
            }
          });
          let completed = false;
          try {
            completed = (await runtime.runner.runUntilBoundary(start)).action === "complete";
          } catch {
            /* fail closed is permitted */
          }
          expect(tripped).toBe(true);
          expect(completed).toBe(false);
          if (boundary === "before-readiness" || boundary === "ready-await") {
            expect(http.requests).toHaveLength(requestsAtRevoke);
            expect(http.uploads).toHaveLength(0);
          }
          expect(http.requests).toHaveLength(requestsAtRevoke);
          expect(http.submissions).toHaveLength(boundary === "accepted" ? 1 : 0);
        } finally {
          runtime?.close();
          await http.close();
        }
      });
});

describe("live owner state and concrete owner custody", () => {
  it("refuses wrong project, foreign/proxied/forged owners without accepting instanceof", () => {
    using f = new ControlledFixture();
    using foreign = new ControlledFixture();
    const a = f.authorize(controlledProfile(12345, "fresh"), "fresh"),
      h = a.authorityHost();
    const wrong = {
      ...h,
      gate: { ...h.gate, project_id: foreign.projectId },
      rights: { ...h.rights, project_id: foreign.projectId },
    };
    expect(() => new ImageAssetAuthority(wrong)).toThrow();
    expect(
      () =>
        new ImageAssetAuthority({
          ...h,
          gate: { ...h.gate, store: foreign.store },
          rights: { ...h.rights, store: foreign.store },
        })
    ).toThrow();
    expect(
      () =>
        new ImageAssetAuthority({ ...h, gate: { ...h.gate, checkpointer: foreign.checkpointer } })
    ).toThrow();
    expect(
      () =>
        new ImageAssetAuthority({
          ...h,
          gate: { ...h.gate, checkpointer: new Proxy(f.checkpointer, {}) },
        })
    ).toThrow();
    expect(
      () =>
        new ImageAssetAuthority({
          ...h,
          gate: { ...h.gate, store: new Proxy(f.store, {}) },
          rights: { ...h.rights, store: new Proxy(f.store, {}) },
        })
    ).toThrow();
    const fakeStore: unknown = Object.create(ArtifactStore.prototype);
    const fakeControl: unknown = Object.create(Checkpointer.prototype);
    if (!(fakeStore instanceof ArtifactStore) || !(fakeControl instanceof Checkpointer))
      throw new Error("forgery fixture failed");
    expect(
      () =>
        new ImageAssetAuthority({
          ...h,
          gate: { ...h.gate, store: fakeStore },
          rights: { ...h.rights, store: fakeStore },
        })
    ).toThrow();
    expect(
      () => new ImageAssetAuthority({ ...h, gate: { ...h.gate, checkpointer: fakeControl } })
    ).toThrow();
    expect(() =>
      assertImageAssetOwners(a.authority(), foreign.store, foreign.checkpointer)
    ).toThrow();
  });
  for (const loss of ["rights", "selected-G1", "call-scope"] as const)
    for (const timing of ["admission", "readiness-await", "accepted"] as const)
      it(`rejects ${loss} changed after authority creation at ${timing}`, async () => {
        using f = new ControlledFixture();
        const http = await controlledHttp(true);
        let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
        try {
          const profile = controlledProfile(http.port, "whole"),
            a = f.authorize(profile, "whole"),
            authority = a.authority();
          runtime = await f.runtime(profile, authority);
          const revoke = () => {
            if (loss === "rights") {
              f.rights[0] = { ...must(f.rights[0]), status: "revoked" };
              f.commitRights();
            } else {
              const parent = f.checkpointer.loadRun(a.identity);
              const lost = loss === "selected-G1" ? must(f.approvals[0]).decision_ref : a.callRef;
              parent.selectedArtifacts = parent.selectedArtifacts.filter(
                (ref) => ref.artifact_id !== lost.artifact_id
              );
              f.checkpointer.saveRun(parent, "fixture_authority_revoked", {});
            }
          };
          let tripped = false;
          let completed = false;
          try {
            if (timing === "admission") {
              revoke();
              tripped = true;
            }
            const start = runtime.start(a.asset);
            http.onRequest((request) => {
              if (
                !tripped &&
                request === (timing === "readiness-await" ? "GET /system_stats" : "POST /prompt")
              ) {
                revoke();
                tripped = true;
              }
            });
            completed = (await runtime.runner.runUntilBoundary(start)).action === "complete";
          } catch {
            /* the real owner may refuse rather than manufacture a negative terminal */
          }
          expect(tripped).toBe(true);
          expect(completed).toBe(false);
          expect(http.submissions).toHaveLength(timing === "accepted" ? 1 : 0);
          if (timing === "admission") expect(http.requests).toHaveLength(0);
          if (timing === "readiness-await") {
            expect(http.requests).toHaveLength(1);
            expect(http.uploads).toHaveLength(0);
          }
        } finally {
          runtime?.close();
          await http.close();
        }
      });
});

describe("checkpoint owner selections cannot be replaced by stale projections", () => {
  it.each(["gate-copy", "gate-proxy", "projection-copy", "owner-copy", "owner-proxy"] as const)(
    "rejects %s after real G1 revocation",
    (form) => {
      using f = new ControlledFixture();
      const profile = controlledProfile(12345, "fresh"),
        a = f.authorize(profile, "fresh"),
        owner = a.owner();
      const projected = readVideogenOwnerSelection(owner),
        copiedGate = structuredClone({
          current_approvals: projected.gate.current_approvals,
          current_presented: projected.gate.current_presented,
        });
      const historical = { ...projected, gate: { ...projected.gate, ...copiedGate } };
      const ownerCopy: unknown = Object.create(VideogenOwnerSelection.prototype);
      const malicious: unknown =
        form === "gate-copy"
          ? historical
          : form === "gate-proxy"
            ? { ...historical, gate: new Proxy(projected.gate, {}) }
            : form === "projection-copy"
              ? { ...projected }
              : form === "owner-copy"
                ? ownerCopy
                : new Proxy(owner, {});
      const real = a.authority();
      real.check(a.asset, f.imageRun, profile.profile_sha256, 1);
      f.revokeApproval();
      expect(() => real.check(a.asset, f.imageRun, profile.profile_sha256, 1)).toThrow();
      expect(() => new ImageAssetAuthority(malicious)).toThrow(/concrete/u);
    }
  );
  it("cannot spend a previously approved scope after durable parent cancellation", () => {
    using f = new ControlledFixture();
    const profile = controlledProfile(12345, "fresh"),
      a = f.authorize(profile, "fresh"),
      authority = a.authority();
    authority.check(a.asset, f.imageRun, profile.profile_sha256, 1);
    const parent = f.checkpointer.loadRun(a.identity);
    parent.status = "cancelled";
    parent.pendingDirective = null;
    parent.terminalDirective = {
      schema_version: 2,
      action: "cancelled",
      identity: parent.identity,
      status: "cancelled",
      met: false,
      result: {},
      artifacts: parent.selectedArtifacts,
      unresolved: ["cancelled"],
    };
    f.checkpointer.saveRun(parent, "fixture_parent_cancelled", {});
    expect(() => authority.check(a.asset, f.imageRun, profile.profile_sha256, 1)).toThrow();
  });
  it("reopens against revoked rights rather than retaining an earlier authority snapshot", () => {
    using f = new ControlledFixture();
    const profile = controlledProfile(12345, "whole"),
      a = f.authorize(profile, "whole");
    a.authority().check(a.asset, f.imageRun, profile.profile_sha256, 1);
    f.rights.splice(0);
    f.commitRights();
    f.reopen();
    expect(() => a.authority().check(a.asset, f.imageRun, profile.profile_sha256, 1)).toThrow();
  });
  for (const method of ["mask", "rectangle"] as const)
    it.each(["ready", "upload", "accepted"] as const)(
      `${method} rechecks durable rights at %s await`,
      async (boundary) => {
        using f = new ControlledFixture();
        const http = await controlledHttp(true);
        let runtime: Awaited<ReturnType<ControlledFixture["runtime"]>> | undefined;
        try {
          const profile = controlledProfile(http.port, method),
            a = f.authorize(profile, method);
          runtime = await f.runtime(profile, a.authority());
          const start = runtime.start(a.asset);
          let tripped = false,
            countAtRevocation = 0;
          http.onRequest((request) => {
            if (
              !tripped &&
              request ===
                (boundary === "ready"
                  ? "GET /system_stats"
                  : boundary === "upload"
                    ? "POST /upload/image"
                    : "POST /prompt")
            ) {
              f.rights.splice(0);
              f.commitRights();
              tripped = true;
              countAtRevocation = http.requests.length;
            }
          });
          let positive = false;
          try {
            positive = (await runtime.runner.runUntilBoundary(start)).action === "complete";
          } catch {
            /* Closed refusal is valid. */
          }
          expect(tripped).toBe(true);
          expect(positive).toBe(false);
          expect(http.requests).toHaveLength(countAtRevocation);
          expect(http.submissions).toHaveLength(boundary === "accepted" ? 1 : 0);
        } finally {
          runtime?.close();
          await http.close();
        }
      }
    );
});
