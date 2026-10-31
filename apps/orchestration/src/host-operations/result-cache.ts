import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.js";

const CACHE_KEY = /^[a-f0-9]{64}$/u;
const MAX_CACHE_BYTES = 4_294_967_296;

export interface HostOperationCachedResultV1 {
  readonly schema_version: 1;
  readonly request_sha256: string;
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly bytes: Uint8Array;
}

/** Host-owned exact-byte cache used only to bridge fetch and journal-persistence crash windows. */
export interface HostOperationResultCacheV1 {
  read(requestSha256: string): Promise<HostOperationCachedResultV1 | null>;
  write(requestSha256: string, bytes: Uint8Array): Promise<HostOperationCachedResultV1>;
}

interface CacheEnvelopeV1 {
  readonly schema_version: 1;
  readonly request_sha256: string;
  readonly content_sha256: string;
  readonly byte_length: number;
  readonly content_base64: string;
}

function assertKey(value: string): void {
  if (!CACHE_KEY.test(value)) throw new Error("host-operation result-cache key is invalid");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeEnvelope(value: unknown, requestSha256: string): HostOperationCachedResultV1 {
  if (!isRecord(value)) {
    throw new Error("host-operation result cache contains a malformed envelope");
  }
  const record = value;
  const keys = Object.keys(record).sort();
  if (
    canonicalJson(keys) !==
      canonicalJson(
        [
          "byte_length",
          "content_base64",
          "content_sha256",
          "request_sha256",
          "schema_version",
        ].sort()
      ) ||
    record.schema_version !== 1 ||
    record.request_sha256 !== requestSha256 ||
    typeof record.content_sha256 !== "string" ||
    !CACHE_KEY.test(record.content_sha256) ||
    typeof record.byte_length !== "number" ||
    !Number.isSafeInteger(record.byte_length) ||
    record.byte_length < 0 ||
    record.byte_length > MAX_CACHE_BYTES ||
    typeof record.content_base64 !== "string"
  ) {
    throw new Error("host-operation result cache envelope contract is invalid");
  }
  const bytes = Buffer.from(record.content_base64, "base64");
  if (
    bytes.toString("base64") !== record.content_base64 ||
    bytes.byteLength !== record.byte_length ||
    sha256(bytes) !== record.content_sha256
  ) {
    throw new Error("host-operation result cache failed exact digest verification");
  }
  return {
    schema_version: 1,
    request_sha256: requestSha256,
    content_sha256: record.content_sha256,
    byte_length: record.byte_length,
    bytes,
  };
}

/**
 * Safe file-backed result cache. The caller supplies a dedicated root; provisioning rejects
 * symlinked roots, uses private directory/file modes, publishes atomically, fsyncs both file and
 * directory, and never follows a cache-entry symlink.
 */
export class FileHostOperationResultCache implements HostOperationResultCacheV1 {
  private constructor(private readonly root: string) {}

  static async provision(root: string): Promise<FileHostOperationResultCache> {
    const resolved = path.resolve(root);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
    await FileHostOperationResultCache.verifyRoot(resolved);
    return new FileHostOperationResultCache(resolved);
  }

  /** Open an operator-provisioned production root without creating or repairing it. */
  static async openExisting(root: string): Promise<FileHostOperationResultCache> {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) {
      throw new Error("host-operation result-cache root must be an absolute canonical path");
    }
    await FileHostOperationResultCache.verifyRoot(root);
    return new FileHostOperationResultCache(root);
  }

  private static async verifyRoot(root: string): Promise<void> {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("host-operation result-cache root must be a real directory");
    }
    if ((await realpath(root)) !== root) {
      throw new Error("host-operation result-cache root cannot traverse symlinks");
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new Error("host-operation result-cache root must use mode 0700");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error("host-operation result-cache root must be owned by the service identity");
    }
  }

  async read(requestSha256: string): Promise<HostOperationCachedResultV1 | null> {
    assertKey(requestSha256);
    const file = this.file(requestSha256);
    try {
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("host-operation result-cache entry is not a regular file");
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let encoded: Buffer;
      try {
        encoded = await handle.readFile();
      } finally {
        await handle.close();
      }
      const text = encoded.toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error("host-operation result-cache entry is not JSON", { cause: error });
      }
      if (canonicalJson(parsed) !== text) {
        throw new Error("host-operation result-cache entry is not canonical JSON");
      }
      return decodeEnvelope(parsed, requestSha256);
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
      throw error;
    }
  }

  async write(requestSha256: string, bytesValue: Uint8Array): Promise<HostOperationCachedResultV1> {
    assertKey(requestSha256);
    const bytes = Buffer.from(bytesValue);
    if (bytes.byteLength > MAX_CACHE_BYTES) {
      throw new Error("host-operation result-cache value is oversized");
    }
    const envelope: CacheEnvelopeV1 = {
      schema_version: 1,
      request_sha256: requestSha256,
      content_sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      content_base64: bytes.toString("base64"),
    };
    const encoded = Buffer.from(canonicalJson(envelope), "utf8");
    const destination = this.file(requestSha256);
    const existing = await this.read(requestSha256);
    if (existing !== null) {
      if (
        existing.content_sha256 !== envelope.content_sha256 ||
        existing.byte_length !== envelope.byte_length ||
        !Buffer.from(existing.bytes).equals(bytes)
      ) {
        throw new Error("host-operation result-cache key conflicts with existing exact bytes");
      }
      return existing;
    }

    const temporary = path.join(
      this.root,
      `.${requestSha256}.${process.pid.toString(10)}.${randomUUID()}.tmp`
    );
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    let writeFailure: unknown;
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } catch (error) {
      writeFailure = error;
    } finally {
      await handle.close();
    }
    if (writeFailure !== undefined) {
      await rm(temporary, { force: true });
      throw writeFailure;
    }
    try {
      await link(temporary, destination);
      await rm(temporary);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      if (error instanceof Error && Reflect.get(error, "code") === "EEXIST") {
        const raced = await this.read(requestSha256);
        if (
          raced !== null &&
          raced.content_sha256 === envelope.content_sha256 &&
          Buffer.from(raced.bytes).equals(bytes)
        ) {
          return raced;
        }
        throw new Error("host-operation result-cache key conflicts with raced exact bytes", {
          cause: error,
        });
      }
      throw error;
    }
    const readback = await this.read(requestSha256);
    if (
      readback === null ||
      readback.content_sha256 !== envelope.content_sha256 ||
      !Buffer.from(readback.bytes).equals(bytes)
    ) {
      throw new Error("host-operation result-cache publication failed exact readback");
    }
    return readback;
  }

  private file(requestSha256: string): string {
    return path.join(this.root, `${requestSha256}.json`);
  }
}
