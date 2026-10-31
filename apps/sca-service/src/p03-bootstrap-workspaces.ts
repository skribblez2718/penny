import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";

export interface ScaP03WorkspaceIdentityV1 {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
export interface ScaP03WorkspaceRegistryCallbacksV1 {
  register(attemptId: string, identity: ScaP03WorkspaceIdentityV1): void;
  digest(attemptId: string): string;
}

/** A private owner-created registry. No artifact body or caller lookup supplies its path list. */
export class ScaP03WorkspaceRegistryV1 implements ScaP03WorkspaceRegistryCallbacksV1 {
  readonly #entries = new Map<string, ScaP03WorkspaceIdentityV1[]>();
  private fileIdentity: { dev: number; ino: number } | null = null;
  private failed = false;
  private constructor(readonly file: string | null) {}
  static inProcess(): ScaP03WorkspaceRegistryV1 {
    return new ScaP03WorkspaceRegistryV1(null);
  }
  static create(file: string): ScaP03WorkspaceRegistryV1 {
    if (!path.isAbsolute(file)) throw new Error("p03_registry_path_invalid");
    const registry = new ScaP03WorkspaceRegistryV1(file);
    registry.checkParent();
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const initial = lstatSync(file);
    registry.fileIdentity = { dev: initial.dev, ino: initial.ino };
    registry.flush();
    return registry;
  }
  static resume(file: string): ScaP03WorkspaceRegistryV1 {
    if (!path.isAbsolute(file)) throw new Error("p03_registry_path_invalid");
    const registry = new ScaP03WorkspaceRegistryV1(file);
    registry.checkParent();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      const named = lstatSync(file);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > 128 * 1024 ||
        before.ino !== named.ino ||
        before.dev !== named.dev
      )
        throw new Error("p03_registry_custody_invalid");
      const text = readFileSync(fd, "utf8");
      const after = fstatSync(fd);
      const still = lstatSync(file);
      if (
        before.size !== after.size ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        after.ino !== still.ino ||
        after.dev !== still.dev
      )
        throw new Error("p03_registry_raced");
      const raw: unknown = JSON.parse(text);
      if (canonicalJson(raw) !== text || !Array.isArray(raw) || raw.length > 256)
        throw new Error("p03_registry_invalid");
      registry.fileIdentity = { dev: before.dev, ino: before.ino };
      for (const row of raw) {
        if (!isRow(row) || registry.#entries.has(row.attempt_id))
          throw new Error("p03_registry_invalid");
        registry.#entries.set(
          row.attempt_id,
          row.workspaces.map((item) => ({ ...item }))
        );
      }
    } finally {
      closeSync(fd);
    }
    return registry;
  }
  private checkParent(): void {
    if (this.file === null) return;
    const parent = path.dirname(this.file);
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("p03_registry_parent_invalid");
  }
  private flush(): void {
    if (this.file === null) return;
    this.checkParent();
    const contents = canonicalJson(
      [...this.#entries]
        .map(([attempt_id, workspaces]) => ({ attempt_id, workspaces }))
        .sort((a, b) => a.attempt_id.localeCompare(b.attempt_id))
    );
    if (Buffer.byteLength(contents) > 128 * 1024) throw new Error("p03_registry_limit");
    const temporary = path.join(path.dirname(this.file), `.p03-registry-${randomUUID()}`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    } finally {
      closeSync(fd);
    }
    try {
      // Do not adopt an externally substituted registry during a multi-step attempt.
      const current = lstatSync(this.file);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.uid !== process.getuid?.() ||
        (current.mode & 0o777) !== 0o600 ||
        this.fileIdentity === null ||
        current.dev !== this.fileIdentity.dev ||
        current.ino !== this.fileIdentity.ino
      )
        throw new Error("p03_registry_custody_invalid");
      renameSync(temporary, this.file);
      const replaced = lstatSync(this.file);
      this.fileIdentity = { dev: replaced.dev, ino: replaced.ino };
      const dir = openSync(
        path.dirname(this.file),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* rename may already have succeeded */
      }
      throw error;
    }
  }
  register(attemptId: string, identity: ScaP03WorkspaceIdentityV1): void {
    if (this.failed) throw new Error("p03_registry_poisoned");
    if (!/^[0-9a-f-]{36}$/.test(attemptId) || !isIdentity(identity))
      throw new Error("p03_registry_identity_invalid");
    const existing = this.#entries.get(attemptId) ?? [];
    if (existing.length >= 256 || existing.some((entry) => entry.path === identity.path))
      throw new Error("p03_registry_limit");
    const stat = lstatSync(identity.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("p03_registry_workspace_raced");
    this.#entries.set(attemptId, [...existing, { ...identity }]);
    try {
      this.flush();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  paths(attemptId: string): readonly string[] {
    if (this.failed) throw new Error("p03_registry_poisoned");
    const entries = this.#entries.get(attemptId);
    if (entries === undefined || entries.length === 0)
      throw new Error("p03_registry_attempt_missing");
    return entries.map((entry) => entry.path);
  }
  digest(attemptId: string): string {
    if (this.failed) throw new Error("p03_registry_poisoned");
    const entries = this.#entries.get(attemptId);
    if (entries === undefined || entries.length === 0)
      throw new Error("p03_registry_attempt_missing");
    return sha256(canonicalJson(entries.map((entry) => sha256(canonicalJson(entry)))));
  }
}
function isIdentity(value: unknown): value is ScaP03WorkspaceIdentityV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = Object.entries(value);
  return (
    row.length === 3 &&
    row
      .map(([key]) => key)
      .sort()
      .join(",") === "dev,ino,path" &&
    "path" in value &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    path.normalize(value.path) === value.path &&
    "dev" in value &&
    Number.isSafeInteger(value.dev) &&
    "ino" in value &&
    Number.isSafeInteger(value.ino)
  );
}
function isRow(
  value: unknown
): value is { attempt_id: string; workspaces: ScaP03WorkspaceIdentityV1[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "attempt_id,workspaces" &&
    "attempt_id" in value &&
    typeof value.attempt_id === "string" &&
    /^[0-9a-f-]{36}$/.test(value.attempt_id) &&
    "workspaces" in value &&
    Array.isArray(value.workspaces) &&
    value.workspaces.length > 0 &&
    value.workspaces.length <= 256 &&
    value.workspaces.every(isIdentity) &&
    new Set(value.workspaces.map((entry) => entry.path)).size === value.workspaces.length
  );
}
