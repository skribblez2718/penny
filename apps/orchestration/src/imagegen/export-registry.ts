import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ImagegenExportReceiptV1Schema,
  ImagegenExportRequestV1Schema,
  type ImagegenExportReceiptV1,
  type ImagegenExportRequestV1,
} from "../skill-contracts/imagegen.js";
import { assertOpaqueId, validateSkillSchema } from "../skill-contracts/common.js";
import type {
  ImagegenExportDestinationV1,
  ImagegenExportFileV1,
  ImagegenExportRegistry,
} from "./types.js";

interface StoredDestinationV1 extends ImagegenExportDestinationV1 {
  readonly root: string;
  readonly root_dev: bigint | number;
  readonly root_ino: bigint | number;
}

function safeLeaf(value: string, label: string): void {
  if (
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded safe leaf name`);
  }
}

function assertDirectory(
  candidate: string,
  label: string
): NonNullable<ReturnType<typeof lstatSync>> {
  const stat = lstatSync(candidate);
  if (stat === undefined) throw new Error(`${label} is absent`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new Error(`${label} has the wrong owner`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
  return stat;
}

function assertRootIdentity(destination: StoredDestinationV1): void {
  const stat = assertDirectory(destination.root, "registered imagegen export root");
  if (stat.dev !== destination.root_dev || stat.ino !== destination.root_ino) {
    throw new Error("registered imagegen export root changed after admission");
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
  }
}

function publishFile(
  directory: string,
  filename: string,
  bytes: Uint8Array,
  sequence: number
): void {
  safeLeaf(filename, "imagegen export filename");
  const temporary = path.join(directory, `.pending-${sequence}-${sha256(bytes).slice(0, 16)}`);
  const target = path.join(directory, filename);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.byteLength) {
      throw new Error("imagegen export temporary file failed exact write verification");
    }
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
    unlinkSync(temporary);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/** Host-registered destination authority with no caller-supplied root or overwrite behavior. */
export class StaticImagegenExportRegistry implements ImagegenExportRegistry {
  private readonly destinations = new Map<string, StoredDestinationV1>();

  constructor(
    destinations: readonly {
      readonly destination_id: string;
      readonly root: string;
      readonly max_files: number;
      readonly max_bytes: number;
    }[]
  ) {
    for (const destination of destinations) {
      assertOpaqueId(destination.destination_id, "imagegen export destination ID");
      if (this.destinations.has(destination.destination_id)) {
        throw new Error(`duplicate imagegen export destination '${destination.destination_id}'`);
      }
      if (
        !Number.isSafeInteger(destination.max_files) ||
        destination.max_files < 2 ||
        destination.max_files > 128 ||
        !Number.isSafeInteger(destination.max_bytes) ||
        destination.max_bytes < 1
      ) {
        throw new Error("imagegen export destination limits are invalid");
      }
      const root = realpathSync(destination.root);
      const stat = assertDirectory(root, "imagegen export root");
      this.destinations.set(destination.destination_id, {
        destination_id: destination.destination_id,
        root,
        max_files: destination.max_files,
        max_bytes: destination.max_bytes,
        root_dev: stat.dev,
        root_ino: stat.ino,
      });
    }
  }

  resolve(intentValue: ImagegenExportRequestV1): ImagegenExportDestinationV1 {
    const intent = validateSkillSchema(
      ImagegenExportRequestV1Schema,
      intentValue,
      "ImagegenExportRequestV1"
    );
    safeLeaf(intent.directory_name, "imagegen export directory_name");
    const destination = this.destinations.get(intent.destination_id);
    if (destination === undefined) {
      throw new Error(`imagegen export destination '${intent.destination_id}' is not registered`);
    }
    assertRootIdentity(destination);
    return {
      destination_id: destination.destination_id,
      max_files: destination.max_files,
      max_bytes: destination.max_bytes,
    };
  }

  export(input: {
    readonly intent: ImagegenExportRequestV1;
    readonly files: readonly ImagegenExportFileV1[];
    readonly selected_filename: string;
    readonly readArtifact: (ref: ImagegenExportFileV1["source_ref"]) => Uint8Array;
  }): ImagegenExportReceiptV1 {
    const intent = validateSkillSchema(
      ImagegenExportRequestV1Schema,
      input.intent,
      "ImagegenExportRequestV1"
    );
    this.resolve(intent);
    const destination = this.destinations.get(intent.destination_id);
    if (destination === undefined)
      throw new Error("registered imagegen export destination vanished");
    assertRootIdentity(destination);
    safeLeaf(input.selected_filename, "imagegen selected export filename");
    if (input.files.length < 2 || input.files.length > destination.max_files) {
      throw new Error("imagegen export file count exceeds the destination policy");
    }
    const names = input.files.map((file) => file.filename);
    for (const name of names) safeLeaf(name, "imagegen export filename");
    if (new Set(names).size !== names.length) throw new Error("imagegen export filenames repeat");
    if (!names.includes(input.selected_filename)) {
      throw new Error("imagegen selected export filename is not in the complete file set");
    }
    const payloads = input.files.map((file) => {
      const bytes = Buffer.from(input.readArtifact(file.source_ref));
      if (
        bytes.byteLength !== file.source_ref.byte_length ||
        sha256(bytes) !== file.source_ref.content_digest
      ) {
        throw new Error("imagegen export source failed exact artifact verification");
      }
      return { file, bytes };
    });
    const total = payloads.reduce((sum, payload) => sum + payload.bytes.byteLength, 0);
    if (total > destination.max_bytes) {
      throw new Error("imagegen export bytes exceed the destination policy");
    }
    const target = path.join(destination.root, intent.directory_name);
    if (!withinRoot(destination.root, target))
      throw new Error("imagegen export target escapes its root");
    let created = false;
    try {
      mkdirSync(target, { mode: 0o700, recursive: false });
      created = true;
      const targetStat = assertDirectory(target, "imagegen export run directory");
      const targetReal = realpathSync(target);
      if (!withinRoot(destination.root, targetReal)) {
        throw new Error("imagegen export run directory resolves outside its root");
      }
      for (const [index, payload] of payloads.entries()) {
        assertRootIdentity(destination);
        const current = assertDirectory(targetReal, "imagegen export run directory");
        if (current.dev !== targetStat.dev || current.ino !== targetStat.ino) {
          throw new Error("imagegen export run directory changed during publication");
        }
        publishFile(targetReal, payload.file.filename, payload.bytes, index);
      }
      const directoryDescriptor = openSync(
        targetReal,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      const rootDescriptor = openSync(
        destination.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        fsyncSync(rootDescriptor);
      } finally {
        closeSync(rootDescriptor);
      }
      return validateSkillSchema(
        ImagegenExportReceiptV1Schema,
        {
          schema_id: "penny.image-export-receipt.v1",
          schema_version: 1,
          destination_id: intent.destination_id,
          directory_name: intent.directory_name,
          files: payloads.map((payload) => ({
            filename: payload.file.filename,
            source_artifact_id: payload.file.source_ref.artifact_id,
            byte_length: payload.bytes.byteLength,
            sha256: sha256(payload.bytes),
          })),
          selected_filename: input.selected_filename,
          completed_at: new Date().toISOString(),
        },
        "ImagegenExportReceiptV1"
      );
    } catch (error) {
      if (created) rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }
}

export function imagegenExportReceiptSha256(receipt: ImagegenExportReceiptV1): string {
  return sha256(canonicalJson(receipt));
}
