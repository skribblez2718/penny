import { createHash, createHmac, randomBytes } from "crypto";
import * as path from "path";
import { canonicalArtifactJson, parseArtifactRef, type ArtifactRef } from "./artifact-client.js";

/**
 * REALM-SHARED process singletons (owner key + questionnaire transport registry).
 *
 * pi loads every extension through its OWN jiti instance with `moduleCache: false`
 * (pi-coding-agent `dist/core/extensions/loader.js::loadExtensionModule`). Importing
 * this module from two extensions therefore yields TWO module instances with
 * SEPARATE module-level state. That silently broke every P0 human gate:
 *
 *   - the skill extension registers a questionnaire transport and mints the owner
 *     key it hands to the Python orchestrator;
 *   - the questionnaire extension resolves that transport and signs the
 *     trusted_human_event with the owner key.
 *
 * With per-instance state those are different Maps AND different keys, so the gate
 * failed first as "capability is invalid or stale" and would then have failed as
 * "signature is missing or invalid" had only the Map been shared. Both values must
 * live on ONE realm-shared object, or neither fix is worth making.
 *
 * This does NOT weaken the boundary the capability indirection exists to provide.
 * That boundary is model <-> process: the model never executes JS here (it calls
 * tools and reads text), so this slot is exactly as unreachable to it as a
 * module-level const. Anything able to read it is already-trusted extension code
 * that could equally patch this module's exports. The key is still never written to
 * process.env, a file, an agent task, or a receipt.
 */
const EXECUTION_OWNER_REALM = Symbol.for("penny.skill.execution-owner");

interface ExecutionOwnerRealm {
  ownerKey: Buffer;
  transports: Map<string, TrustedQuestionnaireTransport>;
}

function executionOwnerRealm(): ExecutionOwnerRealm {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const existing = host[EXECUTION_OWNER_REALM];
  if (existing === undefined) {
    const created: ExecutionOwnerRealm = {
      ownerKey: randomBytes(32),
      transports: new Map<string, TrustedQuestionnaireTransport>(),
    };
    Object.defineProperty(host, EXECUTION_OWNER_REALM, {
      value: created,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return created;
  }
  // Fail loud rather than silently minting a SECOND owner identity, which would
  // reintroduce exactly the split-brain this exists to prevent.
  const realm = existing as Partial<ExecutionOwnerRealm>;
  if (
    !Buffer.isBuffer(realm.ownerKey) ||
    realm.ownerKey.length !== 32 ||
    !(realm.transports instanceof Map)
  ) {
    throw new Error(
      "execution-owner realm singleton is present but malformed; refusing to mint a second owner identity"
    );
  }
  return realm as ExecutionOwnerRealm;
}

/** The per-PROCESS (not per-module-instance) execution-owner capability. */
function ownerKey(): Buffer {
  return executionOwnerRealm().ownerKey;
}

/** The per-PROCESS trusted questionnaire transport registry. */
function ownerTransports(): Map<string, TrustedQuestionnaireTransport> {
  return executionOwnerRealm().transports;
}

export function withExecutionOwnerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    PENNY_RECEIPT_HMAC_KEY: ownerKey().toString("hex"),
    PENNY_APPROVAL_HMAC_KEY: ownerKey().toString("hex"),
  };
}

function ownerConfiguredSecrets(explicitSecrets: string[]): string[] {
  const secretName = /(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)/i;
  const environmentSecrets = Object.entries(process.env)
    .filter(([name, value]) => secretName.test(name) && typeof value === "string")
    .map(([, value]) => value as string);
  return Array.from(
    new Set([...explicitSecrets, ...environmentSecrets, ownerKey().toString("hex")])
  ).filter((value) => value.length >= 4);
}

export function redactReceiptOutput(output: string, configuredSecrets: string[] = []): string {
  let redacted = output;
  for (const secret of ownerConfiguredSecrets(configuredSecrets)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  redacted = redacted
    .replace(
      /(\b(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)\b\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /(--(?:secret|token|password|passwd|api-key|credential|private-key))(?:=|\s+)([^\s]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  return Array.from(redacted, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === "\n" ||
      character === "\t" ||
      (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))
      ? character
      : `\\u${code.toString(16).padStart(4, "0")}`;
  }).join("");
}

function canonicalReceiptJson(value: unknown): string {
  const sortValue = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sortValue);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sortValue(child)])
      );
    }
    return item;
  };
  return JSON.stringify(sortValue(value));
}

