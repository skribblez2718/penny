import { describe, expect, it } from "vitest";
import path from "node:path";
import { CompleteVideogenFixture, completeFixture } from "./helpers/videogen-complete-fixture.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import { FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { currentHumanReviewCandidate } from "../dist/videogen/human-review.js";
import { executionState, slot, setSlot } from "../dist/videogen/execution-state.js";
import { constructGateDecision, validateGatePacket } from "../dist/videogen/gates.js";
import { VideogenRuntime } from "../dist/videogen/runtime.js";
import type { Directive } from "../dist/contracts.js";

// Real G1–G5 engine custody over synthetic products/answers only. NOT a human watch test.
describe("human viewer reuses the current G5 candidate and original gate closure", () => {
  it("binds exact master/package/native and rejects package replacement while G5 is pending", async () => {
    using f = new CompleteVideogenFixture();
    const x = await completeFixture(f);
    try {
      const request = videogenStageRequest();
      let d: Directive = await x.runner.runUntilBoundary(
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
          project_root: path.resolve(import.meta.dirname, "../../.."),
          trust_profile: "hardened-untrusted",
        })
      );
      for (let i = 0; i < 6; i++) {
        if (d.action !== "await_user") throw new Error("synthetic fixture gate absent");
        const c = f.checkpointer.loadRunById(f.run_id);
        if (!c) throw new Error("fixture run absent");
        const ref = slot(executionState(c), "packet");
        const packet = validateGatePacket(
          JSON.parse(f.store.read(ref).toString()),
          FOUNDATION_LIMITS
        );
        if (packet.gate_id === "G5") break;
        if (packet.kind === "clarification") {
          new VideogenRuntime(f.store, f.checkpointer, f.project_id, x.providers).capturePlayback(
            c,
            x.playbackRef()
          );
          f.checkpointer.saveRun(c, "fixture_synthetic_playback", {});
        }
        d = await x.runner.runUntilBoundary(
          x.engine.handle({
            schema_version: 2,
            action: "respond",
            identity: c.identity,
            gate_id: d.gate_id,
            challenge: d.challenge,
            response: constructGateDecision(
              packet,
              ref,
              packet.kind === "clarification" ? "answer" : "approve",
              FOUNDATION_LIMITS,
              "synthetic fixture only"
            ),
          })
        );
      }
      const service = {
        artifacts: f.store,
        checkpointer: f.checkpointer,
        config: { projectId: f.project_id },
      };
      const candidate = currentHumanReviewCandidate(service, f.run_id);
      const c = f.checkpointer.loadRunById(f.run_id);
      if (!c) throw new Error("fixture run absent");
      expect(c.stateId).toBe("g5");
      expect(candidate.master_ref).toEqual(slot(executionState(c), "master"));
      expect(candidate.manifest_ref).toEqual(slot(executionState(c), "manifest"));
      const replacement = f.json(
        { notice: "different package" },
        "penny.videogen-portable-package.v1"
      );
      setSlot(c, executionState(c), "manifest", replacement);
      f.checkpointer.saveRun(c, "fixture_package_swap", {});
      expect(() => currentHumanReviewCandidate(service, f.run_id)).toThrow();
    } finally {
      await x.close();
    }
  });
});
