/** Synthetic-only live cohort resources. Config/tool paths remain host-private and caller-bound. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../dist/contracts.js";
import type { AgentInvocation } from "../dist/model-client.js";
import { ScaAnalysisToolsSchema } from "../dist/sca/ordinary-contracts.js";
import type { ArtifactHostStore } from "../dist/artifact-store.js";
import { exactBytes } from "../dist/sca/ordinary-artifacts.js";
import { SCA_AGENT_BY_STATE } from "../dist/playbooks/sca.js";
import { ScaSemanticDiagnosticSchema } from "../dist/sca/ordinary-semantic.js";
import {
  createTextToolResult,
  fitUtf8ToolResult,
  type ToolResultBudget,
} from "../../../.pi/extensions/lib/tool-result-budget.js";
import type { OrdinaryScaModelLimits } from "../dist/sca/ordinary-model-guard.js";

/** Explicit synthetic test-cohort policy only; never an ordinary runtime default. */
export const SCA_ROUTING_REPAIR_SESSION_LIMIT = 4;
/** Per-request reallocation only: the cohort's aggregate consent is unchanged. */
export const SCA_LIVE_LIMITS = Object.freeze({
  calls: 96,
  callsPerSession: 24,
  routingRepairSessions: SCA_ROUTING_REPAIR_SESSION_LIMIT,
  inputBytesPerCall: 512_000,
  outputTokensPerCall: 6_144,
  totalOutputTokens: 589_824,
  totalOutputBytes: 2_359_296,
  inactivityMs: 90_000,
} satisfies OrdinaryScaModelLimits);
/** Explicit expected-strategy allowance for tool calls, assistant reasoning and SDK framing.
 * It is NOT a license to truncate evidence; the actual serialized guard still checks every byte. */
export const SCA_REVIEW_TRANSCRIPT_RESERVE_BYTES = 65_536;
export interface ScaLiveReviewClosure {
  readonly openingBytes: number;
  readonly artifactBytes: number;
  readonly toolMessagesBytes: number;
  readonly continuationReads: number;
  readonly batchedCalls: number;
  readonly batchedInputTokenUpperBound: number;
  readonly transcriptReserveBytes: number;
  readonly completeRequestBytes: number;
}
/** Complete read-once closure using the real reader's envelope fitter and UTF-8 boundaries.
 * All assigned inputs are included, even identical bodies under different identities.
 * This is measurement only: it neither substitutes a reader nor edits the real transcript. */
export function measureLiveReviewClosure(input: {
  readonly openingBytes: number;
  readonly refs: readonly ArtifactRef[];
  readonly read: (ref: ArtifactRef) => Uint8Array;
  readonly toolBudget: ToolResultBudget;
}): ScaLiveReviewClosure {
  let artifactBytes = 0,
    toolMessagesBytes = 0,
    continuationReads = 0;
  const roundBytes: number[] = [];
  for (const ref of input.refs) {
    const bytes = Buffer.from(input.read(ref));
    if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
      throw new Error("Review closure artifact bytes drift");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    artifactBytes += bytes.length;
    let start = 0,
      round = 0;
    do {
      const fitted = fitUtf8ToolResult({
        source: bytes,
        start,
        end: bytes.length,
        budget: input.toolBudget,
        build: (end, content, truncated) =>
          createTextToolResult({
            schema_version: 2,
            ok: true,
            type: "artifact_read",
            artifact_ref: ref,
            phase: ref.phase,
            kind: ref.kind,
            producer: ref.producer,
            media_type: ref.media_type,
            total_bytes: ref.byte_length,
            requested_range: { start, end: bytes.length },
            returned_range: { start, end },
            returned_bytes: end - start,
            content_digest: ref.content_digest,
            content,
            truncated,
            next_range: truncated ? { start: end, end: bytes.length } : null,
          }),
      });
      const text = fitted.result.content[0]?.text;
      if (text === undefined) throw new Error("Review closure lacks exact tool text");
      // Includes both JSON escaping layers: artifact envelope, then provider content string.
      const messageBytes =
        Buffer.byteLength(
          JSON.stringify({
            role: "tool",
            tool_call_id: `review-read-${continuationReads}`,
            content: text,
          })
        ) + 1;
      toolMessagesBytes += messageBytes;
      roundBytes[round] = (roundBytes[round] ?? 0) + messageBytes;
      round += 1;
      continuationReads += 1;
      start = fitted.end;
    } while (start < bytes.length);
  }
  // One opening turn plus one model turn after each batched continuation round.
  // Count all earlier bytes again on EVERY request, including the entire reserve.
  let prefixBytes = 0;
  let batchedInputTokenUpperBound = input.openingBytes + SCA_REVIEW_TRANSCRIPT_RESERVE_BYTES + 4096;
  for (const bytes of roundBytes) {
    prefixBytes += bytes;
    batchedInputTokenUpperBound +=
      input.openingBytes + prefixBytes + SCA_REVIEW_TRANSCRIPT_RESERVE_BYTES + 4096;
  }
  return {
    openingBytes: input.openingBytes,
    artifactBytes,
    toolMessagesBytes,
    continuationReads,
    batchedCalls: roundBytes.length + 1,
    batchedInputTokenUpperBound,
    transcriptReserveBytes: SCA_REVIEW_TRANSCRIPT_RESERVE_BYTES,
    completeRequestBytes:
      input.openingBytes + toolMessagesBytes + SCA_REVIEW_TRANSCRIPT_RESERVE_BYTES,
  };
}
export function assertLiveReviewClosureFits(closure: ScaLiveReviewClosure): void {
  if (closure.batchedCalls > SCA_LIVE_LIMITS.callsPerSession)
    throw new Error("Disclosure denied: complete review closure exceeds session call cap");
  if (closure.completeRequestBytes > SCA_LIVE_LIMITS.inputBytesPerCall)
    throw new Error("Disclosure denied: complete review closure exceeds per-request cap");
}

