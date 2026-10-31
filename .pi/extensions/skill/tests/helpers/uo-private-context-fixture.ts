/** Offline cognition + trusted synthetic resolver; owners, SDK, compaction and stores stay real. */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PiAgentClient,
  canonicalJson,
  loadRuntimeConfig,
  parseSsotTools,
  sha256,
  type AgentInvocation,
  type InlineExtension,
  type OrchestrationServiceOptions,
} from "@penny/orchestration";
import { registerTool } from "../../../../lib/pi-tool-registration.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import { createArtifactReadExtension } from "../../../artifacts/index.js";
import compactionExtension, { collectTrustedWorkerContinuity } from "../../../compaction/index.js";
import { contextText, continuationFixture } from "./uo-continuation-fixture.js";

// Harmless sentinels, not real KB inputs, policy or credentials.
export const privateBody =
  "UO_PRIVATE_ORCHID_47: A paper moon prefers a blue envelope. Advisory only.";
export const privateFailure = "UO_PRIVATE_RESOLVER_FAILURE_83: synthetic confidential diagnostic.";
export const publicEvidence =
  "SYNTHETIC PUBLIC EVIDENCE: The supplied note names Tuesday at 09:00 UTC.";
export type PrivateCase = "complete" | "provider-error" | "revoked" | "resolver-outage";
type CurrentProviders = Extract<
  NonNullable<OrchestrationServiceOptions["researchContextProviders"]>,
  { resolver_contract_version: 2 }
