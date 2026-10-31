import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../dist/config.js";
import {
  ComfyHttpClient,
  type ComfyClientLimitsV1,
  type ComfyEndpointV1,
} from "../dist/imagegen/comfy-client.js";
import { loadImagegenRuntimeFromEnvironment } from "../dist/imagegen/runtime-config.js";
import type { ImagegenProfileV1 } from "../dist/skill-contracts/imagegen.js";
import {
  assertImagegenSecurityInspectionGate,
  imagegenSecurityInspectionEnabled,
  imagegenSecurityInspectionIssueCodes,
  IMAGEGEN_SECURITY_INSPECTION_GATE_ENV,
  IMAGEGEN_SECURITY_INSPECTION_MANIFEST_ENV,
  IMAGEGEN_SECURITY_REPORT_DIRECTORY,
  IMAGEGEN_SECURITY_REPORT_FILENAME,
  type ImagegenSecurityCheckIdV1,
  type ImagegenSecurityCheckResultV1,
} from "./imagegen-security-inspection-contract.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const MAX_MANIFEST_BYTES = 16_777_216;
const SCAN_BYTE_CAP = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be text`);
  return value;
}

interface PrivateManifestInspectionV1 {
  readonly storage: { readonly ceiling_bytes: number; readonly warning_threshold_bytes: number };
  readonly export_destinations: readonly {
    readonly destination_id: string;
    readonly root: string;
  }[];
}

function readManifestInspection(filename: string): PrivateManifestInspectionV1 {
  const parsed: unknown = JSON.parse(readFileSync(filename, "utf8"));
  const root = requireRecord(parsed, "imagegen runtime manifest");
  const storage = requireRecord(root["storage"], "imagegen storage policy");
  const destinations = root["export_destinations"];
  if (!Array.isArray(destinations))
    throw new Error("imagegen export destinations must be an array");
  return {
    storage: {
      ceiling_bytes: requireInteger(storage["ceiling_bytes"], "storage ceiling"),
      warning_threshold_bytes: requireInteger(
        storage["warning_threshold_bytes"],
        "storage warning threshold"
      ),
    },
    export_destinations: destinations.map((entry, index) => {
      const destination = requireRecord(entry, `imagegen export destination[${index}]`);
      return {
        destination_id: requireString(
          destination["destination_id"],
          `imagegen export destination[${index}].destination_id`
        ),
        root: requireString(destination["root"], `imagegen export destination[${index}].root`),
      };
    }),
  };
}

function assertOwnerPrivate(filePath: string, label: string): void {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
}

function assertOwnerPrivateDirectory(directory: string, label: string): void {
  if (!existsSync(directory)) throw new Error(`${label} is absent`);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("loopback listener probe timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

function comfyLimits(profile: ImagegenProfileV1): ComfyClientLimitsV1 {
  return {
    max_request_bytes: profile.limits.max_request_json_bytes,
    max_readiness_bytes: profile.limits.max_history_json_bytes,
    max_inventory_bytes: profile.limits.max_inventory_json_bytes,
    max_history_bytes: profile.limits.max_history_json_bytes,
    max_image_bytes: profile.limits.max_image_bytes,
    connect_timeout_ms: profile.limits.connect_timeout_ms,
    read_timeout_ms: profile.limits.read_timeout_ms,
  };
}

async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("inspection deadline elapsed")), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function scanForMarkers(files: readonly string[], markers: readonly Buffer[]): number {
  let remaining = SCAN_BYTE_CAP;
  let found = 0;
  for (const file of files) {
    if (remaining <= 0) break;
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file).subarray(0, remaining);
    remaining -= bytes.byteLength;
    if (markers.some((marker) => bytes.includes(marker))) found += 1;
  }
  return found;
}

function writeReport(
  results: readonly ImagegenSecurityCheckResultV1[],
  issues: readonly string[]
): void {
  const directory = path.join(PROJECT_ROOT, IMAGEGEN_SECURITY_REPORT_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const report = JSON.stringify(
    { schema_version: 1, generated_at: new Date().toISOString(), checks: results, issues },
    null,
    2
  );
  const file = path.join(directory, IMAGEGEN_SECURITY_REPORT_FILENAME);
  writeFileSync(file, report, { mode: 0o600 });
  chmodSync(file, 0o600);
}

describe("opt-in deployed imagegen security inspection", () => {
  it(
    "inspects loopback, egress, identity, custody, profiles, storage, permissions, export, and leakage",
    async () => {
      assertImagegenSecurityInspectionGate(process.env);
      const manifestFile = process.env[IMAGEGEN_SECURITY_INSPECTION_MANIFEST_ENV];
      if (manifestFile === undefined) {
        throw new Error(
          `Set ${IMAGEGEN_SECURITY_INSPECTION_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
        );
      }
      const results: ImagegenSecurityCheckResultV1[] = [];
      const record = async (
        check_id: ImagegenSecurityCheckIdV1,
        run: () => Promise<void> | void
      ): Promise<void> => {
        try {
          await run();
          results.push({ check_id, status: "passed", detail_code: "ok" });
        } catch {
          // Never echo the underlying error: it may contain a private path or a response body.
          results.push({ check_id, status: "failed", detail_code: "failed" });
        }
      };

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PI_OBSERVABILITY_AUTO_START: "false",
        PI_OBSERVABILITY_ENABLED: "false",
      };
      const config = loadRuntimeConfig(PROJECT_ROOT, env);
      const loaded = loadImagegenRuntimeFromEnvironment({
        env,
        state_root: config.stateRoot,
      });
      if (loaded === undefined) {
        throw new Error(
          `Set ${IMAGEGEN_SECURITY_INSPECTION_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
        );
      }
      const manifestInspection = readManifestInspection(manifestFile);
      const resolved = loaded.providers.profiles.resolve();
      const profile = resolved.profile;
      const endpoint: ComfyEndpointV1 = profile.endpoint;
      const client = new ComfyHttpClient(endpoint, comfyLimits(profile));

      try {
        await record("loopback_listener_reachability", async () => {
          if (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") {
            throw new Error("profile endpoint is not a literal loopback address");
          }
          await probeTcp(endpoint.host, endpoint.port, 2_000);
        });

        await record("direct_client_egress_and_proxy", async () => {
          const source = readFileSync(
            path.join(PROJECT_ROOT, "apps", "orchestration", "src", "imagegen", "comfy-client.ts"),
            "utf8"
          );
          for (const forbidden of [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "proxyAgent",
            "ProxyAgent",
            "https.Agent",
            "Authorization",
            "Cookie",
          ]) {
            if (source.includes(forbidden)) {
              throw new Error(`Comfy client references a forbidden egress control '${forbidden}'`);
            }
          }
          const saved = {
            HTTP_PROXY: process.env.HTTP_PROXY,
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            ALL_PROXY: process.env.ALL_PROXY,
          };
          process.env.HTTP_PROXY = "http://127.0.0.1:1";
          process.env.HTTPS_PROXY = "http://127.0.0.1:1";
          process.env.ALL_PROXY = "http://127.0.0.1:1";
          try {
            await withDeadline(
              profile.limits.read_timeout_ms + profile.limits.connect_timeout_ms,
              (signal) => client.ready({ signal })
            );
          } finally {
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }
        });

        await record("runtime_identity", () => {
          assertOwnerPrivate(manifestFile, "imagegen runtime manifest");
          assertOwnerPrivateDirectory(config.stateRoot, "penny state root");
          assertOwnerPrivateDirectory(path.join(PROJECT_ROOT, ".penny"), "private .penny root");
        });

        await record("manifest_custody", () => {
          const stat = lstatSync(manifestFile);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("imagegen runtime manifest must be a non-symlink regular file");
          }
          if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
            throw new Error("imagegen runtime manifest has the wrong owner");
          }
          if ((stat.mode & 0o022) !== 0) {
            throw new Error("imagegen runtime manifest must not be group/world writable");
          }
          if (stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) {
            throw new Error("imagegen runtime manifest is outside its byte policy");
          }
        });

        await record("profile_approval_and_inventory", async () => {
          if (resolved.profile.profile_sha256.length !== 64) {
            throw new Error("resolved profile lacks a digest");
          }
          const inventory = await withDeadline(
            profile.limits.read_timeout_ms + profile.limits.connect_timeout_ms,
            (signal) => client.inventory({ signal })
          );
          if (inventory.sha256 !== profile.required_inventory.object_info_sha256) {
            throw new Error("backend inventory drifted from the approved profile");
          }
          for (const classType of profile.required_inventory.class_types) {
            if (!inventory.class_types.has(classType)) {
              throw new Error("backend inventory is missing a required class type");
            }
          }
          for (const modelId of profile.required_inventory.model_ids) {
            if (!inventory.scalar_strings.has(modelId)) {
              throw new Error("backend inventory is missing a required model");
            }
          }
        });

        await record("storage_quota_reservations_modes", () => {
          if (manifestInspection.storage.ceiling_bytes <= 0) {
            throw new Error("storage partition ceiling is not positive");
          }
          if (
            manifestInspection.storage.warning_threshold_bytes >
            manifestInspection.storage.ceiling_bytes
          ) {
            throw new Error("storage warning threshold exceeds the partition ceiling");
          }
          assertOwnerPrivateDirectory(
            path.join(config.stateRoot, "imagegen-storage"),
            "imagegen storage"
          );
        });

        await record("artifact_and_output_permissions", () => {
          assertOwnerPrivateDirectory(config.artifactRoot, "artifact partition root");
        });

        await record("export_destinations_and_permissions", () => {
          for (const destination of manifestInspection.export_destinations) {
            if (!path.isAbsolute(destination.root)) {
              throw new Error("export destination root must be absolute");
            }
            assertOwnerPrivateDirectory(destination.root, "export destination root");
          }
        });

        await record("log_and_control_state_leakage", () => {
          const contentMarkers = [
            Buffer.from(manifestFile, "utf8"),
            Buffer.from("data:image", "utf8"),
            Buffer.from("base64,", "utf8"),
          ];
          const imagegenControlFiles = [
            path.join(config.stateRoot, "imagegen-activation", "imagegen-activation.sqlite"),
            path.join(config.stateRoot, "imagegen-storage", "imagegen-storage.sqlite"),
          ];
          const credentialMarkers = [
            Buffer.from("Authorization", "utf8"),
            Buffer.from("Bearer ", "utf8"),
          ];
          if (
            scanForMarkers([config.dbPath, ...imagegenControlFiles], contentMarkers) > 0 ||
            scanForMarkers(imagegenControlFiles, credentialMarkers) > 0
          ) {
            throw new Error("bounded control-state scan found a forbidden marker");
          }
        });
      } finally {
        loaded.close();
      }

      const issues = imagegenSecurityInspectionIssueCodes(results);
      writeReport(results, issues);
      expect(
        imagegenSecurityInspectionEnabled(process.env),
        `set ${IMAGEGEN_SECURITY_INSPECTION_GATE_ENV} exactly to '1'`
      ).toBe(true);
      expect(issues).toEqual([]);
    },
    10 * 60_000
  );
});
