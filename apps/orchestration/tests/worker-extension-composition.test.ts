import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerResourceLoader,
  type WorkerExtensionSourceReplacement,
} from "../dist/model-client.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-extension-composition-"));
  roots.push(root);
  const project = path.join(root, "project");
  const agent = path.join(root, "agent");
  mkdirSync(path.join(project, ".pi", "extensions"), { recursive: true });
  mkdirSync(path.join(agent, "extensions"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  const source = path.join(project, ".pi", "extensions", "owned.js");
  writeFileSync(source, 'export default pi => pi.registerFlag("owned", {type:"boolean"});');
  const replacement: WorkerExtensionSourceReplacement = {
    source,
    extension: {
      name: "scoped-owner",
      hidden: true,
      factory: (pi) => pi.registerFlag("owned", { type: "boolean" }),
    },
  };
  return { root, project, agent, source, replacement };
}

function provider(file: string, name: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `export default pi => {
      pi.registerFlag(${JSON.stringify(name)}, {type:"boolean"});
      pi.registerCommand(${JSON.stringify(name)}, {description:"fixture", handler:async()=>{}});
      pi.on("session_start", async()=>{});
    };`
  );
}

function catalog(loader: DefaultResourceLoader, exclude: string) {
  return loader
    .getExtensions()
    .extensions.filter(
      (extension) =>
        !extension.path.startsWith("<inline:") && realpathSync(extension.path) !== exclude
    )
    .map((extension) => ({
      path: realpathSync(extension.path),
      flags: [...extension.flags.keys()],
      commands: [...extension.commands.keys()],
      handlers: [...extension.handlers.keys()],
    }));
}

function load(input: ReturnType<typeof fixture>, replacements = [input.replacement]) {
  return createWorkerResourceLoader(
    input.project,
    [],
    undefined,
    undefined,
    SettingsManager.create(input.project, input.agent),
    undefined,
    undefined,
    replacements
  );
}

describe("host-owned worker extension source composition", () => {
  it("preserves the complete native enabled inventory, including project/global declarations, packages, filters and aliases", async () => {
    const input = fixture();
    for (const [file, name] of [
      [path.join(input.project, ".pi/extensions/project-auto.js"), "project_auto"],
      [path.join(input.agent, "extensions/global-auto.js"), "global_auto"],
      [path.join(input.project, ".pi/declared.js"), "project_declared"],
      [path.join(input.agent, "declared.js"), "global_declared"],
      [path.join(input.project, ".pi/pkg/first.js"), "project_package"],
      [path.join(input.project, ".pi/pkg/disabled.js"), "disabled_package"],
      [path.join(input.agent, "pkg/first.js"), "global_package"],
      [path.join(input.agent, "extensions/disabled.js"), "disabled_auto"],
    ]) {
      if (file === undefined || name === undefined) throw new Error("fixture pair missing");
      provider(file, name);
    }
    writeFileSync(
      path.join(input.project, ".pi/pkg/package.json"),
      JSON.stringify({
        pi: { extensions: ["first.js", "disabled.js"] },
      })
    );
    writeFileSync(
      path.join(input.agent, "pkg/package.json"),
      JSON.stringify({
        pi: { extensions: ["first.js"] },
      })
    );
    const alias = path.join(input.agent, "owned-alias.js");
    symlinkSync(input.source, alias);
    writeFileSync(
      path.join(input.project, ".pi/settings.json"),
      JSON.stringify({
        packages: [{ source: "./pkg", extensions: ["first.js"] }],
        extensions: ["./declared.js"],
      })
    );
    writeFileSync(
      path.join(input.agent, "settings.json"),
      JSON.stringify({
        packages: ["./pkg"],
        extensions: ["./declared.js", "!extensions/disabled.js", "./owned-alias.js"],
      })
    );
    // The alias intentionally duplicates only the replaced source in the baseline.
    const native = new DefaultResourceLoader({
      cwd: input.project,
      agentDir: input.agent,
      settingsManager: SettingsManager.create(input.project, input.agent),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await native.reload();
    const loader = await load(input);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(catalog(loader, input.source)).toEqual(catalog(native, input.source));
    const flags = loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.flags.keys()]);
    expect(flags.sort()).toEqual(
      [
        "owned",
        "project_auto",
        "global_auto",
        "project_declared",
        "global_declared",
        "project_package",
        "global_package",
      ].sort()
    );
    expect(
      loader
        .getExtensions()
        .extensions.filter((extension) => extension.flags.has("owned"))
        .map((extension) => extension.path)
    ).toEqual(["<inline:scoped-owner>"]);
    writeFileSync(
      path.join(input.project, ".pi/extensions/late.js"),
      'export default () => { throw new Error("inventory was not frozen"); };'
    );
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(catalog(loader, input.source)).toEqual(catalog(native, input.source));
  });

  it("does not execute the replaced ambient factory and retains unrelated inline factories", async () => {
    const input = fixture();
    writeFileSync(
      input.source,
      'export default () => { throw new Error("ambient factory executed"); };'
    );
    const loader = await createWorkerResourceLoader(
      input.project,
      [
        {
          name: "other-inline",
          factory: (pi) => pi.registerFlag("other", { type: "boolean" }),
        },
      ],
      undefined,
      undefined,
      SettingsManager.inMemory(),
      undefined,
      undefined,
      [input.replacement]
    );
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
      "<inline:other-inline>",
      "<inline:scoped-owner>",
    ]);
  });

  it("still refuses unrelated duplicates and load errors", async () => {
    const input = fixture();
    provider(path.join(input.project, ".pi/extensions/first.js"), "unrelated");
    provider(path.join(input.agent, "extensions/second.js"), "unrelated");
    await expect(load(input)).rejects.toThrow(/EXTENSION_CONFLICT/u);
    rmSync(path.join(input.agent, "extensions/second.js"));
    writeFileSync(
      path.join(input.project, ".pi/extensions/broken.js"),
      'export default () => {throw new Error("broken")};'
    );
    await expect(load(input)).rejects.toThrow(/EXTENSION_LOAD_ERROR/u);
  });

  it("rejects ambiguous canonical replacements before any factory runs", async () => {
    const input = fixture();
    const factory = vi.fn<ExtensionFactory>();
    const alias = path.join(input.root, "alias.js");
    symlinkSync(input.source, alias);
    await expect(
      load(input, [
        { ...input.replacement, extension: factory },
        { ...input.replacement, source: alias, extension: factory },
      ])
    ).rejects.toThrow(/WORKER_EXTENSION_LOAD_FAILED/u);
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps scoped registration when ambient discovery is explicitly disabled or the source is not discovered", async () => {
    const input = fixture();
    const factory = vi.fn<ExtensionFactory>();
    const settingsManager = SettingsManager.inMemory();
    const loader = await createWorkerResourceLoader(
      input.project,
      [],
      undefined,
      {
        settingsManager,
        noAmbientExtensions: true,
        attach: () => () => {},
      },
      undefined,
      undefined,
      undefined,
      [{ ...input.replacement, extension: factory }]
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    const outside = path.join(input.root, "not-discovered.js");
    writeFileSync(outside, 'export default () => {throw new Error("must not load")};');
    const absent = await load(input, [
      {
        source: outside,
        extension: {
          name: "outside-owner",
          factory: (pi) => pi.registerFlag("outside", { type: "boolean" }),
        },
      },
    ]);
    // A different source declaration must not remove the existing ambient provider.
    expect(
      absent
        .getExtensions()
        .extensions.flatMap((extension) => [...extension.flags.keys()])
        .sort()
    ).toEqual(["outside", "owned"]);
  });
});
