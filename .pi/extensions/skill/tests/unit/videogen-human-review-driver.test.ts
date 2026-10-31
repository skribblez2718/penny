import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareVideogenHumanReview } from "../../videogen-human-review-driver.js";
import {
  consumeTrustedQuestionnaireTransport,
  signTrustedHumanEvent,
} from "../../execution-receipts.js";
import { FoundationFixture } from "../../../../../apps/orchestration/tests/helpers/videogen-foundation-fixtures.js";
import { humanReviewFixture } from "../../../../../apps/orchestration/tests/helpers/videogen-human-review-fixture.js";
import { candidateDigest } from "../../../../../apps/orchestration/dist/videogen/human-review.js";
import {
  executionState,
  saveExecution,
} from "../../../../../apps/orchestration/dist/videogen/execution-state.js";
import { canonicalJson } from "../../../../../apps/orchestration/dist/canonical-json.js";

// Isolated protocol tests simulate the existing UI signer; NONE records real user approval.
function prepared(f: FoundationFixture) {
  const x = humanReviewFixture(f);
  const review = prepareVideogenHumanReview({
    service: x.service,
    run_id: f.run_id,
    expiry_ms: 120000,
    playback_device_profile_ref: x.device,
  });
  const answers = {
    schema_id: "penny.videogen-human-review-answers.v1",
    schema_version: 1,
    candidate_digest: candidateDigest(review.candidate),
    reviewer_id: "synthetic-reviewer",
    reviewer_role: "isolated test",
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
    issues: "SIMULATED UI EVENT ONLY. No human watched.",
    playback_device_profile_ref: x.device,
  };
  const event = (response: unknown) => {
    const transport = consumeTrustedQuestionnaireTransport(review.questionnaire_capability);
    if (!transport) throw new Error("test transport missing");
    return signTrustedHumanEvent({ ...transport.binding, response: canonicalJson(response) });
  };
  return { x, review, answers, event };
}
afterEach(() => vi.restoreAllMocks());
describe("native-only human review submission, never model authority", () => {
  it("creates no approval before response; direct JSON cannot submit; signed simulated response persists audit and existing playback contract without selecting/answering", () => {
    using f = new FoundationFixture();
    const { review, answers, event, x } = prepared(f);
    const before = x.service.checkpointer.loadRunById(f.run_id)?.snapshot();
    expect(() => review.submit(answers)).toThrow(/signature/);
    expect(() => review.submit({ approved: true, nonce: review.questionnaire_capability })).toThrow(
      /signature/
    );
    const signed = event(answers);
    const result = review.submit(signed);
    expect(result.disposition).toBe("positive_attestation");
    expect(result.playback_review_ref).not.toBeNull();
    expect(x.service.checkpointer.loadRunById(f.run_id)?.snapshot()).toEqual(before);
    const audit = f.store.read(result.audit_ref).toString();
    expect(audit).toContain("not_watch_proof");
    expect(audit).toContain('"effect_permission":"none"');
    expect(audit).not.toContain(review.questionnaire_capability);
    if (!result.playback_review_ref) throw new Error("test playback ref absent");
    expect(f.store.read(result.playback_review_ref).toString()).toContain(answers.issues);
    expect(() => review.submit(signed)).toThrow(/replay/);
  });
  it.each([
    "complete_viewing",
    "heard_audio",
    "image",
    "audio",
    "captions",
    "overall",
    "motion",
    "speech",
    "sync",
    "identity",
  ])("persists negative %s without any positive playback record", (field) => {
    using f = new FoundationFixture();
    const { review, answers, event } = prepared(f);
    const response = {
      ...answers,
      [field]: ["complete_viewing", "heard_audio"].includes(field) ? false : "fail",
    };
    const result = review.submit(event(response));
    expect(result.disposition).toBe("not_approved");
    expect(result.playback_review_ref).toBeNull();
  });
  it("rejects missing answers and closed-contract mass assignment even with a valid test signature", () => {
    using f = new FoundationFixture();
    const { review, answers, event } = prepared(f);
    expect(() =>
      review.submit(event({ ...answers, captions: undefined, approved: true }))
    ).toThrow();
  });
  it("rejects swapped candidates and tampered signed response", () => {
    using f = new FoundationFixture();
    const { review, answers, event } = prepared(f);
    const signed = event({ ...answers, candidate_digest: "b".repeat(64) });
    expect(() => review.submit({ ...signed, response: canonicalJson(answers) })).toThrow(
      /signature/
    );
    expect(() => review.submit(signed)).toThrow(/candidate/);
  });
  it("expires the one-time challenge without granting a response", () => {
    using f = new FoundationFixture();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const { review, answers, event } = prepared(f);
    const signed = event(answers);
    clock.mockReturnValue(121001);
    expect(() => review.submit(signed)).toThrow(/expired/);
  });
  it("rejects same-byte revision races and never overwrites the checkpoint", () => {
    using f = new FoundationFixture();
    const { review, answers, event, x } = prepared(f);
    const signed = event(answers);
    const c = f.checkpointer.loadRunById(f.run_id);
    if (!c) throw new Error("fixture run absent");
    const s = executionState(c);
    const manifest = s.slots.find((v) => v.slot === "manifest");
    if (!manifest) throw new Error("fixture manifest absent");
    manifest.ref = { ...x.manifest, version: 2 };
    saveExecution(c, s);
    f.checkpointer.saveRun(c, "fixture_revision", {});
    const before = c.snapshot();
    expect(() => review.submit(signed)).toThrow();
    expect(f.checkpointer.loadRunById(f.run_id)?.snapshot()).toEqual(before);
  });
});
