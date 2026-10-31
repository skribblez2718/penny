import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  SCA_SOURCE_ADMISSION_REQUEST_SCHEMA,
  ScaSourceAdmissionError,
  admitScaSourceV1,
  type ScaSourceAdmissionRequestV1,
} from "../dist/sca/source-admission.js";
import {
  SCA_SOURCE_ADMISSION_POLICY_SCHEMA,
  SCA_SOURCE_MANIFEST_SCHEMA,
  SCA_SOURCE_SNAPSHOT_SCHEMA,
  canonicalScaSourceSnapshotV1,
  computeScaSourceTreeSha256,
  validateScaSourceAdmissionResultV1,
  type ScaSourceAdmissionPolicyV1,
  type ScaSourceFileDeclarationV1,
  type ScaSourceAdmissionResultV1,
} from "../dist/sca/source-inventory.js";
import type { ArtifactRef } from "../dist/contracts.js";

const DEFAULT_POLICY: ScaSourceAdmissionPolicyV1 = {
  schema_id: SCA_SOURCE_ADMISSION_POLICY_SCHEMA,
  schema_version: 1,
  max_files: 32,
  max_bytes_per_file: 1_024,
  max_total_bytes: 8_192,
  max_path_bytes: 256,
  max_path_depth: 8,
  binary: "exclude",
  generated: "exclude",
  generated_paths: [],
};

interface DeclaredBytes {
  readonly path: string;
  readonly bytes: Buffer;
  readonly content_kind?: "text" | "binary";
  readonly generated?: boolean;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "sca-source-admission-")));
  temporaryRoots.push(root);
  return root;
}

