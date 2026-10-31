import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { caseFold } from "unicode-case-folding";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";

const treeFile = (maxBytes: number) =>
  Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: 4096 }),
      bytes: Type.Integer({ minimum: 0, maximum: maxBytes }),
      sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    },
    { additionalProperties: false }
  );
export const TreeFile = treeFile(16_777_216);
const runtimeFile = treeFile(536_870_912);

const treeSchema = (file: typeof TreeFile, maxFiles: number, maxTotal: number) =>
  Type.Object(
    {
      root: Type.String({ minLength: 1, maxLength: 4096 }),
      files: Type.Array(file, { minItems: 1, maxItems: maxFiles }),
      total_bytes: Type.Integer({ minimum: 0, maximum: maxTotal }),
      tree_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    },
    { additionalProperties: false }
  );
export const Tree = treeSchema(TreeFile, 256, 67_108_864);
export const SealedRuntimeTreeV1 = treeSchema(runtimeFile, 50_000, 2_147_483_648);
export type HostTree = Static<typeof Tree>;
export type HostSealedRuntimeTreeV1 = Static<typeof SealedRuntimeTreeV1>;
export type SourceGeneration = Readonly<{ file_manifest_sha256: string; custody_sha256: string }>;
const GENERATION_MARKER = ".penny-sca-generation.json";

const SOURCE_LIMITS = { schema: Tree, manifest: 32_768, total: 67_108_864 };
const RUNTIME_LIMITS = { schema: SealedRuntimeTreeV1, manifest: 8_388_608, total: 2_147_483_648 };

export function exactPath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.split("/").includes("..")
  );
}
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function validTreeWithLimits(
  tree: HostTree | HostSealedRuntimeTreeV1,
  limits: typeof SOURCE_LIMITS
): void {
  validateContract(limits.schema, tree, "P02 tree");
  if (Buffer.byteLength(canonicalJson(tree)) > limits.manifest) throw Error("p02_host_tree_limit");
  if (!exactPath(tree.root)) throw Error("p02_host_tree_path");
  let total = 0;
  let previous = "";
  const seen = new Set<string>();
  const named = new Map<string, string>();
  for (const file of tree.files) {
    const parts = file.path.split("/");
    if (
      file.path.startsWith("/") ||
      parts.some(
        (part) =>
          part === "" || part === "." || part === ".." || part.includes("\0") || part.includes("\n")
      ) ||
      (previous !== "" && file.path <= previous)
    )
      throw Error("p02_host_tree_path");
    const folded = caseFold(file.path);
    if (seen.has(folded)) throw Error("p02_host_tree_collision");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = caseFold(prefix);
      if (i < parts.length && seen.has(key)) throw Error("p02_host_tree_collision");
      const prior = named.get(key);
      if (prior !== undefined && prior !== prefix) throw Error("p02_host_tree_collision");
      named.set(key, prefix);
    }
    seen.add(folded);
    previous = file.path;
    total += file.bytes;
  }
  if (
    total !== tree.total_bytes ||
    total > limits.total ||
    sha256(canonicalJson(tree.files)) !== tree.tree_sha256
  )
    throw Error("p02_host_tree_digest");
}

export function validTree(tree: HostTree): void {
  validTreeWithLimits(tree, SOURCE_LIMITS);
}
export function validSealedRuntimeTreeV1(tree: HostSealedRuntimeTreeV1): void {
  validTreeWithLimits(tree, RUNTIME_LIMITS);
}

async function directory(dir: string, uid: number, sealed: boolean): Promise<void> {
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    info.nlink < 2 ||
    (info.mode & 0o022) !== 0 ||
    (sealed && (info.mode & 0o200) !== 0) ||
    (await realpath(dir)) !== dir
  )
    throw Error("p02_host_tree_directory");
}

