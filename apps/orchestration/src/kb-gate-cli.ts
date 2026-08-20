#!/usr/bin/env node
/**
 * penny-kb-gate — HOST-ONLY surface for KB capabilities and the
 * content-review gate.
 *
 * The model-facing `knowledge_base` tool CANNOT approve or deny; decisions
 * reach the KB only through this host binary (the §5.1 "authenticated
 * callback" in the single-host trust domain: owner-only state under the KB
 * root, digests re-verified on every decision).
 *
 * Commands:
 *   capability-mint    Mint a source_read capability envelope (operator action)
 *   capability-list    List capability leases for a profile
 *   gate-list          List content-review gates for a profile (safe projection)
 *   approve            Approve a pending gate (host decision; publishes)
 *   deny               Deny a pending gate (host decision; publishes nothing)
 *   refine             Request a refinement round (host decision; re-enters compose, re-gates)
 *   parent-grant-mint  Mint a single-use derived-answer grant (§5.1; operator action)
 *   parent-grant-list  List parent-delivery grants (safe projection; no bodies)
 *
 * Conventions:
 *   --project-root  Defaults to cwd. KB root = <project-root>/.penny/kb/<profile>.
 *   Grant store     <project-root>/.penny/kb-parent-grants/ (host state, not the KB).
 *   No command prints any source or page body to stdout.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { Checkpointer } from "./checkpointer.js";
import { OrchestrationEngine } from "./engine.js";
import { loadRuntimeConfig } from "./config.js";
import type { Directive, JsonValue } from "./contracts.js";
import { envelopeDigest, CapabilityStore } from "./kb/capabilities.js";
import {
  ParentDeliveryGrantStore,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "./kb/parent-delivery.js";
import {
  approveGate,
  denyGate,
  findGateForRun,
  listGates,
  latestPendingGate,
  mintSourceCapability,
  sourcesFromCapabilities,
} from "./kb/gate.js";

interface Args {
  projectRoot: string;
  profile: string;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): Args {
  const multi = new Set(["author"]);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) throw new Error("unexpected end of argv");
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    if (multi.has(key)) {
      const list = (out[key] as string[] | undefined) ?? [];
      out[key] = [...list, next];
    } else {
      out[key] = next;
    }
    i += 1;
  }
  const args = out as Args;
  args.projectRoot = String(out["project-root"] ?? process.cwd());
  args.profile = String(out["profile"] ?? "");
  return args;
}

function kbRootFor(args: Args): string {
  if (args.profile.length === 0) throw new Error("--profile is required");
  return path.join(path.resolve(args.projectRoot), ".penny", "kb", args.profile);
}

function fail(message: string): never {
  process.stderr.write(`kb-gate: ${message}\n`);
  process.exit(1);
}

// ── capability-mint ─────────────────────────────────────────────────────────

function grantStoreDir(args: Args): string {
  return path.join(path.resolve(args.projectRoot), ".penny", "kb-parent-grants");
}

function cmdParentGrantMint(args: Args): void {
  const sessionId = String(args["session"] ?? "");
  const invocationId = String(args["invocation"] ?? "");
  const requestJson = String(args["request"] ?? "");
  if (sessionId.length === 0 || invocationId.length === 0 || requestJson.length === 0) {
    fail("parent-grant-mint requires --session, --invocation, and --request '<json>'");
  }
  let rawRequest: unknown;
  try {
    rawRequest = JSON.parse(requestJson);
  } catch {
    fail("--request must be a JSON object (the exact QueryKbRequestV1 to run)");
    return;
  }
  const request = validateQueryRequest(rawRequest);
  if (request.kb_profile_id !== args.profile) {
    fail(
      `--profile is ${args.profile} but the request names ${request.kb_profile_id}; they must match`
    );
  }
  if (request.answer_delivery !== undefined && request.answer_delivery !== "parent_tool_result") {
    fail("a grant request must use answer_delivery: parent_tool_result (or omit it)");
  }
  const maxBytes = Number(args["max-bytes"] ?? 16384);
  const ttlMinutes = Number(args["ttl-minutes"] ?? 15);
  if (
    !Number.isFinite(maxBytes) ||
    !Number.isFinite(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > 10080
  ) {
    fail("--max-bytes must be a positive integer (≤ 32768) and --ttl-minutes 1–10080");
  }
  const now = new Date();
  const grant = mintParentDeliveryGrant({
    session_id: sessionId,
    invocation_id: invocationId,
    request,
    max_utf8_bytes: Math.max(1, Math.min(32768, Math.trunc(maxBytes))),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
  });
  const store = new ParentDeliveryGrantStore(grantStoreDir(args));
  store.mint(grant);
  process.stdout.write(
    JSON.stringify(
      {
        schema_version: 1,
        grant_id: grant.grant_id,
        kb_profile_id: grant.kb_profile_id,
        request_sha256: grant.request_sha256,
        max_utf8_bytes: grant.max_utf8_bytes,
        issued_at: grant.issued_at,
        expires_at: grant.expires_at,
        note: "single-use; consumed atomically by the matching approved run. See parent-grant-list.",
      },
      null,
      2
    ) + "\n"
  );
}

function cmdParentGrantList(args: Args): void {
  const store = new ParentDeliveryGrantStore(grantStoreDir(args));
  const { grants, skipped_malformed } = store.list();
  process.stdout.write(
    JSON.stringify({ schema_version: 1, grants, skipped_malformed }, null, 2) + "\n"
  );
}

function cmdCapabilityMint(args: Args): void {
  const kbRoot = kbRootFor(args);
  const filePath = String(args["path"] ?? "");
  const title = String(args["title"] ?? "");
  const authors = (args["author"] as string[] | undefined) ?? [];
  if (filePath.length === 0 || title.length === 0 || authors.length === 0) {
    fail("capability-mint requires --path, --title, and at least one --author");
  }
  const absolute = path.resolve(args.projectRoot, filePath);

  const envelope = mintSourceCapability({
    kbRoot,
    kbProfileId: args.profile,
    absolutePath: absolute,
    title,
    authors,
    ...(args["source-type"] !== undefined
      ? {
          sourceType: String(args["source-type"]) as
            | "file"
            | "url_snapshot"
            | "research_artifact"
            | "manual",
        }
      : {}),
    ...(args["media-type"] !== undefined
      ? {
          mediaType: String(args["media-type"]) as
            | "text/plain"
            | "text/markdown"
            | "application/json",
        }
      : {}),
    ...(args["session-id"] !== undefined ? { sessionId: String(args["session-id"]) } : {}),
    ...(args["captured-at"] !== undefined ? { capturedAt: String(args["captured-at"]) } : {}),
    ...(args["expires-hours"] !== undefined ? { expiresHours: Number(args["expires-hours"]) } : {}),
  });

  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      capability_id: envelope.capability_id,
      source_id: envelope.capability_id,
      envelope_sha256: envelopeDigest(envelope),
      expected_sha256: envelope.expected_sha256,
      expires_at: envelope.expires_at,
      note: "capability registered; reference it in knowledge_base ingest (source_capability_ids)",
    }) + "\n"
  );
}

// ── listings (safe projections; no bodies) ──────────────────────────────────

function cmdCapabilityList(args: Args): void {
  const kbRoot = kbRootFor(args);
  const store = new CapabilityStore(kbRoot);
  try {
    const dir = path.join(kbRoot, "capabilities");
    const ids = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
      : [];
    const out = ids.map((id) => ({
      capability_id: id,
      lease: store.lease(id) ?? null,
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } finally {
    store.close();
  }
}

function cmdGateList(args: Args): void {
  const kbRoot = kbRootFor(args);
  const gates = listGates(kbRoot);
  process.stdout.write(
    JSON.stringify(
      gates.map((g) => ({
        gate_id: g.gate_id,
        run_id: g.run_id,
        status: g.status,
        issued_at: g.issued_at,
        expires_at: g.expires_at,
        source_ids: g.source_ids,
        artifact_kinds: g.artifacts.map((a) => a.artifact_kind),
        terminal_reason: g.terminal_reason ?? null,
        published_generation_id: g.published_generation_id ?? null,
      })),
      null,
      2
    ) + "\n"
  );
}

// ── operator decisions ──────────────────────────────────────────────────────

function resolveGate(args: Args) {
  const kbRoot = kbRootFor(args);
  const runId = args["run"] !== undefined ? String(args["run"]) : undefined;
  const gate = (runId !== undefined && findGateForRun(kbRoot, runId)) || latestPendingGate(kbRoot);
  if (gate === undefined) throw new Error("no pending content-review gate");
  return { kbRoot, gate };
}

function cmdApprove(args: Args): void {
  const { kbRoot, gate } = resolveGate(args);
  if (gate.source_capability_ids.length === 0) {
    throw new Error("gate is not bound to source capabilities; refusing blind approval");
  }
  // Engine-driven run: the canonical path terminates the run behind the publish
  // (the gate decision is the run's gate response, and the run's state machine
  // performs the publication behind it — one consistent outcome).
  const engineTerminal = decisionViaEngine(args.projectRoot, gate.run_id, "approve");
  if (engineTerminal !== undefined) {
    process.stdout.write(
      JSON.stringify(terminalProjection(engineTerminal, { run_id: gate.run_id }), null, 2) + "\n"
    );
    return;
  }
  // Legacy gate (no engine run owns it, e.g. pre-refactor): publish directly.
  const sources = sourcesFromCapabilities(kbRoot, gate.source_capability_ids);
  const { gate: updatedGate, result } = approveGate(kbRoot, sources, gate.run_id);
  process.stdout.write(
    JSON.stringify(
      {
        schema_version: 1,
        gate_id: updatedGate.gate_id,
        run_id: updatedGate.run_id,
        gate_status: updatedGate.status,
        published_generation_id: updatedGate.published_generation_id ?? null,
        counts: result.counts,
        warnings: result.warnings,
      },
      null,
      2
    ) + "\n"
  );
}

function cmdDeny(args: Args): void {
  const { kbRoot, gate } = resolveGate(args);
  const engineTerminal = decisionViaEngine(args.projectRoot, gate.run_id, "deny");
  if (engineTerminal !== undefined) {
    process.stdout.write(
      JSON.stringify(terminalProjection(engineTerminal, { run_id: gate.run_id }), null, 2) + "\n"
    );
    return;
  }
  const denied = denyGate(kbRoot, gate.run_id);
  process.stdout.write(
    JSON.stringify(
      {
        schema_version: 1,
        gate_id: denied.gate_id,
        run_id: denied.run_id,
        gate_status: denied.status,
        published: false,
      },
      null,
      2
    ) + "\n"
  );
}

function cmdRefine(args: Args): void {
  const { gate } = resolveGate(args);
  // refine is an engine path: the run's own machine re-enters compose, re-lints,
  // re-verifies, and re-offers the gate. Non-engine (legacy) gates have no
  // refinement path, and we refuse rather than guess one.
  const directive = decisionViaEngine(args.projectRoot, gate.run_id, "refine");
  if (directive === undefined) {
    throw new Error(
      "refine applies only to engine-driven runs; this gate is not owned by an engine run"
    );
  }
  const d = directive as { action: string; gate_id?: string; status?: string };
  if (d.action === "await_user") {
    // The refinement round completed and the re-reviewed candidate is gated again.
    process.stdout.write(
      JSON.stringify(
        {
          schema_version: 1,
          status: "awaiting_user",
          gate_id: d.gate_id ?? null,
          run_id: gate.run_id,
          note: "refinement round executed; the re-reviewed candidate is pending at the gate again (use gate-list to inspect)",
        },
        null,
        2
      ) + "\n"
    );
    return;
  }
  // The refinement round hit a budget limit or the run terminated; project safely.
  process.stdout.write(
    JSON.stringify(terminalProjection(directive, { run_id: gate.run_id }), null, 2) + "\n"
  );
}

/**
 * The canonical decision path for engine-driven runs (§5.12 "host-authenticated
 * callback"): the decision is a gate response on the run; the run's own state
 * machine performs the publish/denial behind it, so the run's terminal state
 * can never disagree with what happened on disk. Returns undefined when no
 * engine run owns this gate, and the caller uses the direct-plane fallback.
 */