export const LiveConfigSchema = Type.Object(
  {
    destination: Type.String({ minLength: 1 }),
    analysis_tools: ScaAnalysisToolsSchema,
    preparation_cache: Type.Optional(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
export type LiveConfig = Static<typeof LiveConfigSchema>;
export const SYNTHETIC_SOURCES: Readonly<Record<string, string>> = {
  "flow.php":
    '<?php\nfunction sink($value) { return $value; }\nfunction vulnerable($input) {\n  if ($input !== "") {\n    $copy = $input;\n    return sink($copy);\n  }\n}\nfunction fixed($input) { return sink("constant"); }\n',
  "flow.js":
    'function sink(value) { return value; }\nfunction vulnerable(input) {\n  if (input !== "") {\n    const copy = input;\n    return sink(copy);\n  }\n}\nfunction fixed(input) { return sink("constant"); }\n',
  "typed.ts":
    'function sink(value: string): string { return value; }\nfunction vulnerable(input: string): string {\n  if (input !== "") {\n    const copy: string = input;\n    return sink(copy);\n  }\n  return "";\n}\nfunction fixed(input: string): string { return sink("constant"); }\n',
};
export function atomicBytes(file: string, content: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.next`;
  writeFileSync(staged, content, { mode: 0o600 });
  renameSync(staged, file);
}
export function atomicJson(file: string, value: unknown): void {
  const content = canonicalJson(value);
  JSON.parse(content);
  atomicBytes(file, content);
}
export function fixtureProject(root: string, repository: string) {
  const project = path.join(root, "project");
  const source = path.join(root, "source");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const copyPublic = (relative: string) => {
    const bytes = readFileSync(path.join(repository, relative));
    const target = path.join(project, relative);
    atomicBytes(target, bytes);
  };
  for (const [name, content] of Object.entries(SYNTHETIC_SOURCES)) {
    const target = path.join(source, name);
    if (existsSync(target) && readFileSync(target, "utf8") !== content)
      throw new Error("Synthetic fixture source drift; preserving evidence");
    atomicBytes(target, content);
  }
  copyPublic(".pi/SYSTEM.md");
  // Generic ingress discovers public manifests, not another project's catalog.
  for (const entry of readdirSync(path.join(repository, ".pi/skills"), { withFileTypes: true }))
    if (
      entry.isDirectory() &&
      existsSync(path.join(repository, ".pi/skills", entry.name, "SKILL.md"))
    )
      copyPublic(`.pi/skills/${entry.name}/SKILL.md`);
  // Registry validation binds ordinary peer YAML maxima even though no child may run.
  for (const name of readdirSync(path.join(repository, ".pi", "agents")).filter((name) =>
    name.endsWith(".md")
  ))
    copyPublic(`.pi/agents/${name}`);
  // The generic engine also binds Define's public provenance catalog at start admission.
  const definePrompts = ".pi/skills/define/assets/prompts";
  for (const name of readdirSync(path.join(repository, definePrompts)).filter((name) =>
    name.endsWith(".md")
  ))
    copyPublic(`${definePrompts}/${name}`);
  for (const [state, agent] of Object.entries(SCA_AGENT_BY_STATE))
    copyPublic(`.pi/skills/sca/assets/prompts/${agent}-${state}.md`);
  for (const name of ["standard", "review"]) copyPublic(`docs/agents/writing/${name}.md`);
  atomicBytes(
    path.join(project, "AGENTS.md"),
    "# Synthetic SCA fixture\nOnly the exact supplied artifacts and registered public guidance are available. Do not inspect host paths. This disposable project contains no private data.\n"
  );
  mkdirSync(path.join(project, "package"), { recursive: true });
  const hashes = Object.entries(SYNTHETIC_SOURCES).map(([name, content]) => ({
    path: name,
    byte_length: Buffer.byteLength(content),
    sha256: sha256(content),
  }));
  atomicJson(path.join(root, "source-hashes.json"), hashes);
  return { project, source, hashes };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const MODEL_ARTIFACT_KINDS = new Set([
  "sca-preparation-result",
  "sca-focused-sources",
  "sca-reconciliation",
  "sca-evidence-result",
  "sca-validated-evidence",
  "sca-advanced-catalog",
  "sca-advanced-summary",
  "semantic-core",
  "sca-report-markdown",
  "sca-report-sarif",
  "sca-report-validation",
  "sca-report-feedback",
  "agent-output",
  "sca-semantic-diagnostic",
  ...Object.keys(SCA_AGENT_BY_STATE).map((state) => `sca-${state.replaceAll("_", "-")}`),
]);
export interface ScaLiveReadReceipt {
  readonly state: string;
  readonly worker_id: string | null;
  readonly artifact: string;
  readonly digest: string;
  readonly start: number;
  readonly end: number;
}
/** Exact byte coverage by this worker, not another stage or an earlier draft. */
export function hasCompleteArtifactRead(
  reads: readonly ScaLiveReadReceipt[],
  invocation: AgentInvocation,
  ref: ArtifactRef
): boolean {
  const worker = invocation.workflowSession?.worker_id ?? null;
  const ranges = reads
    .filter(
      (read) =>
        read.state === invocation.stateId &&
        read.worker_id === worker &&
        read.artifact === ref.artifact_id &&
        read.digest === ref.content_digest
    )
    .sort((a, b) => a.start - b.start);
  let end = 0;
  for (const range of ranges) {
    if (range.start > end || range.end > ref.byte_length) return false;
    end = Math.max(end, range.end);
  }
  return end === ref.byte_length;
}
export function syntheticDisclosure(input: {
  root: string;
  repository: string;
  store: ArtifactHostStore;
}) {
  const reads: ScaLiveReadReceipt[] = [];
  // Admission rechecks the entire transcript twice per turn. Those are not new reads.
  const readKeys = new Set<string>();
  const observedToolErrors = new Set<string>();
  const errorKey = (invocation: AgentInvocation, callId: string, text: string) =>
    canonicalJson([
      invocation.workflowSession?.worker_id ?? null,
      invocation.stateId,
      callId,
      sha256(text),
    ]);
  const scanString = (text: string) => {
    // Synthetic temp paths are explicitly admitted; every other host path is withheld.
    const withoutFixture = text.split(input.root).join("<synthetic-fixture>");
    for (const forbidden of [input.repository, homedir(), "/home/", "/Users/", "/root/"]) {
      if (withoutFixture.includes(forbidden))
        throw new Error("Disclosure denied: non-fixture host path");
    }
    // A public instruction naming the staging root `/tmp/` is not an operator filename.
    if (/\/(?:tmp|var\/tmp)\/[^\s`"'<>]+/u.test(withoutFixture))
      throw new Error("Disclosure denied: non-fixture temporary file path");
  };
  const visit = (value: unknown, invocation: AgentInvocation): void => {
    if (typeof value === "string") {
      scanString(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, invocation);
      return;
    }
    if (!isRecord(value)) return;
    if (value.role === "toolResult" || value.role === "tool") {
      const content = value.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((part: unknown) =>
                  isRecord(part) && part.type === "text" && typeof part.text === "string"
                    ? part.text
                    : ""
                )
                .join("")
            : "";
      const callId = value.toolCallId ?? value.tool_call_id;
      // Non-positive feedback is admitted only when the actual SDK tool-end
      // event bound these exact bytes to this worker and this tool call.
      if (
        typeof callId === "string" &&
        observedToolErrors.has(errorKey(invocation, callId, text))
      ) {
        scanString(text);
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new Error("Disclosure denied: unobserved/non-JSON artifact result");
      }
      if (
        !isRecord(envelope) ||
        envelope.ok !== true ||
        !isRecord(envelope.artifact_ref) ||
        typeof envelope.content !== "string" ||
        !isRecord(envelope.returned_range)
      )
        throw new Error("Disclosure denied: non-exact artifact result");
      const ref = invocation.inputArtifacts.find(
        (entry) =>
          entry.artifact_id ===
          (isRecord(envelope.artifact_ref) ? envelope.artifact_ref.artifact_id : undefined)
      );
      if (
        ref === undefined ||
        canonicalJson(envelope.artifact_ref) !== canonicalJson(ref) ||
        !MODEL_ARTIFACT_KINDS.has(ref.kind) ||
        (ref.kind === "agent-output" &&
          invocation.executionPurpose !== "routing_repair" &&
          !isExactSemanticRejection(input.store, invocation, ref.artifact_id))
      )
        throw new Error("Disclosure denied: non-admitted artifact kind/identity");
      const bytes = exactBytes(input.store, ref);
      // This cohort deliberately grants no application execution, rule promotion,
      // or rescan authority. New advanced host summaries are admitted only empty.
      if (ref.kind === "sca-advanced-catalog")
        validateContract(
          Type.Object(
            {
              schema_version: Type.Literal(1),
              application_tests: Type.Array(Type.Unknown(), { maxItems: 0 }),
              learning: Type.Array(Type.Unknown(), { maxItems: 0 }),
            },
            { additionalProperties: false }
          ),
          JSON.parse(bytes.toString("utf8")),
          "Synthetic static-only advanced catalog"
        );
      if (ref.kind === "sca-advanced-summary")
        validateContract(
          Type.Object(
            {
              schema_version: Type.Literal(1),
              operations: Type.Array(Type.Unknown(), { maxItems: 0 }),
            },
            { additionalProperties: false }
          ),
          JSON.parse(bytes.toString("utf8")),
          "Synthetic static-only advanced summary"
        );
      const { start, end } = envelope.returned_range;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end > bytes.length ||
        end < start ||
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end)) !==
          envelope.content ||
        envelope.content_digest !== ref.content_digest
      )
        throw new Error("Disclosure denied: artifact result byte/digest mismatch");
      const receipt: ScaLiveReadReceipt = {
        state: invocation.stateId,
        worker_id: invocation.workflowSession?.worker_id ?? null,
        artifact: ref.artifact_id,
        digest: ref.content_digest,
        start,
        end,
      };
      const key = canonicalJson(receipt);
      if (!readKeys.has(key)) {
        readKeys.add(key);
        reads.push(receipt);
      }
    }
    for (const entry of Object.values(value)) visit(entry, invocation);
  };
  return {
    reads,
    observeToolError(callId: string, result: unknown, invocation: AgentInvocation): void {
      if (!isRecord(result) || !Array.isArray(result.content)) return;
      if (
        !result.content.every(
          (part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string"
        )
      )
        return;
      const text = result.content
        .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
      try {
        scanString(text);
      } catch {
        return; // never register a host-path-bearing diagnostic for disclosure
      }
      observedToolErrors.add(errorKey(invocation, callId, text));
    },
    admit: visit,
    redactError: (text: string) =>
      text.split(input.repository).join("<repository>").split(homedir()).join("<home>"),
  };
}
function isExactSemanticRejection(
  store: ArtifactHostStore,
  invocation: AgentInvocation,
  artifactId: string
): boolean {
  const ref = invocation.inputArtifacts.find((x) => x.kind === "sca-semantic-diagnostic");
  if (ref === undefined) return false;
  const diagnostic = validateContract(
    ScaSemanticDiagnosticSchema,
    JSON.parse(exactBytes(store, ref).toString("utf8")),
    "Live semantic revision disclosure"
  );
  return (
    diagnostic.state === invocation.stateId &&
    diagnostic.rejected_artifact.artifact_id === artifactId &&
    diagnostic.rejected_artifact.phase === invocation.stateId &&
    diagnostic.rejected_artifact.producer === `agent:${invocation.agent}` &&
    canonicalJson(invocation.inputArtifacts) ===
      canonicalJson([...diagnostic.original_input_refs, diagnostic.rejected_artifact, ref])
  );
}
export function verifyLiveAnalysisInputs(tools: LiveConfig["analysis_tools"]) {
  const bindings: { path: string; sha256: string }[] = [];
  const pin = (file: string, digest: string) => {
    if (!path.isAbsolute(file) || sha256(readFileSync(file)) !== digest)
      throw new Error("Live native preparation tool/rule/query bytes drifted");
    bindings.push({ path: file, sha256: digest });
  };
  for (const scanner of [tools.semgrep, tools.gitleaks]) {
    if (scanner === undefined) continue;
    pin(scanner.tool.executable, scanner.tool.sha256);
    pin(scanner.rules_path, scanner.rules_sha256);
  }
  if (tools.graph !== undefined) {
    for (const tool of [tools.graph.joern, tools.graph.php_frontend, tools.graph.js_frontend])
      if (tool !== undefined) pin(tool.executable, tool.sha256);
    for (const query of tools.graph.queries) pin(query.script_path, query.sha256);
  }
  if (tools.advisory_results !== undefined)
    pin(tools.advisory_results.path, tools.advisory_results.sha256);
  return bindings;
}
export function readLiveConfig(file: string): LiveConfig {
  const input: unknown = JSON.parse(readFileSync(file, "utf8"));
  return validateContract(LiveConfigSchema, input, "Ordinary DeepSeek live config");
}
