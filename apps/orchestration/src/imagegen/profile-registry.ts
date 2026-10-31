import { ComfyWorkerIdentityRegistry } from "../comfy/worker-identity.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  validateImagegenProfile,
  validateImagegenProfileSnapshot,
  type ImagegenProfileV1,
} from "../skill-contracts/imagegen.js";
import type {
  ImagegenNodeClassSafetyPolicyV1,
  ImagegenProfileRegistry,
  ResolvedImagegenProfileV1,
} from "./types.js";

interface StoredProfileV1 {
  readonly canonical_profile: string;
  readonly profile_sha256: string;
  readonly backend_key_sha256: string;
}

function assertSafetyPolicy(policy: ImagegenNodeClassSafetyPolicyV1, label: string): void {
  if (
    policy.schema_version !== 1 ||
    (policy.execution_class !== "pure_compute" &&
      policy.execution_class !== "backend_output" &&
      policy.execution_class !== "registered_input") ||
    policy.class_type.length === 0 ||
    policy.class_type.length > 128
  ) {
    throw new Error(`${label} is not a supported imagegen node policy`);
  }
  if (policy.inputs.length === 0 || policy.inputs.length > 128) {
    throw new Error(`${label} has an invalid input policy count`);
  }
  const names = policy.inputs.map((input) => input.input_name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${label} has duplicate input policies`);
  }
}

function parsedProfile(canonical: string): ImagegenProfileV1 {
  const value: unknown = JSON.parse(canonical);
  const profile = validateImagegenProfile(value);
  if (canonicalJson(profile) !== canonical) {
    throw new Error("stored imagegen profile is not canonical JSON");
  }
  return profile;
}

/**
 * Immutable, injected profile authority. Concrete profiles and class policies are supplied by the
 * host; tracked Penny code contains no profile IDs, graph assets, model names, ports, or paths.
 */
export class StaticImagegenProfileRegistry implements ImagegenProfileRegistry {
  private readonly profiles = new Map<string, StoredProfileV1>();
  private readonly defaultProfileId: string | undefined;

  constructor(input: {
    readonly profiles: readonly unknown[];
    readonly approved_profile_sha256_by_id: ReadonlyMap<string, string>;
    readonly node_class_policies: readonly ImagegenNodeClassSafetyPolicyV1[];
    readonly default_profile_id?: string;
    readonly approved_revision_sha256_by_profile_id?: ReadonlyMap<string, string>;
    /** Explicit host-only opt-in; absence preserves the retained endpoint key. */
    readonly worker_identities?: ComfyWorkerIdentityRegistry;
  }) {
    if (
      input.worker_identities !== undefined &&
      !(input.worker_identities instanceof ComfyWorkerIdentityRegistry)
    )
      throw new Error("imagegen actual worker registry invalid");
    const policies = new Map<string, ImagegenNodeClassSafetyPolicyV1>();
    for (const [index, policy] of input.node_class_policies.entries()) {
      assertSafetyPolicy(policy, `imagegen node class policy[${index}]`);
      if (policies.has(policy.class_type)) {
        throw new Error(`duplicate imagegen node class policy '${policy.class_type}'`);
      }
      policies.set(policy.class_type, policy);
    }
    for (const value of input.profiles) {
      const profile = validateImagegenProfile(value);
      if (this.profiles.has(profile.profile_id)) {
        throw new Error(`duplicate imagegen profile '${profile.profile_id}'`);
      }
      const approved = input.approved_profile_sha256_by_id.get(profile.profile_id);
      if (approved === undefined || approved !== profile.profile_sha256) {
        throw new Error(`imagegen profile '${profile.profile_id}' is not exactly approved`);
      }
      for (const nodeClass of profile.node_classes) {
        const hostPolicy = policies.get(nodeClass.class_type);
        if (hostPolicy === undefined) {
          throw new Error(
            `imagegen profile '${profile.profile_id}' class '${nodeClass.class_type}' has no host safety policy`
          );
        }
        if (
          hostPolicy.execution_class !== nodeClass.execution_class ||
          canonicalJson(hostPolicy.inputs) !== canonicalJson(nodeClass.inputs)
        ) {
          throw new Error(
            `imagegen profile '${profile.profile_id}' class '${nodeClass.class_type}' safety policy drifted`
          );
        }
      }
      const graphClasses = new Set(
        Object.values(profile.source_graph).map((node) => node.class_type)
      );
      const requiredClasses = new Set(profile.required_inventory.class_types);
      for (const classType of graphClasses) {
        if (!requiredClasses.has(classType)) {
          throw new Error(
            `imagegen profile '${profile.profile_id}' omits graph class '${classType}' from required inventory`
          );
        }
      }
      if (
        profile.revision_capability !== undefined &&
        (input.worker_identities === undefined ||
          input.approved_revision_sha256_by_profile_id?.get(profile.profile_id) !==
            sha256(canonicalJson(profile.revision_capability)))
      )
        throw new Error(
          "revision requires explicit actual worker and independently approved capability binding"
        );
      const canonical = canonicalJson(profile);
      this.profiles.set(profile.profile_id, {
        canonical_profile: canonical,
        profile_sha256: profile.profile_sha256,
        backend_key_sha256:
          input.worker_identities === undefined
            ? sha256(
                canonicalJson({
                  schema_version: 1,
                  endpoint: profile.endpoint,
                })
              )
            : input.worker_identities.keyFor(profile.endpoint),
      });
    }
    if (this.profiles.size === 0) throw new Error("imagegen profile registry is empty");
    if (input.default_profile_id !== undefined && !this.profiles.has(input.default_profile_id)) {
      throw new Error("imagegen default profile is not registered");
    }
    this.defaultProfileId = input.default_profile_id;
  }

  resolve(profileId?: string): ResolvedImagegenProfileV1 {
    const selected = profileId ?? this.defaultProfileId;
    if (selected === undefined) throw new Error("imagegen has no configured default profile");
    const stored = this.profiles.get(selected);
    if (stored === undefined) throw new Error(`imagegen profile '${selected}' is not registered`);
    const profile = parsedProfile(stored.canonical_profile);
    if (profile.profile_sha256 !== stored.profile_sha256) {
      throw new Error(`imagegen profile '${selected}' drifted after registry admission`);
    }
    const snapshot = validateImagegenProfileSnapshot({
      schema_id: "penny.imagegen-profile-snapshot.v1",
      schema_version: 1,
      profile,
      approved_profile_sha256: stored.profile_sha256,
      source_graph_sha256: profile.source_graph_sha256,
    });
    return {
      profile,
      snapshot,
      backend_key_sha256: stored.backend_key_sha256,
    };
  }
}