function write(root: string, relativePath: string, bytes: Buffer): void {
  const destination = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

function declaration(value: DeclaredBytes): ScaSourceFileDeclarationV1 {
  return {
    path: value.path,
    expected_byte_length: value.bytes.byteLength,
    expected_sha256: sha256(value.bytes),
    content_kind: value.content_kind ?? "text",
    generated: value.generated ?? false,
  };
}

function artifactIdFor(metadata: {
  readonly run_id: string;
  readonly phase: string;
  readonly branch_id: string | null;
  readonly kind: string;
  readonly operation_id: string;
  readonly version: number;
}): string {
  return `art_${sha256(
    canonicalJson({
      branch_id: metadata.branch_id,
      kind: metadata.kind,
      operation_id: metadata.operation_id,
      phase: metadata.phase,
      run_id: metadata.run_id,
      version: metadata.version,
    })
  )}`;
}

function snapshotRef(
  runId: string,
  treeDigest: string,
  treeByteLength: number,
  operationId = "source-admission"
): ArtifactRef {
  const identity = {
    run_id: runId,
    phase: "source-admission",
    branch_id: null,
    kind: "source-snapshot",
    operation_id: operationId,
    version: 1,
  } as const;
  return {
    schema_version: 2,
    artifact_id: artifactIdFor(identity),
    ...identity,
    producer: "orchestration",
    media_type: "application/vnd.penny.sca-source-tree+json",
    content_schema: { schema_id: SCA_SOURCE_SNAPSHOT_SCHEMA, schema_version: 1 },
    byte_length: treeByteLength,
    content_digest: treeDigest,
    store_ref: `artifact://sha256/${treeDigest}`,
  };
}

function requestFor(
  root: string,
  files: readonly ScaSourceFileDeclarationV1[],
  policy?: ScaSourceAdmissionPolicyV1,
  identity: { readonly tenant_id: string; readonly project_id: string; readonly run_id: string } = {
    tenant_id: "tenant-a",
    project_id: "project-a",
    run_id: "run-a",
  }
): ScaSourceAdmissionRequestV1 {
  const effectivePolicy =
    policy ??
    ({
      ...DEFAULT_POLICY,
      generated_paths: files.filter((file) => file.generated).map((file) => file.path),
    } satisfies ScaSourceAdmissionPolicyV1);
  const tree = files.map((file) => ({
    path: file.path,
    byte_length: file.expected_byte_length,
    sha256: file.expected_sha256,
  }));
  const treeDigest = computeScaSourceTreeSha256(tree);
  const treeByteLength = Buffer.byteLength(canonicalScaSourceSnapshotV1(tree), "utf8");
  return {
    schema_id: SCA_SOURCE_ADMISSION_REQUEST_SCHEMA,
    schema_version: 1,
    ...identity,
    source_snapshot_ref: snapshotRef(identity.run_id, treeDigest, treeByteLength),
    root,
    policy: effectivePolicy,
    files: [...files],
  };
}

function expectAdmissionCode(action: () => unknown, code: ScaSourceAdmissionError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ScaSourceAdmissionError && error.code === code
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resignInventory(inventory: ScaSourceAdmissionResultV1): ScaSourceAdmissionResultV1 {
  const { inventory_sha256: _discarded, ...unsigned } = inventory;
  return {
    ...unsigned,
    inventory_sha256: sha256(canonicalJson(unsigned)),
  };
}

test("admits exact declarations with stable replay, deterministic order, and no discovery", () => {
  const root = tempRoot();
  const sources: DeclaredBytes[] = [
    { path: "z.bin", bytes: Buffer.from([0, 255, 7]), content_kind: "binary" },
    { path: "src/a.ts", bytes: Buffer.from("export const a = 1;\n") },
    {
      path: "generated/client.ts",
      bytes: Buffer.from("export const generated = true;\n"),
      generated: true,
    },
  ];
  for (const source of sources) write(root, source.path, source.bytes);
  write(root, "undeclared.txt", Buffer.from("not part of the exact declaration"));

  const before = new Map(
    sources.map((source) => [source.path, readFileSync(path.join(root, source.path))])
  );
  const request = requestFor(root, sources.map(declaration).reverse());
  const first = admitScaSourceV1(request);
  const second = admitScaSourceV1(request);

  assert.deepEqual(second, first);
  assert.equal(first.schema_id, SCA_SOURCE_MANIFEST_SCHEMA);
  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    ["generated/client.ts", "src/a.ts", "z.bin"]
  );
  assert.deepEqual(
    first.entries.map((entry) => [entry.status, entry.reason]),
    [
      ["excluded", "excluded_generated"],
      ["included", "included_by_policy"],
      ["excluded", "excluded_binary"],
    ]
  );
  assert.deepEqual(first.counts, { declared: 3, included: 1, excluded: 2 });
  assert.equal(
    first.bytes.declared,
    sources.reduce((sum, source) => sum + source.bytes.byteLength, 0)
  );
  assert.equal(first.tree_sha256, request.source_snapshot_ref.content_digest);
  validateScaSourceAdmissionResultV1(first, {
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    source_snapshot_ref: request.source_snapshot_ref,
  });

  for (const source of sources) {
    assert.deepEqual(readFileSync(path.join(root, source.path)), before.get(source.path));
  }

  write(root, "another-undeclared.txt", Buffer.from("also ignored"));
  assert.deepEqual(admitScaSourceV1(request), first);
});

test("closed request, policy, declaration, and inventory schemas reject unknown fields", () => {
  const root = tempRoot();
  const bytes = Buffer.from("hello");
  write(root, "a.txt", bytes);
  const base = requestFor(root, [declaration({ path: "a.txt", bytes })]);

  expectAdmissionCode(() => admitScaSourceV1({ ...base, surprise: true }), "invalid_input");
  expectAdmissionCode(() => admitScaSourceV1({ ...base, files: null }), "invalid_input");
  expectAdmissionCode(
    () => admitScaSourceV1({ ...base, policy: { ...base.policy, surprise: true } }),
    "invalid_input"
  );
  const firstDeclaration = base.files.at(0);
  assert.ok(firstDeclaration);
  expectAdmissionCode(
    () => admitScaSourceV1({ ...base, files: [{ ...firstDeclaration, surprise: true }] }),
    "invalid_input"
  );

  const inventory = admitScaSourceV1(base);
  assert.throws(() => validateScaSourceAdmissionResultV1({ ...inventory, surprise: true }));
  const firstEntry = inventory.entries.at(0);
  assert.ok(firstEntry);
  assert.throws(() =>
    validateScaSourceAdmissionResultV1({
      ...inventory,
      entries: [{ ...firstEntry, surprise: true }],
    })
  );
});

test("rejects noncanonical and mismatched source snapshot bindings", () => {
  const root = tempRoot();
  const bytes = Buffer.from("binding");
  write(root, "a.txt", bytes);
  const base = requestFor(root, [declaration({ path: "a.txt", bytes })]);

  expectAdmissionCode(
    () =>
      admitScaSourceV1({
        ...base,
        source_snapshot_ref: {
          ...base.source_snapshot_ref,
          store_ref: `artifact://sha256/${"0".repeat(64)}`,
        },
      }),
    "binding_mismatch"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1({
        ...base,
        source_snapshot_ref: { ...base.source_snapshot_ref, run_id: "another-run" },
      }),
    "binding_mismatch"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1({
        ...base,
        source_snapshot_ref: {
          ...base.source_snapshot_ref,
          byte_length: base.source_snapshot_ref.byte_length + 1,
        },
      }),
    "binding_mismatch"
  );
  const wrongDigest = "1".repeat(64);
  expectAdmissionCode(
    () =>
      admitScaSourceV1({
        ...base,
        source_snapshot_ref: {
          ...snapshotRef(base.run_id, wrongDigest, base.source_snapshot_ref.byte_length),
          content_digest: wrongDigest,
        },
      }),
    "binding_mismatch"
  );
});

test("requires one existing absolute canonical non-symlink root", () => {
  const outer = tempRoot();
  const actual = path.join(outer, "actual");
  mkdirSync(actual);
  const bytes = Buffer.from("root");
  write(actual, "a.txt", bytes);
  const file = declaration({ path: "a.txt", bytes });

  expectAdmissionCode(() => admitScaSourceV1(requestFor("relative", [file])), "unsafe_root");
  expectAdmissionCode(
    () => admitScaSourceV1(requestFor(path.join(outer, "missing"), [file])),
    "unsafe_root"
  );
  expectAdmissionCode(() => admitScaSourceV1(requestFor(`${actual}/`, [file])), "unsafe_root");

  const linkedRoot = path.join(outer, "linked-root");
  symlinkSync(actual, linkedRoot, "dir");
  expectAdmissionCode(() => admitScaSourceV1(requestFor(linkedRoot, [file])), "unsafe_root");

  const linkParent = path.join(outer, "link-parent");
  symlinkSync(outer, linkParent, "dir");
  expectAdmissionCode(
    () => admitScaSourceV1(requestFor(path.join(linkParent, "actual"), [file])),
    "unsafe_root"
  );
});

test("rejects unsafe and noncanonical repository-relative paths", () => {
  const root = tempRoot();
  const bytes = Buffer.from("x");
  const unsafePaths = [
    "/absolute.txt",
    "../escape.txt",
    "a/../escape.txt",
    "a/./b.txt",
    "a//b.txt",
    "trailing/",
    "C:/windows.txt",
    "a\\b.txt",
    "nul\0name.txt",
    "line\nname.txt",
    "cafe\u0301.txt",
  ];

  for (const unsafePath of unsafePaths) {
    const file = declaration({ path: unsafePath, bytes });
    expectAdmissionCode(() => admitScaSourceV1(requestFor(root, [file])), "unsafe_path");
  }
});

test("rejects duplicate, case-fold, and Unicode-compatibility path collisions", () => {
  const root = tempRoot();
  const bytes = Buffer.from("x");
  const pairs = [
    ["same.txt", "same.txt"],
    ["Readme.md", "README.md"],
    ["K.txt", "\u24c0.txt"],
    ["A.txt", "\uff21.txt"],
    ["strasse.txt", "stra\u00dfe.txt"],
  ] as const;

  for (const [left, right] of pairs) {
    expectAdmissionCode(
      () =>
        admitScaSourceV1(
          requestFor(root, [
            declaration({ path: left, bytes }),
            declaration({ path: right, bytes }),
          ])
        ),
      "path_collision"
    );
  }
});

test("validates and collision-checks policy-owned generated paths", () => {
  const root = tempRoot();
  const bytes = Buffer.from("x");
  write(root, "a.txt", bytes);
  const file = declaration({ path: "a.txt", bytes });

  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [file], { ...DEFAULT_POLICY, generated_paths: ["../generated.ts"] })
      ),
    "unsafe_path"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [file], {
          ...DEFAULT_POLICY,
          generated_paths: ["Generated.ts", "generated.ts"],
        })
      ),
    "path_collision"
  );
});

