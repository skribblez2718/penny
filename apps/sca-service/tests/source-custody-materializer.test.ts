import { lstatSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { scaP01SourceTreeDigest } from "../../orchestration/dist/sca/p01-contracts.js";
import {
  ScaSourceCustodyMaterializationError,
  materializeScaSourceCustodyV1,
  scaStableUnicodeCollisionKey,
} from "../src/source-custody-materializer.js";

const temporaryParents: string[] = [];

async function temporaryParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "penny-sca-materializer-"));
  temporaryParents.push(parent);
  return parent;
}

async function restoreTreePermissions(root: string): Promise<void> {
  try {
    await chmod(root, 0o700);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await restoreTreePermissions(join(root, entry.name));
    }
  } catch {
    // Cleanup is best-effort after the test oracle has already run.
  }
}

function artifactRef(contentDigest: string, byteLength: number) {
  return {
    schema_version: 2,
    artifact_id: `art_${contentDigest}`,
    run_id: "materializer-fixture",
    phase: "SCA-P01",
    branch_id: null,
    kind: "source-manifest",
    operation_id: "source-custody",
    version: 1,
    producer: "host:source-custody",
    media_type: "application/json",
    byte_length: byteLength,
    content_digest: contentDigest,
    store_ref: `artifact://sha256/${contentDigest}`,
  };
}

function materialInput(entries: ReadonlyArray<readonly [string, string]>) {
  const files = entries
    .map(([path, content]) => {
      const bytes = Buffer.from(content, "utf8");
      return {
        path,
        byte_count: bytes.byteLength,
        content_sha256: sha256(bytes),
        content_base64: bytes.toString("base64"),
      };
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const identities = files.map(({ path, byte_count, content_sha256 }) => ({
    path,
    byte_count,
    content_sha256,
  }));
  const treeSha256 = scaP01SourceTreeDigest(identities);
  const manifest = {
    schema_id: "penny.sca-p01-source-file-manifest.v1",
    schema_version: 1,
    snapshot_id: "snapshot-fixture",
    scope: { include_paths: ["src"], exclude_paths: [] },
    files: identities,
    file_count: files.length,
    byte_count: files.reduce((total, file) => total + file.byte_count, 0),
    tree_sha256: treeSha256,
  };
  const manifestBytes = canonicalJson(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const custody = {
    schema_id: "penny.sca-p01-source-custody-corpus.v1",
    schema_version: 1,
    custody_id: "custody-fixture",
    snapshot_id: "snapshot-fixture",
    file_manifest_ref: artifactRef(manifestSha256, Buffer.byteLength(manifestBytes)),
    files: files.map((file) => ({
      path: file.path,
      encoding: "base64" as const,
      content_base64: file.content_base64,
      byte_count: file.byte_count,
      content_sha256: file.content_sha256,
    })),
    file_count: files.length,
    byte_count: files.reduce((total, file) => total + file.byte_count, 0),
    tree_sha256: treeSha256,
    sealed: true as const,
  };
  return {
    schema_id: "penny.sca-source-custody-materialization-input.v1",
    schema_version: 1,
    file_manifest_sha256: manifestSha256,
    custody_sha256: sha256(canonicalJson(custody)),
    file_manifest: manifest,
    custody,
  };
}

function expectMissingSync(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error && "code" in error) expect(error.code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected '${path}' to be absent`);
}

async function expectMaterializerError(
  run: () => Promise<unknown>,
  code: ScaSourceCustodyMaterializationError["code"]
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaSourceCustodyMaterializationError);
    if (error instanceof ScaSourceCustodyMaterializationError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected source custody materialization error '${code}'`);
}

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop();
    if (parent !== undefined) {
      await restoreTreePermissions(parent);
      await rm(parent, { recursive: true, force: true });
    }
  }
});

