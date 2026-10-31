import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  HostOperationLeaseIdentityV1Schema,
  type HostOperationDispositionV1,
} from "../dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import { VideogenCapacitySchedulerBinding } from "../dist/videogen/capacity-scheduler.js";
import {
  CapacityFixture,
  capacityPolicy,
  type CapacityFixtureOperation,
} from "./helpers/capacity-fixtures.js";
import { requireValue } from "./helpers/narrowing.js";
import { prepareWorkerConsumer, workerProfiles } from "./videogen-worker-identity-fixtures.js";

const NEVER: HostOperationDispositionV1 = {
  outcome: "cancelled",
  remote_disposition: "proven_not_accepted",
  lease_disposition: "released",
  retryable: false,
  reason_code: "fixture_never_submitted",
};
const UNKNOWN: HostOperationDispositionV1 = {
  outcome: "remote_unknown",
  remote_disposition: "may_continue",
  lease_disposition: "quarantined",
  retryable: false,
  reason_code: "fixture_remote_unknown",
};
function policy() {
  const result = capacityPolicy();
  const base = requireValue(
    result.bindings.find((b) => b.binding_id === "video-a"),
    "video binding"
  );
  result.bindings.push({ ...base, binding_id: "upload-a", operation_kind: "reference_upload" });
  return result;
}
function acquire(f: CapacityFixture, op: CapacityFixtureOperation, leases = f.leases) {
  const result = leases.tryAcquire(op.leaseRequest, f.now);
  if (result.kind !== "acquired" && result.kind !== "adopted")
    throw new Error(`expected acquisition, got ${result.kind}`);
  f.transition(op, {
    lifecycle: "lease_acquired",
    lease: result.active.lease,
    lease_expires_at_ms: result.active.expires_at_ms,
  });
  return result.active.lease;
}

const ProcessResult = Type.Union([
  Type.Object(
    {
      kind: Type.Union([Type.Literal("acquired"), Type.Literal("adopted")]),
      lease: HostOperationLeaseIdentityV1Schema,
    },
    { additionalProperties: false }
  ),
  Type.Object({ kind: Type.Literal("waiting") }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal("quarantined"),
      quarantine_id: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false }
  ),
]);
function subprocess(
  f: CapacityFixture,
  op: CapacityFixtureOperation,
  consumer: "image" | "first" | "second" | "distinct"
) {
  const loader = path.join(f.root, "worker-test-loader.mjs");
  writeFileSync(
    loader,
    `import { registerHooks } from 'node:module';\nimport { existsSync } from 'node:fs';\nregisterHooks({ resolve(specifier, context, nextResolve) {\n  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {\n    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);\n    if (existsSync(candidate)) return nextResolve(candidate.href, context);\n  }\n  return nextResolve(specifier, context);\n} });\n`,
    { mode: 0o600 }
  );
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      loader,
      fileURLToPath(new URL("./videogen-worker-identity-process.ts", import.meta.url)),
      JSON.stringify({
        state_root: f.stateRoot,
        database: path.join(op.project.root, "orchestration.db"),
        artifacts: path.join(op.project.root, "artifacts"),
        project_id: op.project.projectId,
        operation_record_id: op.record.operation_record_id,
        run_id: op.record.identity.run_id,
        consumer,
        now: f.now,
      }),
    ],
    { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }
  );
  const raw: unknown = JSON.parse(output);
  return validateSkillSchema(ProcessResult, raw, "WorkerIdentityProcessResult");
}

