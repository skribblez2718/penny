import {
  LocalApiMeterBindingSchema,
  LocalApiOperationMeter,
} from "../host-operations/local-api-meter.js";
import { NativeCapacityRuntimeSchema } from "../host-operations/native-capacity-contracts.js";
import { NativeCapacityMeter } from "../host-operations/native-capacity.js";
import { lstatSync, realpathSync } from "node:fs";
import { readVideogenPrivateFile } from "./private-input.js";
import { parseRuntimeWireJson } from "./runtime-json.js";
export { readVideogenPrivateFile } from "./private-input.js";
import { FileHostOperationResultCache } from "../host-operations/result-cache.js";
import path from "node:path";
import { Type, type Static } from "typebox";
import { ArtifactStore, previewArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  JsonValueSchema,
  validateContract,
  type ArtifactRef,
  type JsonValue,
} from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema } from "../skill-contracts/common.js";
import {
  GENERIC_CHILD_PARENT_POLICY,
  bindGenericChildYamlAuthority,
} from "../playbooks/registry.js";
import { validateImagegenChildPolicy } from "../child-workflows/imagegen-policy.js";
import { IMAGEGEN_PLAYBOOK_REGISTRATION } from "../playbooks/imagegen.js";
import { runtimeRegistrationSha256 } from "../playbooks/runtime-registration-digest.js";
import { childExecutionProgressLeaseBinding } from "../liveness-profiles.js";
import { validateImagegenRequest } from "../skill-contracts/imagegen.js";
import {
  HostCapacityPolicyV1Schema,
  HostCapacityDemandV1Schema,
  validateCapacityPolicy,
  validateCapacitySnapshot,
} from "../host-operations/capacity-contracts.js";
import type { HostOperationCapacityRuntimeOptions } from "../host-operations/capacity-runtime.js";
import { assembleVideogenEffects, VideogenAdapterManifestV1Schema } from "./runtime-adapters.js";
import {
  validateVideogenPrivateConfig,
  VideogenEffectRecipeV1Schema,
  VideogenInformationTriggerV1Schema,
  type VideogenRuntimeProvidersV1,
} from "./runtime-config.js";

export const VIDEOGEN_RUNTIME_MANIFEST_ENV = "PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE";
const MAX_MANIFEST_BYTES = 16_777_216;
const closed = { additionalProperties: false } as const;
const File = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    sha256: Sha256Schema,
    max_bytes: Type.Integer({ minimum: 1, maximum: 268_435_456 }),
  },
  closed
);
/** JSON only. {$artifact:id} substitutes a host-derived canonical ref, never a module or callback.
 * Config and recipe templates are checked against their concrete schemas after substitution. */
