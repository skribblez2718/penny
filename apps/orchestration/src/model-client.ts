import { readFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  ConfidenceSchema,
  type ArtifactRef,
  type Confidence,
  type JsonValue,
  validateContract,
} from "./contracts.js";
import { researchSummarySchema } from "./playbooks/research.js";

type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type PiModel = NonNullable<CreateSessionOptions["model"]>;

export interface AgentInvocation {
  readonly agent: string;
  readonly stateId: string;
  readonly task: string;
  readonly projectRoot: string;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly inputArtifacts: readonly ArtifactRef[];
  readonly signal?: AbortSignal;
  readonly modelOverride?: string;
}

export interface AgentCompletion {
  readonly text: string;
  readonly confidence: Confidence;
  readonly details: Record<string, JsonValue>;
}

export interface ModelClient {
  runAgent(invocation: AgentInvocation): Promise<AgentCompletion>;
}

export interface PiAgentClientOptions {
  readonly resolveModel?: (modelId: string) => Promise<PiModel> | PiModel;
  readonly readArtifact?: (ref: ArtifactRef, consumer: string) => Promise<Buffer> | Buffer;
}

interface ParsedSummary {
  readonly confidence: Confidence;
  readonly details: Record<string, JsonValue>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

export function parseSummaryFromText(text: string): ParsedSummary {
  const marker = text.lastIndexOf("SUMMARY:");
  if (marker < 0) {
    throw new Error("agent output is missing a SUMMARY: JSON object");
  }
  const objectStart = text.indexOf("{", marker + "SUMMARY:".length);
  if (objectStart < 0) {
    throw new Error("agent SUMMARY does not contain a JSON object");
  }
  const json = balancedObject(text, objectStart);
  if (json === undefined) {
    throw new Error("agent SUMMARY JSON object is incomplete");
  }
  const parsed = objectValue(JSON.parse(json), "agent SUMMARY");
  const confidence = validateContract(
    ConfidenceSchema,
    parsed.confidence ?? "UNCERTAIN",
    "agent confidence"
  );
  const details = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "confidence")
  ) as Record<string, JsonValue>;
  return { confidence, details };
}

function assistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectValue(messages[index], "agent message");
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => objectValue(part, "assistant content part"))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("\n");
    }
  }
  throw new Error("agent session produced no assistant text");
}