describe("registry-derived worker identity through real project journals and catalog leases", () => {
  it("serializes two video profiles, upload and imagegen across independent project consumers", () => {
    using f = new CapacityFixture(policy());
    const p = workerProfiles();
    using other = new HostOperationLeaseAuthority(f.stateRoot);
    const one = prepareWorkerConsumer(f, {
      id: "first-render",
      key: p.videos.resolve(p.first.profile_id).backend_key_sha256,
      binding_id: "video-a",
    });
    const two = prepareWorkerConsumer(f, {
      id: "second-render",
      key: p.videos.resolve(p.second.profile_id).backend_key_sha256,
      binding_id: "video-a",
      project_index: 1,
    });
    const upload = prepareWorkerConsumer(f, {
      id: "reference-upload",
      key: p.videos.resolve(p.second.profile_id).backend_key_sha256,
      binding_id: "upload-a",
      project_index: 1,
    });
    const image = prepareWorkerConsumer(f, {
      id: "image-render",
      key: p.images.resolve(p.image.profile_id).backend_key_sha256,
      binding_id: "image-a",
    });
    acquire(f, one);
    // Ordered enqueue times, not hashes, define the FIFO oracle.
    for (const op of [two, upload, image]) {
      f.now += 1;
      expect(other.tryAcquire(op.leaseRequest, f.now)).toEqual({ kind: "waiting" });
    }
    f.disposition(one, NEVER);
    expect(other.tryAcquire(image.leaseRequest, f.now)).toEqual({ kind: "waiting" });
    for (const op of [two, upload, image]) {
      acquire(f, op, other);
      f.disposition(op, NEVER);
    }
    expect(other.inspect(one.leaseRequest.backend_key_sha256)).toEqual({ state: "free" });
    for (const op of [one, two, upload, image]) {
      expect(op.project.authority.read(op.record.operation_record_id)).toEqual(op.record);
      expect(
        other.dispositionForOperation(op.record.operation_record_id)?.lease?.backend_key_sha256
      ).toBe(hostCapacityWorkerKey("worker-a"));
    }
  });

  it("shares one persistent upload quarantine with both video profiles and imagegen while another worker progresses", () => {
    using f = new CapacityFixture(policy());
    const p = workerProfiles();
    const upload = prepareWorkerConsumer(f, {
      id: "upload-unknown",
      key: p.videos.resolve(p.second.profile_id).backend_key_sha256,
      binding_id: "upload-a",
    });
    acquire(f, upload);
    f.submit(upload);
    f.disposition(upload, UNKNOWN);
    const poisoned = f.leases.inspect(upload.leaseRequest.backend_key_sha256);
    if (poisoned.state !== "quarantined") throw new Error("quarantine missing");
    f.now += 1000000;
    using reopened = new HostOperationLeaseAuthority(f.stateRoot);
    for (const [id, key, binding_id] of [
      ["first-blocked", p.videos.resolve(p.first.profile_id).backend_key_sha256, "video-a"],
      ["second-blocked", p.videos.resolve(p.second.profile_id).backend_key_sha256, "video-a"],
      ["image-blocked", p.images.resolve(p.image.profile_id).backend_key_sha256, "image-a"],
    ]) {
      const op = prepareWorkerConsumer(f, {
        id: requireValue(id, "id"),
        key: requireValue(key, "key"),
        binding_id: requireValue(binding_id, "binding"),
        project_index: 1,
      });
      expect(reopened.tryAcquire(op.leaseRequest, f.now)).toEqual({
        kind: "quarantined",
        quarantine_id: poisoned.quarantine_id,
      });
    }
    const distinct = prepareWorkerConsumer(f, {
      id: "distinct-progress",
      key: p.images.resolve(p.distinct.profile_id).backend_key_sha256,
      binding_id: "video-c",
      project_index: 1,
    });
    acquire(f, distinct, reopened);
    f.disposition(distinct, NEVER);
    expect(reopened.inspect(upload.leaseRequest.backend_key_sha256)).toEqual(poisoned);
    expect(() =>
      reopened.resetQuarantine({
        backend_key_sha256: upload.leaseRequest.backend_key_sha256,
        quarantine_id: "wrong-quarantine",
        disposition: "specific_remote_terminal",
        evidence_sha256: sha256("synthetic inspection"),
        now_ms: f.now,
      })
    ).toThrow("exact poisoned");
  });

  it("rejects stale release, submission, renewal and quarantine after same-owner fence rotation", () => {
    using f = new CapacityFixture(policy());
    const p = workerProfiles();
    const op = prepareWorkerConsumer(f, {
      id: "stale-fence",
      key: p.images.resolve(p.image.profile_id).backend_key_sha256,
      binding_id: "image-a",
    });
    const stale = acquire(f, op);
    f.now += 100001;
    const current = acquire(f, op);
    expect(current.fencing_token_sha256).not.toBe(stale.fencing_token_sha256);
    expect(() => f.leases.release(op.leaseRequest, stale, NEVER, null, f.now)).toThrow("stale");
    expect(() => f.leases.guardSubmission(op.leaseRequest, stale, f.now)).toThrow("stale");
    expect(() => f.leases.renew(op.leaseRequest, stale, f.now)).toThrow("stale");
    expect(() => f.leases.quarantine(op.leaseRequest, stale, UNKNOWN, null, f.now)).toThrow(
      "stale"
    );
    const waiter = prepareWorkerConsumer(f, {
      id: "stale-waiter",
      key: p.videos.resolve(p.first.profile_id).backend_key_sha256,
      binding_id: "video-a",
      project_index: 1,
    });
    expect(f.leases.tryAcquire(waiter.leaseRequest, f.now)).toEqual({ kind: "waiting" });
    f.disposition(op, NEVER);
    acquire(f, waiter);
    f.disposition(waiter, NEVER);
  });

  it("uses existing GPU capacity for a separate colocated voice queue and keeps a distinct GPU independent", () => {
    using f = new CapacityFixture(policy());
    const p = workerProfiles();
    const core = f.core();
    const video = prepareWorkerConsumer(f, {
      id: "gpu-video",
      key: p.videos.resolve(p.first.profile_id).backend_key_sha256,
      binding_id: "video-a",
      amount: 60,
    });
    acquire(f, video);
    const scheduler = new VideogenCapacitySchedulerBinding(
      core,
      [p.first, p.second].map((profile) => ({
        profile_id: profile.profile_id,
        profile_sha256: profile.profile_sha256,
        operation_kind: "video_render",
        capacity_binding_id: "video-a",
      })),
      p.videos
    );
    const held = scheduler.reserve({
      profile_id: p.first.profile_id,
      profile_sha256: p.first.profile_sha256,
      operation_kind: "video_render",
      operation_record_id: video.record.operation_record_id,
      project_id: video.project.projectId,
      demands: video.request.demands,
    });
    expect(held.state).toBe("held");
    const image = prepareWorkerConsumer(f, {
      id: "gpu-image",
      key: p.images.resolve(p.image.profile_id).backend_key_sha256,
      binding_id: "image-a",
      project_index: 1,
    });
    expect(f.leases.tryAcquire(image.leaseRequest, f.now)).toEqual({ kind: "waiting" });
    const voice = prepareWorkerConsumer(f, {
      id: "gpu-voice",
      key: hostCapacityWorkerKey("voice-process"),
      binding_id: "voice-a",
      project_index: 1,
      amount: 60,
    });
    acquire(f, voice);
    expect(voice.leaseRequest.backend_key_sha256).not.toBe(video.leaseRequest.backend_key_sha256);
    expect(core.reserve(voice.request).state).toBe("queued");
    const distinct = prepareWorkerConsumer(f, {
      id: "gpu-distinct",
      key: p.images.resolve(p.distinct.profile_id).backend_key_sha256,
      binding_id: "video-c",
      project_index: 1,
      amount: 60,
    });
    acquire(f, distinct);
    expect(core.reserve(distinct.request).state).toBe("held");
    f.disposition(video, NEVER);
    f.snapshot(video, 0, 1, "final");
    const accounted = core.account(video.record.operation_record_id, held.revision);
    core.settle(video.record.operation_record_id, accounted.revision);
    expect(core.tryAdmit(voice.record.operation_record_id, 1).state).toBe("held");
  });

  it("retains legacy journal keys instead of silently adopting an explicitly opted-in worker", () => {
    using f = new CapacityFixture();
    const p = workerProfiles();
    const legacy = sha256(
      canonicalJson({
        adapter: "videogen.comfyui",
        endpoint: p.first.endpoint,
        profile_id: p.first.profile_id,
        profile_sha256: p.first.profile_sha256,
      })
    );
    const op = prepareWorkerConsumer(f, {
      id: "legacy-journal",
      key: legacy,
      binding_id: "video-a",
    });
    acquire(f, op);
    const before = canonicalJson(op.project.authority.read(op.record.operation_record_id));
    expect(p.videos.resolve(p.first.profile_id).backend_key_sha256).not.toBe(legacy);
    expect(() => f.core().reserve(op.request)).toThrow("binding conflict");
    expect(canonicalJson(op.project.authority.read(op.record.operation_record_id))).toBe(before);
    expect(op.record.policy_binding.backend_key_sha256).toBe(legacy);
    f.disposition(op, NEVER);
  });

  it("re-derives the same image/video keys in fresh independent Node processes against exact project stores", () => {
    using f = new CapacityFixture(policy());
    const p = workerProfiles();
    const one = prepareWorkerConsumer(f, {
      id: "process-first",
      key: p.videos.resolve(p.first.profile_id).backend_key_sha256,
      binding_id: "video-a",
    });
    const two = prepareWorkerConsumer(f, {
      id: "process-second",
      key: p.videos.resolve(p.second.profile_id).backend_key_sha256,
      binding_id: "video-a",
      project_index: 1,
    });
    const image = prepareWorkerConsumer(f, {
      id: "process-image",
      key: p.images.resolve(p.image.profile_id).backend_key_sha256,
      binding_id: "image-a",
      project_index: 1,
    });
    const distinct = prepareWorkerConsumer(f, {
      id: "process-distinct",
      key: p.images.resolve(p.distinct.profile_id).backend_key_sha256,
      binding_id: "video-c",
      project_index: 1,
    });
    const first = subprocess(f, one, "first");
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") throw new Error("child first acquisition missing");
    acquire(f, one); // Exact current fence adoption, not a new submission.
    expect(requireValue(one.record.lease, "adopted lease")).toEqual(first.lease);
    expect(subprocess(f, two, "second")).toEqual({ kind: "waiting" });
    expect(subprocess(f, image, "image")).toEqual({ kind: "waiting" });
    expect(subprocess(f, distinct, "distinct").kind).toBe("acquired");
    f.submit(one);
    f.disposition(one, UNKNOWN);
    const poison = f.leases.inspect(one.leaseRequest.backend_key_sha256);
    if (poison.state !== "quarantined") throw new Error("child quarantine missing");
    expect(subprocess(f, image, "image")).toEqual({
      kind: "quarantined",
      quarantine_id: poison.quarantine_id,
    });
  });
});
