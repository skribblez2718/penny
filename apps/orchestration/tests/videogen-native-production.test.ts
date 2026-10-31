import { ConfinedMediaRunner } from "../dist/host-operations/confined-media-runner.js";
import {
  qualifyNativeProject,
  isNativeQualification,
} from "../dist/videogen/native-qualification.js";
import {
  MEDIA_POLICY,
  MEDIA_LIMITS,
  suppliedCpuBindings,
} from "./helpers/videogen-media-fixtures.js";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  ConfinedNativeRunner,
  ConfinedNativeBindingsSchema,
} from "../dist/host-operations/confined-native-runner.js";
import { writeNativeProject } from "../dist/videogen/kdenlive-writer.js";
import { KdenliveFixtureRegistry } from "../dist/videogen/kdenlive-registry.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { nativeInput, saved, XML_LIMITS } from "./helpers/videogen-native-fixtures.js";
import { sha256, canonicalJson } from "../dist/canonical-json.js";
const bindingPath = process.env["VIDEOGEN_NATIVE_TEST_BINDINGS"];
const assetPath = process.env["VIDEOGEN_NATIVE_TEST_ASSET"];
const outputPath = process.env["VIDEOGEN_NATIVE_TEST_OUTPUT"];
if (process.env["PENNY_VIDEOGEN_NATIVE_CPU"] !== "1")
  throw new Error(
    "Set PENNY_VIDEOGEN_NATIVE_CPU=1 and supply explicit private native/CPU bindings for actual qualification."
  );
describe("packaged real native driver (explicit private CPU/native bindings)", () => {
  it("opens, saves, closes, reopens and relocates actual synthetic content", async () => {
    if (bindingPath === undefined || assetPath === undefined || outputPath === undefined)
      throw new Error("explicit native fixture bindings required");
    const raw: unknown = JSON.parse(readFileSync(bindingPath, "utf8"));
    const binding = validateSkillSchema(ConfinedNativeBindingsSchema, raw, "test native binding");
    using f = new FoundationFixture();
    const input = nativeInput(f);
    const bytes = readFileSync(assetPath);
    const ref = f.raw(bytes, "video/x-matroska");
    const track = input.edit.tracks[0];
    const clip = track?.items[0];
    if (track === undefined || clip?.kind !== "clip") throw new Error("fixture clip required");
    const r = new KdenliveFixtureRegistry({
      editor_build_digest:
        binding.runtime_files.find((f) => f.target === binding.evidence_protocol?.editor_target)
          ?.sha256 ?? "",
      mlt_build_digest:
        binding.runtime_files.find((f) => f.target.endsWith("/libmlt-7.so.7.41.0"))?.sha256 ?? "",
      fixtures: ["single.kdenlive", "caption.kdenlive", "ordered.kdenlive"].map((n) => ({
        bytes: saved(n),
        sha256: sha256(saved(n)),
      })),
      limits: XML_LIMITS,
    });
    const projectInput = {
      ...input,
      registry: r,
      edit: { ...input.edit, tracks: [{ ...track, items: [{ ...clip, source_ref: ref }] }] },
      assets: [
        { source_ref: ref, relative_path: "assets/pattern.mkv", bytes, duration_frames: 50 },
      ],
    };
    const written = writeNativeProject(projectInput);
    writeFileSync(outputPath + "/generated.kdenlive", written.bytes);
    const runner = new ConfinedNativeRunner(binding);
    const policy = {
      max_input_bytes: 16777216,
      max_output_bytes: 16777216,
      max_writable_bytes: 268435456,
      max_writable_inodes: 4096,
      max_diagnostic_bytes: 1048576,
      inactivity_ms: 90000,
      max_elapsed_ms: 120000,
      address_space_bytes: 3221225472,
      cpu_seconds: 90,
      max_processes: 65536,
      max_open_files: 256,
    };
    const initial = await runner.runObserved({
      verb: "render_compare",
      files: [
        { relative_path: "project.kdenlive", bytes: written.bytes },
        { relative_path: "assets/pattern.mkv", bytes },
      ],
      policy,
      signal: new AbortController().signal,
    });
    const cpu = new ConfinedMediaRunner(suppliedCpuBindings(f.root).bindings);
    const qualification = await qualifyNativeProject({
      project: projectInput,
      native_runner: runner,
      native_policy: policy,
      cpu_runner: cpu,
      cpu_policy: {
        ...MEDIA_POLICY,
        max_width: 512,
        max_height: 288,
        max_pixels: 512 * 288,
        max_frames: 175,
        max_input_bytes: 16777216,
        max_output_bytes: 134217728,
        max_decoded_bytes: 134217728,
        max_samples: 480000,
        max_elapsed_ms: 30000,
      },
      limits: MEDIA_LIMITS,
      accepted_master: initial.bytes,
      signal: new AbortController().signal,
    });
    expect(isNativeQualification(qualification)).toBe(true);
    expect(isNativeQualification({ ...qualification })).toBe(false);
    for (const observed of qualification.observations) {
      expect(ConfinedNativeRunner.isObserved(observed)).toBe(true);
      writeFileSync(outputPath + `/${observed.header.verb}.json`, canonicalJson(observed.header));
      writeFileSync(outputPath + `/${observed.header.verb}.bytes`, observed.bytes);
    }
    writeFileSync(outputPath + "/comparison.json", canonicalJson(qualification.comparison));
    expect(qualification.comparison.status).toBe("exact_full_decode_match");
    const originalByte = qualification.normalized_project[0];
    if (originalByte === undefined) throw new Error("native output absent");
    qualification.normalized_project[0] = originalByte ^ 1;
    expect(isNativeQualification(qualification)).toBe(false);
  }, 480000);
});