export interface TrustedQuestionnaireOption {
  value: string;
  label: string;
  description?: string;
}

export interface TrustedQuestionnaireQuestion {
  id: string;
  label: string;
  prompt: string;
  options: TrustedQuestionnaireOption[];
  allowOther: boolean;
  type?: "single" | "multi";
}

export interface TrustedQuestionnaireBinding {
  runId: string;
  gateId: string;
  challenge: string;
  artifactRef: Record<string, unknown>;
  transportRef: Record<string, unknown>;
  renderedQuestionsDigest: string;
}

interface TrustedQuestionnaireTransport {
  questions: TrustedQuestionnaireQuestion[];
  binding: TrustedQuestionnaireBinding;
  createdAt: number;
  consumed: boolean;
}

// NOTE: the registry itself lives on the realm singleton above (see
// ExecutionOwnerRealm). Access it ONLY via ownerTransports() — a module-level Map
// here would be per-instance and would silently break cross-extension resolution.
const TRUSTED_QUESTIONNAIRE_MAX_PENDING = 128;
const TRUSTED_QUESTIONNAIRE_MAX_AGE_MS = 30 * 60 * 1000;

export function renderedQuestionsDigest(questions: TrustedQuestionnaireQuestion[]): string {
  return createHash("sha256").update(canonicalReceiptJson(questions), "utf8").digest("hex");
}

function pruneTrustedQuestionnaireTransports(now: number): void {
  for (const [capability, transport] of ownerTransports()) {
    if (transport.consumed || now - transport.createdAt > TRUSTED_QUESTIONNAIRE_MAX_AGE_MS) {
      ownerTransports().delete(capability);
    }
  }
  while (ownerTransports().size >= TRUSTED_QUESTIONNAIRE_MAX_PENDING) {
    const oldest = ownerTransports().keys().next().value as string | undefined;
    if (!oldest) break;
    ownerTransports().delete(oldest);
  }
}

/**
 * Register owner-supplied structural gate content and return only an opaque bearer
 * capability to the model-facing questionnaire call. The caller cannot replace the
 * prompt/options because the questionnaire resolves them from this parent-process map.
 */
export function registerTrustedQuestionnaireTransport(
  questions: TrustedQuestionnaireQuestion[],
  binding: TrustedQuestionnaireBinding
): string | undefined {
  if (!questions.length) return undefined;
  const actualDigest = renderedQuestionsDigest(questions);
  if (!/^[0-9a-f]{64}$/.test(binding.renderedQuestionsDigest)) return undefined;
  if (actualDigest !== binding.renderedQuestionsDigest) return undefined;
  if (
    !binding.runId ||
    !binding.gateId ||
    !binding.challenge ||
    !binding.artifactRef ||
    !binding.transportRef
  ) {
    return undefined;
  }
  const now = Date.now();
  pruneTrustedQuestionnaireTransports(now);
  const capability = randomBytes(32).toString("base64url");
  ownerTransports().set(capability, {
    questions: structuredClone(questions),
    binding: structuredClone(binding),
    createdAt: now,
    consumed: false,
  });
  return capability;
}

export function resolveTrustedQuestionnaireTransport(
  capability: string
): Omit<TrustedQuestionnaireTransport, "createdAt" | "consumed"> | undefined {
  pruneTrustedQuestionnaireTransports(Date.now());
  const transport = ownerTransports().get(capability);
  if (!transport || transport.consumed) return undefined;
  return {
    questions: structuredClone(transport.questions),
    binding: structuredClone(transport.binding),
  };
}

export function consumeTrustedQuestionnaireTransport(
  capability: string
): Omit<TrustedQuestionnaireTransport, "createdAt" | "consumed"> | undefined {
  const transport = ownerTransports().get(capability);
  if (!transport || transport.consumed) return undefined;
  transport.consumed = true;
  ownerTransports().delete(capability);
  return {
    questions: structuredClone(transport.questions),
    binding: structuredClone(transport.binding),
  };
}

function ownerSignature(value: Record<string, unknown>): string {
  const unsigned = { ...value };
  delete unsigned.signature;
  return createHmac("sha256", ownerKey())
    .update(canonicalReceiptJson(unsigned), "utf8")
    .digest("hex");
}

