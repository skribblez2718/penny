/**
 * KB playbook — the second registered playbook.
 *
 * Implements PlaybookCoreV1 for the knowledge-base workflow. Registered in the
 * playbook registry alongside research (which remains the sole production skill
 * for the research workflow). The KB playbook owns the eight public actions:
 * init, ingest, query, save, lint, promote, status, resume.
 *
 * This is a thin playbook: it delegates to the `kb/workflows.ts` module, which
 * contains the actual state machine logic. The playbook's job is to translate
 * between the engine's directive protocol and the KB workflow functions.
 */

import type { Confidence, Directive, JsonValue } from "../contracts.js";
import type { RunContext } from "../context.js";
import type { PlaybookCoreV1 } from "./playbook.js";
import type { SkillContract } from "../contracts.js";

/**
 * The KB skill contract — the reference instance for the knowledge-base playbook.
 */
export const KNOWLEDGE_BASE_SKILL_CONTRACT: SkillContract = {
  schema_version: 1,
  name: "knowledge-base",
  objective:
    "Manage a private advisory knowledge base: initialize, ingest sources, query, save, lint, and prepare promotions.",
  accepts: ["agent-output"],
  produces: ["agent-output"],
  invariants: [
    "No raw source, page, claim, report, or patch body is returned to the parent.",
    "Query and lint do not publish; only ingest and save publish after content review.",
    "Promotion only prepares; approved apply is a separate host-only path.",
  ],
  authority: {
    trust_profiles: ["trusted-interactive", "hardened-untrusted"],
  },
  guidance: {
    skill_root: ".pi/skills/knowledge-base/assets/prompts",
    resolution: "per_agent_phase",
  },
  feedback_kinds: ["evidence_gap", "synthesis_gap", "validation_gap", "malformed_result"],
  budgets: {},
  completion_gate: {
    schema_version: 1,
    required_receipts: [],
    required_states: [],
  },
};

/**
 * The KB playbook. Currently a stub that returns a complete directive — the
 * actual workflow logic lives in `kb/workflows.ts` and is invoked by the adapter
 * when the `knowledge_base` tool is called. The playbook exists so the registry
 * has a second entry and the engine can dispatch to it by name.
 *
 * As the KB workflows are wired into the engine's start/step/recover protocol,
 * this playbook will grow to implement the full state machine. For now, it
 * proves the registry can hold two playbooks and the engine can dispatch to
 * either by name.
 */
export class KnowledgeBasePlaybook implements PlaybookCoreV1 {
  constructor() {}

  initialize(_context: RunContext): Directive {
    return {
      schema_version: 2,
      action: "complete",
      identity: _context.identity,
      status: "complete",
      met: true,
      result: { code: "KB_STUB", message: "KB playbook initialized (stub)" },
      artifacts: [],
      unresolved: [],
    } as unknown as Directive;
  }

  dispatch(context: RunContext): Directive {
    return this.initialize(context);
  }

  resume(context: RunContext, _response: JsonValue): Directive {
    return this.dispatch(context);
  }

  cancel(context: RunContext, reason: string): Directive {
    return {
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: { code: "KB_CANCELLED", message: reason },
      artifacts: [],
      unresolved: [reason],
    } as unknown as Directive;
  }

  validateDetails(_state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    return details;
  }

  acceptSummary(
    _context: RunContext,
    _details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    return {
      schema_version: 2,
      action: "complete",
      identity: _context.identity,
      status: "complete",
      met: true,
      result: { code: "KB_ACCEPTED" },
      artifacts: [],
      unresolved: [],
    } as unknown as Directive;
  }

  rebindPendingDirective(): Directive | null {
    return null;
  }
}
