import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { sha256 } from "../canonical-json.js";
import { validatePortablePath } from "./portable-package.js";

export interface DeliveryDestination {
  readonly destination_id: string;
  readonly root: string;
  readonly max_files: number;
  readonly max_bytes: number;
  readonly reserve_bytes: number;
}
export interface DeliveryFile {
  readonly relative_path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
export interface DeliveryFileReadback {
  readonly relative_path: string;
  readonly sha256: string;
  readonly bytes: number;
}
function refuse(message: string): never {
  throw new Error(`local delivery: ${message}`);
}
/** Linux fd-anchored traversal: no parent symlink/rename race after opening a directory.
 * Roots are host-registered private directories, not model-selected paths. No shared-writer root.
 * No public root/default, file discovery, overwrite, shell, network or archive extraction. */
export class LocalDeliveryFiles implements Disposable {
  private readonly destinations = new Map<string, DeliveryDestination>();
  private readonly roots = new Map<string, number>();
  constructor(destinations: readonly DeliveryDestination[]) {
    if (process.platform !== "linux" || destinations.length < 1 || destinations.length > 64)
      refuse("bounded Linux destination registry required");
    try {
      for (const value of destinations) {
        if (
          Object.keys(value).sort().join(",") !==
            "destination_id,max_bytes,max_files,reserve_bytes,root" ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(value.destination_id) ||
          this.destinations.has(value.destination_id) ||
          !path.isAbsolute(value.root) ||
          realpathSync(value.root) !== value.root
        )
          refuse("invalid/duplicate selector/root");
        for (const n of [value.max_files, value.max_bytes, value.reserve_bytes])
          if (!Number.isSafeInteger(n) || n < 0) refuse("finite delivery budget required");
        if (value.max_files < 1 || value.max_bytes < 1) refuse("positive delivery budget required");
        const fd = openSync(
          value.root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        this.roots.set(value.destination_id, fd);
        this.privateDirectory(fd);
        this.destinations.set(value.destination_id, structuredClone(value));
      }
    } catch (error) {
      this[Symbol.dispose]();
      throw error;
    }
  }
  private privateDirectory(fd: number): void {
    const s = fstatSync(fd);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
      refuse("owner-only directory required");
  }
  private anchored(fd: number, name = ""): string {
    return `/proc/self/fd/${fd}${name === "" ? "" : `/${name}`}`;
  }
  private root(selector: string): number {
    const fd = this.roots.get(selector),
      value = this.destinations.get(selector);
    if (fd === undefined || value === undefined) refuse("unregistered destination selector");
    this.privateDirectory(fd);
    const current = lstatSync(value.root),
      original = fstatSync(fd);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      realpathSync(value.root) !== value.root
    )
      refuse("destination root changed");
    return fd;
  }
  private component(value: string): string {
    validatePortablePath(value);
    if (value.includes("/")) refuse("namespace must be one component");
    return value;
  }
  private directory(parent: number, name: string, create: boolean): number {
    const target = this.anchored(parent, this.component(name));
    if (create) mkdirSync(target, { mode: 0o700 });
    const fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      this.privateDirectory(fd);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  private payloadFile(root: number, relative: string, create: boolean, bytes?: Uint8Array): Buffer {
    const parts = validatePortablePath(relative).split("/"),
      name = parts.pop();
    if (name === undefined) refuse("missing payload name");
    let parent = root;
    const opened: number[] = [];
    try {
      for (const part of parts) {
        if (create) {
          try {
            mkdirSync(this.anchored(parent, part), { mode: 0o700 });
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
              throw error;
          }
        }
        const next = this.directory(parent, part, false);
        opened.push(next);
        parent = next;
      }
      const target = this.anchored(parent, name);
      const fd = openSync(
        target,
        create
          ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
          : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600
      );
      try {
        if (create) {
          if (bytes === undefined) refuse("write bytes absent");
          writeFileSync(fd, bytes);
          fsyncSync(fd);
          fsyncSync(parent);
          return Buffer.alloc(0);
        }
        const s = fstatSync(fd);
        if (
          !s.isFile() ||
          s.nlink !== 1 ||
          s.uid !== process.getuid?.() ||
          (s.mode & 0o077) !== 0 ||
          s.size > (bytes?.byteLength ?? 0)
        )
          refuse("nonregular/linked/oversized payload");
        const actual = Buffer.alloc(s.size + 1);
        let read = 0;
        while (read < actual.length) {
          const n = readSync(fd, actual, read, actual.length - read, null);
          if (n === 0) break;
          read += n;
        }
        const after = fstatSync(fd);
        if (
          read !== s.size ||
          after.size !== s.size ||
          after.mtimeMs !== s.mtimeMs ||
          after.ctimeMs !== s.ctimeMs
        )
          refuse("payload changed during read");
        return actual.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } finally {
      for (const fd of opened.reverse()) {
        if (create) fsyncSync(fd);
        closeSync(fd);
      }
    }
  }
  private validateFiles(selector: string, files: readonly DeliveryFile[]): void {
    const policy = this.destinations.get(selector);
    if (policy === undefined) refuse("unknown selector");
    if (files.length < 2 || files.length > policy.max_files) refuse("dual product/count limit");
    let total = 0n;
    const names = new Set<string>();
    for (const f of files) {
      const name = validatePortablePath(f.relative_path).toLowerCase();
      if (
        names.has(name) ||
        [...names].some((n) => n.startsWith(`${name}/`) || name.startsWith(`${n}/`))
      )
        refuse("payload path collision");
      names.add(name);
      total += BigInt(f.bytes.byteLength);
      if (total > BigInt(policy.max_bytes) || sha256(f.bytes) !== f.sha256)
        refuse("payload bytes/budget mismatch");
    }
  }
  private verifyTree(root: number, files: readonly DeliveryFile[]): DeliveryFileReadback[] {
    const expected = new Set(files.map((f) => f.relative_path));
    let count = 0;
    const maxEntries = files.reduce((n, f) => n + f.relative_path.split("/").length, 0);
    const walk = (fd: number, prefix: string): void => {
      for (const entry of readdirSync(this.anchored(fd), { withFileTypes: true })) {
        if (++count > maxEntries) refuse("unlisted tree complexity");
        const relative = prefix + entry.name;
        validatePortablePath(relative);
        if (entry.isDirectory()) {
          if (![...expected].some((n) => n.startsWith(`${relative}/`)))
            refuse("unlisted directory");
          const next = this.directory(fd, entry.name, false);
          try {
            walk(next, `${relative}/`);
          } finally {
            closeSync(next);
          }
        } else if (!entry.isFile() || !expected.has(relative))
          refuse("unlisted/symlink/nonregular file");
      }
    };
    walk(root, "");
    return files.map((f) => {
      const bytes = this.payloadFile(root, f.relative_path, false, f.bytes);
      if (!bytes.equals(Buffer.from(f.bytes)) || sha256(bytes) !== f.sha256)
        refuse("payload readback mismatch");
      return { relative_path: f.relative_path, sha256: f.sha256, bytes: bytes.length };
    });
  }
  prepare(
    selector: string,
    stageId: string,
    files: readonly DeliveryFile[],
    signal: AbortSignal
  ): void {
    signal.throwIfAborted();
    this.validateFiles(selector, files);
    const root = this.root(selector),
      policy = this.destinations.get(selector);
    if (policy === undefined) refuse("selector absent");
    const free = statfsSync(this.anchored(root), { bigint: true });
    if (
      free.bavail * free.bsize <
      files.reduce((n, f) => n + BigInt(f.bytes.byteLength), 0n) + BigInt(policy.reserve_bytes)
    )
      refuse("free-space reservation unavailable");
    const stage = this.directory(root, stageId, true);
    try {
      for (const file of files) {
        signal.throwIfAborted();
        this.payloadFile(stage, file.relative_path, true, file.bytes);
      }
      this.verifyTree(stage, files);
      fsyncSync(stage);
      fsyncSync(root);
    } catch (error) {
      // Only this call's exclusive stage, never a user namespace or a recovered stage.
      rmSync(this.anchored(root, stageId), { recursive: true, force: true });
      fsyncSync(root);
      throw error;
    } finally {
      closeSync(stage);
    }
  }
  /** Restart-safe staging only for an already persisted exact host intent. Never adopts
   * another namespace or repairs a changed/partial stage. */
  prepareForIntent(
    selector: string,
    stageId: string,
    files: readonly DeliveryFile[],
    signal: AbortSignal
  ): void {
    signal.throwIfAborted();
    this.validateFiles(selector, files);
    const root = this.root(selector);
    let stage: number;
    try {
      stage = this.directory(root, stageId, false);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.prepare(selector, stageId, files, signal);
        return;
      }
      throw error;
    }
    try {
      this.verifyTree(stage, files);
      fsyncSync(stage);
    } finally {
      closeSync(stage);
    }
  }
  /** Exclusive final namespace is reserved first; only its `products` directory is visible as
   * complete. The empty reservation is not a delivered product. Private-root single-writer
   * custody prevents rename's replacement semantics from becoming an overwrite primitive. */
  apply(
    selector: string,
    stageId: string,
    finalId: string,
    files: readonly DeliveryFile[],
    signal: AbortSignal
  ): DeliveryFileReadback[] {
    signal.throwIfAborted();
    this.validateFiles(selector, files);
    if (stageId === finalId) refuse("stage/final alias");
    const root = this.root(selector),
      stage = this.directory(root, stageId, false);
    try {
      this.verifyTree(stage, files);
      fsyncSync(stage);
    } finally {
      closeSync(stage);
    }
    signal.throwIfAborted();
    const final = this.directory(root, finalId, true);
    try {
      fsyncSync(root);
      signal.throwIfAborted();
      renameSync(this.anchored(root, this.component(stageId)), this.anchored(final, "products"));
      fsyncSync(final);
      fsyncSync(root);
      return this.readback(selector, finalId, files);
    } finally {
      closeSync(final);
    }
  }
  /** Recovery is read-only and requires the EXACT owner-journal namespace; never scan/adopt or
   * republish after an ambiguous crash. An empty reservation cannot pass. */
  readback(
    selector: string,
    finalId: string,
    files: readonly DeliveryFile[]
  ): DeliveryFileReadback[] {
    this.validateFiles(selector, files);
    const root = this.root(selector),
      final = this.directory(root, finalId, false);
    try {
      if (readdirSync(this.anchored(final)).join(",") !== "products")
        refuse("final namespace closure");
      const products = this.directory(final, "products", false);
      try {
        return this.verifyTree(products, files);
      } finally {
        closeSync(products);
      }
    } finally {
      closeSync(final);
    }
  }
  [Symbol.dispose](): void {
    for (const fd of this.roots.values()) closeSync(fd);
    this.roots.clear();
  }
}
