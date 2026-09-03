import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestExtensionApi, requireFunction } from "../../../../lib/tests/test-narrowers.js";
import environmentExtension from "../../index.js";

const temporaryDirectories: string[] = [];
const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

async function createMismatchedPennyFixture(): Promise<{
  root: string;
  nested: string;
  manifestPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "penny-pi-session-alignment-"));
  temporaryDirectories.push(root);
  const nested = path.join(root, "nested");
  const orchestration = path.join(root, "apps", "orchestration");
  await mkdir(nested, { recursive: true });
  await mkdir(orchestration, { recursive: true });
  const manifestPath = path.join(root, "package.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: "penny",
        devDependencies: Object.fromEntries(PI_PACKAGES.map((name) => [name, "999.0.0"])),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(orchestration, "package.json"),
    `${JSON.stringify(
      { dependencies: { "@earendil-works/pi-coding-agent": "999.0.0" } },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { root, nested, manifestPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Pi SDK alignment session warning", () => {
  it("warns once through the registered session_start handler without changing manifests", async () => {
    const handlers = new Map<string, unknown>();
    const pi = createTestExtensionApi({
      onEvent(event, handler) {
        handlers.set(event, handler);
      },
    });
    await environmentExtension(pi);
    const sessionStart = requireFunction(
      handlers.get("session_start"),
      "session_start handler was not registered"
    );

    const { nested, manifestPath } = await createMismatchedPennyFixture();
    const originalManifest = await readFile(manifestPath);
    const notices: Array<{ message: string; level: string | undefined }> = [];
    const context = {
      cwd: nested,
      hasUI: true,
      ui: {
        notify(message: string, level?: string) {
          notices.push({ message, level });
        },
      },
    };

    await sessionStart({}, context);
    await sessionStart({}, context);

    const warnings = notices.filter((notice) => notice.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("bun run pi:update");
    await expect(readFile(manifestPath)).resolves.toEqual(originalManifest);
  });
});
