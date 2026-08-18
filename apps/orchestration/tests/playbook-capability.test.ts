/**
 * W1 — playbook core/capability split (Foundation stage, workstream 1 of 3).
 *
 * Proves the engine's coupling to research has been replaced by structural capability
 * probing. Full end-to-end drivability of a non-research playbook needs an injection
 * seam, which arrives with the registry in W2 — see `playbook-registry.test.ts` (FG3).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Confidence, Directive, JsonValue } from "../src/contracts.js";
import type { RunContext } from "../src/context.js";
import {
  hasFanAggregate,
  hasMalformedReissue,
  type PlaybookCoreV1,
  type PlaybookV1,
} from "../src/playbooks/playbook.js";
import { ResearchPlaybook } from "../src/playbooks/research.js";

/** A playbook implementing the mandatory surface and nothing else. */
class CoreOnlyPlaybook implements PlaybookCoreV1 {
  initialize(): Directive {
    return { action: "complete", met: true, summary: "core-only" } as unknown as Directive;
  }
  dispatch(): Directive {
    return { action: "complete", met: true, summary: "core-only" } as unknown as Directive;
  }
  resume(_context: RunContext, _response: JsonValue): Directive {
    return this.dispatch();
  }
  cancel(): Directive {
    return { action: "complete", met: false, summary: "cancelled" } as unknown as Directive;
  }
  validateDetails(_state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    return details;
  }
  acceptSummary(
    _context: RunContext,
    _details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    return this.dispatch();
  }
  rebindPendingDirective(): Directive | null {
    return null;
  }
}

describe("W1 capability probing", () => {
  it("detects both capabilities on the reference playbook", () => {
    const research = new ResearchPlaybook() as PlaybookV1;
    expect(hasFanAggregate(research)).toBe(true);
    expect(hasMalformedReissue(research)).toBe(true);
  });

  it("detects the absence of both capabilities on a core-only playbook", () => {
    const core = new CoreOnlyPlaybook() as PlaybookV1;
    expect(hasFanAggregate(core)).toBe(false);
    expect(hasMalformedReissue(core)).toBe(false);
  });

  it("probes structurally, never by playbook identity", () => {
    // A bare object with the right shape must satisfy the probe: the engine asks
    // "can you aggregate?", not "are you research?".
    const duck = {
      ...new CoreOnlyPlaybook(),
      aggregateBranches: () => ({}),
    } as unknown as PlaybookV1;
    expect(hasFanAggregate(duck)).toBe(true);
    expect(hasMalformedReissue(duck)).toBe(false);
  });
});

describe("W1 engine decoupling", () => {
  const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

  it("never calls a research-named playbook method", () => {
    expect(source).not.toContain("aggregateResearchBranches");
    // The engine must not branch on a literal playbook name for dispatch.
    expect(source).not.toMatch(/playbook\s*===\s*"research"/);
  });

  it("reaches optional capabilities only through the probes", () => {
    expect(source).toContain("hasFanAggregate(this.playbook)");
    expect(source).toContain("hasMalformedReissue(this.playbook)");
  });
});
