import { constants } from "node:fs";
import { copyFile, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../orchestration/dist/canonical-json.js";
import { verifyP02OsvPin, verifyP02OsvPinSet } from "../src/p02-osv-pin.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "p02-osv-pin-test-"));
  dirs.push(dir);
  const target = path.join(dir, "libc.so.6.1");
  const lexical = path.join(dir, "libc.so.6");
  const bytes = Buffer.from("regular ELF closure bytes");
  await writeFile(target, bytes, { mode: 0o444 });
  await symlink("libc.so.6.1", lexical);
  return { dir, target, lexical, bytes, pin: { path: lexical, sha256: sha256(bytes) } };
}

describe("P02 OSV closure pinning (offline filesystem only)", () => {
  it("hashes a canonical regular target and stages its bytes as a regular private pin", async () => {
    const { dir, target, lexical, bytes, pin } = await fixture();
    await expect(verifyP02OsvPin(pin)).rejects.toThrow();
    const verified = await verifyP02OsvPin(pin, true);
    expect(verified.source).toBe(target);
    expect(verified.size).toBe(bytes.length);
    const staged = path.join(dir, "staged");
    await copyFile(verified.source, staged, constants.COPYFILE_EXCL);
    await verifyP02OsvPin({ path: staged, sha256: pin.sha256 });
    expect((await lstat(staged)).isFile()).toBe(true);
    expect((await lstat(staged)).isSymbolicLink()).toBe(false);
    expect(await readFile(staged)).toEqual(bytes);
    expect((await lstat(lexical)).isSymbolicLink()).toBe(true);
  });

  it("rejects target substitution, disallowed resolved roots, hardlinks and non-regular targets", async () => {
    const { dir, target, lexical, pin } = await fixture();
    const specs = [{ pin, allowSymlink: true }];
    const initial = await verifyP02OsvPin(pin, true);
    const baseline = await verifyP02OsvPinSet(specs);
    await rm(lexical);
    const alternate = path.join(dir, "alternate");
    await copyFile(target, alternate);
    await symlink(alternate, lexical);
    const changed = await verifyP02OsvPin(pin, true);
    expect(changed.source).not.toBe(initial.source);
    expect(changed.identity).not.toBe(initial.identity);
    await expect(verifyP02OsvPinSet(specs, baseline)).rejects.toThrow();
    await expect(verifyP02OsvPin(pin, true, (p) => p === target)).rejects.toThrow();
    await rm(lexical);
    await symlink(dir, lexical);
    await expect(verifyP02OsvPin(pin, true)).rejects.toThrow();
    await rm(lexical);
    await link(target, lexical);
    await expect(verifyP02OsvPin(pin)).rejects.toThrow();
    await rm(lexical);
    await writeFile(lexical, "wrong");
    await expect(verifyP02OsvPin(pin)).rejects.toThrow();
  });

  it("rejects duplicate resolved targets and resolved-to-lexical collisions", async () => {
    const { dir, target, pin } = await fixture();
    const alias = path.join(dir, "other.so");
    await symlink(target, alias);
    await expect(
      verifyP02OsvPinSet([
        { pin, allowSymlink: true },
        { pin: { ...pin, path: alias }, allowSymlink: true },
      ])
    ).rejects.toThrow(/collision/);
    await expect(
      verifyP02OsvPinSet([
        { pin, allowSymlink: true },
        { pin: { ...pin, path: target }, allowSymlink: false },
      ])
    ).rejects.toThrow(/collision/);
  });
});