interface OwnedReceiptInput {
  receiptId: string;
  runId: string;
  stateId: string;
  obligationId: string;
  argv: string[];
  projectRoot: string;
  executorIdentity: string;
  startedAt: string;
  endedAt: string;
  exitStatus: number;
  outputArtifactRef: ArtifactRef;
  output: string;
  secretValues: string[];
}

/** Encode the real canonical ref into the receipt schema's legacy string field. */
export function encodeReceiptArtifactRef(value: ArtifactRef | unknown): string {
  return canonicalArtifactJson(parseArtifactRef(value));
}

function buildOwnedReceipt(input: OwnedReceiptInput): Record<string, unknown> {
  const redactedOutput = redactReceiptOutput(input.output, input.secretValues);
  const receipt: Record<string, unknown> = {
    schema_version: 1,
    receipt_id: input.receiptId,
    run_id: input.runId,
    state_id: input.stateId,
    obligation_id: input.obligationId,
    argv: input.argv,
    working_directory: path.resolve(input.projectRoot),
    executor_identity: input.executorIdentity,
    execution_owner_identity: "skill-extension-execution-owner",
    started_at: input.startedAt,
    ended_at: input.endedAt,
    exit_status: input.exitStatus,
    output_artifact_ref: encodeReceiptArtifactRef(input.outputArtifactRef),
    output_digest: createHash("sha256").update(redactedOutput, "utf8").digest("hex"),
    output_excerpt: redactedOutput,
    integrity_state: "intact",
    redaction_state: "redacted",
    signature_algorithm: "hmac-sha256",
    signature: "",
  };
  receipt.signature = ownerSignature(receipt);
  return receipt;
}

export function buildAgentExecutionReceipt(input: {
  receiptId: string;
  runId: string;
  stateId: string;
  agent: string;
  projectRoot: string;
  startedAt: string;
  endedAt: string;
  exitStatus: number;
  outputArtifactRef: ArtifactRef;
  output: string;
  secretValues: string[];
}): Record<string, unknown> {
  return buildOwnedReceipt({
    ...input,
    obligationId: `state:${input.stateId}`,
    argv: ["pi-agent", "--agent", input.agent],
    executorIdentity: `agent:${input.agent}`,
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

interface ObservedCall {
  command: string;
  startedAt?: string;
}

interface ObservedCommand extends ObservedCall {
  callId: string;
  startedAt: string;
  endedAt: string;
  output: string;
}

function eventTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return new Date(value).toISOString();
}

function completeCommandOutput(result: Record<string, unknown>): string | undefined {
  const details = result.details as Record<string, unknown> | undefined;
  const truncation = details?.truncation as Record<string, unknown> | undefined;
  if (truncation?.truncated !== true) return contentText(result.content) || undefined;

  const capture = details?.executionOwnerCapture as Record<string, unknown> | undefined;
  const output = capture?.output;
  const outputDigest = capture?.output_digest;
  if (
    capture?.schema_version !== 1 ||
    capture.complete !== true ||
    typeof output !== "string" ||
    !output ||
    typeof outputDigest !== "string"
  ) {
    return undefined;
  }
  const actualDigest = createHash("sha256").update(output, "utf8").digest("hex");
  return actualDigest === outputDigest ? output : undefined;
}

function observedSuccessfulCommands(messages: unknown[]): ObservedCommand[] {
  const calls = new Map<string, ObservedCall>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      if (!block || typeof block !== "object") continue;
      const call = block as Record<string, unknown>;
      const args = call.arguments as Record<string, unknown> | undefined;
      if (
        call.type === "toolCall" &&
        call.name === "bash" &&
        typeof call.id === "string" &&
        typeof args?.command === "string"
      ) {
        calls.set(call.id, {
          command: args.command,
          startedAt: eventTimestamp(record.timestamp),
        });
      }
    }
  }
  const observed: ObservedCommand[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const result = message as Record<string, unknown>;
    const callId = typeof result.toolCallId === "string" ? result.toolCallId : "";
    const call = calls.get(callId);
    if (result.role !== "toolResult" || result.toolName !== "bash" || !call) continue;
    if (result.isError === true) continue;
    const output = completeCommandOutput(result);
    const endedAt = eventTimestamp(result.timestamp);
    if (!output || !call.startedAt || !endedAt || endedAt < call.startedAt) continue;
    observed.push({
      callId,
      command: call.command,
      startedAt: call.startedAt,
      endedAt,
      output,
    });
  }
  return observed;
}

