import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../dist/canonical-json.js";
import { LocalDeliveryFiles, type DeliveryFile } from "../dist/videogen/delivery-files.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { editFixture, packageFixture } from "./helpers/videogen-edit-fixtures.js";
class DeliveryFixture implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-delivery-"));
  readonly files: LocalDeliveryFiles;
  readonly signal = new AbortController().signal;
  constructor() {
    chmodSync(this.root, 0o700);
    this.files = new LocalDeliveryFiles([
      {
        destination_id: "local",
        root: this.root,
        max_files: 1024,
        max_bytes: 10000000,
        reserve_bytes: 1,
      },
    ]);
  }
  [Symbol.dispose](): void {
    this.files[Symbol.dispose]();
    rmSync(this.root, { recursive: true, force: true });
  }
}
function files(): DeliveryFile[] {
  return [
    "master.mp4",
    "package/project.kdenlive",
    "package/original/video.mp4",
    "package/original/voice.wav",
    "package/manifest.json",
  ].map((relative_path) => {
    const bytes = Buffer.from(relative_path);
    return { relative_path, bytes, sha256: sha256(bytes) };
  });
}
describe("actual nonoverwriting fd-anchored dual-product local delivery", () => {
  it("prepares, fsyncs, atomically publishes one complete products namespace and independently reads all bytes", () => {
    using f = new DeliveryFixture();
    const payload = files();
    f.files.prepare("local", "stage", payload, f.signal);
    expect(existsSync(path.join(f.root, "final"))).toBe(false);
    const result = f.files.apply("local", "stage", "final", payload, f.signal);
    expect(result).toHaveLength(payload.length);
    expect(readdirSync(f.root)).toEqual(["final"]);
    for (const item of payload)
      expect(readFileSync(path.join(f.root, "final/products", item.relative_path))).toEqual(
        item.bytes
      );
    expect(f.files.readback("local", "final", payload)).toEqual(result);
    f.files.prepare("local", "stage-second", payload, f.signal);
    expect(() => f.files.apply("local", "stage-second", "final", payload, f.signal)).toThrow();
    expect(readFileSync(path.join(f.root, "final/products/master.mp4"))).toEqual(payload[0]?.bytes);
  });
  it("preserves real package closure payload/originals and frozen manifest without mutating canonical artifacts", () => {
    using source = new FoundationFixture();
    using f = new DeliveryFixture();
    const e = editFixture(source),
      p = packageFixture(source, e);
    const manifest = Buffer.from(JSON.stringify(p.manifest));
    const payload: DeliveryFile[] = p.manifest.files.map((item) => ({
      relative_path: `package/${item.relative_path}`,
      bytes: source.store.read(item.producer_ref),
      sha256: item.sha256,
    }));
    payload.push(
      { relative_path: "package/manifest.json", bytes: manifest, sha256: sha256(manifest) },
      {
        relative_path: "master.mp4",
        bytes: source.store.read(p.master),
        sha256: p.master.content_digest,
      }
    );
    f.files.prepare("local", "stage", payload, f.signal);
    f.files.apply("local", "stage", "delivered", payload, f.signal);
    for (const item of p.manifest.files)
      expect(
        sha256(readFileSync(path.join(f.root, "delivered/products/package", item.relative_path)))
      ).toBe(item.sha256);
    expect(source.store.read(p.project)).toEqual(
      readFileSync(
        path.join(f.root, "delivered/products/package", p.manifest.native_project.relative_path)
      )
    );
  });
  it.each(["../escape", "/absolute", "a/../../x", "A/../b", "a\\b", "a/%2e/x", "a/.hidden"])(
    "rejects hostile path %s",
    (relative_path) => {
      using f = new DeliveryFixture();
      const payload = files();
      payload[0] = { relative_path, bytes: Buffer.from("x"), sha256: sha256("x") };
      expect(() => f.files.prepare("local", "stage", payload, f.signal)).toThrow();
      expect(readdirSync(f.root)).toEqual([]);
    }
  );
  it("rejects selector drift, wrong bytes, case collisions and file/directory aliases before writing", () => {
    using f = new DeliveryFixture();
    const payload = files();
    expect(() => f.files.prepare("other", "stage", payload, f.signal)).toThrow();
    expect(() =>
      f.files.prepare(
        "local",
        "stage",
        payload.map((p) => ({ ...p, sha256: sha256("wrong") })),
        f.signal
      )
    ).toThrow();
    for (const extra of ["MASTER.mp4", "package"]) {
      const bytes = Buffer.from(extra);
      expect(() =>
        f.files.prepare(
          "local",
          "stage",
          [...payload, { relative_path: extra, bytes, sha256: sha256(bytes) }],
          f.signal
        )
      ).toThrow("collision");
    }
    expect(readdirSync(f.root)).toEqual([]);
  });
  it("refuses staged symlink, hardlink, extra files and byte swaps before publication", () => {
    using f = new DeliveryFixture();
    const payload = files();
    for (const mode of ["symlink", "hardlink", "extra", "bytes"]) {
      const stage = `stage-${mode}`;
      f.files.prepare("local", stage, payload, f.signal);
      const target = path.join(f.root, stage, "master.mp4");
      if (mode === "symlink") {
        renameSync(target, `${target}-old`);
        symlinkSync(`${target}-old`, target);
      }
      if (mode === "hardlink") linkSync(target, `${target}-linked`);
      if (mode === "extra")
        writeFileSync(path.join(f.root, stage, "unlisted"), "x", { mode: 0o600 });
      if (mode === "bytes") writeFileSync(target, "wrong");
      expect(() => f.files.apply("local", stage, `final-${mode}`, payload, f.signal)).toThrow();
      expect(existsSync(path.join(f.root, `final-${mode}`))).toBe(false);
    }
  });
  it("refuses symlink/replaced root and symlink namespace without affecting original targets", () => {
    using f = new DeliveryFixture();
    const payload = files();
    symlinkSync(f.root, path.join(f.root, "alias"));
    expect(
      () =>
        new LocalDeliveryFiles([
          {
            destination_id: "x",
            root: path.join(f.root, "alias"),
            max_files: 3,
            max_bytes: 100,
            reserve_bytes: 0,
          },
        ])
    ).toThrow();
    f.files.prepare("local", "stage", payload, f.signal);
    symlinkSync(f.root, path.join(f.root, "final"));
    expect(() => f.files.apply("local", "stage", "final", payload, f.signal)).toThrow();
  });
  it("handles disk failure and cancellation with exact owned-stage cleanup, no positive receipt", () => {
    using f = new DeliveryFixture();
    const payload = files();
    const aborted = new AbortController();
    aborted.abort();
    expect(() => f.files.prepare("local", "cancelled", payload, aborted.signal)).toThrow();
    using insufficient = new LocalDeliveryFiles([
      {
        destination_id: "local",
        root: f.root,
        max_files: 1024,
        max_bytes: 10000000,
        reserve_bytes: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(() => insufficient.prepare("local", "diskfail", payload, f.signal)).toThrow(
      "free-space reservation"
    );
    expect(readdirSync(f.root)).toEqual([]);
  });
  it("crash recovery is read-only, rejects an empty reservation and never overwrites on retry", () => {
    using f = new DeliveryFixture();
    const payload = files();
    f.files.prepare("local", "stage", payload, f.signal);
    mkdirSync(path.join(f.root, "reserved"), { mode: 0o700 });
    expect(() => f.files.readback("local", "reserved", payload)).toThrow("closure");
    expect(() => f.files.apply("local", "stage", "reserved", payload, f.signal)).toThrow();
    f.files.apply("local", "stage", "published", payload, f.signal);
    using reopened = new LocalDeliveryFiles([
      {
        destination_id: "local",
        root: f.root,
        max_files: 1024,
        max_bytes: 10000000,
        reserve_bytes: 1,
      },
    ]);
    expect(reopened.readback("local", "published", payload)).toHaveLength(payload.length);
    writeFileSync(path.join(f.root, "published/products/master.mp4"), "corrupt");
    expect(() => reopened.readback("local", "published", payload)).toThrow();
  });
});