describe("SCA-P02 exact source custody materializer", () => {
  it("publishes the complete fsynced tree in one rename and recovers a published replay", async () => {
    const parent = await temporaryParent();
    const stagingRoot = join(parent, "stage");
    const input = materialInput([
      ["src/a.php", "<?php echo 'safe';\n"],
      ["src/nested/app.ts", "export const safe = true;\n"],
    ]);
    const before = JSON.stringify(input);
    const visibility: string[] = [];
    const materialized = await materializeScaSourceCustodyV1(input, {
      staging_root: stagingRoot,
      on_file_materialized: () => {
        visibility.push("callback");
        expectMissingSync(stagingRoot);
      },
    });

    expect(visibility).toHaveLength(2);
    expect(JSON.stringify(input)).toBe(before);
    expect(materialized.receipt).toMatchObject({
      staging_root: stagingRoot,
      tree_sha256: input.file_manifest.tree_sha256,
      file_count: 2,
      directory_mode: "0555",
      filesystem_modes_prepared_read_only: true,
      sandbox_read_only_enforced: false,
    });
    expect(materialized.receipt.generation_token).toMatch(/^[a-f0-9]{64}$/u);
    expect(materialized.receipt.filesystem_identity).toEqual({
      device: (await lstat(stagingRoot, { bigint: true })).dev.toString(),
      inode: (await lstat(stagingRoot, { bigint: true })).ino.toString(),
    });
    expect((await stat(stagingRoot)).mode & 0o777).toBe(0o555);
    expect((await stat(join(stagingRoot, "src/a.php"))).mode & 0o777).toBe(0o444);
    expect(await readFile(join(stagingRoot, "src/a.php"), "utf8")).toBe("<?php echo 'safe';\n");
    await expect(writeFile(join(stagingRoot, "src/a.php"), "changed")).rejects.toThrow();

    const replay = await materializeScaSourceCustodyV1(input, { staging_root: stagingRoot });
    expect(replay.receipt).toEqual(materialized.receipt);

    const cleanup = await replay.cleanup();
    expect(cleanup).toMatchObject({
      schema_id: "penny.sca-source-custody-quarantine-receipt.v1",
      generation_token: materialized.receipt.generation_token,
      filesystem_identity: materialized.receipt.filesystem_identity,
      status: "quarantined",
      method: "identity_checked_atomic_rename_to_private_quarantine",
    });
    if (cleanup.quarantine_path === null || cleanup.quarantine_token === null) {
      throw new Error("expected an exact quarantine receipt");
    }
    expect(cleanup.quarantine_path).toBe(
      join(parent, `${basename(stagingRoot)}.penny-quarantine-${cleanup.quarantine_token}`)
    );
    expect({
      device: (await lstat(cleanup.quarantine_path, { bigint: true })).dev.toString(),
      inode: (await lstat(cleanup.quarantine_path, { bigint: true })).ino.toString(),
    }).toEqual(materialized.receipt.filesystem_identity);
    expect(await readFile(join(cleanup.quarantine_path, "src/a.php"), "utf8")).toBe(
      "<?php echo 'safe';\n"
    );
    expect(await replay.cleanup()).toMatchObject({
      status: "already_absent",
      quarantine_path: null,
      quarantine_token: null,
    });
    await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds cleanup to generation and inode so an old cleanup cannot delete a replacement", async () => {
    const parent = await temporaryParent();
    const stagingRoot = join(parent, "stage");
    const input = materialInput([["src/a.php", "safe"]]);
    const first = await materializeScaSourceCustodyV1(input, { staging_root: stagingRoot });
    const firstCleanup = await first.cleanup();
    if (firstCleanup.quarantine_path === null) throw new Error("expected first quarantine path");
    const replacement = await materializeScaSourceCustodyV1(input, { staging_root: stagingRoot });

    expect(replacement.receipt.generation_token).not.toBe(first.receipt.generation_token);
    await expectMaterializerError(() => first.cleanup(), "ownership_mismatch");
    expect(await readFile(join(stagingRoot, "src/a.php"), "utf8")).toBe("safe");
    expect(await readFile(join(firstCleanup.quarantine_path, "src/a.php"), "utf8")).toBe("safe");
    await replacement.cleanup();
  });

  it("recovers recognized empty partial generations and refuses unknown control occupants", async () => {
    const parent = await temporaryParent();
    const stagingRoot = join(parent, "retry-stage");
    const token = "a".repeat(64);
    const partial = join(parent, `${basename(stagingRoot)}.penny-partial-${token}`);
    await mkdir(partial, { mode: 0o700 });
    const recovered = await materializeScaSourceCustodyV1(materialInput([["src/a.php", "safe"]]), {
      staging_root: stagingRoot,
    });
    await expect(lstat(partial)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(parent)).filter((entry) => entry.startsWith("retry-stage.penny-quarantine-"))
    ).toHaveLength(1);
    await recovered.cleanup();

    const unknown = join(parent, `${basename(stagingRoot)}.penny-partial-not-a-token`);
    await mkdir(unknown, { mode: 0o700 });
    await expectMaterializerError(
      () =>
        materializeScaSourceCustodyV1(materialInput([["src/a.php", "safe"]]), {
          staging_root: stagingRoot,
        }),
      "unknown_occupant"
    );
  });

  it("cleans an interrupted private tree and allows deterministic retry", async () => {
    const parent = await temporaryParent();
    const stagingRoot = join(parent, "retry-stage");
    const input = materialInput([
      ["src/a.php", "one"],
      ["src/b.php", "two"],
    ]);
    const controller = new AbortController();
    await expectMaterializerError(
      () =>
        materializeScaSourceCustodyV1(input, {
          staging_root: stagingRoot,
          signal: controller.signal,
          on_file_materialized: (completed) => {
            if (completed === 1) controller.abort();
          },
        }),
      "interrupted"
    );
    await expect(lstat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(parent)).filter((entry) => entry.includes(".penny-partial-"))).toEqual(
      []
    );
    expect(
      (await readdir(parent)).filter((entry) => entry.includes(".penny-quarantine-"))
    ).toHaveLength(1);

    const retried = await materializeScaSourceCustodyV1(input, { staging_root: stagingRoot });
    expect(retried.receipt.file_count).toBe(2);
    await retried.cleanup();
  });

  it("uses complete Unicode Default Case Folding for path-collision keys", async () => {
    expect(scaStableUnicodeCollisionKey("src/Straße.php")).toBe(
      scaStableUnicodeCollisionKey("src/STRASSE.php")
    );
    expect(scaStableUnicodeCollisionKey("src/ος.php")).toBe(
      scaStableUnicodeCollisionKey("src/οσ.php")
    );
    expect(scaStableUnicodeCollisionKey("src/\u0345.php")).toBe(
      scaStableUnicodeCollisionKey("src/ι.php")
    );
    const parent = await temporaryParent();
    for (const [left, right] of [
      ["src/Straße.php", "src/STRASSE.php"],
      ["src/ος.php", "src/οσ.php"],
      ["src/\u0345.php", "src/ι.php"],
    ] as const) {
      await expectMaterializerError(
        () =>
          materializeScaSourceCustodyV1(
            materialInput([
              [left, "one"],
              [right, "two"],
            ]),
            { staging_root: join(parent, `collision-${sha256(left).slice(0, 8)}`) }
          ),
        "path_collision"
      );
    }
  });

  it("contains no component-owned recursive deletion path", async () => {
    const sourceText = await readFile(
      fileURLToPath(new URL("../src/source-custody-materializer.ts", import.meta.url)),
      "utf8"
    );
    expect(sourceText).not.toContain("recursive: true");
    expect(sourceText).not.toMatch(/\brm\s*\(/u);
  });

  it("rejects traversal, symlinks, custody drift, and unknown published occupants", async () => {
    const parent = await temporaryParent();
    const traversal = materialInput([["src/a.php", "safe"]]);
    traversal.file_manifest.files[0] = { ...traversal.file_manifest.files[0], path: "../a.php" };
    traversal.custody.files[0] = { ...traversal.custody.files[0], path: "../a.php" };
    await expectMaterializerError(
      () => materializeScaSourceCustodyV1(traversal, { staging_root: join(parent, "traversal") }),
      "invalid_input"
    );

    const target = join(parent, "target");
    const linked = join(parent, "linked-stage");
    await mkdir(target);
    await symlink(target, linked);
    await expectMaterializerError(
      () =>
        materializeScaSourceCustodyV1(materialInput([["src/a.php", "safe"]]), {
          staging_root: linked,
        }),
      "symlink_refused"
    );

    const input = materialInput([["src/a.php", "safe"]]);
    const mutated = {
      ...input,
      custody: {
        ...input.custody,
        files: [
          { ...input.custody.files[0], content_base64: Buffer.from("changed").toString("base64") },
        ],
      },
    };
    await expectMaterializerError(
      () => materializeScaSourceCustodyV1(mutated, { staging_root: join(parent, "mutated") }),
      "invalid_input"
    );

    const existing = join(parent, "existing");
    await mkdir(existing);
    await expectMaterializerError(
      () => materializeScaSourceCustodyV1(input, { staging_root: existing }),
      "unknown_occupant"
    );
  });
});