test("rejects final and intermediate symlinks, hard links, non-regular files, and missing files", () => {
  const root = tempRoot();
  const outside = tempRoot();
  const bytes = Buffer.from("target");
  write(outside, "outside.txt", bytes);

  symlinkSync(path.join(outside, "outside.txt"), path.join(root, "final-link"));
  expectAdmissionCode(
    () => admitScaSourceV1(requestFor(root, [declaration({ path: "final-link", bytes })])),
    "unsafe_path"
  );

  symlinkSync(outside, path.join(root, "dir-link"), "dir");
  expectAdmissionCode(
    () =>
      admitScaSourceV1(requestFor(root, [declaration({ path: "dir-link/outside.txt", bytes })])),
    "unsafe_path"
  );

  mkdirSync(path.join(root, "directory"));
  expectAdmissionCode(
    () => admitScaSourceV1(requestFor(root, [declaration({ path: "directory", bytes })])),
    "unsafe_path"
  );

  expectAdmissionCode(
    () => admitScaSourceV1(requestFor(root, [declaration({ path: "missing.txt", bytes })])),
    "filesystem_refused"
  );

  write(root, "original.txt", bytes);
  linkSync(path.join(root, "original.txt"), path.join(root, "hard-link.txt"));
  expectAdmissionCode(
    () => admitScaSourceV1(requestFor(root, [declaration({ path: "original.txt", bytes })])),
    "unsafe_path"
  );
});

