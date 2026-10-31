import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createP03ProtectedTempFixture } from "./p03-protected-temp-fixture.js";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { withScaP03Digest } from "../../orchestration/dist/sca/p03-contracts.js";
import { SCA_P03_IMPLEMENTATION_SOURCE_PATHS } from "../../orchestration/dist/sca/p03-qualification.js";
import {
  assertScaP03ProtectedPathV1,
  measureScaP03ProtectedDependencyRootV1,
  createScaP03ProductionBootstrapSamplerV1,
} from "../src/p03-production-sampler.js";
import { createScaP03LocalHostProbeDeterministicTestOnlyV1 } from "../src/p03-bootstrap-local-probe.js";
import {
  runScaP03BootstrapCliV1,
  sampleScaP03ProductionBootstrapDeterministicTestOnlyV1,
} from "../src/p03-bootstrap-cli.js";
import {
  parseScaP03CliCanonical,
  ScaP03CliProductionSealedHandoffSchema,
  ScaP03CliProductionFreezeHandoffSchema,
} from "../src/p03-bootstrap-cli-contracts.js";
import {
  productionSamplerFixture,
  disposeSamplerFixtures,
  verificationChild,
  samplerAuthorityFixture,
  protectedNodeFixture,
} from "./p03-production-sampler-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  disposeSamplerFixtures();
});
function objectFile(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("test object missing");
  return Object.fromEntries(Object.entries(value));
}
const input = (f: Awaited<ReturnType<typeof productionSamplerFixture>>) => ({
  manifest_path: f.manifest_path,
  manifest_sha256: sha256(readFileSync(f.manifest_path)),
});