/** Rejects unlisted entries (including empty directories), links and changed inode/metadata. */
async function verifyTreeWithLimits(
  tree: HostTree | HostSealedRuntimeTreeV1,
  sealed: boolean,
  limits: typeof SOURCE_LIMITS,
  generation?: SourceGeneration
): Promise<void> {
  validTreeWithLimits(tree, limits);
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw Error("p02_host_tree_identity");
  if (limits === RUNTIME_LIMITS) {
    const parent = await lstat(path.dirname(tree.root));
    if (
      !parent.isDirectory() ||
      parent.uid !== uid ||
      (parent.mode & 0o077) !== 0 ||
      (await realpath(path.dirname(tree.root))) !== path.dirname(tree.root)
    )
      throw Error("p02_host_tree_private");
  }
  await directory(tree.root, uid, sealed);
  if (generation !== undefined && ((await lstat(tree.root)).mode & 0o777) !== 0o555)
    throw Error("p02_host_tree_private");
  if (generation !== undefined) {
    if (
      sealed ||
      limits !== SOURCE_LIMITS ||
      tree.files.some((file) => file.path === GENERATION_MARKER)
    )
      throw Error("p02_host_tree_marker");
    const filename = path.join(tree.root, GENERATION_MARKER);
    const before = await lstat(filename);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== uid ||
      before.size > 4096 ||
      (before.mode & 0o777) !== 0o444
    )
      throw Error("p02_host_tree_marker");
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await fd.readFile();
      const after = await fd.stat();
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        canonicalJson(value) !== bytes.toString("utf8")
      )
        throw Error("p02_host_tree_marker");
      const marker = validateContract(
        Type.Record(Type.String(), Type.Unknown()),
        value,
        "P02 generation marker"
      );
      if (
        marker.schema_id !== "penny.sca-source-custody-generation-marker.v1" ||
        marker.schema_version !== 1 ||
        marker.staging_root !== tree.root ||
        marker.file_manifest_sha256 !== generation.file_manifest_sha256 ||
        marker.custody_sha256 !== generation.custody_sha256 ||
        marker.tree_sha256 !==
          sha256(
            canonicalJson(
              tree.files.map((file) => ({
                path: file.path,
                byte_count: file.bytes,
                content_sha256: file.sha256,
              }))
            )
          ) ||
        marker.file_count !== tree.files.length ||
        marker.byte_count !== tree.total_bytes ||
        marker.publication_intent !== "publish_complete_tree" ||
        typeof marker.generation_token !== "string" ||
        !/^[a-f0-9]{64}$/.test(marker.generation_token) ||
        typeof marker.snapshot_id !== "string" ||
        marker.snapshot_id.length === 0 ||
        Object.keys(marker).length !== 12 ||
        typeof marker.filesystem_identity !== "object" ||
        marker.filesystem_identity === null ||
        canonicalJson(marker.filesystem_identity) !==
          canonicalJson({
            device: String((await lstat(tree.root)).dev),
            inode: String((await lstat(tree.root)).ino),
          })
      )
        throw Error("p02_host_tree_marker");
    } finally {
      await fd.close();
    }
  }
  if (!sealed && generation === undefined && ((await lstat(tree.root)).mode & 0o077) !== 0)
    throw Error("p02_host_tree_private");
  const expected = new Set<string>();
  const dirs = new Set<string>();
  for (const file of tree.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    expected.add(file.path);
  }
  for (const name of dirs) {
    const dir = path.join(tree.root, name);
    await directory(dir, uid, sealed || generation !== undefined);
    if (generation !== undefined && ((await lstat(dir)).mode & 0o777) !== 0o555)
      throw Error("p02_host_tree_directory");
  }
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(tree.root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (dirs.has(name) && entry.isDirectory()) await walk(name);
      else if (generation !== undefined && name === GENERATION_MARKER && entry.isFile()) continue;
      else if (!expected.has(name) || !entry.isFile()) throw Error("p02_host_tree_extra");
    }
  };
  await walk("");
  const buffer = Buffer.alloc(65536);
  for (const file of tree.files) {
    const filename = path.join(tree.root, file.path);
    const before = await lstat(filename);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== uid ||
      before.size !== file.bytes ||
      (before.mode & 0o022) !== 0 ||
      (sealed && (before.mode & 0o200) !== 0) ||
      (generation !== undefined && (before.mode & 0o777) !== 0o444)
    )
      throw Error("p02_host_tree_file");
    const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await fd.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
        throw Error("p02_host_tree_drift");
      const hash = createHash("sha256");
      for (let offset = 0; offset < file.bytes; ) {
        const { bytesRead } = await fd.read(
          buffer,
          0,
          Math.min(buffer.length, file.bytes - offset),
          offset
        );
        if (bytesRead === 0) throw Error("p02_host_tree_drift");
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await fd.stat();
      const again = await lstat(filename);
      if (
        hash.digest("hex") !== file.sha256 ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        again.ino !== before.ino ||
        again.dev !== before.dev ||
        again.mtimeMs !== before.mtimeMs ||
        again.ctimeMs !== before.ctimeMs
      )
        throw Error("p02_host_tree_drift");
    } finally {
      await fd.close();
    }
  }
  await walk("");
}

export async function verifyTree(tree: HostTree, generation?: SourceGeneration): Promise<void> {
  await verifyTreeWithLimits(tree, false, SOURCE_LIMITS, generation);
}
export async function verifySealedSourceTree(tree: HostTree): Promise<void> {
  await verifyTreeWithLimits(tree, true, SOURCE_LIMITS);
}
export async function verifySealedRuntimeTreeV1(tree: HostSealedRuntimeTreeV1): Promise<void> {
  await verifyTreeWithLimits(tree, true, RUNTIME_LIMITS);
}

export async function unsealStagedTree(tree: HostTree): Promise<void> {
  validTree(tree);
  for (const file of tree.files) await chmod(path.join(tree.root, file.path), 0o600);
  const directories = new Set<string>();
  for (const file of tree.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  for (const dir of [...directories].sort((a, b) => b.length - a.length))
    await chmod(path.join(tree.root, dir), 0o700);
  await chmod(tree.root, 0o700);
}

export async function stageTree(tree: HostTree, destination: string): Promise<HostTree> {
  validTree(tree);
  await mkdir(destination, { mode: 0o700 });
  const directories = new Set<string>();
  for (const file of tree.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  for (const dir of [...directories].sort((a, b) => a.length - b.length))
    await mkdir(path.join(destination, dir), { mode: 0o700 });
  for (const file of tree.files) {
    const source = await open(
      path.join(tree.root, file.path),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await source.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== file.bytes)
        throw Error("p02_host_tree_drift");
      // Source-only staging: the schema caps each allocation at 16 MiB.
      const bytes = Buffer.alloc(file.bytes);
      for (let offset = 0; offset < file.bytes; ) {
        const { bytesRead } = await source.read(
          bytes,
          offset,
          Math.min(65536, file.bytes - offset),
          offset
        );
        if (bytesRead === 0) throw Error("p02_host_tree_drift");
        offset += bytesRead;
      }
      const after = await source.stat();
      if (
        sha256(bytes) !== file.sha256 ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs ||
        after.ino !== info.ino ||
        after.dev !== info.dev
      )
        throw Error("p02_host_tree_drift");
      await writeFile(path.join(destination, file.path), bytes, { flag: "wx", mode: 0o400 });
      await chmod(path.join(destination, file.path), 0o444);
    } finally {
      await source.close();
    }
  }
  for (const dir of [...directories].sort((a, b) => b.length - a.length))
    await chmod(path.join(destination, dir), 0o555);
  await chmod(destination, 0o555);
  return { ...tree, root: destination };
}
