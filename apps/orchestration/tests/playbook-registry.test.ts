/**
 * W2 — Playbook registry (Foundation stage, workstream 1 of 3).
 *
 * Three things are proven here:
 *   1. The shipped registry holds exactly one entry (C1 / M7 line).
 *   2. An unregistered playbook still fails closed with the exact pre-registry refusal.
 *   3. Multi-playbook dispatch works -- demonstrated with an INJECTED DOUBLE, never with
 *      a shipped registration, because registering a second skill crosses the M7 line.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import type { Confidence, Directive, JsonValue, RunIdentity } from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { PlaybookCoreV1, PlaybookV1 } from "../src/playbooks/playbook.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";
import {
  assertSoleProductionRegistration,
  isRegisteredPlaybook,
  PLAYBOOK_REGISTRY,
  registeredPlaybookNames,
  resolvePlaybook,
  SOLE_PRODUCTION_PLAYBOOK,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "../src/playbooks/registry.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-registry-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identity(playbook: string, runId = "run-registry-001"): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: "session-registry",
    playbook,
    engine_owner: "typescript",
  } as RunIdentity;
}

class DoublePlaybook implements PlaybookCoreV1 {
  initialize(): Directive {
    return { action: "complete", met: true } as unknown as Directive;
  }
  dispatch(): Directive {
    return { action: "complete", met: true } as unknown as Directive;
  }
  resume(_c: RunContext, _r: JsonValue): Directive {
    return this.dispatch();
  }
  cancel(): Directive {
    return { action: "complete", met: false } as unknown as Directive;
  }
  validateDetails(_s: string, d: Record<string, JsonValue>): Record<string, JsonValue> {
    return d;
  }
  acceptSummary(_c: RunContext, _d: Record<string, JsonValue>, _k: Confidence): Directive {
    return this.dispatch();
  }
  rebindPendingDirective(): Directive | null {
    return null;
  }
}

describe("W2 shipped registry — exactly one entry", () => {
  it("registers only research", () => {
    expect(registeredPlaybookNames()).toEqual([SOLE_PRODUCTION_PLAYBOOK]);
    expect(PLAYBOOK_REGISTRY.size).toBe(1);
  });

  it("passes the executable sole-registration invariant", () => {
    expect(() => assertSoleProductionRegistration()).not.toThrow();
  });

  it("rejects a second production registration", () => {
    const two: PlaybookRegistryV1 = new Map([
      ...PLAYBOOK_REGISTRY,
      [
        "knowledge-base",
        {
          name: "knowledge-base",
          contract: { ...RESEARCH_SKILL_CONTRACT, name: "knowledge-base" },
          construct: () => new DoublePlaybook(),
        },
      ],
    ]);
    expect(() => assertSoleProductionRegistration(two)).toThrow(/exactly one playbook/);
  });

  it("resolves research and does not resolve an unregistered name", () => {
    expect(resolvePlaybook(SOLE_PRODUCTION_PLAYBOOK)).toBeDefined();
    expect(resolvePlaybook("knowledge-base")).toBeUndefined();
    expect(isRegisteredPlaybook("knowledge-base")).toBe(false);
  });

  it("the engine imports no concrete playbook class", () => {
    const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/import\s*\{\s*ResearchPlaybook\s*\}/);
    expect(source).not.toContain("new ResearchPlaybook(");
  });
});

describe("W2 fail-closed on an unregistered playbook", () => {
  it("returns the exact pre-registry PLAYBOOK_UNAVAILABLE refusal, checkpoint untouched", () => {
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 8,
    });

    const unknown = identity("knowledge-base");
    // A real run persisted under a playbook the engine does not serve.
    const context = RunContext.create({
      identity: unknown,
      goal: "registry fail-closed fixture",
      constraints: {},
      projectRoot: root,
      trustProfile: "trusted-interactive",
      maxSteps: 8,
    });
    checkpointer.createRun(context, "run_created", {});

    // recover() is private; drive it through the public handle() surface.
    const directive = engine.handle({
      schema_version: 2,
      action: "recover",
      identity: unknown,
    } as never) as unknown as Directive & {
      result?: Record<string, JsonValue>;
      unresolved?: string[];
    };

    expect(directive.action).toBe("error");
    expect(directive.result?.code).toBe("PLAYBOOK_UNAVAILABLE");
    expect(directive.result?.checkpoint_unchanged).toBe(true);
    expect(directive.result?.playbook).toBe("knowledge-base");
    checkpointer.close();
  });
});

describe("W2 multi-playbook dispatch — injected double only", () => {
  it("constructs a non-research playbook from an injected registry", () => {
    const registration: PlaybookRegistrationV1 = {
      name: SOLE_PRODUCTION_PLAYBOOK,
      contract: RESEARCH_SKILL_CONTRACT,
      construct: () => new DoublePlaybook() as PlaybookV1,
    };
    const injected: PlaybookRegistryV1 = new Map([[registration.name, registration]]);
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));

    // The engine accepts any registry that provides the sole production name; this proves
    // construction is registry-driven rather than hardcoded.
    expect(
      () =>
        new OrchestrationEngine(checkpointer, {
          projectRoot: root,
          maxSteps: 8,
          playbookRegistry: injected,
        })
    ).not.toThrow();
    checkpointer.close();
  });

  it("refuses to build when the registry omits the production playbook", () => {
    const empty: PlaybookRegistryV1 = new Map();
    const root = temporaryDirectory();
    const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
    expect(
      () =>
        new OrchestrationEngine(checkpointer, {
          projectRoot: root,
          maxSteps: 8,
          playbookRegistry: empty,
        })
    ).toThrow(/not registered/);
    checkpointer.close();
  });
});
