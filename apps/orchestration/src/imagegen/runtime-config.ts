import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import {
  SqliteImagegenActivationController,
  type ImagegenActivationCanaryDeclarationV1,
  type ImagegenActivationModeV1,
} from "./activation.js";
import { COMFY_IMAGEGEN_ADAPTER_ID, ComfyImagegenOperationAdapter } from "./operation-owner.js";
import {
  COMFY_IMAGEGEN_READINESS_ADAPTER_ID,
  ComfyImagegenReadinessAdapter,
} from "./readiness-operation.js";
import { IMAGEGEN_EXPORT_ADAPTER_ID, ImagegenExportOperationAdapter } from "./export-operation.js";
import { StaticImagegenExportRegistry } from "./export-registry.js";
import { StaticImagegenProfileRegistry } from "./profile-registry.js";
import { SqliteImagegenStorageAdmission } from "./storage-admission.js";
import type {
  ImagegenNodeClassSafetyPolicyV1,
  ImagegenStartAdmissionProvidersV1,
} from "./types.js";

const RUNTIME_MANIFEST_ENV = "PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE";
const MAX_RUNTIME_MANIFEST_BYTES = 16_777_216;

interface RuntimeActivationV1 {
  readonly mode: ImagegenActivationModeV1;
  readonly canary?: ImagegenActivationCanaryDeclarationV1;
}

interface RuntimeManifestV1 {
  readonly schema_version: 1;
  readonly default_profile_id?: string;
  readonly approved_profile_sha256_by_id: Readonly<Record<string, string>>;
  readonly profiles: readonly unknown[];
  readonly node_class_policies: readonly ImagegenNodeClassSafetyPolicyV1[];
  readonly activation: RuntimeActivationV1;
  readonly storage: {
    readonly ceiling_bytes: number;
    readonly warning_threshold_bytes: number;
  };
  readonly export_destinations: readonly {
    readonly destination_id: string;
    readonly root: string;
    readonly max_files: number;
    readonly max_bytes: number;
  }[];
}

export interface LoadedImagegenRuntimeV1 {
  readonly providers: ImagegenStartAdmissionProvidersV1;
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allow.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields`);
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer no less than ${minimum}`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be text`);
  return value;
}

function nodeInputValueType(
  value: unknown
): ImagegenNodeClassSafetyPolicyV1["inputs"][number]["value_type"] {
  if (
    value === "string" ||
    value === "integer" ||
    value === "number" ||
    value === "boolean" ||
    value === "json"
  ) {
    return value;
  }
  throw new Error("imagegen node input has an unsupported value type");
}

function nodeInputSemantic(
  value: unknown
): ImagegenNodeClassSafetyPolicyV1["inputs"][number]["semantic"] {
  if (value === "data" || value === "registered_asset") return value;
  throw new Error("imagegen node input has an unsupported semantic");
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} digest is invalid`);
  }
  return value;
}

/**
 * Parse the closed activation policy. Absence is fail-closed to `disabled`, so a deployment never
 * gains ordinary start authority by omission.
 */
function parseActivation(value: unknown): RuntimeActivationV1 {
  if (value === undefined) return { mode: "disabled" };
  const activation = record(value, "imagegen activation policy");
  exactKeys(activation, ["mode", "canary"], "imagegen activation policy");
  const mode = activation["mode"];
  if (mode !== "disabled" && mode !== "canary" && mode !== "enabled") {
    throw new Error("imagegen activation mode is unsupported");
  }
  const canaryValue = activation["canary"];
  if (canaryValue === undefined) return { mode };
  const canary = record(canaryValue, "imagegen canary capability");
  exactKeys(
    canary,
    ["canary_id", "request_sha256", "profile_sha256"],
    "imagegen canary capability"
  );
  return {
    mode,
    canary: {
      canary_id: string(canary["canary_id"], "imagegen canary capability.canary_id"),
      request_sha256: digest(canary["request_sha256"], "imagegen canary capability.request_sha256"),
      profile_sha256: digest(canary["profile_sha256"], "imagegen canary capability.profile_sha256"),
    },
  };
}

function nodeClassPolicy(value: unknown, index: number): ImagegenNodeClassSafetyPolicyV1 {
  const label = `imagegen node class policy[${index}]`;
  const policy = record(value, label);
  exactKeys(policy, ["schema_version", "class_type", "execution_class", "inputs"], label);
  if (policy["schema_version"] !== 1) throw new Error(`${label} version is unsupported`);
  const executionClass = policy["execution_class"];
  if (executionClass !== "pure_compute" && executionClass !== "backend_output") {
    throw new Error(`${label} has an unsupported execution class`);
  }
  const values = policy["inputs"];
  if (!Array.isArray(values)) throw new Error(`${label}.inputs must be an array`);
  const inputs = values.map((entry, inputIndex) => {
    const inputLabel = `${label}.inputs[${inputIndex}]`;
    const item = record(entry, inputLabel);
    exactKeys(item, ["input_name", "value_type", "semantic"], inputLabel);
    return {
      input_name: string(item["input_name"], `${inputLabel}.input_name`),
      value_type: nodeInputValueType(item["value_type"]),
      semantic: nodeInputSemantic(item["semantic"]),
    };
  });
  return {
    schema_version: 1,
    class_type: string(policy["class_type"], `${label}.class_type`),
    execution_class: executionClass,
    inputs,
  };
}

function secureManifestBytes(filename: string): Buffer {
  const requested = path.resolve(filename);
  const stat = lstatSync(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("imagegen runtime manifest must be a non-symlink regular file");
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new Error("imagegen runtime manifest has the wrong owner");
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error("imagegen runtime manifest must not be group/world writable");
  }
  if (stat.size < 1 || stat.size > MAX_RUNTIME_MANIFEST_BYTES) {
    throw new Error("imagegen runtime manifest exceeds its byte policy");
  }
  if (realpathSync(requested) !== requested) {
    throw new Error("imagegen runtime manifest path traverses a symlink");
  }
  const bytes = readFileSync(requested);
  if (bytes.byteLength !== stat.size)
    throw new Error("imagegen runtime manifest changed while read");
  return bytes;
}

