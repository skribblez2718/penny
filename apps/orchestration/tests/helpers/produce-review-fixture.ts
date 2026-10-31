// Semantic V2 cognition only. The host binds judgment to real owner-selected operands.
// Raw text is deliberately not upgraded: malformed/absent-core controls stay malformed.
import { Type } from "typebox";
import {
  canonicalJson,
  validateContract,
  JsonValueSchema,
  type AgentInvocation,
  type JsonValue,
} from "../../dist/index.js";

const PREFIX = "FIXTURE_PRODUCE_REVIEW:";
export function produceReviewFixture(summary: Record<string, JsonValue>): string {
  return PREFIX + JSON.stringify(summary);
}
export function produceFixtureRoutingOnly(text: string): string {
  if (!text.startsWith(PREFIX)) throw new Error("expected explicit review fixture");
  return "SUMMARY:" + text.slice(PREFIX.length);
}
export function bindProduceReviewFixture(invocation: AgentInvocation, text: string): string {
  if (!text.startsWith(PREFIX)) return text;
  if (invocation.executionPurpose === "routing_repair") return produceFixtureRoutingOnly(text);
  const summary = validateContract(
    Type.Record(Type.String(), JsonValueSchema),
    JSON.parse(text.slice(PREFIX.length)),
    "scripted review"
  );
  const { confidence, ...review } = summary;
  const runId = invocation.workflowSession?.run_id;
  if (runId === undefined) throw new Error("native review invocation correlation is absent");
  const core = {
    schema_version: 2,
    review_kind: invocation.stateId === "verifying_artifact" ? "validity" : "quality",
    confidence,
    review,
  };
  return `PRODUCE_REVIEW:${canonicalJson(core)}\nSUMMARY:${JSON.stringify(summary)}`;
}
