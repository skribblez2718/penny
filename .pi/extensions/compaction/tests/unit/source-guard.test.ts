import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const productionSources = () =>
  readdirSync(extensionRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, source: readFileSync(join(extensionRoot, name), "utf8") }));

describe("compaction source guard", () => {
  it("contains no raw memory bridge, room discovery, or process-spawn path", () => {
    const source = productionSources()
      .map(({ source }) => source)
      .join("\n");
    for (const forbidden of [
      "memory_bridge.py",
      "list_rooms",
      "list_drawers",
      "mempalace_drawer",
      "queryMempalace",
      'startsWith("skills/")',
      "child_process",
      "spawn(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("uses an exact, read-only run-id query instead of a pending-run scan", () => {
    const source = readFileSync(join(extensionRoot, "checkpointer.ts"), "utf8");
    expect(source).toContain("new DatabaseSync(databasePath, { readOnly: true })");
    expect(source).toContain('database.exec("PRAGMA query_only = ON")');
    expect(source).toContain("FROM runs WHERE run_id IN");
    expect(source).not.toMatch(/WHERE\s+status\s+IN/i);
    expect(source).not.toMatch(/WHERE\s+session_id\s*=/i);
  });
});
