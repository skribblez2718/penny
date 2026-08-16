import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function snapshot(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = statSync(path);
      hash.update(`${name}:${stats.mode & 0o777}:`);
      if (stats.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function runBun(arguments_: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync("bun", arguments_, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0) {
    throw new Error(`bun ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function writeConsumerPackage(consumer: string, dependencyPath?: string): void {
  const dependencies = dependencyPath ? { "platform-memory": `file:${dependencyPath}` } : {};
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "clean-consumer", private: true, type: "module", dependencies }, null, 2)
  );
}

function copyRelease(destination: string, version: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of ["src", "README.md", "LICENSE"]) {
    cpSync(join(packageRoot, entry), join(destination, entry), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  manifest.version = version;
  delete manifest.devDependencies;
  writeFileSync(join(destination, "package.json"), JSON.stringify(manifest, null, 2));
}

describe("clean-machine code/data separation", () => {
  it("install, update, import, and remove preserve external data roots byte-for-byte", () => {
    const scratch = mkdtempSync(join(tmpdir(), "platform-memory-clean-"));
    const consumer = join(scratch, "consumer");
    const releaseOne = join(scratch, "release-one");
    const releaseTwo = join(scratch, "release-two");
    const dataRootAlpha = join(scratch, "data-alpha");
    const dataRootBeta = join(scratch, "data-beta");
    mkdirSync(consumer);
    mkdirSync(dataRootAlpha);
    mkdirSync(dataRootBeta);
    writeFileSync(join(dataRootAlpha, "sentinel"), "alpha-palace-bytes\n", { mode: 0o400 });
    writeFileSync(join(dataRootBeta, "sentinel"), "beta-palace-bytes\n", { mode: 0o400 });
    chmodSync(dataRootAlpha, 0o500);
    chmodSync(dataRootBeta, 0o500);
    copyRelease(releaseOne, "1.0.0");
    copyRelease(releaseTwo, "1.0.1");

    const env = {
      ...process.env,
      MEMORY_DATA_ROOT_ALPHA: dataRootAlpha,
      MEMORY_DATA_ROOT_BETA: dataRootBeta,
    };
    const before = [snapshot(dataRootAlpha), snapshot(dataRootBeta)];

    writeConsumerPackage(consumer, releaseOne);
    runBun(["install", "--offline"], consumer, env);
    expect(
      JSON.parse(
        readFileSync(join(consumer, "node_modules", "platform-memory", "package.json"), "utf8")
      ).version
    ).toBe("1.0.0");
    runBun(
      [
        "-e",
        'import { validatePlatformMemoryConfigV1 } from "platform-memory"; ' +
          'if (validatePlatformMemoryConfigV1({ contractVersion: 1, mode: "none", principalId: "clean-consumer" }).mode !== "none") process.exit(2);',
      ],
      consumer,
      env
    );
    expect([snapshot(dataRootAlpha), snapshot(dataRootBeta)]).toEqual(before);

    writeConsumerPackage(consumer, releaseTwo);
    runBun(["install", "--offline", "--force"], consumer, env);
    expect(
      JSON.parse(
        readFileSync(join(consumer, "node_modules", "platform-memory", "package.json"), "utf8")
      ).version
    ).toBe("1.0.1");
    expect([snapshot(dataRootAlpha), snapshot(dataRootBeta)]).toEqual(before);

    runBun(["remove", "platform-memory"], consumer, env);
    expect(existsSync(join(consumer, "node_modules", "platform-memory"))).toBe(false);
    expect([snapshot(dataRootAlpha), snapshot(dataRootBeta)]).toEqual(before);
  });

  it("ships no lifecycle hook or storage-mutating production API", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const hook of ["preinstall", "install", "postinstall", "preuninstall", "postuninstall"]) {
      expect(manifest.scripts?.[hook]).toBeUndefined();
    }

    const source = readdirSync(join(packageRoot, "src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(packageRoot, "src", name), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/PersistentClient|chromadb|child_process|\bspawn\s*\(/i);
    expect(source).not.toMatch(/writeFile|appendFile|mkdir|rename|unlink|\brmSync\b/);
    const publishableText = ["README.md", "package.json", "LICENSE"]
      .map((name) => readFileSync(join(packageRoot, name), "utf8"))
      .concat(source)
      .join("\n");
    expect(publishableText).not.toMatch(
      /\/home\/|\/Users\/|skribble|specific-downstream|operator-project|\bpenny\b/i
    );
  });
});