const READ_TOOLS = ["artifact_read"];
const TOOLS_BY_AGENT: Readonly<Record<string, readonly string[]>> = {
  piper: [],
  carren: READ_TOOLS,
  echo: ["artifact_read", "web_search", "web_fetch", "youtube_transcript"],
  synthia: READ_TOOLS,
  vera: ["artifact_read", "web_fetch"],
  skribble: ["artifact_read", "write"],
};

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export class PiAgentClient implements ModelClient {
  constructor(private readonly options: PiAgentClientOptions = {}) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const summarySchema = researchSummarySchema(invocation.stateId);
    const ToolParameters = Type.Object(
      {
        confidence: Type.String({
          pattern: "^(CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN)$",
        }),
        details: summarySchema,
      },
      { additionalProperties: false }
    );
    let captured: ParsedSummary | undefined;
    const readArtifact = this.options.readArtifact;
    const resultTool = defineTool({
      name: "submit_orchestration_result",
      label: "Submit orchestration result",
      description:
        "Submit the typed routing result for this phase exactly once after completing the task.",
      promptSnippet: "Submit the typed result for the current orchestration phase.",
      promptGuidelines: [
        "Call submit_orchestration_result exactly once after the complete stage output is ready.",
      ],
      parameters: ToolParameters,
      async execute(_toolCallId, params) {
        if (captured !== undefined) {
          throw new Error("phase result was already submitted");
        }
        const confidence = validateContract(ConfidenceSchema, params.confidence, "tool confidence");
        const details = validateContract(
          summarySchema,
          params.details,
          `${invocation.stateId} tool result`
        ) as Record<string, JsonValue>;
        captured = { confidence, details };
        return {
          content: [
            {
              type: "text" as const,
              text: "Typed phase result accepted. Finish with the complete stage output.",
            },
          ],
          details: { accepted: true },
        };
      },
    });

    const artifactTool = defineTool({
      name: "artifact_read",
      label: "Read exact artifact",
      description:
        "Read one exact task-granted artifact. Continue from next_offset until truncated is false.",
      parameters: Type.Object(
        {
          artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const ref = invocation.inputArtifacts.find(
          (candidate) => candidate.artifact_id === params.artifact_id
        );
        if (ref === undefined) {
          throw new Error(`artifact '${params.artifact_id}' is not granted`);
        }
        if (readArtifact === undefined) {
          throw new Error("artifact reader is not configured");
        }
        const bytes = await readArtifact(ref, `agent:${invocation.agent}`);
        const offset = params.offset ?? 0;
        if (offset > bytes.length) {
          throw new Error("artifact offset exceeds byte length");
        }
        let end = Math.min(bytes.length, offset + 48_000);
        while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
          end -= 1;
        }
        const truncated = end < bytes.length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                artifact_id: ref.artifact_id,
                offset,
                next_offset: end,
                truncated,
                text: bytes.subarray(offset, end).toString("utf8"),
              }),
            },
          ],
          details: { nextOffset: end, truncated },
        };
      },
    });

    const agentGuidance = await optionalText(
      path.join(invocation.projectRoot, ".pi", "agents", `${invocation.agent}.md`)
    );
    const domainGuidance = await optionalText(
      path.join(
        invocation.projectRoot,
        ".pi",
        "skills",
        "research",
        "assets",
        "prompts",
        `${invocation.agent}.md`
      )
    );
    const allowed = [...(TOOLS_BY_AGENT[invocation.agent] ?? []), "submit_orchestration_result"];
    if (invocation.trustProfile === "hardened-untrusted") {
      const writeIndex = allowed.indexOf("write");
      if (writeIndex >= 0) {
        allowed.splice(writeIndex, 1);
      }
    }

    const sessionOptions: CreateSessionOptions = {
      cwd: invocation.projectRoot,
      sessionManager: SessionManager.inMemory(invocation.projectRoot),
      tools: allowed,
      customTools: [resultTool, ...(invocation.inputArtifacts.length > 0 ? [artifactTool] : [])],
    };
    if (invocation.modelOverride !== undefined) {
      if (this.options.resolveModel === undefined) {
        throw new Error(`model override '${invocation.modelOverride}' requires a model resolver`);
      }
      sessionOptions.model = await this.options.resolveModel(invocation.modelOverride);
    }

    const { session } = await createAgentSession(sessionOptions);
    const abort = (): void => {
      void session.abort();
    };
    invocation.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (invocation.signal?.aborted) {
        throw new Error("agent invocation aborted before prompt");
      }
      await session.prompt(
        [
          `You are executing the '${invocation.agent}' role in a durable research workflow.`,
          agentGuidance,
          domainGuidance,
          "TASK:",
          invocation.task,
          invocation.inputArtifacts.length > 0
            ? `GRANTED INPUT ARTIFACTS:\n${invocation.inputArtifacts
                .map((ref) => JSON.stringify(ref))
                .join("\n")}\nRead each with artifact_read before working.`
            : "GRANTED INPUT ARTIFACTS: none.",
          "Return the complete stage output in assistant text. Use the result tool for routing metadata.",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
        { expandPromptTemplates: false, source: "rpc" }
      );
      const text = assistantText(session.messages);
      const parsed = captured ?? parseSummaryFromText(text);
      const details = validateContract(
        summarySchema,
        parsed.details,
        `${invocation.stateId} result`
      ) as Record<string, JsonValue>;
      return { text, confidence: parsed.confidence, details };
    } finally {
      invocation.signal?.removeEventListener("abort", abort);
      session.dispose();
    }
  }
}
