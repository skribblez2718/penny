import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";

const roots: string[] = [];

function root(label: string): string {
  const value = mkdtempSync(path.join(tmpdir(), `penny-host-result-cache-${label}-`));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    chmodSync(value, 0o700);
    rmSync(value, { recursive: true, force: true });
  }
});

describe("host-operation durable result cache", () => {
  it("publishes exact private bytes atomically and adopts an identical write", async () => {
    const directory = root("roundtrip");
    const cache = await FileHostOperationResultCache.provision(directory);
    const requestSha256 = sha256("exact request bytes");
    const bytes = Buffer.from(canonicalJson({ result: "exact", sequence: 1 }), "utf8");

    const first = await cache.write(requestSha256, bytes);
    const second = await cache.write(requestSha256, bytes);
    const recovered = await cache.read(requestSha256);

    expect(second).toEqual(first);
    expect(recovered).toEqual(first);
    expect(Buffer.from(recovered?.bytes ?? [])).toEqual(bytes);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(directory, `${requestSha256}.json`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(directory, `${requestSha256}.json`), "utf8")).toBe(
      canonicalJson({
        schema_version: 1,
        request_sha256: requestSha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        content_base64: bytes.toString("base64"),
      })
    );
  });

  it("opens only a pre-existing canonical owner-private production root", async () => {
    const directory = root("existing");
    const cache = await FileHostOperationResultCache.openExisting(directory);
    const requestSha256 = sha256("existing root request");
    await cache.write(requestSha256, Buffer.from("exact", "utf8"));
    expect((await cache.read(requestSha256))?.content_sha256).toBe(sha256("exact"));

    const missing = path.join(directory, "missing");
    await expect(FileHostOperationResultCache.openExisting(missing)).rejects.toThrow();
    expect(() => lstatSync(missing)).toThrow();

    chmodSync(directory, 0o750);
    await expect(FileHostOperationResultCache.openExisting(directory)).rejects.toThrow(/0700/u);
    chmodSync(directory, 0o700);

    const symlink = path.join(root("root-link"), "cache");
    symlinkSync(directory, symlink);
    await expect(FileHostOperationResultCache.openExisting(symlink)).rejects.toThrow();
    await expect(FileHostOperationResultCache.openExisting("relative-cache-root")).rejects.toThrow(
      /absolute canonical/u
    );
  });

  it("rejects conflicting bytes, symlink entries, and digest-tampered envelopes", async () => {
    const conflictRoot = root("conflict");
    const conflictCache = await FileHostOperationResultCache.provision(conflictRoot);
    const conflictKey = sha256("conflict request");
    await conflictCache.write(conflictKey, Buffer.from("first", "utf8"));
    await expect(conflictCache.write(conflictKey, Buffer.from("second", "utf8"))).rejects.toThrow(
      /conflicts/u
    );

    const symlinkRoot = root("symlink");
    const symlinkCache = await FileHostOperationResultCache.provision(symlinkRoot);
    const symlinkKey = sha256("symlink request");
    const outside = path.join(root("outside"), "outside.json");
    writeFileSync(outside, "{}", { mode: 0o600 });
    symlinkSync(outside, path.join(symlinkRoot, `${symlinkKey}.json`));
    await expect(symlinkCache.read(symlinkKey)).rejects.toThrow(/not a regular file/u);

    const tamperRoot = root("tamper");
    const tamperCache = await FileHostOperationResultCache.provision(tamperRoot);
    const tamperKey = sha256("tamper request");
    const bytes = Buffer.from("trusted", "utf8");
    await tamperCache.write(tamperKey, bytes);
    const entry = path.join(tamperRoot, `${tamperKey}.json`);
    writeFileSync(
      entry,
      canonicalJson({
        schema_version: 1,
        request_sha256: tamperKey,
        content_sha256: sha256("different"),
        byte_length: bytes.byteLength,
        content_base64: bytes.toString("base64"),
      }),
      { mode: 0o600 }
    );
    await expect(tamperCache.read(tamperKey)).rejects.toThrow(/digest verification/u);
  });
});