describe("P03 protected temporary fixture portability", () => {
  function allocationFailure(parents: readonly string[]): unknown {
    try {
      createP03ProtectedTempFixture("p03-denied-", { parents });
    } catch (error) {
      return error;
    }
    throw new Error("Expected protected temporary fixture allocation to fail");
  }
  const parents: string[] = [];
  const parentFixture = () => {
    const parent = createP03ProtectedTempFixture("p03-temp-parent-");
    parents.push(parent);
    return parent;
  };
  afterEach(() => {
    for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
  });

  it("honors a valid caller TMPDIR, creates an owned private child, and cleans only that child", () => {
    const parent = parentFixture();
    const sentinel = path.join(parent, "caller-owned");
    writeFileSync(sentinel, "untouched", { mode: 0o600 });
    const before = lstatSync(parent);
    vi.stubEnv("TMPDIR", parent);
    const root = createP03ProtectedTempFixture("p03-caller-temp-");
    try {
      expect(path.dirname(root)).toBe(parent);
      expect(lstatSync(root).uid).toBe(process.geteuid?.());
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(() => assertScaP03ProtectedPathV1(root, true)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(existsSync(root)).toBe(false);
    expect(readdirSync(parent)).toEqual(["caller-owned"]);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(lstatSync(parent).ino).toBe(before.ino);
    expect(lstatSync(parent).mode).toBe(before.mode);
  });

  it("isolates a real sampler from ambient TMPDIR ancestor pollution and disposes its deployment", async () => {
    const parent = parentFixture();
    const polluted = path.join(parent, "polluted");
    mkdirSync(polluted, { mode: 0o700 });
    const modules = path.join(polluted, "node_modules");
    mkdirSync(modules, { mode: 0o700 });
    const sentinel = path.join(modules, "caller-owned.js");
    writeFileSync(sentinel, "untouched", { mode: 0o600 });
    const nested = path.join(polluted, "tmp");
    mkdirSync(nested, { mode: 0o700 });
    const before = lstatSync(modules);
    vi.stubEnv("TMPDIR", nested);
    const f = await transportFixture("throw new Error('must not execute')");
    expect(f.root.startsWith(`${polluted}${path.sep}`)).toBe(false);
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    disposeSamplerFixtures();
    expect(existsSync(f.root)).toBe(false);
    expect(readdirSync(nested)).toEqual([]);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(lstatSync(modules).ino).toBe(before.ino);
    expect(lstatSync(modules).mode).toBe(before.mode);
  });

  it("rejects a dangling ancestor node_modules symlink without changing the caller tree", () => {
    const parent = parentFixture();
    const modules = path.join(parent, "node_modules");
    symlinkSync(path.join(parent, "absent"), modules);
    const before = lstatSync(modules);
    expect(allocationFailure([parent])).toMatchObject({
      message: "p03_test_no_protected_temp_parent",
      errors: [{ cause: { message: `p03_test_ambient_dependency_root: ${modules}` } }],
    });
    expect(readdirSync(parent)).toEqual(["node_modules"]);
    expect(lstatSync(modules).ino).toBe(before.ino);
    expect(lstatSync(modules).isSymbolicLink()).toBe(true);
  });

  it("removes a failed private allocation without repairing an unsafe existing parent", () => {
    const parent = parentFixture();
    const unsafe = path.join(parent, "unsafe");
    mkdirSync(unsafe, { mode: 0o700 });
    chmodSync(unsafe, 0o777); // Only this test-owned directory is mutated.
    expect(allocationFailure([unsafe])).toMatchObject({
      message: "p03_test_no_protected_temp_parent",
      errors: [{ cause: { message: "p03_sampler_writable_ancestor" } }],
    });
    expect(readdirSync(unsafe)).toEqual([]);
    expect(lstatSync(unsafe).mode & 0o777).toBe(0o777);
  });

  it("fails honestly when no existing parent qualifies and does not create a missing parent", () => {
    const parent = parentFixture();
    const polluted = path.join(parent, "polluted");
    mkdirSync(polluted, { mode: 0o700 });
    mkdirSync(path.join(polluted, "node_modules"), { mode: 0o700 });
    const missing = path.join(parent, "missing");
    expect(allocationFailure([polluted, missing])).toMatchObject({
      message: "p03_test_no_protected_temp_parent",
      errors: [
        {
          cause: {
            message: `p03_test_ambient_dependency_root: ${path.join(polluted, "node_modules")}`,
          },
        },
        { cause: { code: "ENOENT" } },
      ],
    });
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(polluted)).toEqual(["node_modules"]);
    expect(readdirSync(parent)).toEqual(["polluted"]);
  });
});

describe("P03 fresh production sampling (component-only)", () => {
  it("projects exact sealed bytes and verified refs, replays real proof paths on EVERY async call", async () => {
    const f = await productionSamplerFixture();
    const durableFiles = [
      f.manifest_path,
      f.freezePath,
      f.sealedPath,
      f.selection,
      path.join(f.working, "registry.json"),
      path.join(f.storeRoot, "manifest.db"),
    ];
    const durableBefore = durableFiles.map((file) => sha256(readFileSync(file)));
    const first = await sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command);
    const second = await sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(
      input(f),
      f.command
    );
    expect(second).toEqual(first);
    expect(durableFiles.map((file) => sha256(readFileSync(file)))).toEqual(durableBefore);
    const sealed = parseScaP03CliCanonical(
      ScaP03CliProductionSealedHandoffSchema,
      readFileSync(f.sealedPath)
    );
    expect(first).toMatchObject({
      handoff_sha256: sha256(readFileSync(f.sealedPath)),
      proof_sha256: sealed.proof_sha256,
      production_binding_sha256: sealed.production_binding_sha256,
      production_record_ref: sealed.production_record_ref,
      attestation_ref: sealed.host_attestation_ref,
      selection_sha256: sha256(readFileSync(f.selection)),
      deployment_identity_sha256: f.manifest.config.deployment_identity_sha256,
    });
    expect(first.handoff_sha256).not.toBe(sha256(readFileSync(f.freezePath)));
    expect(f.commands.filter((a) => a[1] === "create")).toHaveLength(2);
    expect(f.commands.filter((a) => a[1] === "rm")).toHaveLength(2);
  });
  it("refuses synchronous production measurements before launching any pinned child", async () => {
    const f = await productionSamplerFixture();
    const { config, counter } = verificationChild(f);
    const authority = samplerAuthorityFixture(f.root);
    const sampler = createScaP03ProductionBootstrapSamplerV1(config, authority);
    expect(sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    expect(sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    expect(existsSync(counter)).toBe(false);
    expect(createScaP03ProductionBootstrapSamplerV1(config, authority.reopen())).toThrow(
      "p03_guarded_bootstrap_verification_unavailable"
    );
  });
  it("does not bypass unavailable observations, deployment drift, or uncertain Docker cleanup", async () => {
    const f = await productionSamplerFixture();
    await sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command);
    f.setUnavailable(true);
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("unavailable");
    f.setUnavailable(false);
    f.setDrift(true);
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_host_deployment_drift");
    f.setDrift(false);
    f.setResidue(true);
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_host_probe_residue");
  });
  it.each(["implementation", "package", "docker"] as const)(
    "rejects current %s byte drift",
    async (target) => {
      const f = await productionSamplerFixture();
      const file =
        target === "implementation"
          ? f.implementation[0]?.path
          : target === "package"
            ? f.packages[0]?.path
            : f.manifest.config.docker_executable;
      if (file === undefined) throw new Error("fixture file missing");
      writeFileSync(file, "drift");
      await expect(
        sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
      ).rejects.toThrow(/drift/u);
    }
  );
  it("refuses revoked selection and selection mutation during verification", async () => {
    const f = await productionSamplerFixture();
    const original = readFileSync(f.selection);
    const draft = Object.fromEntries(
      Object.entries(objectFile(f.selection)).filter(([key]) => key !== "selection_sha256")
    );
    writeFileSync(
      f.selection,
      canonicalJson(withScaP03Digest({ ...draft, status: "revoked" }, "selection_sha256"))
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_host_lineage_invalid");
    writeFileSync(f.selection, original);
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(
        input(f),
        async (argv, dir, signal) => {
          const output = await f.command(argv, dir, signal);
          if (argv[0] === "version")
            writeFileSync(
              f.selection,
              canonicalJson(withScaP03Digest({ ...draft, status: "revoked" }, "selection_sha256"))
            );
          return output;
        }
      )
    ).rejects.toThrow("p03_cli_sampling_input_drift");
  });
  it("checks reviewer fingerprint and actual signature, with disposable test-only keys", async () => {
    const f = await productionSamplerFixture();
    const { publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(f.keyPath, publicKey.export({ type: "spki", format: "pem" }));
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_cli_reviewer_key_untrusted");
    writeFileSync(
      f.manifest_path,
      canonicalJson({
        ...f.manifest,
        reviewer_public_key_sha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_host_review_untrusted");
  });
  it("refuses invalid external signatures before a production seal exists", async () => {
    await expect(productionSamplerFixture(true)).rejects.toThrow("p03_cli_review_untrusted");
  });
  it("refuses exact P01 root substitution even with recomputed handoff and binding digests", async () => {
    const f = await productionSamplerFixture();
    const frozen = parseScaP03CliCanonical(
      ScaP03CliProductionFreezeHandoffSchema,
      readFileSync(f.freezePath)
    );
    const { binding_sha256: originalBinding, ...production } = frozen.production_bindings;
    expect(originalBinding).toBe(sha256(canonicalJson(production)));
    const substituted = withScaP03Digest(
      {
        ...production,
        roots: { ...production.roots, root_executable_ref: production.roots.root_measurement_ref },
      },
      "binding_sha256"
    );
    writeFileSync(f.freezePath, canonicalJson({ ...frozen, production_bindings: substituted }));
    const sealed = objectFile(f.sealedPath);
    writeFileSync(
      f.sealedPath,
      canonicalJson({ ...sealed, production_binding_sha256: substituted.binding_sha256 })
    );
    writeFileSync(
      f.manifest_path,
      canonicalJson({
        ...f.manifest,
        freeze_handoff_sha256: sha256(readFileSync(f.freezePath)),
        sealed_handoff_sha256: sha256(readFileSync(f.sealedPath)),
      })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow(/p03_production_p01_root_drift/u);
    expect(f.commands).toHaveLength(0);
  });
  it("refuses a production record substituted by a valid bootstrap record", async () => {
    const f = await productionSamplerFixture();
    writeFileSync(
      f.sealedPath,
      canonicalJson({ ...objectFile(f.sealedPath), production_record_ref: f.record_ref })
    );
    writeFileSync(
      f.manifest_path,
      canonicalJson({ ...f.manifest, sealed_handoff_sha256: sha256(readFileSync(f.sealedPath)) })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow(/schema validation/u);
    expect(f.commands).toHaveLength(0);
  });
  it("rejects a self-valid production record with different lineage and custody", async () => {
    const f = await productionSamplerFixture();
    const sealed = parseScaP03CliCanonical(
      ScaP03CliProductionSealedHandoffSchema,
      readFileSync(f.sealedPath)
    );
    let substitution;
    {
      using store = ArtifactStore.openExisting(f.storeRoot, { projectId: f.project_id });
      const value: unknown = JSON.parse(store.read(sealed.production_record_ref).toString());
      if (value === null || typeof value !== "object" || !("record_sha256" in value))
        throw new Error("production record missing");
      const { record_sha256: originalDigest, ...draft } = value;
      expect(originalDigest).toBe(sha256(canonicalJson(draft)));
      substitution = store.persist({
        metadata: {
          ...store.metadata(sealed.production_record_ref),
          operation_id: "test-substituted-production-record",
        },
        content: canonicalJson(
          withScaP03Digest(
            { ...draft, production_bindings_sha256: sha256("other production binding") },
            "record_sha256"
          )
        ),
      });
    }
    writeFileSync(f.sealedPath, canonicalJson({ ...sealed, production_record_ref: substitution }));
    writeFileSync(
      f.manifest_path,
      canonicalJson({ ...f.manifest, sealed_handoff_sha256: sha256(readFileSync(f.sealedPath)) })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_production_record_binding_invalid");
    expect(f.commands).toHaveLength(0);
  });
  it("rejects P01 cohort substitution before any host observation", async () => {
    const f = await productionSamplerFixture();
    const handoff = parseScaP03CliCanonical(
      ScaP03CliProductionFreezeHandoffSchema,
      readFileSync(f.freezePath)
    );
    const { binding_sha256: originalBinding, ...draft } = handoff.production_bindings;
    expect(originalBinding).toBe(sha256(canonicalJson(draft)));
    const production = withScaP03Digest(
      {
        ...draft,
        roots: {
          ...draft.roots,
          accepted_p01: {
            ...draft.roots.accepted_p01,
            p01_gate_ref: draft.roots.accepted_p01.campaign_manifest_core_ref,
          },
        },
      },
      "binding_sha256"
    );
    writeFileSync(f.freezePath, canonicalJson({ ...handoff, production_bindings: production }));
    writeFileSync(
      f.sealedPath,
      canonicalJson({
        ...objectFile(f.sealedPath),
        production_binding_sha256: production.binding_sha256,
      })
    );
    writeFileSync(
      f.manifest_path,
      canonicalJson({
        ...f.manifest,
        freeze_handoff_sha256: sha256(readFileSync(f.freezePath)),
        sealed_handoff_sha256: sha256(readFileSync(f.sealedPath)),
      })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow(/P01 gate has an unexpected artifact contract/u);
    expect(f.commands).toHaveLength(0);
  });
  it("refuses substituted proof custody and wrong manifest/handoff bytes without cached success", async () => {
    const f = await productionSamplerFixture();
    await sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command);
    const original = readFileSync(f.sealedPath);
    const sealed = parseScaP03CliCanonical(ScaP03CliProductionSealedHandoffSchema, original);
    writeFileSync(
      f.sealedPath,
      canonicalJson({
        ...sealed,
        production_record_ref: {
          ...sealed.production_record_ref,
          content_digest: "0".repeat(64),
          store_ref: `artifact://sha256/${"0".repeat(64)}`,
        },
      })
    );
    writeFileSync(
      f.manifest_path,
      canonicalJson({ ...f.manifest, sealed_handoff_sha256: sha256(readFileSync(f.sealedPath)) })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow(/absent from the manifest/u);
    writeFileSync(f.sealedPath, original);
    writeFileSync(f.manifest_path, canonicalJson(f.manifest));
    writeFileSync(f.sealedPath, `${readFileSync(f.sealedPath, "utf8")} `);
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow("p03_cli_sealed_handoff_drift");
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(
        { ...input(f), manifest_sha256: "0".repeat(64) },
        f.command
      )
    ).rejects.toThrow("p03_cli_manifest_drift");
  });
  it("preserves existing verify-production output and refuses standalone manifests on the sampler route", async () => {
    const f = await productionSamplerFixture();
    const emitted: string[] = [];
    await runScaP03BootstrapCliV1(["verify-production", "--manifest", f.manifest_path], {
      createProbe: (probe) => createScaP03LocalHostProbeDeterministicTestOnlyV1(probe, f.command),
      emit: (line) => emitted.push(line),
    });
    expect(emitted).toHaveLength(1);
    const oldOutput: unknown = JSON.parse(emitted[0] ?? "");
    expect(oldOutput).toMatchObject({
      status: "verified",
      proof: { proof_sha256: objectFile(f.sealedPath).proof_sha256 },
    });
    expect(oldOutput).not.toHaveProperty("handoff_sha256");
    // Bad standalone schema fails before host work on the production-only sampling route.
    writeFileSync(
      f.manifest_path,
      canonicalJson({ ...f.manifest, schema_id: "penny.sca-p03-cli-verify-manifest.v1" })
    );
    await expect(
      sampleScaP03ProductionBootstrapDeterministicTestOnlyV1(input(f), f.command)
    ).rejects.toThrow(/P03 CLI input/u);
    await expect(
      runScaP03BootstrapCliV1(["sample-production", "--manifest", f.manifest_path])
    ).rejects.toThrow(/usage/u);
  });
  it("includes every new module/test in the fixed P03 census without index/package edits", () => {
    for (const file of [
      "src/p03-production-activation.ts",
      "tests/p03-production-activation.test.ts",
      "src/p03-production-sampler.ts",
      "tests/p03-production-sampler-fixture.ts",
      "tests/p03-production-sampler.test.ts",
    ])
      expect(SCA_P03_IMPLEMENTATION_SOURCE_PATHS).toContain(`apps/sca-service/${file}`);
  });
});

async function transportFixture(
  program: string,
  limits: { timeout_ms?: number; max_output_bytes?: number } = {},
  fixtureRoot?: string
) {
  const f = await productionSamplerFixture(false, { root: fixtureRoot });
  const root = f.working;
  const entrypoint = path.join(root, "worker ; '$.mjs");
  writeFileSync(entrypoint, program, { mode: 0o600 });
  const manifest = path.join(root, "manifest ; '$.json");
  writeFileSync(manifest, canonicalJson(f.manifest), { mode: 0o600 });
  const node = protectedNodeFixture(root);
  const config = {
    node_executable: node,
    node_executable_sha256: sha256(readFileSync(node)),
    cli_entrypoint: entrypoint,
    cli_entrypoint_sha256: sha256(readFileSync(entrypoint)),
    manifest_path: manifest,
    manifest_sha256: sha256(readFileSync(manifest)),
    deployment_roots: [f.root, path.dirname(node)],
    external_dependency_root: null,
    external_dependency_sha256: null,
    timeout_ms: limits.timeout_ms ?? 1000,
    max_output_bytes: limits.max_output_bytes ?? 16_384,
  };
  const authority = samplerAuthorityFixture(root);
  return {
    authority,
    root,
    entrypoint,
    manifest,
    config,
    sampler: createScaP03ProductionBootstrapSamplerV1(config, authority),
  };
}

describe("P03 production direct-subprocess retirement", () => {
  it.each([
    ["malformed", "process.stdout.write('not json\\n')"],
    ["noncanonical", "process.stdout.write('{ \"x\": 1 }\\n')"],
    ["invalid UTF-8", "process.stdout.write(Buffer.from([255,10]))"],
    ["schema-invalid", "process.stdout.write('{}\\n')"],
    ["unavailable", "process.exitCode=1"],
    ["stderr", "process.stderr.write('secret diagnostic');process.stdout.write('{}\\n')"],
    ["oversized", "process.stdout.write('x'.repeat(100000))"],
    ["unframed", "process.stdout.write('{}')"],
    ["banner", "process.stdout.write('PASS\\n{}\\n')"],
    ["multiple", "process.stdout.write('{}\\n{}\\n')"],
    ["never settles", "setInterval(()=>{},1000)"],
    ["module redirection", "await import(process.argv[4]+'.outside.mjs')"],
    ["ancestor package insertion", "throw new Error('must not execute')"],
    ["protection mutation", "import {chmodSync} from 'node:fs';chmodSync(process.cwd(),0o777)"],
  ])(
    "refuses the retired direct %s program before it can produce output or effects",
    async (_label, program) => {
      const f = await transportFixture(program);
      expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
      const restarted = createScaP03ProductionBootstrapSamplerV1(f.config, f.authority.reopen());
      expect(restarted).toThrow("p03_guarded_bootstrap_verification_unavailable");
    }
  );
  it("pins executable/entrypoint bytes and rejects symlinks, writable code, missing programs, and input drift", async () => {
    const f = await transportFixture("process.exitCode=1");
    writeFileSync(f.entrypoint, "changed");
    expect(f.sampler).toThrow("identity_invalid");
    writeFileSync(f.entrypoint, "process.exitCode=1");
    chmodSync(f.entrypoint, 0o666);
    expect(f.sampler).toThrow("identity_invalid");
    chmodSync(f.entrypoint, 0o600);
    const real = f.entrypoint + ".real";
    writeFileSync(real, "process.exitCode=1");
    rmSync(f.entrypoint);
    symlinkSync(real, f.entrypoint);
    expect(f.sampler).toThrow();
    expect(
      createScaP03ProductionBootstrapSamplerV1(
        {
          ...f.config,
          node_executable_sha256: "0".repeat(64),
        },
        f.authority
      )
    ).toThrow();
    const g = await transportFixture("process.exitCode=1");
    expect(
      createScaP03ProductionBootstrapSamplerV1(
        {
          ...g.config,
          node_executable: path.join(g.root, "absent"),
        },
        g.authority
      )
    ).toThrow();
    writeFileSync(g.manifest, `${readFileSync(g.manifest, "utf8")} `);
    expect(g.sampler).toThrow("manifest_drift");
  });
  it("rejects unsafe resource/configuration and oversized or nonprivate input", async () => {
    const f = await transportFixture("process.exitCode=1");
    for (const patch of [
      { timeout_ms: 0 },
      { timeout_ms: 300_001 },
      { max_output_bytes: 1_048_577 },
      { max_output_bytes: 0 },
      { node_executable: "node" },
      { injected_sample: {} },
    ])
      expect(() =>
        createScaP03ProductionBootstrapSamplerV1({ ...f.config, ...patch }, f.authority)
      ).toThrow();
    chmodSync(f.manifest, 0o644);
    expect(f.sampler).toThrow("custody_invalid");
    chmodSync(f.manifest, 0o600);
    writeFileSync(f.manifest, Buffer.alloc(1_048_577));
    expect(f.sampler).toThrow("custody_invalid");
  });
  it("rejects writable deployment ancestors before launch under the configured temporary parent", async () => {
    const f = await transportFixture("process.exitCode=1");
    const deployment = f.config.deployment_roots[0];
    if (deployment === undefined) throw new Error("missing deployment");
    expect(lstatSync(deployment).uid).toBe(process.geteuid?.());
    expect(lstatSync(deployment).mode & 0o777).toBe(0o700);
    const protection = assertScaP03ProtectedPathV1(f.entrypoint);
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    // Even stable pinned files cannot rescue an ancestor permitting a non-owner name swap.
    chmodSync(deployment, 0o777);
    expect(lstatSync(deployment).mode & 0o777).toBe(0o777);
    expect(f.sampler).toThrow("writable_ancestor");
    chmodSync(deployment, 0o700);
    chmodSync(f.root, 0o770);
    expect(lstatSync(f.root).mode & 0o777).toBe(0o770);
    expect(f.sampler).toThrow("writable_ancestor");
    chmodSync(f.root, 0o700);
    expect(assertScaP03ProtectedPathV1(f.entrypoint)).toBe(protection);
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    expect(
      f.authority.owner.verifyIssuance({
        record: f.authority.installation.record,
        ref: f.authority.installation.ref,
        scope: f.authority.installation.authority.scope,
        policy_id: f.authority.installation.authority.scope.issuer_policy_id,
      })
    ).toBe(true); // no child fault, no unrelated revocation
  });
  it("accepts a private immediate root-owned sticky child but rejects its writable replacement metadata", async () => {
    const deployment = createP03ProtectedTempFixture("p03-sampler-sticky-", {
      requireStickyParent: true,
    });
    const f = await transportFixture("process.exitCode=1", {}, deployment);
    const sticky = lstatSync(path.dirname(deployment));
    expect(sticky.uid).toBe(0);
    expect(sticky.mode & 0o1000).toBe(0o1000);
    expect(sticky.mode & 0o022).not.toBe(0);
    expect(lstatSync(deployment).uid).toBe(process.geteuid?.());
    expect(lstatSync(deployment).mode & 0o777).toBe(0o700);
    const protection = assertScaP03ProtectedPathV1(f.entrypoint);
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    chmodSync(deployment, 0o777);
    expect(lstatSync(deployment).mode & 0o777).toBe(0o777);
    expect(() => assertScaP03ProtectedPathV1(f.entrypoint)).toThrow("writable_ancestor");
    expect(f.sampler).toThrow("writable_ancestor");
    chmodSync(deployment, 0o700);
    expect(assertScaP03ProtectedPathV1(f.entrypoint)).toBe(protection);
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
  });
  it("rejects writable/symlink/ambient dependency roots and altered loader bytes before launch", async () => {
    const f = await transportFixture("process.exitCode=1");
    const dependencies = path.join(f.root, "node_modules");
    mkdirSync(dependencies, { mode: 0o700 });
    const loader = path.join(dependencies, "loader.js");
    writeFileSync(loader, "reviewed loader", { mode: 0o600 });
    const digest = measureScaP03ProtectedDependencyRootV1(dependencies);
    expect(f.sampler).toThrow("ambient_dependency_root");
    const config = {
      ...f.config,
      external_dependency_root: dependencies,
      external_dependency_sha256: digest,
    };
    chmodSync(dependencies, 0o777);
    expect(createScaP03ProductionBootstrapSamplerV1(config, f.authority)).toThrow(
      "writable_ancestor"
    );
    chmodSync(dependencies, 0o700);
    chmodSync(loader, 0o666);
    expect(createScaP03ProductionBootstrapSamplerV1(config, f.authority)).toThrow(
      "dependency_custody_invalid"
    );
    chmodSync(loader, 0o600);
    writeFileSync(loader, "swapped loader");
    expect(createScaP03ProductionBootstrapSamplerV1(config, f.authority)).toThrow(
      "dependency_drift"
    );
    writeFileSync(loader, "reviewed loader");
    const link = dependencies + ".real";
    // A real-tree pointer still fails: a named symlink is not a protected deployment root.
    rmSync(dependencies, { recursive: true });
    mkdirSync(link, { mode: 0o700 });
    symlinkSync(link, dependencies);
    expect(createScaP03ProductionBootstrapSamplerV1(config, f.authority)).toThrow("not_canonical");
  });
  it("does not depend on a revocation write to contain disabled dispatch", async () => {
    const f = await transportFixture("process.exitCode=1");
    const write = vi.spyOn(f.authority.owner, "revoke").mockImplementation(() => {
      throw new Error("revocation I/O fault");
    });
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    expect(write).not.toHaveBeenCalled();
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    expect(createScaP03ProductionBootstrapSamplerV1(f.config, f.authority.reopen())).toThrow(
      "p03_guarded_bootstrap_verification_unavailable"
    );
  });
  it("owns configuration and permits no direct argv/environment effects or fallback", async () => {
    const f = await transportFixture("throw new Error('must not execute')");
    f.config.manifest_path = "/caller-mutated";
    expect(f.sampler).toThrow("p03_guarded_bootstrap_verification_unavailable");
    expect(existsSync(`${f.manifest}.observed`)).toBe(false);
  });
});
