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
  hasExternalStartOperationGroup,
  hasFanAggregate,
  hasGenericResponsePolicy,
  hasHostReviewedGateValidation,
  hasStateAwareRepair,
  type PlaybookCoreV1,
  type PlaybookV1,
} from "../src/playbooks/playbook.js";
import { ResearchPlaybook } from "../src/playbooks/research.js";

function terminal(met: boolean): Directive {
  return {
    schema_version: 2,
    action: met ? "complete" : "cancelled",
    identity: {
      schema_version: 2,
      run_id: "run_core_only",
      session_id: "session_core_only",
      playbook: "core-only",
      engine_owner: "typescript",
    },
    status: met ? "complete" : "cancelled",
    met,
    result: { summary: met ? "core-only" : "cancelled" },
    artifacts: [],
    unresolved: [],
  } satisfies Directive;
}

/** A playbook implementing the mandatory surface and nothing else. */
class CoreOnlyPlaybook implements PlaybookCoreV1 {
  initialize(): Directive {
    return terminal(true);
  }
  dispatch(): Directive {
    return terminal(true);
  }
  resume(_context: RunContext, _response: JsonValue): Directive {
    return this.dispatch();
  }
  cancel(): Directive {
    return terminal(false);
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

class AggregatingCorePlaybook extends CoreOnlyPlaybook {
  aggregateBranches(): Record<string, JsonValue> {
    return {};
  }
}

describe("W1 capability probing", () => {
  it("detects the reference playbook's actual optional capabilities", () => {
    const research: PlaybookV1 = new ResearchPlaybook();
    expect(hasFanAggregate(research)).toBe(true);
    expect(hasStateAwareRepair(research)).toBe(true);
    expect(hasGenericResponsePolicy(research)).toBe(false);
  });

  it("detects optional-capability absence on a core-only playbook", () => {
    const core: PlaybookV1 = new CoreOnlyPlaybook();
    expect(hasFanAggregate(core)).toBe(false);
    expect(hasStateAwareRepair(core)).toBe(false);
    expect(hasExternalStartOperationGroup(core)).toBe(false);
    expect(hasHostReviewedGateValidation(core)).toBe(false);
  });

  it("probes structurally, never by playbook identity", () => {
    // A bare object with the right shape must satisfy the probe: the engine asks
    // "can you aggregate?", not "are you research?".
    const duck: PlaybookV1 = new AggregatingCorePlaybook();
    expect(hasFanAggregate(duck)).toBe(true);
    expect(hasStateAwareRepair(duck)).toBe(false);
  });
});

describe("W1 engine decoupling", () => {
  const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");

  it("never calls a research-named playbook method", () => {
    expect(source).not.toContain("aggregateResearchBranches");
    // The engine must not branch on a literal playbook name for dispatch.
    expect(source).not.toMatch(/playbook\s*[!=]==?\s*"(?:research|knowledge-base)"/u);
  });

  it("reaches optional capabilities only through the probes", () => {
    expect(source).toContain("hasFanAggregate(this.playbook)");
    expect(source).toContain("hasRoutingRepair(this.playbook)");
    expect(source).toContain("hasLivenessTerminal(this.playbook)");
    expect(source).toContain("hasStateAwareRepair(this.playbook)");
    expect(source).toContain("hasExternalStartOperationGroup(this.playbook)");
    expect(source).toContain("hasHostReviewedGateValidation(this.playbook)");
  });

  it("contains no dead malformed-branch reissue capability", () => {
    const playbookSource = readFileSync(
      new URL("../src/playbooks/playbook.ts", import.meta.url),
      "utf8"
    );
    const researchSource = readFileSync(
      new URL("../src/playbooks/research.ts", import.meta.url),
      "utf8"
    );
    expect(playbookSource).not.toContain("MalformedReissueCapabilityV1");
    expect(playbookSource).not.toContain("hasMalformedReissue");
    expect(researchSource).not.toContain("reissueMalformedBranch");
  });
});