function decisionViaEngine(
  projectRoot: string,
  gateRunId: string,
  response: "approve" | "deny" | "refine"
): Directive | undefined {
  const config = loadRuntimeConfig(projectRoot, process.env);
  const checkpointer = new Checkpointer(config.dbPath);
  try {
    const run = checkpointer.loadRunById(gateRunId);
    const pending = run?.pendingDirective;
    if (run === undefined || run.status !== "awaiting_user" || pending?.action !== "await_user") {
      return undefined;
    }
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: config.projectRoot,
      maxSteps: config.maxSteps,
      playbookName: "knowledge-base",
    });
    return engine.handle({
      schema_version: 2,
      action: "respond",
      identity: run.identity,
      gate_id: pending.gate_id,
      challenge: pending.challenge,
      response,
    });
  } finally {
    checkpointer.close();
  }
}

/** Safe terminal projection for stdout: status, generation id, counts — no bodies. */
function terminalProjection(
  terminal: Directive,
  fallback: Record<string, JsonValue>
): Record<string, JsonValue> {
  const result = (terminal as { result?: Record<string, JsonValue> }).result ?? {};
  const counts = (result["published_counts"] ?? {}) as Record<string, JsonValue>;
  const generationId = String(result["published_generation_id"] ?? "");
  return {
    schema_version: 1,
    gate_status: String((terminal as { status?: string }).status ?? String(terminal.action)),
    published: terminal.action === "complete",
    published_generation_id: generationId.length > 0 ? generationId : null,
    counts,
    ...fallback,
  };
}

