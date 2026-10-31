import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { ComfyWorkerIdentityRegistry } from "../dist/comfy/worker-identity.js";
import { hostCapacityWorkerKey } from "../dist/host-operations/capacity-contracts.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import { StaticVideogenProfileRegistry } from "../dist/videogen/profile-registry.js";
import { VideogenCapacitySchedulerBinding } from "../dist/videogen/capacity-scheduler.js";
import { CapacityFixture } from "./helpers/capacity-fixtures.js";
import { SYNTHETIC_NODE_POLICIES, syntheticProfile } from "./helpers/imagegen-fixtures.js";
import { syntheticVideogenProfile } from "./helpers/videogen-fixtures.js";
import { workerProfiles } from "./videogen-worker-identity-fixtures.js";

describe("explicit shared actual-worker identity", () => {
  it("joins imagegen and two video profiles without changing their approved bytes or snapshots", () => {
    const f = workerProfiles();
    const expected = hostCapacityWorkerKey("worker-a");
    expect(f.images.resolve(f.image.profile_id).backend_key_sha256).toBe(expected);
    for (const profile of [f.first, f.second]) {
      const resolved = f.videos.resolve(profile.profile_id);
      expect(resolved.backend_key_sha256).toBe(expected);
      expect(resolved.profile).toEqual(profile);
      expect(resolved.approved_profile_sha256).toBe(profile.profile_sha256);
    }
    expect(f.first.profile_sha256).not.toBe(f.second.profile_sha256);
    expect(f.images.resolve(f.distinct.profile_id).backend_key_sha256).toBe(
      hostCapacityWorkerKey("worker-c")
    );
    expect(f.images.resolve(f.distinct.profile_id).backend_key_sha256).not.toBe(expected);
    expect(f.workers.keyFor({ ...f.image.endpoint, host: "::1" })).toBe(expected);
    expect(f.images.resolve(f.image.profile_id).snapshot.profile).toEqual(f.image);
  });

  it("keeps exact legacy endpoint/profile key formulas when the host does not opt in", () => {
    const f = workerProfiles();
    const images = new StaticImagegenProfileRegistry({
      profiles: [f.image],
      approved_profile_sha256_by_id: new Map([[f.image.profile_id, f.image.profile_sha256]]),
      node_class_policies: SYNTHETIC_NODE_POLICIES,
    });
    const videos = new StaticVideogenProfileRegistry({
      profiles: [f.first, f.second],
      approved_profile_sha256_by_id: new Map(
        [f.first, f.second].map((p) => [p.profile_id, p.profile_sha256])
      ),
    });
    expect(images.resolve(f.image.profile_id).backend_key_sha256).toBe(
      sha256(canonicalJson({ schema_version: 1, endpoint: f.image.endpoint }))
    );
    expect(images.resolve(f.image.profile_id).snapshot).toEqual(
      f.images.resolve(f.image.profile_id).snapshot
    );
    for (const profile of [f.first, f.second]) {
      expect(videos.resolve(profile.profile_id).backend_key_sha256).toBe(
        sha256(
          canonicalJson({
            adapter: "videogen.comfyui",
            endpoint: profile.endpoint,
            profile_id: profile.profile_id,
            profile_sha256: profile.profile_sha256,
          })
        )
      );
    }
    expect(videos.resolve(f.first.profile_id).backend_key_sha256).not.toBe(
      videos.resolve(f.second.profile_id).backend_key_sha256
    );
  });

  it("uses immutable host topology even if supplied arrays or returned video profiles mutate", () => {
    const f = workerProfiles();
    f.topology.splice(0);
    const returned = f.videos.resolve(f.first.profile_id);
    returned.profile.endpoint.port = 10103;
    f.first.endpoint.port = 10104;
    expect(f.videos.resolve(f.first.profile_id).profile.endpoint.port).toBe(10101);
    expect(f.videos.resolve(f.first.profile_id).backend_key_sha256).toBe(
      hostCapacityWorkerKey("worker-a")
    );
    expect(f.workers.keyFor(f.image.endpoint)).toBe(hostCapacityWorkerKey("worker-a"));
  });

  it("retains a worker key across approved profile revision while still refusing stale snapshots", () => {
    const f = workerProfiles();
    const changed = syntheticVideogenProfile({
      port: 10101,
      mode: "t2v",
      model_id: "synthetic-revised-model",
    });
    const registry = new StaticVideogenProfileRegistry({
      profiles: [changed],
      approved_profile_sha256_by_id: new Map([[changed.profile_id, changed.profile_sha256]]),
      worker_identities: f.workers,
    });
    expect(changed.profile_sha256).not.toBe(f.first.profile_sha256);
    expect(registry.resolve(changed.profile_id).backend_key_sha256).toBe(
      f.videos.resolve(f.first.profile_id).backend_key_sha256
    );
    expect(() =>
      registry.verifySnapshot({
        schema_id: "penny.videogen-profile-snapshot.v1",
        schema_version: 1,
        profile: f.first,
        approved_profile_sha256: f.first.profile_sha256,
        source_graph_sha256: f.first.source_graph_sha256,
      })
    ).toThrow("snapshot");
  });

  it.each([
    undefined,
    null,
    [],
    {},
    [{ worker_id: "worker-a", endpoints: [] }],
    [{ worker_id: "bad/id", endpoints: [{ scheme: "http", host: "127.0.0.1", port: 10101 }] }],
    [{ worker_id: "worker-a", endpoints: [{ scheme: "http", host: "localhost", port: 10101 }] }],
    [{ worker_id: "worker-a", endpoints: [{ scheme: "https", host: "127.0.0.1", port: 10101 }] }],
    [{ worker_id: "worker-a", endpoints: [{ scheme: "http", host: "127.0.0.1", port: 0 }] }],
    [{ worker_id: "worker-a", endpoints: [{ scheme: "http", host: "127.0.0.1", port: 65536 }] }],
    [{ worker_id: "worker-a", endpoints: [{ scheme: "http", host: "127.0.0.1", port: 1.5 }] }],
    [
      {
        worker_id: "worker-a",
        endpoints: [{ scheme: "http", host: "127.0.0.1", port: 10101, path: "/" }],
      },
    ],
    [
      {
        worker_id: "worker-a",
        endpoints: [{ scheme: "http", host: "127.0.0.1", port: 10101 }],
        qualified: true,
      },
    ],
  ])("refuses malformed host injection %# without a fallback", (value: unknown) => {
    expect(() => new ComfyWorkerIdentityRegistry(value)).toThrow();
  });

  it("refuses duplicate identities, endpoint aliases, accessors, cycles and oversized topology", () => {
    const f = workerProfiles();
    const one = { worker_id: "worker-a", endpoints: [f.image.endpoint] };
    expect(() => new ComfyWorkerIdentityRegistry([one, one])).toThrow("identities");
    expect(() => new ComfyWorkerIdentityRegistry([one, { ...one, worker_id: "worker-b" }])).toThrow(
      "endpoint"
    );
    expect(
      () =>
        new ComfyWorkerIdentityRegistry([
          { ...one, endpoints: [f.image.endpoint, f.image.endpoint] },
        ])
    ).toThrow("endpoint");
    let accessed = false;
    expect(
      () =>
        new ComfyWorkerIdentityRegistry([
          {
            get worker_id() {
              accessed = true;
              return "worker-a";
            },
            endpoints: [f.image.endpoint],
          },
        ])
    ).toThrow("accessors");
    expect(accessed).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic["cycle"] = cyclic;
    expect(() => new ComfyWorkerIdentityRegistry(cyclic)).toThrow("complexity");
    expect(
      () =>
        new ComfyWorkerIdentityRegistry(
          Array.from({ length: 257 }, (_, i) => ({
            worker_id: `worker-${i}`,
            endpoints: [{ ...f.image.endpoint, port: i + 1 }],
          }))
        )
    ).toThrow();
  });

  it("refuses unmapped or drifted endpoints at registry construction, without legacy fallback", () => {
    const f = workerProfiles();
    const changedImage = syntheticProfile({ port: 10103 });
    const changedVideo = syntheticVideogenProfile({ port: 10103 });
    expect(
      () =>
        new StaticImagegenProfileRegistry({
          profiles: [changedImage],
          approved_profile_sha256_by_id: new Map([
            [changedImage.profile_id, changedImage.profile_sha256],
          ]),
          node_class_policies: SYNTHETIC_NODE_POLICIES,
          worker_identities: f.workers,
        })
    ).toThrow("absent or drifted");
    expect(
      () =>
        new StaticVideogenProfileRegistry({
          profiles: [changedVideo],
          approved_profile_sha256_by_id: new Map([
            [changedVideo.profile_id, changedVideo.profile_sha256],
          ]),
          worker_identities: f.workers,
        })
    ).toThrow("absent or drifted");
    expect(
      () =>
        new StaticVideogenProfileRegistry({
          profiles: [f.first],
          approved_profile_sha256_by_id: new Map([[f.first.profile_id, sha256("not approved")]]),
          worker_identities: f.workers,
        })
    ).toThrow("not approved");
  });

  it("matches the opt-in video scheduler to the existing exact capacity worker binding", () => {
    using store = new CapacityFixture();
    const f = workerProfiles();
    const core = store.core();
    const selections = [f.first, f.second].map((p) => ({
      profile_id: p.profile_id,
      profile_sha256: p.profile_sha256,
      operation_kind: "video_render",
      capacity_binding_id: "video-a",
    }));
    const scheduler = new VideogenCapacitySchedulerBinding(core, selections, f.videos);
    const op = store.operation("worker-scheduler");
    const input = {
      ...selections[0],
      profile_id: f.first.profile_id,
      profile_sha256: f.first.profile_sha256,
      operation_kind: "video_render",
      project_id: op.project.projectId,
      operation_record_id: op.record.operation_record_id,
      demands: op.request.demands,
    };
    expect(scheduler.reserve(input).state).toBe("held");
    expect(
      scheduler.requestFor({
        ...input,
        profile_id: f.second.profile_id,
        profile_sha256: f.second.profile_sha256,
      })
    ).toEqual(op.request);
    expect(
      () =>
        new VideogenCapacitySchedulerBinding(
          core,
          selections.map((s) => ({ ...s, capacity_binding_id: "video-b" })),
          f.videos
        )
    ).toThrow("worker/profile");
    expect(
      () =>
        new VideogenCapacitySchedulerBinding(
          core,
          selections.map((s) => ({ ...s, profile_sha256: sha256("stale") })),
          f.videos
        )
    ).toThrow("worker/profile");
    expect(() => scheduler.requestFor({ ...input, profile_sha256: sha256("stale") })).toThrow(
      "stale"
    );
  });
});
