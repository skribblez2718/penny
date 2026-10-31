/** Offline cognition and SDK instrumentation only; owners, tools and persistence stay real. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerTool } from "../../../../lib/pi-tool-registration.js";
import { createArtifactReadExtension } from "../../../artifacts/index.js";
import compactionExtension from "../../../compaction/index.js";
import {
  loadRuntimeConfig,
  canonicalJson,
  PiAgentClient,
  parseSsotTools,
  catalogRoleBody,
  validateCatalogWorkerContinuityMetadata,
  type AgentInvocation,
  type InlineExtension,
  type OrchestrationServiceOptions,
} from "@penny/orchestration";
import type { AssessmentDraftV2, AssessmentRequestV1 } from "@penny/orchestration";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";

export const repository = path.resolve(import.meta.dirname, "../../../../..");
export type ContinuationMode =
  | "penny-threshold"
  | "native-overflow"
  | "native-silent"
  | "provider-error"
  | "cancel";
const request: AssessmentRequestV1 = {
  schema_version: 1,
  assessment_purpose: "Assess the supplied release note.",
  target: [{ statement: "Maintenance starts Tuesday at 09:00 UTC." }],
  criteria: [{ statement: "States the maintenance time clearly.", importance: "required" }],
  supplied_evidence: [{ statement: "The note names Tuesday at 09:00 UTC." }],
  hard_constraints: [{ statement: "Do not externally verify the schedule." }],
  non_goals: [{ statement: "Do not rewrite or send the note." }],
  known_uncertainties: [{ statement: "The audience was not specified." }],
};
const draft: AssessmentDraftV2 = {
  schema_version: 2,
  disposition: "meets",
  criterion_outcomes: [
    {
      criterion_index: 0,
      verdict: "met",
      supporting_evidence_indexes: [0],
      contradicting_evidence_indexes: [],
      rationale: "The supplied material states a precise maintenance time.",
    },
  ],
  summary: "The supplied note satisfies the criterion.",
  strengths: [{ statement: "The note is precise.", criterion_indexes: [0], evidence_indexes: [0] }],
  gaps: [],
  improvement_suggestions: [],
  assumptions: [],
  uncertainties: [],
  request_coverage: {
    assessment_purpose_covered: true,
    target_statement_indexes: [0],
    criterion_indexes: [0],
    supplied_evidence_indexes: [0],
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
  },
  confidence: "PROBABLE",
};
const { assessment_purpose, ...constraints } = request;
export const assessment = {
  goal: assessment_purpose,
  constraints,
  outputs: [
    'Criteria mapped.\nSUMMARY:{"confidence":"PROBABLE","complete":true}',
    `ASSESSMENT_DRAFT:${canonicalJson(draft)}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
    `Verification report.\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", verdict: "PASS", gap_kind: "none", repair_owner: "none", findings: [], evidence: ["The exact current assessment satisfies coverage, index and lineage checks."], strategy_delta: "Admit only this exact current assessment product." })}`,
  ],
};
const states = ["analyzing_assessment", "authoring_assessment", "verifying_assessment"];
// Fixture pressure, not a production token or liveness policy. The SDK estimates actual usage.
const pressure = "Disposable intermediate analysis; not final output. ".repeat(7000);
export interface WorkerObservation {
  invocation: AgentInvocation;
  session: AgentSession;
  reasons: string[];
  readIds: string[];
  readBytes: Map<string, string>;
  expected: string;
  resumed: number;
  shutdown: number;
  restoredOpening: string;
  handoffId: string;
  handoffBytes: string;
  rangeReads: number;
  readExecutions: number;
  handoffReads: Map<string, string>;
  unexpectedTools: string[];
}
export function contextText(context: TranscriptContext): string {
  return context.messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return message.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "thinking") return part.thinking;
          return "";
        })
        .join("");
    })
    .join("\n");
}
export function continuationFixture(mode: ContinuationMode, cancel: AbortController) {
  const root = mkdtempSync(path.join(tmpdir(), "penny-owner-continuation-"));
  const projectRoot = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  mkdirSync(projectRoot);
  cpSync(path.join(repository, ".pi/agents"), path.join(projectRoot, ".pi/agents"), {
    recursive: true,
  });
  cpSync(path.join(repository, ".pi/skills"), path.join(projectRoot, ".pi/skills"), {
    recursive: true,
  });
  cpSync(path.join(repository, ".pi/SYSTEM.md"), path.join(projectRoot, ".pi/SYSTEM.md"));
  cpSync(
    path.join(repository, "docs/agents/writing"),
    path.join(projectRoot, "docs/agents/writing"),
    { recursive: true }
  );
  cpSync(path.join(repository, "AGENTS.md"), path.join(projectRoot, "AGENTS.md"));
  const faux = fauxProvider({
    tokensPerSecond: 0,
    tokenSize: { min: 2048, max: 2048 },
    models: [{ id: "continuation", contextWindow: 65536, maxTokens: 8192 }],
  });
  const observations: WorkerObservation[] = [];
  const nativeMode = mode.startsWith("native-");
  let summaryStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    summaryStarted = resolve;
  });
  let summaryAborted = false;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  function client(options: OrchestrationServiceOptions) {
    const config = loadRuntimeConfig(options.projectRoot, options.env);
    const uncalledTools = new Set<string>();
    for (const agent of ["annie", "carren", "vera"]) {
      for (const tool of parseSsotTools(
        readFileSync(path.join(projectRoot, `.pi/agents/${agent}.md`), "utf8"),
        agent
      )) {
        if (
          !["artifact_read", "read", "bash", "edit", "write", "grep", "find", "ls"].includes(tool)
        )
          uncalledTools.add(tool);
      }
    }
    const providers: InlineExtension = (pi) => {
      pi.registerProvider(faux.provider);
      // Keep the copied real YAML maximum. Unused remote tools fail, never call a service.
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
        await Promise.resolve();
        const observation = requireDefined(observations.at(-1), "shutdown without worker");
        observation.shutdown++;
      });
    };
    return new PiAgentClient({
      catalogSessions: { projectId: config.projectId, root: config.subagentSessionRoot },
      workerExtensions: [
        providers,
        createArtifactReadExtension({ projectRoot, env: { ...options.env } }),
        ...(nativeMode
          ? []
          : [
              (pi: ExtensionAPI) =>
                compactionExtension({
                  on(_name, handler) {
                    pi.on("session_before_compact", async (event, context) => {
                      const result: unknown = await handler(event, context);
                      if (result === undefined) return;
                      if (!isRecord(result) || !isRecord(result.compaction))
                        throw new Error("Invalid Penny compaction result");
                      const value = result.compaction;
                      if (
                        typeof value.summary !== "string" ||
                        typeof value.firstKeptEntryId !== "string" ||
                        typeof value.tokensBefore !== "number"
                      )
                        throw new Error("Invalid Penny compaction fields");
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
                }),
            ]),
      ],
      sessionRuntime: {
        settingsManager: settings,
        noAmbientExtensions: true,
        attach(session, invocation) {
          const index = states.indexOf(invocation.stateId);
          if (index < 0 || states[observations.length] !== invocation.stateId)
            throw new Error(
              `Unexpected worker ${invocation.stateId}; expected ${states[observations.length]}`
            );
          const expected =
            (index === 0 ? "Captured analysis🙂\n".repeat(1500) : "") +
            requireDefined(assessment.outputs[index], "missing scripted phase");
          const observation: WorkerObservation = {
            invocation,
            session,
            reasons: [],
            readIds: [],
            readBytes: new Map(),
            expected,
            resumed: 0,
            shutdown: 0,
            restoredOpening: "",
            handoffId: "",
            handoffBytes: "",
            rangeReads: 0,
            readExecutions: 0,
            handoffReads: new Map(),
            unexpectedTools: [],
          };
          observations.push(observation);
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "compaction_start") observation.reasons.push(event.reason);
            if (event.type === "compaction_end") {
              observation.restoredOpening = "";
              observation.handoffBytes = "";
              handoffRange = undefined;
              if (mode === "cancel")
                cancel.abort(new Error("fixture cancellation after compaction"));
            }
            if (event.type === "tool_execution_end" && event.toolName === "artifact_read")
              observation.readExecutions++;
            if (event.type === "tool_execution_end" && event.toolName !== "artifact_read")
              observation.unexpectedTools.push(event.toolName);
          });
          const refs = invocation.inputArtifacts;
          if (refs.length === 0) throw new Error("owner omitted exact assessment inputs");
          let cursor = 0;
          let range = { start: 0, end: requireDefined(refs[0], "missing first ref").byte_length };
          let previousCall = "";
          let readSequence = 0;
          let handoffCall = "";
          const guidance = readFileSync(
            path.join(
              projectRoot,
              invocation.registration.guidance.skill_root,
              `${invocation.agent}-${invocation.stateId}.md`
            ),
            "utf8"
          ).trim();
          const role = catalogRoleBody(
            readFileSync(path.join(projectRoot, `.pi/agents/${invocation.agent}.md`), "utf8")
          )
            .split("<agent_boundary>")[0]
            ?.trim();
          if (!role) throw new Error("Missing role body");
          let overflowSent = false;
          let pressureSent = false;
          let handoffRange: { start: number; end: number } | undefined;
          const reply: FauxResponseStep = (context) => {
            const text = contextText(context);
            // Check the provider-visible frame AND task, not just session options.
            if (
              !getCurrentSystemPrompt(context.messages).includes(
                `You are **${invocation.agent[0]?.toUpperCase()}${invocation.agent.slice(1)}**`
              )
            ) {
              throw new Error("Provider lost the assigned role frame");
            }
            if (
              !getCurrentSystemPrompt(context.messages).includes(role) ||
              !getCurrentSystemPrompt(context.messages).includes(guidance)
            )
              throw new Error("Provider lost role or registered guidance");
            if (
              observation.reasons.length > 0 &&
              !nativeMode &&
              observation.restoredOpening === ""
            ) {
              const handoff = /Before doing more work, read `(art_[a-f0-9]{64})`/u.exec(text)?.[1];
              if (handoff === undefined) throw new Error("Missing exact continuity pointer");
              observation.handoffId = handoff;
              const response = [...context.messages]
                .reverse()
                .find(
                  (message) => message.role === "toolResult" && message.toolCallId === handoffCall
                );
              if (response?.role === "toolResult") {
                const block = response.content[0];
                if (response.isError || block?.type !== "text")
                  throw new Error("Continuity read failed");
                const payload: unknown = JSON.parse(block.text);
                if (!isRecord(payload) || typeof payload.content !== "string")
                  throw new Error("Invalid continuity envelope");
                observation.handoffBytes += payload.content;
                observation.rangeReads++;
                if (payload.truncated === false) {
                  const body: unknown = JSON.parse(observation.handoffBytes);
                  if (
                    !isRecord(body) ||
                    !isRecord(body.assignment) ||
                    !isRecord(body.assignment.compaction_continuity) ||
                    typeof body.assignment.compaction_continuity.opening !== "string" ||
                    body.assignment.task !== invocation.task
                  )
                    throw new Error("Continuity assignment mismatch");
                  const assignment = validateCatalogWorkerContinuityMetadata(body.assignment);
                  if (JSON.stringify(assignment.input_artifacts) !== JSON.stringify(refs))
                    throw new Error("Continuity exact input refs changed");
                  observation.restoredOpening = body.assignment.compaction_continuity.opening;
                  observation.handoffReads.set(handoff, observation.handoffBytes);
                } else {
                  if (
                    !isRecord(payload.next_range) ||
                    typeof payload.next_range.start !== "number" ||
                    typeof payload.next_range.end !== "number"
                  )
                    throw new Error("Continuity next_range absent");
                  handoffRange = { start: payload.next_range.start, end: payload.next_range.end };
                }
              }
              if (observation.restoredOpening === "") {
                handoffCall = `read-continuity-${++readSequence}`;
                return fauxAssistantMessage(
                  fauxToolCall(
                    "artifact_read",
                    {
                      artifact: handoff,
                      ...(handoffRange === undefined ? {} : { range: handoffRange }),
                    },
                    { id: handoffCall }
                  ),
                  { stopReason: "toolUse" }
                );
              }
            }
            const contract = text + observation.restoredOpening;
            if (!contract.includes("SUMMARY") || !contract.includes("artifact_read"))
              throw new Error("Provider lost output/read contract");
            const results = context.messages.filter(
              (message) => message.role === "toolResult" && message.toolCallId === previousCall
            );
            const result = results.at(-1);
            if (result !== undefined && result.role === "toolResult") {
              if (result.isError) throw new Error("Real artifact_read failed");
              const block = result.content[0];
              if (block?.type !== "text") throw new Error("artifact_read returned no text");
              const decoded: unknown = JSON.parse(block.text);
              if (!isRecord(decoded) || decoded.ok !== true || typeof decoded.content !== "string")
                throw new Error("invalid real artifact_read envelope");
              const ref = requireDefined(refs[cursor], "missing read cursor");
              observation.rangeReads++;
              observation.readBytes.set(
                ref.artifact_id,
                (observation.readBytes.get(ref.artifact_id) ?? "") + decoded.content
              );
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
                range = { start: 0, end: refs[cursor]?.byte_length ?? 0 };
              } else throw new Error("missing read completion flag");
              previousCall = "";
            }
            if (observation.reasons.length > 0) {
              observation.resumed++;
              if (mode === "penny-threshold" && index === 0 && !text.includes("Worker Continuity"))
                throw new Error("Provider lost owner continuity brief");
            }
            if (nativeMode && index === 0 && !overflowSent) {
              overflowSent = true;
              return fauxAssistantMessage("abandoned attempt", {
                stopReason: "error",
                errorMessage: "This model's maximum context length is 65536 tokens",
              });
            }
            const ref = refs[cursor];
            if (ref !== undefined) {
              if (!contract.includes(ref.artifact_id))
                throw new Error("Needed exact ID not available to provider");
              previousCall = `read-${index}-${cursor}-${range.start}-${++readSequence}`;
              const addPressure = index === 0 && !pressureSent && !nativeMode;
              pressureSent = true;
              return fauxAssistantMessage(
                [
                  ...(addPressure ? [fauxText(pressure)] : []),
                  fauxToolCall(
                    "artifact_read",
                    { artifact: ref.artifact_id, range },
                    { id: previousCall }
                  ),
                ],
                { stopReason: "toolUse" }
              );
            }
            if (!contract.includes(invocation.task))
              throw new Error("Provider lost exact assigned task");
            // Multiple final text parts with excluded reasoning make whole-message capture observable.
            const split = Math.floor(expected.length / 2);
            return fauxAssistantMessage(
              [
                fauxText(expected.slice(0, split)),
                fauxThinking("excluded fixture reasoning"),
                fauxText(expected.slice(split)),
              ],
              mode === "provider-error" && index === 0
                ? { stopReason: "error", errorMessage: "offline terminal failure" }
                : {}
            );
          };
          // Native recovery uses history + split-prefix summaries; route by the actual request.
          const nativeRouter: FauxResponseStep = (context, streamOptions, state, model) => {
            faux.appendResponses([nativeRouter]);
            const prompt = getCurrentSystemPrompt(context.messages);
            if (prompt.startsWith("You are a context summarization assistant.")) {
              const evicted = contextText(context);
              if (!evicted.includes(invocation.task))
                throw new Error("Native summary did not receive exact task");
              for (const ref of refs)
                if (!evicted.includes(ref.artifact_id))
                  throw new Error("Native summary did not receive input ID");
              if (mode === "native-silent") {
                summaryStarted?.();
                const signal = streamOptions?.signal;
                if (!signal) throw new Error("Native summary signal absent");
                return new Promise((_resolve, reject) => {
                  const abort = () => {
                    summaryAborted = true;
                    reject(new DOMException("Offline silent summary aborted", "AbortError"));
                  };
                  if (signal.aborted) abort();
                  else signal.addEventListener("abort", abort, { once: true });
                });
              }
              return fauxAssistantMessage(
                `## Goal\n${invocation.task}\n## Next Steps\nContinue exact reads with artifact_read and return full output followed by SUMMARY.\n${refs.map((ref) => ref.artifact_id).join("\n")}`
              );
            }
            return reply(context, streamOptions, state, model);
          };
          faux.setResponses([nativeRouter]);
          return unsubscribe;
        },
      },
    });
  }
  return {
    root,
    projectRoot,
    agentDir,
    client,
    observations,
    faux,
    started,
    summaryAborted: () => summaryAborted,
    cleanup: () => {
      for (const observation of observations) observation.session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
