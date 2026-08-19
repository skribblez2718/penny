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
 *   capability-mint   Mint a source_read capability envelope (operator action)
 *   capability-list   List capability leases for a profile
 *   gate-list         List content-review gates for a profile (safe projection)
 *   approve           Approve a pending gate (host decision; publishes)
 *   deny              Deny a pending gate (host decision; publishes nothing)
 *
 * Conventions:
 *   --project-root  Defaults to cwd. KB root = <project-root>/.penny/kb/<profile>.
 *   No command prints any source or page body to stdout.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { envelopeDigest, CapabilityStore } from "./kb/capabilities.js";
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
      default:
        fail(`unknown command: ${cmd}`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

main(process.argv.slice(2));
