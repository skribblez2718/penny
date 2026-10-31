#!/usr/bin/env node
import {
  VoiceApiBindingRequestSchema,
  buildVoiceApiBinding,
} from "./videogen/voice-api-binding.js";
import { VideogenRuntimeManifestV1Schema } from "./videogen/runtime-manifest.js";
import { VideogenAdapterManifestV1Schema } from "./videogen/runtime-adapters.js";
import { VoiceApiProfileSchema } from "./videogen/voice-api-contracts.js";
import { LocalApiMeterBindingSchema } from "./host-operations/local-api-meter.js";
import { HostCapacityPolicyV1Schema } from "./host-operations/capacity-contracts.js";
import { HostOperationCapacityAuthority } from "./host-operations/capacity-authority.js";
import { Sha256Schema, OpaqueIdSchema } from "./skill-contracts/common.js";
export const CapacityPolicyVersionRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-capacity-policy-version-request.v1"),
    schema_version: Type.Literal(1),
    state_root: Type.String({ minLength: 1, maxLength: 4096 }),
    expected_policy_sha256: Sha256Schema,
    binding_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 256, uniqueItems: true }),
    policy: HostCapacityPolicyV1Schema,
  },
  { additionalProperties: false }
);
/** Fixed service composition entrypoint. No JS bindings, service restart or implicit preload. */
import { ComfyHttpClient } from "./comfy/client.js";
import { requireComfyGraphInventory } from "./comfy/graph-inventory.js";
import { VideogenProfileV1Schema, validateVideogenProfile } from "./videogen/contracts.js";
import { sha256 } from "./canonical-json.js";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestrationService } from "./service.js";
import { parseVoiceWireJson } from "./videogen/voice-json.js";
import { VoicePrivateBindingSchema } from "./videogen/voice-private-client.js";
import { Type } from "typebox";
import { validateSkillSchema } from "./skill-contracts/common.js";
import { readVideogenPrivateFile } from "./videogen/private-input.js";
import {
  VoicePreparationRequestSchema,
  VoicePreparationBindingsSchema,
  parseVoicePreparationBindings,
} from "./videogen/voice-preparation.js";
import { runVoicePreparationJob } from "./videogen/voice-preparation-job.js";
export const VoicePreparationCliRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.voice-preparation-cli.v1"),
    schema_version: Type.Literal(1),
    bindings_file: Type.String({ minLength: 1, maxLength: 4096 }),
    request: VoicePreparationRequestSchema,
  },
  { additionalProperties: false }
);

export const ComfyInspectionRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-comfy-inspection-request.v1"),
    schema_version: Type.Literal(1),
    profile: VideogenProfileV1Schema,
  },
  { additionalProperties: false }
);

