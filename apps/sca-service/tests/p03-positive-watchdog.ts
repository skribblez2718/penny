/** Test-only framing; arbitrary stderr and timers are NOT productive activity. */
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Type, type Static } from "typebox";
import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";

export const P03PositiveMilestoneSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.p03-positive-milestone.v1"),
    sequence: Type.Integer({ minimum: 1, maximum: 4096 }),
    stage: Type.Union([
      Type.Literal("preimages_validated"),
      Type.Literal("current_p02_binding"),
      Type.Literal("qualification_validated"),
      Type.Literal("activation_resolved"),
      Type.Literal("predecessor_replayed"),
      Type.Literal("protected_deployment_validated"),
      Type.Literal("gate_awaiting_user"),
      Type.Literal("signed_approval_validated"),
      Type.Literal("command_completed"),
      Type.Literal("terminal_consumed"),
      Type.Literal("terminated_cleanup_observed"),
    ]),
    command: Type.Union([Type.Integer({ minimum: 1, maximum: 2048 }), Type.Null()]),
    output_sha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
    byte_length: Type.Union([Type.Integer({ minimum: 0, maximum: 1_048_576 }), Type.Null()]),
  },
  { additionalProperties: false }
);
export type P03PositiveMilestone = Static<typeof P03PositiveMilestoneSchema>;
export const P03_POSITIVE_MILESTONE_PREFIX = "p03-positive-milestone ";
// Cumulative raw bytes per stream: retain the original 8 MiB stdout ceiling for both pipes.
export const P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES = 8 * 1_048_576;
// Cold source loading/fixture construction precedes the first protected validation. This is
// NOT the native operation's 60s inactivity policy. Retain the harness's original finite
// 30s cold-start allowance: measured preflight did not need an expansion. Once validation
// completes, renew only from framed milestones. Native scenario tests omit a competing
// wall deadline; output/milestone limits, cancellation and bounded termination still apply.
export const P03_POSITIVE_WATCHDOG = {
  cold_start_ms: 30_000,
  inactivity_ms: 30_000,
  termination_grace_ms: 5000,
};

export function collectP03PositiveFixture(
  child: ChildProcess,
  budgets = P03_POSITIVE_WATCHDOG,
  onMilestone: (milestone: P03PositiveMilestone) => void = () => {},
  signal?: AbortSignal,
  maxStreamBytes = P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES
): Promise<Buffer> {
  for (const value of [...Object.values(budgets), maxStreamBytes])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_fixture_budget");
  // Test overrides may tighten, never relax, the shared per-stream policy.
  if (maxStreamBytes > P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES)
    throw new Error("invalid_fixture_budget");
  if (child.stdout === null || child.stderr === null) throw new Error("fixture_pipes_required");
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const chunks: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      stderr = "",
      pending = "",
      sequence = 0,
      command = 0;
    let stage = "cold_start",
      reason: string | null = null,
      cleanupObserved = false;
    const completed = new Set<string>();
    let timer: ReturnType<typeof setTimeout>;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forcedKill = false;
    let outputLimitReached = false;
    const stop = (why: string) => {
      if (reason !== null) return;
      reason = why;
      clearTimeout(timer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        forcedKill = true;
        child.kill("SIGKILL");
      }, budgets.termination_grace_ms);
    };
    const arm = (interval: number) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => stop(stage === "cold_start" ? "cold_start_expired" : "milestone_inactivity_expired"),
        interval
      );
    };
    const abort = () => stop("harness_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    arm(budgets.cold_start_ms);
    if (signal?.aborted) abort();
    // After either limit, keep draining the pipes without retaining/decoding payload.
    // SIGTERM/SIGKILL cleanup still uses the existing finite termination grace.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputLimitReached) return;
      if (chunk.byteLength > maxStreamBytes - stdoutBytes) {
        outputLimitReached = true;
        pending = "";
        stop("stdout_limit");
        return;
      }
      stdoutBytes += chunk.byteLength;
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (outputLimitReached) return;
      if (chunk.byteLength > maxStreamBytes - stderrBytes) {
        outputLimitReached = true;
        pending = "";
        stop("stderr_limit");
        return;
      }
      stderrBytes += chunk.byteLength;
      const text = chunk.toString("utf8");
      stderr = (stderr + text).slice(-16_384);
      pending += text;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end === -1) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.length > 32_768) {
          stop("stderr_frame_limit");
          return;
        }
        if (!line.startsWith(P03_POSITIVE_MILESTONE_PREFIX)) continue;
        try {
          const text = line.slice(P03_POSITIVE_MILESTONE_PREFIX.length);
          const value: unknown = JSON.parse(text);
          const milestone = validateContract(
            P03PositiveMilestoneSchema,
            value,
            "completed fixture milestone"
          );
          if (canonicalJson(milestone) !== text || milestone.sequence !== sequence + 1)
            throw new Error("noncanonical_or_replayed_milestone");
          if (milestone.stage === "command_completed") {
            if (
              milestone.command !== command + 1 ||
              milestone.output_sha256 === null ||
              milestone.byte_length === null
            )
              throw new Error("incomplete_command_milestone");
            command = milestone.command;
          } else {
            if (
              completed.has(milestone.stage) ||
              milestone.command !== null ||
              milestone.output_sha256 !== null ||
              milestone.byte_length !== null
            )
              throw new Error("repeated_or_invalid_stage");
            completed.add(milestone.stage);
          }
          sequence = milestone.sequence;
          stage = milestone.stage;
          cleanupObserved ||= stage === "terminated_cleanup_observed";
          onMilestone(milestone);
          if (reason === null) arm(budgets.inactivity_ms);
        } catch {
          stop("invalid_milestone");
        }
      }
      if (pending.length > 32_768) stop("stderr_frame_limit");
    });
    child.once("error", () => stop("spawn_error"));
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (killTimer !== undefined) clearTimeout(killTimer);
      const diagnostic = `code=${String(code)} signal=${String(terminationSignal)} elapsed_ms=${Math.round(performance.now() - start)} stage=${stage} watchdog=${reason ?? "none"} termination_grace=${forcedKill ? "expired" : "settled"} after_kill_cleanup=${reason === null ? "not_needed" : cleanupObserved ? "observed" : "unproven"}`;
      process.stderr.write(`native-fixture-terminal ${diagnostic}\n`);
      if (reason !== null || code !== 0)
        reject(new Error(`native fixture failed ${diagnostic}: ${stderr}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}
