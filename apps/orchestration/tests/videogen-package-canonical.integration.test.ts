import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  stageFrozenPortablePackage,
  verifyFrozenPortablePackage,
  PORTABLE_MANIFEST_PATH,
} from "../dist/videogen/portable-package.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { editFixture, manifestMetadata, packageFixture } from "./helpers/videogen-edit-fixtures.js";

function parent(f: FoundationFixture, name = "staging") {
  const root = path.join(f.root, name);
  mkdirSync(root, { mode: 0o700 });
  return root;
}
describe("portable-package real canonical-store / disposable no-follow staging lifecycle", () => {
  it("hashes complete payload before manifest persistence, then reopens canonical store and relocates structural bytes", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const root = parent(f);
    const persist = f.store.persist.bind(f.store);
    const observer = vi.spyOn(f.store, "persist").mockImplementation((input) => {
      const stages = readdirSync(root);
      expect(stages).toHaveLength(1);
      const stage = path.join(root, stages[0] ?? "absent");
      for (const file of p.manifest.files) {
        const actual = readFileSync(path.join(stage, file.relative_path));
        expect(actual.length).toBe(file.bytes);
        expect(sha256(actual)).toBe(file.sha256);
        expect(statSync(path.join(stage, file.relative_path)).nlink).toBe(1);
      }
      expect(readFileSync(path.join(stage, PORTABLE_MANIFEST_PATH), "utf8")).toBe(
        canonicalJson(p.manifest)
      );
      expect(input.content).toEqual(Buffer.from(canonicalJson(p.manifest)));
      return persist(input);
    });
    const staged = stageFrozenPortablePackage({
      host: e.host,
      manifest: p.manifest,
      staging_parent: root,
      output_metadata: manifestMetadata(f),
    });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(staged.manifest_ref.content_digest).toBe(staged.manifest_sha256);
    expect(statSync(staged.staging_root).mode & 0o077).toBe(0);
    expect(staged).toMatchObject({ production_admission: "blocked", effect_permission: "none" });
    using reopened = ArtifactStore.openExisting(path.join(f.root, "artifacts"), {
      projectId: f.project_id,
    });
    const readOnlyPersist = vi.spyOn(reopened, "persist");
    const host = { ...e.host, store: reopened };
    expect(
      verifyFrozenPortablePackage({
        host,
        manifest_ref: staged.manifest_ref,
        staging_root: staged.staging_root,
      }).manifest_sha256
    ).toBe(staged.manifest_sha256);
    const relocated = path.join(f.root, "relocated-structural-only");
    cpSync(staged.staging_root, relocated, { recursive: true });
    chmodSync(relocated, 0o700);
    for (const file of p.manifest.files) {
      chmodSync(path.dirname(path.join(relocated, file.relative_path)), 0o700);
      chmodSync(path.join(relocated, file.relative_path), 0o600);
    }
    chmodSync(path.join(relocated, PORTABLE_MANIFEST_PATH), 0o600);
    // Remove access to the original stage name, not canonical originals or any user destination.
    renameSync(staged.staging_root, `${staged.staging_root}-retained`);
    const relocatedResult = verifyFrozenPortablePackage({
      host,
      manifest_ref: staged.manifest_ref,
      staging_root: relocated,
    });
    expect(relocatedResult.manifest_sha256).toBe(staged.manifest_sha256);
    expect(relocatedResult.unverified).toContain(
      "editor_open_save_reopen_relocation_render_comparison"
    );
    expect(relocatedResult.production_admission).toBe("blocked");
    expect(readOnlyPersist).not.toHaveBeenCalled();
  });
  it("on a stage-time payload read failure creates no manifest/receipt/positive and retains only its private partial namespace", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const root = parent(f);
    const last = p.manifest.files.at(-1);
    if (last === undefined) throw new Error("payload missing");
    const read = f.store.read.bind(f.store);
    vi.spyOn(f.store, "read").mockImplementation((ref) => {
      if (ref.artifact_id === last.producer_ref.artifact_id && readdirSync(root).length > 0)
        throw new Error("injected stage payload read failure");
      return read(ref);
    });
    const persist = vi.spyOn(f.store, "persist");
    expect(() =>
      stageFrozenPortablePackage({
        host: e.host,
        manifest: p.manifest,
        staging_parent: root,
        output_metadata: manifestMetadata(f),
      })
    ).toThrow(/stage payload read failure/);
    expect(persist).not.toHaveBeenCalled();
    const stageName = readdirSync(root)[0];
    if (stageName === undefined) throw new Error("failed stage not retained");
    expect(existsSync(path.join(root, stageName, PORTABLE_MANIFEST_PATH))).toBe(false);
  });
  it("invalid preflight or output identity writes no staging namespace and no canonical manifest", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const root = parent(f);
    const persist = vi.spyOn(f.store, "persist");
    const input = {
      host: e.host,
      manifest: p.manifest,
      staging_parent: root,
      output_metadata: manifestMetadata(f),
    };
    expect(() =>
      stageFrozenPortablePackage({ ...input, manifest: { ...p.manifest, g5_approved: true } })
    ).toThrow();
    expect(() =>
      stageFrozenPortablePackage({
        ...input,
        output_metadata: { ...manifestMetadata(f), run_id: "other_run" },
      })
    ).toThrow(/output identity/);
    expect(readdirSync(root)).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  it("rechecks frozen payload hashes and CURRENT rights after canonical reopen, with no positive override", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const staged = stageFrozenPortablePackage({
      host: e.host,
      manifest: p.manifest,
      staging_parent: parent(f),
      output_metadata: manifestMetadata(f),
    });
    const input = {
      host: e.host,
      manifest_ref: staged.manifest_ref,
      staging_root: staged.staging_root,
    };
    const master = path.join(staged.staging_root, p.manifest.accepted_master.relative_path);
    const original = readFileSync(master);
    const changed = Buffer.from(original);
    changed[0] = (changed[0] ?? 0) ^ 1;
    writeFileSync(master, changed);
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/hash\/readback drift/);
    writeFileSync(master, original);
    expect(verifyFrozenPortablePackage(input).status).toBe("structural_checked");
    const revoked = {
      ...e.host,
      current_rights: e.host.current_rights.map((r) =>
        r.subject_ref.artifact_id === p.master.artifact_id
          ? { ...r, status: "revoked" as const }
          : r
      ),
      g5_approved: true,
      native_verified: true,
    };
    expect(() => verifyFrozenPortablePackage({ ...input, host: revoked })).toThrow(/rights/);
    const manifest = path.join(staged.staging_root, PORTABLE_MANIFEST_PATH);
    writeFileSync(manifest, " " + canonicalJson(p.manifest));
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/manifest hash drift/);
  });
  it("refuses leaf/ancestor symlinks, hardlinks, permission leaks and unlisted external review files", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const staged = stageFrozenPortablePackage({
      host: e.host,
      manifest: p.manifest,
      staging_parent: parent(f),
      output_metadata: manifestMetadata(f),
    });
    const input = {
      host: e.host,
      manifest_ref: staged.manifest_ref,
      staging_root: staged.staging_root,
    };
    const payload = path.join(staged.staging_root, p.manifest.accepted_master.relative_path);
    const bytes = readFileSync(payload);
    const outside = path.join(f.root, "outside-fixture");
    writeFileSync(outside, bytes, { mode: 0o600 });
    unlinkSync(payload);
    symlinkSync(outside, payload);
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/symlink/);
    unlinkSync(payload);
    linkSync(outside, payload);
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/linked/);
    unlinkSync(payload);
    writeFileSync(payload, bytes, { mode: 0o600 });
    chmodSync(payload, 0o644);
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/unsafe/);
    chmodSync(payload, 0o600);
    const extra = path.join(staged.staging_root, "review.json");
    writeFileSync(extra, "outside receipt must bind manifest externally", { mode: 0o600 });
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/unlisted/);
    unlinkSync(extra);
    const directory = path.dirname(payload);
    const saved = path.join(f.root, "saved-media-outside-stage");
    renameSync(directory, saved);
    symlinkSync(saved, directory);
    expect(() => verifyFrozenPortablePackage(input)).toThrow(/symlink/);
    unlinkSync(directory);
    renameSync(saved, directory);
    expect(verifyFrozenPortablePackage(input).status).toBe("structural_checked");
  });
  it("refuses symlink/unsafe staging parents, uses exclusive namespaces and never overwrites prior bytes", () => {
    using f = new FoundationFixture();
    const e = editFixture(f);
    const p = packageFixture(f, e);
    const root = parent(f);
    const link = path.join(f.root, "stage-link");
    symlinkSync(root, link);
    const input = {
      host: e.host,
      manifest: p.manifest,
      staging_parent: root,
      output_metadata: manifestMetadata(f),
    };
    expect(() => stageFrozenPortablePackage({ ...input, staging_parent: link })).toThrow(
      /no-follow/
    );
    chmodSync(root, 0o755);
    expect(() => stageFrozenPortablePackage(input)).toThrow(/owner-only/);
    chmodSync(root, 0o700);
    const first = stageFrozenPortablePackage(input);
    const firstBytes = readFileSync(path.join(first.staging_root, PORTABLE_MANIFEST_PATH));
    const second = stageFrozenPortablePackage({
      ...input,
      output_metadata: manifestMetadata(f, "fixture_package_second"),
    });
    expect(second.staging_root).not.toBe(first.staging_root);
    expect(readFileSync(path.join(first.staging_root, PORTABLE_MANIFEST_PATH))).toEqual(firstBytes);
    expect(second.manifest_sha256).toBe(first.manifest_sha256);
    expect(second.production_admission).toBe("blocked");
    expect(() =>
      verifyFrozenPortablePackage({
        host: e.host,
        manifest_ref: { ...first.manifest_ref, producer: "worker:forged" },
        staging_root: first.staging_root,
      })
    ).toThrow();
  });
});