test("rejects file-count, per-file, total-byte, path-byte, and path-depth quota overflow", () => {
  const root = tempRoot();
  const one = Buffer.from("1");
  const three = Buffer.from("123");
  write(root, "a", three);
  write(root, "b", three);
  write(root, "long", one);
  write(root, "d/e", one);

  const countPolicy = { ...DEFAULT_POLICY, max_files: 1 };
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(
          root,
          [declaration({ path: "a", bytes: three }), declaration({ path: "b", bytes: three })],
          countPolicy
        )
      ),
    "quota_exceeded"
  );

  const filePolicy = { ...DEFAULT_POLICY, max_bytes_per_file: 2 };
  expectAdmissionCode(
    () =>
      admitScaSourceV1(requestFor(root, [declaration({ path: "a", bytes: three })], filePolicy)),
    "quota_exceeded"
  );

  const totalPolicy = { ...DEFAULT_POLICY, max_bytes_per_file: 3, max_total_bytes: 5 };
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(
          root,
          [declaration({ path: "a", bytes: three }), declaration({ path: "b", bytes: three })],
          totalPolicy
        )
      ),
    "quota_exceeded"
  );

  const pathPolicy = { ...DEFAULT_POLICY, max_path_bytes: 3 };
  expectAdmissionCode(
    () =>
      admitScaSourceV1(requestFor(root, [declaration({ path: "long", bytes: one })], pathPolicy)),
    "quota_exceeded"
  );

  const depthPolicy = { ...DEFAULT_POLICY, max_path_depth: 1 };
  expectAdmissionCode(
    () =>
      admitScaSourceV1(requestFor(root, [declaration({ path: "d/e", bytes: one })], depthPolicy)),
    "quota_exceeded"
  );
});

test("rejects expected byte-length and digest mismatches", () => {
  const root = tempRoot();
  const bytes = Buffer.from("actual");
  write(root, "a.txt", bytes);
  const valid = declaration({ path: "a.txt", bytes });

  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [{ ...valid, expected_byte_length: valid.expected_byte_length - 1 }])
      ),
    "integrity_mismatch"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [{ ...valid, expected_sha256: sha256(Buffer.from("other")) }])
      ),
    "integrity_mismatch"
  );
});

test("validates declared text bytes before binary policy disposition", () => {
  const root = tempRoot();
  const nul = Buffer.from([0x61, 0x00, 0x62]);
  const malformedUtf8 = Buffer.from([0xc3, 0x28]);
  const disallowedControl = Buffer.from("left\u0007right", "utf8");
  const ordinaryText = Buffer.from("first\tcolumn\nsecond line\n", "utf8");
  write(root, "nul.txt", nul);
  write(root, "malformed.txt", malformedUtf8);
  write(root, "control.txt", disallowedControl);
  write(root, "ordinary.txt", ordinaryText);

  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [declaration({ path: "nul.txt", bytes: nul })], {
          ...DEFAULT_POLICY,
          binary: "error",
        })
      ),
    "integrity_mismatch"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [declaration({ path: "malformed.txt", bytes: malformedUtf8 })], {
          ...DEFAULT_POLICY,
          binary: "exclude",
        })
      ),
    "integrity_mismatch"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [declaration({ path: "control.txt", bytes: disallowedControl })], {
          ...DEFAULT_POLICY,
          binary: "exclude",
        })
      ),
    "integrity_mismatch"
  );

  const admitted = admitScaSourceV1(
    requestFor(root, [declaration({ path: "ordinary.txt", bytes: ordinaryText })], {
      ...DEFAULT_POLICY,
      binary: "error",
    })
  );
  assert.equal(admitted.entries.at(0)?.status, "included");
});