export const VideogenRuntimeManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-runtime-manifest.v1"),
    schema_version: Type.Literal(1),
    artifacts: Type.Array(
      Type.Object(
        {
          id: Id,
          kind: Id,
          media_type: Type.String({ minLength: 1, maxLength: 128 }),
          schema_id: Type.Optional(Type.String({ pattern: "^penny\\.[a-z0-9-]+\\.v[1-9][0-9]*$" })),
          source: Type.Union([
            Type.Object({ json: JsonValueSchema }, closed),
            Type.Object({ file: File }, closed),
          ]),
        },
        closed
      ),
      { maxItems: 512 }
    ),
    config: JsonValueSchema,
    recipes: Type.Array(JsonValueSchema, { maxItems: 1024 }),
    adapters: Type.Array(JsonValueSchema, { maxItems: 7 }),
    result_cache_root: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    capacity: Type.Optional(
      Type.Union([
        Type.Object(
          {
            policy: HostCapacityPolicyV1Schema,
            measurement_file: Type.String({ minLength: 1, maxLength: 4096 }),
            demands: Type.Array(
              Type.Object(
                {
                  operation_kind: Id,
                  binding_id: Id,
                  demands: Type.Array(HostCapacityDemandV1Schema, { minItems: 1, maxItems: 32 }),
                },
                closed
              ),
              { minItems: 1, maxItems: 64 }
            ),
          },
          closed
        ),
        Type.Object(
          {
            policy: HostCapacityPolicyV1Schema,
            local_api: LocalApiMeterBindingSchema,
            demands: Type.Array(
              Type.Object(
                {
                  operation_kind: Id,
                  binding_id: Id,
                  demands: Type.Array(HostCapacityDemandV1Schema, { minItems: 1, maxItems: 32 }),
                },
                closed
              ),
              { minItems: 1, maxItems: 64 }
            ),
          },
          closed
        ),
        Type.Object(
          {
            policy: HostCapacityPolicyV1Schema,
            native: NativeCapacityRuntimeSchema,
            demands: Type.Array(
              Type.Object(
                {
                  operation_kind: Id,
                  binding_id: Id,
                  demands: Type.Array(HostCapacityDemandV1Schema, { minItems: 1, maxItems: 32 }),
                },
                closed
              ),
              { minItems: 1, maxItems: 64 }
            ),
          },
          closed
        ),
      ])
    ),
    information_triggers: Type.Optional(Type.Array(JsonValueSchema, { maxItems: 6 })),
    image_children: Type.Optional(
      Type.Object(
        {
          authorization_id: Id,
          max_calls: Type.Integer({ minimum: 1, maximum: 64 }),
          requests: Type.Array(
            Type.Object(
              {
                asset_id: Id,
                request: JsonValueSchema,
                profile_sha256: Sha256Schema,
                cost_microcredits: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              },
              closed
            ),
            { minItems: 1, maxItems: 64 }
          ),
        },
        closed
      )
    ),
  },
  closed
);
export type VideogenRuntimeManifestV1 = Static<typeof VideogenRuntimeManifestV1Schema>;

function json(bytes: Buffer): unknown {
  try {
    return parseRuntimeWireJson(bytes, {
      schema_id: "penny.videogen-foundation-limits.v1",
      schema_version: 1,
      max_json_bytes: MAX_MANIFEST_BYTES,
      max_text_bytes: MAX_MANIFEST_BYTES,
      max_collection_items: 32768,
      max_depth: 48,
      max_nodes: 200000,
      max_integer: Number.MAX_SAFE_INTEGER,
    });
  } catch {
    throw new Error("VIDEOGEN_MANIFEST_INVALID_JSON");
  }
}
/** Reject excessive JSON complexity before recursive substitution/schema evaluation. */
function bounded(value: unknown): void {
  let count = 0,
    bytes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++count > 200_000 || depth > 48) throw new Error("VIDEOGEN_MANIFEST_COMPLEXITY");
    if (typeof v === "string") bytes += Buffer.byteLength(v);
    if (bytes > MAX_MANIFEST_BYTES) throw new Error("VIDEOGEN_MANIFEST_COMPLEXITY");
    if (v !== null && typeof v === "object") {
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
        throw new Error("VIDEOGEN_MANIFEST_PLAIN_JSON_REQUIRED");
      for (const key of Reflect.ownKeys(v)) {
        if (Array.isArray(v) && key === "length") continue;
        if (typeof key !== "string") throw new Error("VIDEOGEN_MANIFEST_PLAIN_JSON_REQUIRED");
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new Error("VIDEOGEN_MANIFEST_UNSAFE_KEY");
        bytes += Buffer.byteLength(key);
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          throw new Error("VIDEOGEN_MANIFEST_PLAIN_JSON_REQUIRED");
        const child: unknown = descriptor.value;
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}
export function parseVideogenRuntimeManifest(value: unknown): VideogenRuntimeManifestV1 {
  bounded(value);
  return validateContract(VideogenRuntimeManifestV1Schema, value, "videogen runtime manifest");
}
/** Typed JSON builder for private callers and complete fixture templates. Returns an
 * independent copy so caller mutation cannot change admitted manifest closures. */
export function buildVideogenRuntimeManifest(
  input: Omit<VideogenRuntimeManifestV1, "schema_id" | "schema_version">
): VideogenRuntimeManifestV1 {
  const manifest = parseVideogenRuntimeManifest({
    ...input,
    schema_id: "penny.videogen-runtime-manifest.v1",
    schema_version: 1,
  });
  return parseVideogenRuntimeManifest(json(Buffer.from(canonicalJson(manifest))));
}
export function resolveVideogenSymbols(
  value: JsonValue,
  refs: ReadonlyMap<string, ArtifactRef>
): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x) => resolveVideogenSymbols(x, refs));
  if ("$artifact_digest" in value) {
    const id = value["$artifact_digest"];
    if (Object.keys(value).length !== 1 || typeof id !== "string")
      throw new Error("invalid videogen digest symbol");
    const ref = refs.get(id);
    if (!ref) throw new Error(`missing_input: videogen artifact symbol ${id}`);
    return ref.content_digest;
  }
  if ("$artifact" in value) {
    const id = value["$artifact"];
    if (Object.keys(value).length !== 1 || typeof id !== "string")
      throw new Error("invalid videogen artifact symbol");
    const ref = refs.get(id);
    if (ref === undefined) throw new Error(`missing_input: videogen artifact symbol ${id}`);
    return validateContract(JsonValueSchema, ref, "canonical bootstrap ref");
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, resolveVideogenSymbols(v, refs)])
  );
}
/** Materialize an already validated manifest into the current store. Plan all refs and validate
 * config/recipes/bindings before persisting any bytes. Reopen adopts exact content coordinates. */
