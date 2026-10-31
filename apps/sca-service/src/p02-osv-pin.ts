import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../orchestration/dist/canonical-json.js";

const MAX_FILE_BYTES = 134_217_728;

type Pin = Readonly<{ path: string; sha256: string }>;
type Identity = Readonly<{
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

function identity(s: Identity): string {
  return [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
}
function exactPath(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value && value !== "/";
}
function fail(code: string): never {
  throw new Error(`p02_osv_pin_${code}`);
}

/** Only the caller's configured closure entries may pass allowSymlink=true. */
export type VerifiedP02OsvPin = Readonly<{ source: string; size: number; identity: string }>;
export async function verifyP02OsvPin(
  pin: Pin,
  allowSymlink = false,
  allowedTarget: (target: string) => boolean = () => true
): Promise<VerifiedP02OsvPin> {
  if (!exactPath(pin.path)) fail("path");
  const lexicalBefore = await lstat(pin.path);
  if (
    lexicalBefore.nlink !== 1 ||
    !(lexicalBefore.isFile() || (allowSymlink && lexicalBefore.isSymbolicLink()))
  )
    fail("type");
  const resolved = await realpath(pin.path);
  if (!exactPath(resolved) || !allowedTarget(resolved) || (!allowSymlink && resolved !== pin.path))
    fail("path");
  // Resolve the lexical path, but never open via a link. The terminal target must itself
  // be an exact regular file (not another link). All original path checks repeat later.
  const targetBefore = await lstat(resolved);
  if (
    (await realpath(resolved)) !== resolved ||
    !targetBefore.isFile() ||
    targetBefore.nlink !== 1 ||
    targetBefore.size < 1 ||
    targetBefore.size > MAX_FILE_BYTES ||
    (targetBefore.mode & 0o022) !== 0
  )
    fail("type");
  const fd = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat();
    if (identity(before) !== identity(targetBefore) || !before.isFile()) fail("drift");
    if (sha256(await fd.readFile()) !== pin.sha256) fail("hash");
    const after = await fd.stat();
    const lexicalAfter = await lstat(pin.path);
    const targetAfter = await lstat(resolved);
    if (
      identity(before) !== identity(after) ||
      identity(lexicalBefore) !== identity(lexicalAfter) ||
      identity(targetBefore) !== identity(targetAfter) ||
      (await realpath(pin.path)) !== resolved ||
      (await realpath(resolved)) !== resolved
    )
      fail("drift");
    return {
      source: resolved,
      size: before.size,
      identity: `${identity(lexicalBefore)}|${identity(before)}`,
    };
  } finally {
    await fd.close();
  }
}

/** A closure alias must not resolve to another staged lexical path or duplicate target. */
export async function verifyP02OsvPinSet(
  specs: readonly Readonly<{
    pin: Pin;
    allowSymlink: boolean;
    allowedTarget?: (target: string) => boolean;
  }>[],
  baseline?: ReadonlyMap<string, VerifiedP02OsvPin>
): Promise<Map<string, VerifiedP02OsvPin>> {
  const lexical = new Set(specs.map(({ pin }) => pin.path));
  if (lexical.size !== specs.length || (baseline && baseline.size !== specs.length))
    fail("collision");
  const resolved = new Set<string>();
  const verified = new Map<string, VerifiedP02OsvPin>();
  for (const { pin, allowSymlink, allowedTarget } of specs) {
    const result = await verifyP02OsvPin(pin, allowSymlink, allowedTarget);
    if (resolved.has(result.source) || (result.source !== pin.path && lexical.has(result.source)))
      fail("collision");
    const prior = baseline?.get(pin.path);
    if (
      baseline &&
      (!prior ||
        prior.source !== result.source ||
        prior.size !== result.size ||
        prior.identity !== result.identity)
    )
      fail("drift");
    resolved.add(result.source);
    verified.set(pin.path, result);
  }
  return verified;
}
