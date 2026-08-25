import { chmodSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
}));

import {
  pruneDurableSubagentSessions,
  runSingleAgent,
  type AgentConfig,
} from "../../agent-runner.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-subagent-retention-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("durable subagent session policy", () => {
  it("removes only expired owner-controlled JSONL files", () => {
    const directory = root();
    const now = Date.parse("2026-08-23T00:00:00.000Z");
    const expired = path.join(directory, "expired.jsonl");
    const recent = path.join(directory, "recent.jsonl");
    const unrelated = path.join(directory, "notes.txt");
    writeFileSync(expired, "{}\n", { mode: 0o600 });
    writeFileSync(recent, "{}\n", { mode: 0o600 });
    writeFileSync(unrelated, "retain", { mode: 0o600 });
    utimesSync(expired, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    utimesSync(recent, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));
    symlinkSync(recent, path.join(directory, "linked.jsonl"));

    expect(pruneDurableSubagentSessions(directory, { now })).toEqual([expired]);
    expect(() => chmodSync(expired, 0o600)).toThrow();
    expect(() => chmodSync(recent, 0o600)).not.toThrow();
    expect(() => chmodSync(unrelated, 0o600)).not.toThrow();
  });

  it("returns typed STATE_UNINITIALIZED before spawning an agent", async () => {
    const project = root();
    const stateRoot = path.join(root(), "missing-state");
    const agent: AgentConfig = {
      name: "annie",
      description: "analysis",
      systemPrompt: "analyze",
      tools: [],
      source: "project",
      filePath: path.join(project, ".pi", "agents", "annie.md"),
    };
    const result = await runSingleAgent(
      project,
      [agent],
      "annie",
      "analyze state",
      undefined,
      undefined,
      undefined,
      undefined,
      (results) => ({
        mode: "single",
        agentScope: "project",
        projectAgentsDir: null,
        results,
      }),
      undefined,
      undefined,
      undefined,
      { PENNY_STATE_ROOT: stateRoot }
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("STATE_UNINITIALIZED");
  });
});
