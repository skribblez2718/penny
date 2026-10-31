/** Disposable-child-only offline cognition. Never replaces prompt, owners or Pi events. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCatalogPrompt, catalogRoleBody, parseSsotTools } from "@penny/orchestration";
import { Type } from "typebox";
import { registerTool } from "../../../../lib/pi-tool-registration.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import artifactExtension from "../../../artifacts/index.js";

export const directTask =
  "Compare the exact supplied maintenance note; preserve its Unicode bytes. Return the assigned direct report, not workflow routing metadata.";
export const directContext =
  "DIRECT CALLER CONTEXT: offline maintenance-note comparison only; do not browse or mutate files.";
export const inputBytes = "Maintenance Tuesday 09:00 UTC — café 🙂\n".repeat(2200);
export const finalBytes = "Direct report🙂\n".repeat(2800) + "Verified the complete exact input.\n";
export const failedBytes = "COMPLETED successfully; terminal=completed\n" + finalBytes;
export const cancelledBytes = "Cancelled partial🙂\n".repeat(80);
const pressure = "Disposable intermediate analysis, not final output. ".repeat(13000);
export type DirectMode = "threshold" | "overflow" | "provider-error" | "cancel" | "silent";
export function parseMode(value: unknown): DirectMode {
  if (
    value === "threshold" ||
    value === "overflow" ||
    value === "provider-error" ||
    value === "cancel" ||
    value === "silent"
  )
    return value;
  throw new Error("Unknown direct fixture mode");
}
function contextText(context: TranscriptContext): string {
  return context.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    )
    .join("\n");
}
export default function directChildFixture(pi: ExtensionAPI): void {
  const mode = parseMode(process.env.UO_DIRECT_MODE);
  const root = requireDefined(process.env.PROJECT_ROOT, "fixture project absent");
  const inputId = requireDefined(process.env.UO_DIRECT_INPUT, "fixture input absent");
  const trace = path.join(root, "observations.jsonl");
  const observe = (entry: Record<string, unknown>) =>
    appendFileSync(trace, JSON.stringify(entry) + "\n");
  // Defensive in-process egress refusal, NOT an OS/network sandbox claim.
  globalThis.fetch = () => {
    observe({ type: "forbidden_fetch" });
    return Promise.reject(new Error("Direct fixture forbids network"));
  };
  artifactExtension(pi);
  const definition = readFileSync(path.join(root, ".pi/agents/echo.md"), "utf8");
  const tools = parseSsotTools(definition, "echo");
  const role = requireDefined(
    catalogRoleBody(definition).split("<agent_boundary>")[0],
    "role absent"
  ).trim();
  for (const name of tools) {
    if (["artifact_read", "read", "write", "edit", "bash", "grep", "find", "ls"].includes(name))
      continue;
    registerTool(pi, {
      name,
      label: name,
      description: "Offline unavailable fixture tool. Do not call.",
      parameters: Type.Object({}),
      async execute() {
        throw new Error(`Forbidden offline tool: ${name}`);
      },
    });
  }
  const expectedFrame = buildCatalogPrompt({
    projectRoot: root,
    agentName: "echo",
    role: definition,
    env: process.env,
  }).frame;
  let assignment = "";
  let assignedSystem = "";
  let partialSent = false;
  let compactions = 0;
  let pressureSent = false;
  let previousCall = "";
  let start = 0;
  let end: number | undefined;
  let consumed = "";
  let readSequence = 0;
  let readComplete = false;
  pi.on("before_agent_start", (event) => {
    if ("prompt" in event) {
      assignment = event.prompt;
      observe({ type: "assignment", task: assignment, activeTools: pi.getActiveTools() });
    }
  });
  pi.on("session_before_compact", (event) => {
    observe({
      type: "before_compact",
      reason: event.reason,
      tokensBefore: event.preparation.tokensBefore,
      settings: event.preparation.settings,
    });
    // Observation only: native Pi summary generation and cut selection remain untouched.
  });
  pi.on("session_compact", (event) => {
    compactions++;
    observe({
      type: "compacted",
      reason: event.reason,
      fromExtension: event.fromExtension,
      entry: event.compactionEntry,
    });
  });
  pi.on("session_compact_failed", (event) =>
    observe({ type: "compact_failed", reason: event.reason, aborted: event.aborted })
  );
  pi.on("session_shutdown", (event) => observe({ type: "shutdown", reason: event.reason }));
  const faux = fauxProvider({
    tokensPerSecond: 0,
    tokenSize: { min: 4096, max: 4096 },
    models: [{ id: "direct-continuation", contextWindow: 131072, maxTokens: 8192 }],
  });
  const router: FauxResponseStep = (context, options) => {
    faux.appendResponses([router]);
    const text = contextText(context);
    const system = getCurrentSystemPrompt(context.messages);
    if (system.startsWith("You are a context summarization assistant.")) {
      if (!assignment || !text.includes(assignment))
        throw new Error("Native summary lost original owner assignment");
      observe({
        type: "native_summary",
        includesExactAssignment: true,
        includesInputId: text.includes(inputId),
      });
      if (mode === "silent") {
        writeFileSync(path.join(root, "summary-started"), "ready");
        const signal = requireDefined(options?.signal, "summary cancellation signal absent");
        return new Promise((_resolve, reject) => {
          const abort = () => {
            observe({ type: "summary_aborted" });
            reject(new DOMException("Silent fixture aborted", "AbortError"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      return fauxAssistantMessage(
        `## Goal\n${assignment}\n## Next Steps\nContinue artifact_read through every next_range, then deliver the direct report. No workflow continuity metadata exists for this direct child.`
      );
    }
    if (
      !system.includes(expectedFrame) ||
      !system.includes("You are **Echo**") ||
      !system.includes(role)
    )
      throw new Error("Provider lost actual catalog role/frame");
    if (
      !assignment.includes(directTask) ||
      !assignment.includes(directContext) ||
      !assignment.includes(inputId)
    )
      throw new Error("Owner assignment omitted exact task/context/ID");
    if (assignedSystem === "") assignedSystem = system;
    if (system !== assignedSystem || JSON.stringify(pi.getActiveTools()) !== JSON.stringify(tools))
      throw new Error("Provider lost exact original system frame or YAML tool equality");
    if (compactions > 0) {
      if (!text.includes(assignment))
        throw new Error("Post-compaction provider lost exact assigned task/context/inputs");
      observe({ type: "resumed", compactions, exactAssignment: true, roleAndFrame: true });
    }
    if (!pressureSent) {
      pressureSent = true;
      if (mode === "overflow" || mode === "silent")
        return fauxAssistantMessage("Abandoned overflow attempt", {
          stopReason: "error",
          errorMessage: "This model's maximum context length is 131072 tokens",
        });
      return fauxAssistantMessage(
        [
          fauxText(pressure),
          fauxToolCall("artifact_read", { artifact: inputId }, { id: "pressure-read" }),
        ],
        { stopReason: "toolUse" }
      );
    }
    if (compactions === 0) throw new Error("Fixture did not produce actual native compaction");
    if (previousCall) {
      const result = context.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === previousCall
      );
      if (result?.role !== "toolResult" || result.isError)
        throw new Error("Real artifact_read result absent or failed");
      const block = result.content[0];
      if (block?.type !== "text") throw new Error("Real artifact_read text absent");
      const payload: unknown = JSON.parse(block.text);
      if (
        !isRecord(payload) ||
        payload.ok !== true ||
        payload.artifact_ref === undefined ||
        !isRecord(payload.artifact_ref) ||
        payload.artifact_ref.artifact_id !== inputId ||
        typeof payload.content !== "string" ||
        !isRecord(payload.returned_range) ||
        payload.returned_range.start !== start ||
        typeof payload.returned_range.end !== "number"
      )
        throw new Error("Invalid real artifact envelope");
      const nextStart = payload.returned_range.end;
      if (Buffer.byteLength(payload.content) !== nextStart - start)
        throw new Error("Artifact byte range differs from exact UTF-8 payload");
      consumed += payload.content;
      observe({
        type: "range",
        start,
        end: nextStart,
        content: payload.content,
        truncated: payload.truncated,
        next: payload.next_range,
      });
      if (payload.truncated === false) {
        if (consumed !== inputBytes)
          throw new Error("Full provider-consumed artifact differs byte-for-byte");
        readComplete = true;
      } else if (
        payload.truncated === true &&
        isRecord(payload.next_range) &&
        payload.next_range.start === nextStart &&
        typeof payload.next_range.end === "number"
      ) {
        start = nextStart;
        end = payload.next_range.end;
      } else throw new Error("Exact next_range absent");
      previousCall = "";
    }
    if (!readComplete) {
      previousCall = `exact-read-${++readSequence}`;
      return fauxAssistantMessage(
        fauxToolCall(
          "artifact_read",
          { artifact: inputId, ...(end === undefined ? {} : { range: { start, end } }) },
          { id: previousCall }
        ),
        { stopReason: "toolUse" }
      );
    }
    if (mode === "cancel" && partialSent) {
      observe({ type: "cancellation_wait" });
      const signal = requireDefined(options?.signal, "provider cancellation signal absent");
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Cancelled offline provider", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    partialSent = mode === "cancel";
    const expected =
      mode === "provider-error" ? failedBytes : mode === "cancel" ? cancelledBytes : finalBytes;
    const split = Math.floor(expected.length / 2);
    observe({ type: "final_requested", bytes: Buffer.byteLength(expected), mode });
    return fauxAssistantMessage(
      [
        fauxText(expected.slice(0, split)),
        fauxThinking("excluded direct fixture reasoning"),
        fauxText(expected.slice(split)),
        ...(mode === "cancel"
          ? [fauxToolCall("artifact_read", { artifact: inputId }, { id: "cancel-partial" })]
          : []),
      ],
      mode === "provider-error"
        ? { stopReason: "error", errorMessage: "Offline provider terminal failure" }
        : mode === "cancel"
          ? { stopReason: "toolUse" }
          : {}
    );
  };
  faux.setResponses([router]);
  pi.registerProvider(faux.provider);
}