test("binary and generated include/exclude/error policies are explicit", () => {
  const root = tempRoot();
  const bytes = Buffer.from([0, 1, 2]);
  const generatedBytes = Buffer.from("generated\n");
  write(root, "binary.dat", bytes);
  write(root, "generated.txt", generatedBytes);

  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [declaration({ path: "binary.dat", bytes, content_kind: "binary" })], {
          ...DEFAULT_POLICY,
          binary: "error",
        })
      ),
    "policy_rejected"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(
          root,
          [declaration({ path: "generated.txt", bytes: generatedBytes, generated: true })],
          {
            ...DEFAULT_POLICY,
            generated: "error",
            generated_paths: ["generated.txt"],
          }
        )
      ),
    "policy_rejected"
  );

  const included = admitScaSourceV1(
    requestFor(
      root,
      [
        declaration({
          path: "binary.dat",
          bytes,
          content_kind: "binary",
          generated: true,
        }),
      ],
      {
        ...DEFAULT_POLICY,
        binary: "include",
        generated: "include",
        generated_paths: ["binary.dat"],
      }
    )
  );
  assert.deepEqual(
    included.entries.map((entry) => [entry.status, entry.reason]),
    [["included", "included_by_policy"]]
  );
});

test("rejects generated classification lies in both directions at admission and validation", () => {
  const root = tempRoot();
  const bytes = Buffer.from("generated authority\n");
  write(root, "a.txt", bytes);
  const plain = declaration({ path: "a.txt", bytes });
  const claimedGenerated = { ...plain, generated: true };

  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [plain], {
          ...DEFAULT_POLICY,
          generated: "include",
          generated_paths: ["a.txt"],
        })
      ),
    "invalid_input"
  );
  expectAdmissionCode(
    () =>
      admitScaSourceV1(
        requestFor(root, [claimedGenerated], {
          ...DEFAULT_POLICY,
          generated: "include",
          generated_paths: [],
        })
      ),
    "invalid_input"
  );

  const generatedInventory = admitScaSourceV1(
    requestFor(root, [claimedGenerated], {
      ...DEFAULT_POLICY,
      generated: "include",
      generated_paths: ["a.txt"],
    })
  );
  const forgedNonGenerated = clone(generatedInventory);
  const generatedEntry = forgedNonGenerated.entries.at(0);
  assert.ok(generatedEntry);
  generatedEntry.generated = false;
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(forgedNonGenerated)));

  const plainInventory = admitScaSourceV1(
    requestFor(root, [plain], { ...DEFAULT_POLICY, generated: "include" })
  );
  const forgedGenerated = clone(plainInventory);
  const plainEntry = forgedGenerated.entries.at(0);
  assert.ok(plainEntry);
  plainEntry.generated = true;
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(forgedGenerated)));
});

test("rejects simulated bind-mount boundaries using injected stable mount identities", () => {
  const root = tempRoot();
  const bytes = Buffer.from("mount boundary\n");
  write(root, "mounted/a.txt", bytes);
  const seenTargets: string[] = [];

  expectAdmissionCode(
    () =>
      admitScaSourceV1(requestFor(root, [declaration({ path: "mounted/a.txt", bytes })]), {
        mountIdentityResolver(_descriptor, target) {
          seenTargets.push(`${target.kind}:${target.path}`);
          return target.kind === "directory" && target.path === "mounted"
            ? "simulated-bind-mount"
            : "simulated-root-mount";
        },
      }),
    "filesystem_refused"
  );
  assert.ok(seenTargets.some((target) => target.startsWith("root:")));
  assert.ok(seenTargets.includes("directory:mounted"));
});

test("fails closed when stable mount identity is unavailable", () => {
  const root = tempRoot();
  const bytes = Buffer.from("mount identity\n");
  write(root, "a.txt", bytes);

  expectAdmissionCode(
    () =>
      admitScaSourceV1(requestFor(root, [declaration({ path: "a.txt", bytes })]), {
        mountIdentityResolver() {
          throw new Error("unavailable");
        },
      }),
    "filesystem_refused"
  );
});