>;
type ApprovedResult = Awaited<ReturnType<NonNullable<CurrentProviders["approvedKbResult"]>>>;
const checkedAt = "2026-10-26T00:00:00Z";
const validFrom = "2026-01-01T00:00:00Z";
const validThrough = "9999-12-31T23:59:59Z";
function approvedResult(): ApprovedResult {
  return {
    schema_id: "penny.research-context-resolution.v2",
    schema_version: 2,
    source_kind: "approved_kb_result",
    source_id: "synthetic-private-source",
    content: privateBody,
    media_type: "text/markdown",
    role: "advisory",
    scope_id: "synthetic-research-scope",
    revision: {
      kind: "approved_kb",
      kb_profile_id: "synthetic-profile",
      result_id: "synthetic-approved-result",
      approval_id: "synthetic-approval",
      approval_sha256: sha256("synthetic approval identity"),
    },
    freshness: { status: "not_time_sensitive" },
    upstream_locators: [
      { source_id: "synthetic-private-source", locator: "kb-result:synthetic-approved-result" },
    ],
    provider: {
      provider_id: "synthetic-private-provider",
      configuration_sha256: sha256("synthetic resolver configuration"),
      eligibility_record_id: "synthetic-admission-eligibility",
      eligibility_sha256: sha256("synthetic admission eligibility"),
    },
    verification_disposition: "advisory_only",
    conflict: { status: "none" },
    eligibility: {
      status: "eligible",
      checked_at: checkedAt,
      valid_from: validFrom,
      valid_through: validThrough,
    },
    approval: {
      status: "approved",
      checked_at: checkedAt,
      valid_from: validFrom,
      valid_through: validThrough,
    },
  };
}
export const privateRequest = {
  goal: "What does the supplied synthetic note say about maintenance timing? No external verification.",
  constraints: {
    mode: "standard",
    scope: {
      include: ["The supplied synthetic public note."],
      exclude: ["Private advisory wording as evidence; external activity."],
    },
    context_bindings: [
      {
        slot: "standard_guidance",
        binding_kind: "approved_kb_result",
        selected_by: "host",
        source_id: "synthetic-private-source",
        kb_profile_id: "synthetic-profile",
        result_id: "synthetic-approved-result",
        expected_sha256: sha256(privateBody),
      },
    ],
  },
};
export interface PrivateWorkerObservation {
  readonly invocation: AgentInvocation;
  readonly session: AgentSession;
  readonly readIds: string[];
  readonly readBytes: Map<string, string>;
  readonly reasons: string[];
  readonly toolExecutions: string[];
  rangeReads: number;
  postCompactionReads: number;
  privateOpeningSeen: number;
  resumed: number;
  summaries: number;
  summarySawPrivateBody: boolean;
  hookCalls: number;
  trustedPrivateHookCalls: number;
  hookYielded: number;
  shutdownStarted: number;
  shutdownFinished: number;
  expected: string;
}
function output(invocation: AgentInvocation, reads: ReadonlyMap<string, string>): string {
  let body: string;
  let summary: Record<string, unknown>;
  switch (invocation.stateId) {
    case "planning":
      body =
        "Inspect only the supplied synthetic public note. Private context is advisory, not evidence.";
      summary = {
        plan_steps: ["Read the supplied synthetic note without external verification."],
        plan_complete: true,
      };
      break;
    case "researching":
      // Make later exact reads observably multi-range without private content or production limits.
      body = `${publicEvidence}\n${"Public synthetic padding🙂. ".repeat(700)}`;
      summary = { explore_complete: true };
      break;
    case "synthesizing": {
      const encoded = requireDefined(
        invocation.task.match(/OWNER_SELECTED_EVIDENCE_SLOTS:(\{[^\n]+\})/u)?.[1],
        "owner evidence slots absent"
      );
      const table: unknown = JSON.parse(encoded);
      if (!isRecord(table) || !Array.isArray(table.evidence_artifacts))
        throw new Error("invalid owner evidence table");
      const slot: unknown = table.evidence_artifacts[0];
      if (
        !isRecord(slot) ||
        slot.evidence_artifact_slot !== 0 ||
        typeof slot.artifact_id !== "string"
      )
        throw new Error("missing first evidence slot");
      const evidence = requireDefined(reads.get(slot.artifact_id), "exact evidence not fully read");
      if (!evidence.includes(publicEvidence))
        throw new Error("public note absent from exact Echo bytes");
      body = canonicalJson({
        schema_id: "penny.research-semantic-draft.v1",
        schema_version: 1,
        title: "Synthetic note timing",
        executive_summary:
          "The supplied synthetic note names a maintenance time, not an independently verified schedule.",
        sources: [
          {
            source_kind: "primary",
            role: "evidentiary",
            tier: 1,
            title: "Synthetic supplied note",
            locator: "fixture:public-note",
            observed_at: checkedAt,
          },
        ],
        evidence: [
          {
            source_index: 0,
            evidence_artifact_slot: 0,
            locator: "fixture:public-note",
            excerpt: publicEvidence,
            relation: "supports",
          },
        ],
        claims: [
          {
            statement: "The supplied synthetic note names Tuesday at 09:00 UTC.",
            claim_kind: "fact",
            support_status: "qualified",
            confidence: 0.8,
            evidence_indexes: [0],
            qualifications: ["Synthetic supplied material only; no external verification."],
          },
        ],
        contradictions: [],
        unresolved_gaps: [],
        irreducible_uncertainties: [],
        sections: [
          {
            heading: "Supplied note",
            body: "Only the supplied synthetic note is described; private advisory context is not evidence.",
            claim_indexes: [0],
            evidence_indexes: [0],
          },
        ],
      });
      summary = { synthesis_complete: true };
      break;
    }
    case "validating":
      body =
        "Scripted review: exact public-note excerpt is qualified as supplied synthetic material only.";
      summary = {
        verdict: "PASS",
        unsupported_claims: [],
        evidence: ["Exact public-note excerpt; no private advisory body in the core."],
      };
      break;
    default:
      throw new Error(`Unexpected research state ${invocation.stateId}`);
  }
  return `${body}\nSUMMARY:${canonicalJson({ confidence: "PROBABLE", ...summary })}`;
}