function parseManifest(filename: string): RuntimeManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(secureManifestBytes(filename).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("imagegen runtime manifest is not JSON");
    throw error;
  }
  const root = record(value, "imagegen runtime manifest");
  exactKeys(
    root,
    [
      "schema_version",
      "default_profile_id",
      "approved_profile_sha256_by_id",
      "profiles",
      "node_class_policies",
      "activation",
      "storage",
      "export_destinations",
    ],
    "imagegen runtime manifest"
  );
  if (root["schema_version"] !== 1)
    throw new Error("imagegen runtime manifest version is unsupported");
  if (!Array.isArray(root["profiles"]) || !Array.isArray(root["node_class_policies"])) {
    throw new Error("imagegen runtime manifest profiles and policies must be arrays");
  }
  const approvalValues = record(
    root["approved_profile_sha256_by_id"],
    "imagegen profile approval registry"
  );
  const approvals: Record<string, string> = {};
  for (const [profileId, digest] of Object.entries(approvalValues)) {
    string(profileId, "imagegen approved profile ID");
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new Error("imagegen approved profile digest is invalid");
    }
    approvals[profileId] = digest;
  }
  const storage = record(root["storage"], "imagegen storage policy");
  exactKeys(storage, ["ceiling_bytes", "warning_threshold_bytes"], "imagegen storage policy");
  const exportValues = root["export_destinations"];
  if (!Array.isArray(exportValues))
    throw new Error("imagegen export destinations must be an array");
  const exportDestinations = exportValues.map((entry, index) => {
    const destination = record(entry, `imagegen export destination[${index}]`);
    exactKeys(
      destination,
      ["destination_id", "root", "max_files", "max_bytes"],
      `imagegen export destination[${index}]`
    );
    const exportRoot = string(destination["root"], `imagegen export destination[${index}].root`);
    if (!path.isAbsolute(exportRoot))
      throw new Error("imagegen export destination root must be absolute");
    return {
      destination_id: string(
        destination["destination_id"],
        `imagegen export destination[${index}].destination_id`
      ),
      root: exportRoot,
      max_files: integer(
        destination["max_files"],
        `imagegen export destination[${index}].max_files`,
        2
      ),
      max_bytes: integer(
        destination["max_bytes"],
        `imagegen export destination[${index}].max_bytes`,
        1
      ),
    };
  });
  const defaultProfileId = root["default_profile_id"];
  const nodeClassPolicies = root["node_class_policies"].map(nodeClassPolicy);
  return {
    schema_version: 1,
    ...(defaultProfileId === undefined
      ? {}
      : { default_profile_id: string(defaultProfileId, "imagegen default profile ID") }),
    approved_profile_sha256_by_id: approvals,
    profiles: root["profiles"],
    node_class_policies: nodeClassPolicies,
    activation: parseActivation(root["activation"]),
    storage: {
      ceiling_bytes: integer(storage["ceiling_bytes"], "imagegen storage ceiling", 1),
      warning_threshold_bytes: integer(
        storage["warning_threshold_bytes"],
        "imagegen storage warning threshold",
        0
      ),
    },
    export_destinations: exportDestinations,
  };
}

/**
 * Load operator-private imagegen authority only when the pinned manifest environment key is set.
 * Absence is fail-closed: callers receive no profile, adapter, storage, or export authority.
 */
export function loadImagegenRuntimeFromEnvironment(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly state_root: string;
}): LoadedImagegenRuntimeV1 | undefined {
  const manifestFile = input.env[RUNTIME_MANIFEST_ENV]?.trim();
  if (!manifestFile) return undefined;
  const manifest = parseManifest(manifestFile);
  const profiles = new StaticImagegenProfileRegistry({
    profiles: manifest.profiles,
    approved_profile_sha256_by_id: new Map(Object.entries(manifest.approved_profile_sha256_by_id)),
    node_class_policies: manifest.node_class_policies,
    ...(manifest.default_profile_id === undefined
      ? {}
      : { default_profile_id: manifest.default_profile_id }),
  });
  const exports = new StaticImagegenExportRegistry(manifest.export_destinations);
  const storageDirectory = path.join(input.state_root, "imagegen-storage");
  mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
  const storage = new SqliteImagegenStorageAdmission({
    directory: storageDirectory,
    ceiling_bytes: manifest.storage.ceiling_bytes,
    warning_threshold_bytes: manifest.storage.warning_threshold_bytes,
  });
  const activation = new SqliteImagegenActivationController({
    directory: path.join(input.state_root, "imagegen-activation"),
    mode: manifest.activation.mode,
    ...(manifest.activation.canary === undefined ? {} : { canary: manifest.activation.canary }),
  });
  const providers: ImagegenStartAdmissionProvidersV1 = { profiles, exports, storage, activation };
  const adapters = new Map<string, HostOperationAdapterV1>([
    [COMFY_IMAGEGEN_READINESS_ADAPTER_ID, new ComfyImagegenReadinessAdapter({ profiles })],
    [COMFY_IMAGEGEN_ADAPTER_ID, new ComfyImagegenOperationAdapter({ profiles, storage })],
    [IMAGEGEN_EXPORT_ADAPTER_ID, new ImagegenExportOperationAdapter(exports)],
  ]);
  let closed = false;
  return {
    providers,
    adapters,
    close() {
      if (closed) return;
      closed = true;
      activation.close();
      storage.close();
    },
  };
}