test("detects replacement and in-place mutation races across read boundaries", () => {
  const replacementRoot = tempRoot();
  const expected = Buffer.from("expected");
  write(replacementRoot, "a.txt", expected);
  write(replacementRoot, "replacement.tmp", expected);
  const replacementRequest = requestFor(replacementRoot, [
    declaration({ path: "a.txt", bytes: expected }),
  ]);

  expectAdmissionCode(
    () =>
      admitScaSourceV1(replacementRequest, {
        onBoundary(event) {
          if (event.stage === "after_file_open") {
            renameSync(path.join(replacementRoot, "a.txt"), path.join(replacementRoot, "old.tmp"));
            renameSync(
              path.join(replacementRoot, "replacement.tmp"),
              path.join(replacementRoot, "a.txt")
            );
          }
        },
      }),
    "read_race"
  );

  const mutationRoot = tempRoot();
  write(mutationRoot, "a.txt", expected);
  const mutationRequest = requestFor(mutationRoot, [
    declaration({ path: "a.txt", bytes: expected }),
  ]);
  expectAdmissionCode(
    () =>
      admitScaSourceV1(mutationRequest, {
        onBoundary(event) {
          if (event.stage === "after_file_read") {
            writeFileSync(path.join(mutationRoot, "a.txt"), Buffer.from("mutated!"));
          }
        },
      }),
    "read_race"
  );
});

test("rejects cross-file mutation with a no-hook whole-set coherence pass", () => {
  const root = tempRoot();
  const originalA = Buffer.from("aaaaaaaa");
  const mutatedA = Buffer.from("bbbbbbbb");
  const z = Buffer.from("zzzzzzzz");
  write(root, "a.txt", originalA);
  write(root, "z.txt", z);
  const request = requestFor(root, [
    declaration({ path: "a.txt", bytes: originalA }),
    declaration({ path: "z.txt", bytes: z }),
  ]);
  let boundaryCalls = 0;
  let mutations = 0;

  expectAdmissionCode(
    () =>
      admitScaSourceV1(request, {
        onBoundary(event) {
          boundaryCalls += 1;
          if (event.stage === "after_file_read" && event.path === "z.txt") {
            mutations += 1;
            writeFileSync(path.join(root, "a.txt"), mutatedA);
          }
        },
      }),
    "read_race"
  );
  assert.equal(mutations, 1);
  assert.equal(boundaryCalls, 4);
});

test("inventory validator rejects forged counts, totals, digests, order, disposition, and bindings", () => {
  const root = tempRoot();
  const a = Buffer.from("a");
  const b = Buffer.from("bb");
  write(root, "a.txt", a);
  write(root, "b.txt", b);
  const request = requestFor(root, [
    declaration({ path: "b.txt", bytes: b, content_kind: "binary" }),
    declaration({ path: "a.txt", bytes: a }),
  ]);
  const valid = admitScaSourceV1(request);
  const binding = {
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    source_snapshot_ref: request.source_snapshot_ref,
  };

  const badCount = clone(valid);
  badCount.counts.included += 1;
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(badCount), binding));

  const badBytes = clone(valid);
  badBytes.bytes.declared += 1;
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(badBytes), binding));

  const badTree = clone(valid);
  badTree.tree_sha256 = "0".repeat(64);
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(badTree), binding));

  const badInventoryDigest = clone(valid);
  badInventoryDigest.inventory_sha256 = "0".repeat(64);
  assert.throws(() => validateScaSourceAdmissionResultV1(badInventoryDigest, binding));

  const badOrder = clone(valid);
  badOrder.entries.reverse();
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(badOrder), binding));

  const badDisposition = clone(valid);
  const firstEntry = badDisposition.entries.at(0);
  assert.ok(firstEntry);
  firstEntry.status = "excluded";
  firstEntry.reason = "excluded_generated";
  assert.throws(() => validateScaSourceAdmissionResultV1(resignInventory(badDisposition), binding));

  const reboundSnapshot = clone(valid);
  reboundSnapshot.source_snapshot_ref = snapshotRef(
    request.run_id,
    valid.tree_sha256,
    request.source_snapshot_ref.byte_length,
    "different-source-snapshot"
  );
  assert.throws(() =>
    validateScaSourceAdmissionResultV1(resignInventory(reboundSnapshot), binding)
  );

  const reboundIdentity = clone(valid);
  reboundIdentity.tenant_id = "tenant-b";
  assert.throws(() =>
    validateScaSourceAdmissionResultV1(resignInventory(reboundIdentity), binding)
  );
});