export function buildObservedCommandReceipts(input: {
  messages: unknown[];
  claims: unknown;
  runId: string;
  stateId: string;
  agent: string;
  projectRoot: string;
  startedAt: string;
  endedAt: string;
  outputArtifactRef: ArtifactRef;
  secretValues: string[];
}): Record<string, unknown>[] {
  if (!Array.isArray(input.claims)) return [];
  const observed = observedSuccessfulCommands(input.messages);
  const claimedKeys = new Set<string>();
  const receipts: Record<string, unknown>[] = [];
  for (const claim of input.claims) {
    if (!claim || typeof claim !== "object") continue;
    const record = claim as Record<string, unknown>;
    const obligationId =
      typeof record.obligation_id === "string" ? record.obligation_id.trim() : "";
    const command = typeof record.command === "string" ? record.command : "";
    if (!obligationId || !command) continue;
    const match = observed.find((candidate) => candidate.command === command);
    const claimKey = `${obligationId}\u0000${command}`;
    if (!match || claimedKeys.has(claimKey)) continue;
    claimedKeys.add(claimKey);
    const identity = createHash("sha256")
      .update(`${match.callId}\u0000${obligationId}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    receipts.push(
      buildOwnedReceipt({
        receiptId: `${input.runId}:command:${identity}`,
        runId: input.runId,
        stateId: input.stateId,
        obligationId,
        argv: ["bash", "-lc", command],
        projectRoot: input.projectRoot,
        executorIdentity: `agent:${input.agent}`,
        startedAt: match.startedAt,
        endedAt: match.endedAt,
        exitStatus: 0,
        outputArtifactRef: input.outputArtifactRef,
        output: match.output,
        secretValues: input.secretValues,
      })
    );
  }
  return receipts;
}

export function signTrustedInvocation(input: {
  invocationId: string;
  runId: string;
  stateId: string;
  agentIdentity: string;
  model: string;
  startedAt: string;
  endedAt: string;
}): Record<string, unknown> {
  const invocation: Record<string, unknown> = {
    schema_version: 1,
    invocation_id: input.invocationId,
    run_id: input.runId,
    state_id: input.stateId,
    agent_identity: input.agentIdentity,
    model: input.model,
    execution_owner_identity: "skill-extension-execution-owner",
    started_at: input.startedAt,
    ended_at: input.endedAt,
    signature_algorithm: "hmac-sha256",
    signature: "",
  };
  invocation.signature = ownerSignature(invocation);
  return invocation;
}

export function signTrustedHumanEvent(input: {
  runId: string;
  gateId: string;
  challenge: string;
  artifactRef: Record<string, unknown>;
  transportRef: Record<string, unknown>;
  renderedQuestionsDigest: string;
  response: string;
}): Record<string, unknown> {
  const normalized = input.response.trim().toLowerCase();
  const decision =
    input.gateId.startsWith("risk_acceptance:") &&
    ["accept", "accept risk", "accept-risk"].includes(normalized)
      ? "accept-risk"
      : normalized === "accept" || normalized === "approve"
        ? "approve"
        : normalized === "deny"
          ? "deny"
          : "refine";
  const event: Record<string, unknown> = {
    schema_version: 2,
    origin: "trusted-human-ui",
    run_id: input.runId,
    gate_id: input.gateId,
    challenge: input.challenge,
    artifact_ref: input.artifactRef,
    questionnaire_transport_ref: input.transportRef,
    rendered_questions_digest: input.renderedQuestionsDigest,
    actor: "human:interactive-questionnaire",
    timestamp: new Date().toISOString(),
    decision,
    response: input.response,
    signature: "",
  };
  event.signature = ownerSignature(event);
  return event;
}

export function parseTrustedHumanEventMarker(text: string): Record<string, unknown> | undefined {
  const prefix = "TRUSTED_HUMAN_EVENT:";
  const marker = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix));
  if (!marker) return undefined;
  try {
    const parsed: unknown = JSON.parse(marker.slice(prefix.length));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function verifyOwnerReceiptForTest(receipt: Record<string, unknown>): boolean {
  const signature = String(receipt.signature ?? "");
  const expected = ownerSignature(receipt);
  return signature.length === 64 && signature === expected;
}