/** Publish a new private complete JSON file; never overwrite/repair caller state. */
function publishPrivateJson(target: string, value: unknown): void {
  if (!path.isAbsolute(target) || path.resolve(target) !== target)
    throw new Error("canonical absolute output path required");
  const parent = path.dirname(target),
    st = fs.lstatSync(parent);
  if (
    fs.realpathSync(parent) !== parent ||
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o077) !== 0
  )
    throw new Error("output directory must be canonical owner-only");
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    fs.writeFileSync(fd, canonicalJson(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, target); // Atomic no-replace publication, unlike rename over an existing file.
    const directory = fs.openSync(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function runVideogenRuntimeCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  input: AsyncIterable<unknown> = stdin,
  write: (text: string) => void = (text) => {
    stdout.write(text);
  }
): Promise<void> {
  if (args.length === 1 && args[0] === "--api-schemas") {
    write(
      JSON.stringify({
        manifest: VideogenRuntimeManifestV1Schema,
        adapter: VideogenAdapterManifestV1Schema,
        profile: VoiceApiProfileSchema,
        meter: LocalApiMeterBindingSchema,
        binding_request: VoiceApiBindingRequestSchema,
        policy_version_request: CapacityPolicyVersionRequestSchema,
        comfy_inspection_request: ComfyInspectionRequestSchema,
      }) + "\n"
    );
    return;
  }
  if (
    args.length === 3 &&
    args[0] === "inspect-comfy" &&
    args[1]?.startsWith("--requestfile=") &&
    args[2]?.startsWith("--outputfile=")
  ) {
    const request = validateSkillSchema(
      ComfyInspectionRequestSchema,
      parseVoiceWireJson(readVideogenPrivateFile(args[1].slice("--requestfile=".length), 1048576)),
      "Comfy GET-only inspection"
    );
    const profile = validateVideogenProfile(request.profile),
      l = profile.limits;
    const client = new ComfyHttpClient(profile.endpoint, {
      connect_timeout_ms: l.connect_timeout_ms,
      read_timeout_ms: l.read_timeout_ms,
      max_readiness_bytes: l.max_inventory_json_bytes,
      max_inventory_bytes: l.max_inventory_json_bytes,
      max_request_bytes: l.max_request_json_bytes,
      max_history_bytes: l.max_history_json_bytes,
      max_image_bytes: l.max_video_bytes,
    });
    const inventory = await client.inventory({ signal: new AbortController().signal });
    requireComfyGraphInventory(profile.source_graph, inventory.object_info);
    const selected = Object.fromEntries(
      [
        ...new Set([
          ...profile.required_inventory.class_types,
          ...Object.values(profile.source_graph).map((node) => node.class_type),
        ]),
      ]
        .sort()
        .map((name) => [name, inventory.object_info[name]])
    );
    publishPrivateJson(args[2].slice("--outputfile=".length), selected);
    write(
      canonicalJson({
        inspection: "valid",
        selected_sha256: sha256(canonicalJson(selected)),
        assurance: "object_info_only_not_generation_or_model_residency",
      }) + "\n"
    );
    return;
  }
  if (
    ((args.length === 2 && (args[0] === "bind-api" || args[0] === "install-policy-version")) ||
      (args.length === 3 && args[0] === "bind-api" && args[2]?.startsWith("--outputfile="))) &&
    args[1]?.startsWith("--requestfile=")
  ) {
    const value = parseVoiceWireJson(
      readVideogenPrivateFile(args[1].slice("--requestfile=".length), 1048576)
    );
    if (args[0] === "bind-api") {
      const fragment = await buildVoiceApiBinding(value, AbortSignal.timeout(30000));
      if (args[2] !== undefined) {
        publishPrivateJson(args[2].slice("--outputfile=".length), fragment);
        write('{"binding":"written","assurance":"trusted_local_api"}\n');
      } else write(canonicalJson(fragment) + "\n");
    } else {
      const r = validateSkillSchema(
        CapacityPolicyVersionRequestSchema,
        value,
        "explicit capacity policy version"
      );
      HostOperationCapacityAuthority.installUnreservedVersion(
        r.state_root,
        r.policy,
        r.expected_policy_sha256,
        r.binding_ids
      );
      write('{"policy_version":"installed","services_changed":false}\n');
    }
    return;
  }
  if (args.length === 1 && args[0] === "--prep-schema") {
    write(
      JSON.stringify({
        request: VoicePreparationCliRequestSchema,
        bindings: VoicePreparationBindingsSchema,
      }) + "\n"
    );
    return;
  }
  const prepFile =
    args.length === 2 && args[0] === "prep" && args[1]?.startsWith("--requestfile=")
      ? args[1].slice("--requestfile=".length)
      : args.length === 3 && args[0] === "prep" && args[1] === "--requestfile"
        ? args[2]
        : undefined;
  if (prepFile !== undefined) {
    const envelope = validateSkillSchema(
      VoicePreparationCliRequestSchema,
      parseVoiceWireJson(readVideogenPrivateFile(prepFile, 65536)),
      "voice preparation CLI request"
    );
    const bindings = parseVoicePreparationBindings(
      readVideogenPrivateFile(envelope.bindings_file, 8 * 1024 * 1024)
    );
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      write(
        JSON.stringify(
          await runVoicePreparationJob(bindings, envelope.request, controller.signal)
        ) + "\n"
      );
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (args.length === 1 && args[0] === "--voice-binding-schema") {
    write(
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...VoicePrivateBindingSchema,
      }) + "\n"
    );
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    write(
      "Usage: videogen-runtime-cli --check|--execute --project-root=PATH\nRequires PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE and already initialized state/policy.\n--execute reads one closed orchestration request on stdin; --check only constructs/closes the fixed service.\n--voice-binding-schema prints the private Voice control binding schema.\nprep --requestfile=PATH runs one explicit typed, native-capacity-guarded model preparation job.\n--prep-schema prints its closed request and active-bindings contracts.\n--api-schemas prints the closed normal-API manifest/binding/profile/meter/version contracts.\nbind-api --requestfile=PATH [--outputfile=NEW_PRIVATE_PATH] performs bounded GET-only schema/saved-voice inspection and emits an exact JSON manifest fragment.\ninstall-policy-version --requestfile=PATH explicitly selects a new immutable policy version, only with no reservations/queues/active or quarantined leases.\ninspect-comfy --requestfile=PATH --outputfile=NEW_PRIVATE_PATH validates the complete selected source graph against bounded GET /object_info and pins only its classes.\nNever restarts a service or implicitly preloads a model.\n"
    );
    return;
  }
  const mode = args[0],
    root = args[1];
  if (
    args.length !== 2 ||
    (mode !== "--check" && mode !== "--execute") ||
    !root?.startsWith("--project-root=") ||
    !env.PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE
  )
    throw new Error("explicit mode, project root and private runtime manifest required");
  using service = new OrchestrationService({
    projectRoot: root.slice("--project-root=".length),
    playbookName: "videogen",
    env,
  });
  if (mode === "--check") {
    write('{"configuration":"valid","live_readiness":"not_assessed"}\n');
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw new Error("byte request required");
    size += chunk.byteLength;
    if (size > 4 * 1024 * 1024) throw new Error("orchestration request byte limit");
    chunks.push(Buffer.from(chunk));
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    write(
      JSON.stringify(
        await service.execute(parseVoiceWireJson(Buffer.concat(chunks)), controller.signal)
      ) + "\n"
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runVideogenRuntimeCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('{"error":"videogen_runtime_refused"}\n');
    process.exitCode = 1;
  });
