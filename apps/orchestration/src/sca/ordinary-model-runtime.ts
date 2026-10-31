/** Normal-service composition of the ordinary SCA whole-transcript disclosure fence. */
import path from "node:path";
import { Type, type Static } from "typebox";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { validateContract, ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import type { AgentInvocation, PiAgentClientOptions } from "../model-client.js";
import { PreDispatchPolicyDeniedError } from "../provider-opening-guard.js";
import { ScaRequestV1Schema, type ScaRequestV1 } from "../skill-contracts/sca-request.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { OrdinaryScaModelGuard, type OrdinaryScaDisclosurePolicy } from "./ordinary-model-guard.js";
import { captureScaStaticSourceFile } from "./ordinary-source.js";

const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const ScaModelDisclosureConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    scope: Type.Object(
      {
        project_root: Type.String({ minLength: 1, maxLength: 4096 }),
        run_id: Type.String({ minLength: 1, maxLength: 256 }),
        source_root: ScaRequestV1Schema.properties.source_root,
        source_snapshot_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        purpose: ScaRequestV1Schema.properties.purpose,
      },
      { additionalProperties: false }
    ),
    destination: Type.String({ minLength: 1, maxLength: 4096 }),
    /** Explicit host consent includes every serialized message, source/evidence and tool output.
     * A source-only consent cannot authorize this setting. It is not an analysis request field. */
    disclose_full_transcript: Type.Literal(true),
    limits: Type.Object(
      {
        calls: Type.Optional(positive),
        callsPerSession: Type.Optional(positive),
        routingRepairSessions: Type.Optional(positive),
        inputBytesPerCall: Type.Optional(positive),
        outputTokensPerCall: Type.Optional(positive),
        totalOutputTokens: Type.Optional(positive),
        totalOutputBytes: Type.Optional(positive),
        inactivityMs: positive,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ScaModelDisclosureConfig = Static<typeof ScaModelDisclosureConfigSchema>;
/** Only the host-input boundary accepts this retired, ignored member. */
const ScaModelDisclosureHostInputSchema = Type.Object(
  {
    ...ScaModelDisclosureConfigSchema.properties,
    limits: Type.Object(
      {
        ...ScaModelDisclosureConfigSchema.properties.limits.properties,
        totalInputTokens: Type.Optional(positive),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ScaModelDisclosureHostInput = Static<typeof ScaModelDisclosureHostInputSchema>;
/** Environment files and embeddings share exactly one compatibility/normalization boundary. */
export function parseScaModelDisclosureConfig(value: unknown): ScaModelDisclosureConfig {
  const host = validateContract(ScaModelDisclosureHostInputSchema, value, "SCA disclosure config");
  const { totalInputTokens: deprecated, ...limits } = host.limits;
  void deprecated;
  return validateContract(
    ScaModelDisclosureConfigSchema,
    { ...host, limits },
    "SCA disclosure config"
  );
}
export interface ScaModelHostOptions {
  readonly config: ScaModelDisclosureHostInput;
  /** Optional narrower host policy sees FULL normalized transcript AND exact serialized payload.
   * Throwing denies; it cannot change scope, destination, model or supplied operator limits. */
  readonly admit?: OrdinaryScaDisclosurePolicy["admit"];
}
export function loadScaModelHost(env: NodeJS.ProcessEnv): ScaModelHostOptions | undefined {
  const file = env.PENNY_SCA_ORDINARY_MODEL_CONFIG;
  if (file === undefined) return undefined;
  if (!path.isAbsolute(file)) throw new Error("Ordinary SCA model host config must be absolute");
  const bytes = captureScaStaticSourceFile({
    sourceRoot: path.dirname(file),
    relativePath: path.basename(file),
    maximumBytes: 1048576,
  });
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  return {
    config: parseScaModelDisclosureConfig(value),
  };
}
function denied(reason: string): never {
  throw new PreDispatchPolicyDeniedError("opening_policy_denied", `Ordinary SCA model ${reason}`);
}

/** Always installed for the ordinary default client, including when there is no consent.
 * No policy means no cloud dispatch. Non-SCA services never receive these settings/hooks. */
export function createScaModelSessionRuntime(input: {
  readonly projectRoot: string;
  readonly host?: ScaModelHostOptions;
  readonly requestForRun: (runId: string) => ScaRequestV1 | undefined;
  readonly readArtifact?: (ref: ArtifactRef) => Uint8Array;
}): NonNullable<PiAgentClientOptions["sessionRuntime"]> {
  const config =
    input.host === undefined
      ? undefined
      : parseScaModelDisclosureConfig(JSON.parse(canonicalJson(input.host.config)));
  const scopeBytes = config === undefined ? null : canonicalJson(config.scope);
  const check = (invocation: AgentInvocation) => {
    if (config === undefined) denied("disclosure policy is not configured");
    const session = invocation.workflowSession;
    if (session === undefined || invocation.registration?.playbook_name !== "sca")
      denied("session binding missing");
    const request = input.requestForRun(session.run_id);
    if (request === undefined) denied("caller request unavailable");
    if (
      canonicalJson({
        project_root: input.projectRoot,
        run_id: session.run_id,
        source_root: request.source_root,
        source_snapshot_sha256: request.source_snapshot_sha256,
        purpose: request.purpose,
      }) !== scopeBytes ||
      invocation.projectRoot !== input.projectRoot
    )
      denied("caller/host disclosure scope mismatch");
  };
  const observedToolErrors = new WeakMap<AgentInvocation, Map<string, string>>();
  const guard =
    config === undefined
      ? undefined
      : new OrdinaryScaModelGuard({
          destination: config.destination,
          limits: config.limits,
          admit(value, invocation) {
            check(invocation); // Rechecked before every transcript and serialized HTTP request.
            input.host?.admit?.(value, invocation);
            assertTranscriptArtifacts(
              value,
              invocation,
              input.readArtifact,
              observedToolErrors.get(invocation)
            );
          },
          // Admission messages may contain input bytes; never copy them into generic errors/receipts.
          redactError: () => "host disclosure admission or provider failure",
        });
  return {
    settingsManager: SettingsManager.inMemory({
      defaultThinkingLevel: "off",
      compaction: { enabled: true },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      cacheWarming: "off",
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
    noAmbientExtensions: true,
    attach(session, invocation) {
      check(invocation);
      if (guard === undefined) denied("disclosure policy is not configured");
      const errors = new Map<string, string>();
      observedToolErrors.set(invocation, errors);
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type !== "tool_execution_end" ||
          event.toolName !== "artifact_read" ||
          !event.isError
        )
          return;
        const result: unknown = event.result;
        const text = record(result) ? singleToolText(result.content) : undefined;
        if (text !== undefined) errors.set(event.toolCallId, text);
      });
      try {
        const release = guard.attach(session, invocation);
        return () => {
          try {
            release();
          } finally {
            unsubscribe();
            observedToolErrors.delete(invocation);
          }
        };
      } catch {
        unsubscribe();
        observedToolErrors.delete(invocation);
        return denied("session identity/destination policy rejected");
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function singleToolText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const part: unknown = content[0];
  return record(part) && part.type === "text" && typeof part.text === "string"
    ? part.text
    : undefined;
}
/** Validate complete actual artifact-read envelopes, never a text/sentinel allowlist.
 * Both normalized SDK and serialized OpenAI tool-result forms are checked independently. */
function assertTranscriptArtifacts(
  value: unknown,
  invocation: AgentInvocation,
  readArtifact: ((ref: ArtifactRef) => Uint8Array) | undefined,
  observedToolErrors: ReadonlyMap<string, string> | undefined
): void {
  if (!record(value) || !Array.isArray(value.messages)) denied("transcript messages invalid");
  for (const message of value.messages) {
    if (!record(message)) denied("transcript message invalid");
    if (message.role !== "toolResult" && message.role !== "tool") continue;
    if (message.role === "toolResult" && message.toolName !== "artifact_read")
      denied("tool output outside exact artifact disclosure scope");
    const callId = message.toolCallId ?? message.tool_call_id;
    const errorText = singleToolText(message.content);
    // Only the actual tool-end event can authorize non-positive SDK/reader
    // feedback. It is never an artifact/evidence envelope or permission to act.
    if (
      typeof callId === "string" &&
      errorText !== undefined &&
      observedToolErrors?.get(callId) === errorText &&
      (message.role === "tool" || message.isError === true)
    )
      continue;
    if (message.role === "toolResult" && message.isError === true)
      denied("unobserved artifact tool error");
    const parts: unknown[] =
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content
          : [];
    if (!parts.length) denied("tool output missing");
    for (const part of parts) {
      const text =
        typeof part === "string"
          ? part
          : record(part) && part.type === "text"
            ? part.text
            : undefined;
      if (typeof text !== "string") denied("nontext tool output is not admitted");
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        denied("unobserved non-JSON artifact tool output");
      }
      if (
        !record(envelope) ||
        !record(envelope.requested_range) ||
        !record(envelope.returned_range)
      )
        denied("artifact output envelope invalid");
      const ref = validateContract(
        ArtifactRefSchema,
        envelope.artifact_ref,
        "Disclosed artifact ref"
      );
      if (
        !invocation.inputArtifacts.some((x) => canonicalJson(x) === canonicalJson(ref)) ||
        readArtifact === undefined
      )
        denied("artifact output not assigned to this worker");
      const start = envelope.requested_range.start,
        end = envelope.requested_range.end,
        returnedStart = envelope.returned_range.start,
        returnedEnd = envelope.returned_range.end;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        typeof returnedStart !== "number" ||
        typeof returnedEnd !== "number" ||
        ![start, end, returnedStart, returnedEnd].every(Number.isSafeInteger) ||
        start < 0 ||
        returnedStart !== start ||
        returnedEnd < start ||
        returnedEnd > end ||
        end > ref.byte_length
      )
        denied("artifact output range invalid");
      const bytes = Buffer.from(readArtifact(ref));
      if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
        denied("artifact bytes drift");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(start, returnedEnd)
      );
      const truncated = returnedEnd < end;
      const exact = {
        schema_version: 2,
        ok: true,
        type: "artifact_read",
        artifact_ref: ref,
        phase: ref.phase,
        kind: ref.kind,
        producer: ref.producer,
        media_type: ref.media_type,
        total_bytes: ref.byte_length,
        requested_range: { start, end },
        returned_range: { start, end: returnedEnd },
        returned_bytes: returnedEnd - start,
        content_digest: ref.content_digest,
        content,
        truncated,
        next_range: truncated ? { start: returnedEnd, end } : null,
      };
      if (canonicalJson(envelope) !== canonicalJson(exact))
        denied("artifact tool-output bytes or metadata drift");
    }
  }
}
