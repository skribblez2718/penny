import { ComfyWorkerIdentityRegistry } from "../comfy/worker-identity.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  validateVideogenProfile,
  type VideogenProfileSnapshotV1,
  type VideogenProfileV1,
} from "./contracts.js";

export interface ResolvedVideogenProfileV1 {
  readonly profile: VideogenProfileV1;
  readonly approved_profile_sha256: string;
  readonly backend_key_sha256: string;
}

export interface VideogenProfileRegistry {
  resolve(profile_id: string): ResolvedVideogenProfileV1;
  verifySnapshot(snapshot: VideogenProfileSnapshotV1): ResolvedVideogenProfileV1;
}

export class StaticVideogenProfileRegistry implements VideogenProfileRegistry {
  private readonly profiles = new Map<string, ResolvedVideogenProfileV1>();

  constructor(input: {
    readonly profiles: readonly VideogenProfileV1[];
    readonly approved_profile_sha256_by_id: ReadonlyMap<string, string>;
    /** Explicit host-only opt-in; absence preserves the retained profile key. */
    readonly worker_identities?: ComfyWorkerIdentityRegistry;
  }) {
    if (
      input.worker_identities !== undefined &&
      !(input.worker_identities instanceof ComfyWorkerIdentityRegistry)
    )
      throw new Error("videogen actual worker registry invalid");
    for (const candidate of input.profiles) {
      const profile = validateVideogenProfile(candidate);
      if (this.profiles.has(profile.profile_id)) {
        throw new Error(`duplicate videogen profile '${profile.profile_id}'`);
      }
      const approved = input.approved_profile_sha256_by_id.get(profile.profile_id);
      if (approved === undefined || approved !== profile.profile_sha256) {
        throw new Error(
          `videogen profile '${profile.profile_id}' is not approved at its exact digest`
        );
      }
      this.profiles.set(profile.profile_id, {
        profile: structuredClone(profile),
        approved_profile_sha256: approved,
        backend_key_sha256:
          input.worker_identities === undefined
            ? sha256(
                canonicalJson({
                  adapter: "videogen.comfyui",
                  endpoint: profile.endpoint,
                  profile_id: profile.profile_id,
                  profile_sha256: profile.profile_sha256,
                })
              )
            : input.worker_identities.keyFor(profile.endpoint),
      });
    }
    if (this.profiles.size < 1) throw new Error("videogen profile registry must not be empty");
  }

  resolve(profile_id: string): ResolvedVideogenProfileV1 {
    const found = this.profiles.get(profile_id);
    if (found === undefined) throw new Error(`videogen profile '${profile_id}' is not registered`);
    return structuredClone(found);
  }

  verifySnapshot(snapshot: VideogenProfileSnapshotV1): ResolvedVideogenProfileV1 {
    const resolved = this.resolve(snapshot.profile.profile_id);
    if (
      snapshot.approved_profile_sha256 !== resolved.approved_profile_sha256 ||
      snapshot.source_graph_sha256 !== resolved.profile.source_graph_sha256 ||
      canonicalJson(snapshot.profile) !== canonicalJson(resolved.profile)
    ) {
      throw new Error("videogen profile snapshot does not match the registered approved profile");
    }
    return resolved;
  }
}