// ── main ────────────────────────────────────────────────────────────────────

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      [
        "Usage: penny-kb-gate <command> --profile <id> [--project-root PATH] [opts]",
        "",
        "Commands:",
        "  capability-mint --path FILE --title T --author A [--author B] [--source-type manual] [--media-type text/plain] [--expires-hours 72] [--session-id S] [--captured-at ISO]",
        "  capability-list",
        "  gate-list",
        "  approve [--run RUN_ID]",
        "  deny [--run RUN_ID]",
        "  refine [--run RUN_ID]",
        "  parent-grant-mint --profile P --session S --invocation I --request '<json>' [--max-bytes 16384] [--ttl-minutes 15]",
        "  parent-grant-list",
        "",
      ].join("\n")
    );
    return;
  }
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case "capability-mint":
        cmdCapabilityMint(args);
        break;
      case "capability-list":
        cmdCapabilityList(args);
        break;
      case "gate-list":
        cmdGateList(args);
        break;
      case "approve":
        cmdApprove(args);
        break;
      case "deny":
        cmdDeny(args);
        break;
      case "refine":
        cmdRefine(args);
        break;
      case "parent-grant-mint":
        cmdParentGrantMint(args);
        break;
      case "parent-grant-list":
        cmdParentGrantList(args);
        break;
      default:
        fail(`unknown command: ${cmd}`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

main(process.argv.slice(2));