export function bootstrapVideogenRuntime(input: {
  readonly manifest: unknown;
  readonly store: ArtifactStore;
  readonly project_id: string;
  readonly project_root?: string;
  /** Trusted constructor-only physical probe seam; never manifest data. */
  readonly native_meter_probes?: ConstructorParameters<typeof NativeCapacityMeter>[3];
}): VideogenRuntimeProvidersV1 {
  const m = buildVideogenRuntimeManifest(parseVideogenRuntimeManifest(input.manifest)),
    { store, project_id } = input;
  store.assertBoundProject(project_id);
  const digest = sha256(canonicalJson(m)),
    refs = new Map<string, ArtifactRef>();
  const plans: Parameters<ArtifactStore["persist"]>[0][] = [];
  for (const a of m.artifacts) {
    if (refs.has(a.id)) throw new Error("duplicate videogen bootstrap artifact ID");
    let content: Buffer | string;
    if ("json" in a.source) content = canonicalJson(resolveVideogenSymbols(a.source.json, refs));
    else {
      content = readVideogenPrivateFile(a.source.file.path, a.source.file.max_bytes);
      if (sha256(content) !== a.source.file.sha256) throw new Error("VIDEOGEN_PRIVATE_INPUT_DRIFT");
      if (a.media_type === "application/json") {
        const value = json(content);
        bounded(value);
        if (canonicalJson(value) !== content.toString())
          throw new Error("videogen JSON source must be canonical");
      }
    }
    const plan = {
      metadata: {
        schema_version: 2 as const,
        run_id: `videogen-bootstrap-${digest}`,
        phase: "private-config",
        branch_id: null,
        kind: a.kind,
        operation_id: `videogen-bootstrap:${a.id}`,
        version: 1,
        producer: "host:videogen-bootstrap",
        media_type: a.media_type,
        ...(a.schema_id === undefined
          ? {}
          : { content_schema: { schema_id: a.schema_id, schema_version: 1 } }),
        parent_ref: null,
        upstream_refs: [],
      },
      content,
    };
    plans.push(plan);
    refs.set(a.id, previewArtifactRef(plan));
  }
  const cacheRoot = m.result_cache_root;
  if (cacheRoot !== undefined) {
    const stat = lstatSync(cacheRoot);
    if (
      !path.isAbsolute(cacheRoot) ||
      realpathSync(cacheRoot) !== cacheRoot ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
    )
      throw new Error("VIDEOGEN_RESULT_CACHE_ROOT_UNSAFE");
  }
  const result_cache =
    cacheRoot === undefined
      ? undefined
      : {
          read: async (key: string) =>
            (await FileHostOperationResultCache.openExisting(cacheRoot)).read(key),
          write: async (key: string, bytes: Uint8Array) =>
            (await FileHostOperationResultCache.openExisting(cacheRoot)).write(key, bytes),
        };
  const resolvedConfig = resolveVideogenSymbols(m.config, refs);
  if (
    resolvedConfig === null ||
    typeof resolvedConfig !== "object" ||
    Array.isArray(resolvedConfig)
  )
    throw new Error("videogen config template must be an object");
  const capacity = m.capacity;
  const nativeMeter =
    capacity !== undefined && "native" in capacity
      ? new NativeCapacityMeter(
          capacity.native,
          capacity.policy,
          capacity.native.gpu_probe,
          input.native_meter_probes
        )
      : undefined;
  const localMeter =
    capacity !== undefined && "local_api" in capacity
      ? new LocalApiOperationMeter(store, capacity.policy, capacity.local_api)
      : undefined;
  const capacity_options: HostOperationCapacityRuntimeOptions | undefined =
    capacity === undefined
      ? undefined
      : {
          policy: validateCapacityPolicy(capacity.policy),
          measurements: localMeter ??
            nativeMeter ?? {
              read: () => {
                if (!("measurement_file" in capacity))
                  throw new Error("videogen actual measurement source missing");
                return validateCapacitySnapshot(
                  json(readVideogenPrivateFile(capacity.measurement_file, MAX_MANIFEST_BYTES))
                );
              },
            },
          demands: {
            requestFor: (context) => {
              const matches = capacity.demands.filter(
                (x) => x.operation_kind === context.directive.operation_kind
              );
              const match = matches[0];
              if (matches.length !== 1 || match === undefined)
                throw new Error("videogen capacity demand missing or ambiguous");
              return {
                schema_id: "penny.host-capacity-request.v1",
                schema_version: 1,
                project_id: context.project_id,
                operation_record_id: context.operation_record_id,
                binding_id: match.binding_id,
                // Manifest ordering is not resource priority. Emit the capacity
                // protocol's canonical order without changing members or allowances.
                demands: structuredClone(match.demands).sort((left, right) =>
                  left.resource_id === right.resource_id
                    ? 0
                    : left.resource_id < right.resource_id
                      ? -1
                      : 1
                ),
              };
            },
          },
        };
  const config = validateVideogenPrivateConfig({ ...resolvedConfig, config_digest: digest });
  const recipes = m.recipes.map((value) =>
    validateContract(
      VideogenEffectRecipeV1Schema,
      resolveVideogenSymbols(value, refs),
      "videogen recipe"
    )
  );
  const adapterManifests = m.adapters.map((value) =>
    validateContract(
      VideogenAdapterManifestV1Schema,
      resolveVideogenSymbols(value, refs),
      "videogen adapter binding"
    )
  );
  if (new Set(adapterManifests.map((a) => a.kind)).size !== adapterManifests.length)
    throw new Error("duplicate videogen adapter kind");
  const triggers = (m.information_triggers ?? []).map((value) =>
    validateContract(
      VideogenInformationTriggerV1Schema,
      resolveVideogenSymbols(value, refs),
      "videogen information trigger"
    )
  );
  if (new Set(triggers.map((t) => t.trigger_state)).size !== triggers.length)
    throw new Error("duplicate information trigger state");
  const names = new Set<string>(triggers.map((t) => t.child_name));
  const information_child =
    triggers.length === 0
      ? undefined
      : {
          schema_version: 1 as const,
          authorization_id: "operator.videogen-information-child.v1" as const,
          parent_states: ["child_call"] as const,
          parent_policy: {
            ...GENERIC_CHILD_PARENT_POLICY,
            authorization_id: "operator.videogen-information-child.v1" as const,
            max_calls: triggers.length,
            targets: GENERIC_CHILD_PARENT_POLICY.targets.filter((t) => names.has(t.child_name)),
          },
        };
  const image_requests = new Map(
    (m.image_children?.requests ?? []).map((row) => [
      row.asset_id,
      validateImagegenRequest(resolveVideogenSymbols(row.request, refs)),
    ])
  );
  if (image_requests.size !== (m.image_children?.requests.length ?? 0))
    throw new Error("duplicate image asset request");
  const imagegen_child =
    m.image_children === undefined
      ? undefined
      : validateImagegenChildPolicy({
          schema_version: 1,
          authorization_id: m.image_children.authorization_id,
          max_calls: m.image_children.max_calls,
          max_active_children: 1,
          max_nesting_depth: 1,
          project_concurrency_limit: 1,
          asset_ids: [...image_requests.keys()],
          parent_states: ["image_child"],
          provider_registration_sha256: runtimeRegistrationSha256(
            input.project_root === undefined
              ? IMAGEGEN_PLAYBOOK_REGISTRATION
              : bindGenericChildYamlAuthority(IMAGEGEN_PLAYBOOK_REGISTRATION, input.project_root)
          ),
          progress_lease: childExecutionProgressLeaseBinding(),
        });
  // Constructors are fixed compiled factories. No JSON executable code or callback verdicts.
  const effects = assembleVideogenEffects(adapterManifests, config.limits, nativeMeter, localMeter);
  if (effects.size > 0 && capacity === undefined)
    throw new Error("VIDEOGEN_CAPACITY_REQUIRED: fixed adapters need actual policy and metering");
  if (
    localMeter &&
    adapterManifests.some(
      (a) =>
        (a.kind === "voice_job" || a.kind === "video_render" || a.kind === "reference_upload") &&
        !("assurance" in a.binding)
    )
  )
    throw new Error("API accounting cannot substitute for managed or legacy measurement semantics");
  if (capacity !== undefined) {
    if (new Set(capacity.demands.map((d) => d.operation_kind)).size !== capacity.demands.length)
      throw new Error("videogen capacity demand missing or ambiguous");
    for (const [kind, provider] of effects) {
      const demand = capacity.demands.find((d) => d.operation_kind === kind);
      const binding = capacity.policy.bindings.find((b) => b.binding_id === demand?.binding_id);
      const adapter = adapterManifests.find((a) => a.kind === kind);
      if (
        adapter &&
        (adapter.kind === "video_render" || adapter.kind === "reference_upload") &&
        "managed" in adapter.binding &&
        binding?.worker_id !== adapter.binding.managed.worker.worker_id
      )
        throw new Error("VIDEOGEN_MANAGED_CAPACITY_WORKER_DRIFT");
      if (
        demand === undefined ||
        binding === undefined ||
        binding.operation_kind !== kind ||
        binding.adapter_id !== provider.declaration.adapter_id ||
        binding.backend_binding_id !== provider.declaration.backend_binding_id ||
        demand.demands.length !== binding.resource_ids.length ||
        new Set(demand.demands.map((d) => d.resource_id)).size !== demand.demands.length ||
        demand.demands.some((d) => !binding.resource_ids.includes(d.resource_id))
      )
        throw new Error("VIDEOGEN_CAPACITY_BINDING_DRIFT");
    }
  }
  for (const recipe of recipes)
    if (!effects.has(recipe.kind)) throw new Error(`VIDEOGEN_PROVIDER_MISSING: ${recipe.kind}`);
  for (const plan of plans) {
    const expected = previewArtifactRef(plan),
      prior = store.refById(expected.artifact_id);
    const ref = prior ?? store.persist(plan);
    if (
      canonicalJson(ref) !== canonicalJson(expected) ||
      sha256(store.read(ref)) !== expected.content_digest
    )
      throw new Error("videogen bootstrap immutable artifact conflict");
  }
  return {
    project_id,
    config,
    recipes,
    effects,
    ...(result_cache === undefined ? {} : { result_cache }),
    ...(capacity_options === undefined ? {} : { capacity_options }),
    ...(information_child === undefined
      ? {}
      : { information_child, information_triggers: triggers }),
    ...(imagegen_child === undefined
      ? {}
      : {
          imagegen_child,
          image_requests,
          image_calls: new Map(
            (m.image_children?.requests ?? []).map((row) => [
              row.asset_id,
              { profile_sha256: row.profile_sha256, cost_microcredits: row.cost_microcredits },
            ])
          ),
        }),
  };
}
export function loadVideogenRuntimeFromEnvironment(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly store: ArtifactStore;
  readonly project_id: string;
  readonly project_root?: string;
}): VideogenRuntimeProvidersV1 | undefined {
  const filename = input.env[VIDEOGEN_RUNTIME_MANIFEST_ENV];
  if (filename === undefined) return undefined;
  if (filename.trim() !== filename || filename.length === 0)
    throw new Error("VIDEOGEN_MANIFEST_PATH_INVALID");
  return bootstrapVideogenRuntime({
    ...input,
    manifest: json(readVideogenPrivateFile(filename, MAX_MANIFEST_BYTES)),
  });
}
