import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findPennyProjectRoot,
  inspectPiVersionAlignment,
  piVersionAlignmentWarning,
} from "../../pi-version-alignment.js";

const temporaryDirectories: string[] = [];
const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(
  rootVersion = "0.84.4",
  orchestrationVersion = rootVersion
): Promise<{ root: string; nested: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "penny-pi-alignment-"));
  temporaryDirectories.push(root);
  const orchestration = path.join(root, "apps", "orchestration");
  const nested = path.join(root, "nested", "work");
  await mkdir(orchestration, { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: "penny",
    devDependencies: Object.fromEntries(PI_PACKAGES.map((name) => [name, rootVersion])),
  });
  await writeJson(path.join(orchestration, "package.json"), {
    dependencies: { "@earendil-works/pi-coding-agent": orchestrationVersion },
  });
  return { root, nested };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Pi SDK version alignment", () => {
  it("finds Penny from a nested session directory", async () => {
    const { root, nested } = await fixture();

    await expect(findPennyProjectRoot(nested)).resolves.toBe(root);
  });

  it("reports aligned exact root and orchestration versions", async () => {
    const { nested } = await fixture();

    const result = await inspectPiVersionAlignment(nested, "0.84.4");

    expect(result).toMatchObject({ status: "aligned", version: "0.84.4" });
    expect(piVersionAlignmentWarning(result)).toBeUndefined();
  });

  it("reports every local version when the host is newer", async () => {
    const { nested } = await fixture("0.84.4", "0.84.3");

    const result = await inspectPiVersionAlignment(nested, "0.85.0");
    const warning = piVersionAlignmentWarning(result);

    expect(result).toMatchObject({ status: "mismatch", hostVersion: "0.85.0" });
    expect(warning).toContain("Pi 0.85.0 does not match Penny's SDK pins");
    expect(warning).toContain("root @earendil-works/pi-ai=0.84.4");
    expect(warning).toContain("orchestration @earendil-works/pi-coding-agent=0.84.3");
    expect(warning).toContain("bun run pi:update");
  });

  it("fails closed when a required pin is not exact", async () => {
    const { root, nested } = await fixture();
    await writeJson(path.join(root, "package.json"), {
      name: "penny",
      devDependencies: Object.fromEntries(
        PI_PACKAGES.map((name) => [name, name.endsWith("pi-ai") ? "*" : "0.84.4"])
      ),
    });

    const result = await inspectPiVersionAlignment(nested, "0.84.4");

    expect(result).toMatchObject({ status: "invalid" });
    expect(piVersionAlignmentWarning(result)).toContain("must be an exact semantic version");
  });

  it("reports a malformed Penny root as invalid instead of silently ignoring it", async () => {
    const { root, nested } = await fixture();
    await writeFile(path.join(root, "package.json"), "{not-json", "utf8");

    const result = await inspectPiVersionAlignment(nested, "0.84.4");

    expect(result).toMatchObject({ status: "invalid" });
    expect(piVersionAlignmentWarning(result)).toContain("Could not verify");
  });

  it.each(["01.2.3", "1.2.3-beta.01", "1.2.3-beta..1"])(
    "rejects malformed semantic version %s",
    async (version) => {
      const { nested } = await fixture(version);

      const result = await inspectPiVersionAlignment(nested, "0.84.4");

      expect(result).toMatchObject({ status: "invalid" });
      expect(piVersionAlignmentWarning(result)).toContain("must be an exact semantic version");
    }
  );

  it("does nothing outside a Penny project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "not-penny-"));
    temporaryDirectories.push(directory);

    const result = await inspectPiVersionAlignment(directory, "0.84.4");

    expect(result).toEqual({ status: "not_penny_project" });
    expect(piVersionAlignmentWarning(result)).toBeUndefined();
  });
});