export function privateContextFixture(mode: PrivateCase) {
  // Reuse only its disposable copied real catalog/skills and offline provider. Its client is unused.
  const base = continuationFixture("native-overflow", new AbortController());
  const observations: PrivateWorkerObservation[] = [];
  const resolutions: Array<{
    source_id: string;
    purpose: string;
    signal: AbortSignal;
    interval_ms: number;
  }> = [];
  const providers: CurrentProviders = {
    resolver_contract_version: 2,
    provider_execution: "trusted_in_process",
    admission_resolutions: [approvedResult()],
    async approvedKbResult(request, control) {
      if (
        request.source_id !== "synthetic-private-source" ||
        request.kb_profile_id !== "synthetic-profile" ||
        request.result_id !== "synthetic-approved-result" ||
        request.expected_sha256 !== sha256(privateBody) ||
        request.slot !== "standard_guidance" ||
        request.resolver_contract_version !== 2
      )
        throw new Error("wrong exact resolver request");
      resolutions.push({
        source_id: request.source_id,
        purpose: control.purpose,
        signal: control.signal,
        interval_ms: control.inactivity_interval_ms,
      });
      if (mode === "resolver-outage") throw new Error(privateFailure);
      const current = approvedResult();
      return {
        ...current,
        provider: {
          ...current.provider,
          eligibility_record_id: "synthetic-use-time-eligibility",
          eligibility_sha256: sha256("synthetic current eligibility"),
        },
        ...(mode === "revoked"
          ? {
              approval: {
                status: "revoked",
                checked_at: checkedAt,
                reason_code: "synthetic-owner-revoked",
              } as const,
            }
          : {}),
      };
    },
  };
  function client(options: OrchestrationServiceOptions) {
    const config = loadRuntimeConfig(options.projectRoot, options.env);
    const uncalledTools = new Set<string>();
    for (const agent of ["piper", "echo", "synthia", "vera"]) {
      for (const name of parseSsotTools(
        readFileSync(path.join(base.projectRoot, `.pi/agents/${agent}.md`), "utf8"),
        agent
      )) {
        if (
          !["artifact_read", "read", "bash", "edit", "write", "grep", "find", "ls"].includes(name)
        )
          uncalledTools.add(name);
      }
    }
    const offline: InlineExtension = (pi) => {
      pi.registerProvider(base.faux.provider);
      for (const name of uncalledTools)
        registerTool(pi, {
          name,
          label: name,
          description: "Unavailable offline fixture capability; must not be called.",
          parameters: Type.Object({}),
          async execute() {
            throw new Error(`Forbidden offline tool: ${name}`);
          },
        });
      pi.on("session_shutdown", async () => {
        const observation = requireDefined(observations.at(-1), "shutdown without attached worker");
        observation.shutdownStarted++;
        // A real asynchronous boundary makes an unawaited shutdown observable before the owner returns.
        await new Promise<void>((resolve) => setImmediate(resolve));
        observation.shutdownFinished++;
      });
    };
    const penny: InlineExtension = (pi) =>
      compactionExtension({
        on(_name, handler) {
          pi.on("session_before_compact", async (event, context) => {
            const observation = requireDefined(observations.at(-1), "compaction without worker");
            observation.hookCalls++;
            const admission = collectTrustedWorkerContinuity(
              event.branchEntries.filter((entry) => entry.type === "custom"),
              config.projectId
            );
            if (
              admission.status === "trusted" &&
              admission.continuity.assignment.compaction_continuity.mode ===
                "pi_default_private_context"
            )
              observation.trustedPrivateHookCalls++;
            const result: unknown = await handler(event, context);
            if (result === undefined) {
              observation.hookYielded++;
              return;
            }
            if (!isRecord(result) || !isRecord(result.compaction))
              throw new Error("Unexpected Penny compaction response");
            const value = result.compaction;
            if (
              typeof value.summary !== "string" ||
              typeof value.firstKeptEntryId !== "string" ||
              typeof value.tokensBefore !== "number"
            )
              throw new Error("Invalid Penny compaction response");
            return {
              compaction: {
                summary: value.summary,
                firstKeptEntryId: value.firstKeptEntryId,
                tokensBefore: value.tokensBefore,
                details: value.details,
              },
            };
          });
        },
      });
    return new PiAgentClient({
      catalogSessions: { projectId: config.projectId, root: config.subagentSessionRoot },
      workerExtensions: [
        offline,
        createArtifactReadExtension({ projectRoot: base.projectRoot, env: { ...options.env } }),
        penny,
      ],
      sessionRuntime: {
        noAmbientExtensions: true,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 },
          retry: { enabled: false },
          cacheWarming: "off",
        }),
        attach(session, invocation) {
          const prior = observations.at(-1);
          if (prior !== undefined && prior.shutdownFinished !== 1)
            throw new Error("owner opened the next worker before awaiting prior shutdown");
          const observation: PrivateWorkerObservation = {
            invocation,
            session,
            readIds: [],
            readBytes: new Map(),
            reasons: [],
            toolExecutions: [],
            rangeReads: 0,
            postCompactionReads: 0,
            privateOpeningSeen: 0,
            resumed: 0,
            summaries: 0,
            summarySawPrivateBody: false,
            hookCalls: 0,
            trustedPrivateHookCalls: 0,
            hookYielded: 0,
            shutdownStarted: 0,
            shutdownFinished: 0,
            expected: "",
          };
          observations.push(observation);
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "compaction_start") observation.reasons.push(event.reason);
            if (event.type === "tool_execution_end")
              observation.toolExecutions.push(event.toolName);
          });
          let cursor = 0;
          let range: { start: number; end: number } | undefined;
          let call = "";
          let sequence = 0;
          let overflowSent = false;
          const router: FauxResponseStep = (context) => {
            base.faux.appendResponses([router]);
            const text = contextText(context);
            if (
              getCurrentSystemPrompt(context.messages).startsWith(
                "You are a context summarization assistant."
              )
            ) {
              observation.summaries++;
              observation.summarySawPrivateBody ||= text.includes(privateBody);
              if (!text.includes(invocation.task))
                throw new Error("native summary lost exact task");
              return fauxAssistantMessage(
                `## Goal\n${invocation.task}\n## Next Steps\nContinue exact artifact_read ranges and return complete output with SUMMARY. Private advisory context is not evidence.\n${invocation.inputArtifacts.map((ref) => ref.artifact_id).join("\n")}`
              );
            }
            if (observation.reasons.length === 0) {
              if (
                !text.includes(privateBody) ||
                !text.includes("USE-TIME VALIDATION") ||
                !text.includes("synthetic-use-time-eligibility")
              )
                throw new Error("provider did not receive revalidated owner private context");
              observation.privateOpeningSeen++;
            } else observation.resumed++;
            for (const message of context.messages)
              if (message.role === "toolResult" && JSON.stringify(message).includes(privateBody))
                throw new Error("private body leaked into generic tool result");
            if (!text.includes(invocation.task) || !text.includes("SUMMARY"))
              throw new Error("provider lost assignment contract");
            const result = context.messages.find(
              (message) => message.role === "toolResult" && message.toolCallId === call
            );
            if (result?.role === "toolResult") {
              const block = result.content[0];
              if (result.isError || block?.type !== "text")
                throw new Error("real exact read failed");
              const decoded: unknown = JSON.parse(block.text);
              if (!isRecord(decoded) || decoded.ok !== true || typeof decoded.content !== "string")
                throw new Error("invalid artifact_read envelope");
              const ref = requireDefined(invocation.inputArtifacts[cursor], "read cursor absent");
              observation.readBytes.set(
                ref.artifact_id,
                (observation.readBytes.get(ref.artifact_id) ?? "") + decoded.content
              );
              observation.rangeReads++;
              if (observation.reasons.length > 0) observation.postCompactionReads++;
              if (decoded.truncated === true) {
                if (
                  !isRecord(decoded.next_range) ||
                  typeof decoded.next_range.start !== "number" ||
                  typeof decoded.next_range.end !== "number"
                )
                  throw new Error("missing exact next_range");
                range = { start: decoded.next_range.start, end: decoded.next_range.end };
              } else if (decoded.truncated === false) {
                observation.readIds.push(ref.artifact_id);
                cursor++;
                range = undefined;
              } else throw new Error("missing read completion");
              call = "";
            }
            // Overflow after one exact read, leaving a real input read for native continuation.
            // Fake only the provider response, never a session event or the compaction operation.
            if (invocation.stateId === "planning" && cursor > 0 && !overflowSent) {
              overflowSent = true;
              return fauxAssistantMessage("abandoned offline attempt", {
                stopReason: "error",
                errorMessage: "This model's maximum context length is 65536 tokens",
              });
            }
            const ref = invocation.inputArtifacts[cursor];
            if (ref !== undefined) {
              if (!text.includes(ref.artifact_id))
                throw new Error("provider missing exact input identity");
              call = `private-read-${++sequence}`;
              return fauxAssistantMessage(
                fauxToolCall(
                  "artifact_read",
                  { artifact: ref.artifact_id, ...(range === undefined ? {} : { range }) },
                  { id: call }
                ),
                { stopReason: "toolUse" }
              );
            }
            observation.expected =
              (mode === "provider-error" && invocation.stateId === "planning"
                ? `${privateBody}\n`
                : "") + output(invocation, observation.readBytes);
            const split = Math.floor(observation.expected.length / 2);
            return fauxAssistantMessage(
              [
                fauxText(observation.expected.slice(0, split)),
                fauxThinking("excluded synthetic private-worker reasoning"),
                fauxText(observation.expected.slice(split)),
              ],
              mode === "provider-error" && invocation.stateId === "planning"
                ? {
                    stopReason: "error",
                    errorMessage: "offline terminal failure after private compaction",
                  }
                : {}
            );
          };
          base.faux.setResponses([router]);
          return unsubscribe;
        },
      },
    });
  }
  return {
    ...base,
    client,
    providers,
    observations,
    resolutions,
    cleanup: () => {
      for (const observation of observations) observation.session.dispose();
      base.cleanup();
    },
  };
}
