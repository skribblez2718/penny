/** Harness-only pre-effect authorization. Never enroll this extension in the real project. */
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import {
  CATALOG_WORKER_SESSION_METADATA,
  CATALOG_WORKER_CONTINUITY_METADATA,
  validateCatalogWorkerSessionMetadata,
  validateCatalogWorkerContinuityMetadata,
} from "../dist/model-client.js";
import {
  atomicBytes,
  atomicJson,
  ORDINARY_SKILLS,
  PUBLIC_RESEARCH_URL,
} from "../smoke/ordinary-skills-live-contract.js";

export const WORKER_GUARD_ENV = "PENNY_ORDINARY_SKILLS_LIVE_WORKER_GUARD";
export const WORKER_GUARD_NAME = "ordinary-live-guard.ts";
const denialChannel = channel("penny.ordinary-skills-live.worker-denied");

/** Same-process host cancellation, not another execution surface. Node's channel also spans
 * Pi's normal Jiti-loaded extension module and the harness module without shared module caches. */
export function observeWorkerGuardDenials(
  project: string,
  runId: string,
  onDenied: () => void
): () => void {
  const handler = (message: unknown): void => {
    if (
      typeof message === "object" &&
      message !== null &&
      "project" in message &&
      "run_id" in message &&
      message.project === project &&
      message.run_id === runId
    )
      onDenied();
  };
  denialChannel.subscribe(handler);
  return () => denialChannel.unsubscribe(handler);
}
// Authorization contract, deliberately closed even when a provider schema accepts extra fields.
const AssignedReadSchema = Type.Object(
  {
    artifact: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    range: Type.Optional(
      Type.Object(
        { start: Type.Integer({ minimum: 0 }), end: Type.Optional(Type.Integer({ minimum: 0 })) },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
const PhaseSchema = Type.Object(
  {
    state_id: Type.String({ minLength: 1 }),
    agent: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,127}$" }),
    tools: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false }
);
export const WorkerGuardConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    project: Type.String({ minLength: 1 }),
    project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    session_root: Type.String({ minLength: 1 }),
    run_id: Type.String({ minLength: 1, maxLength: 256 }),
    skill: Type.String({ minLength: 1 }),
    phases: Type.Array(PhaseSchema, { minItems: 1 }),
  },
  { additionalProperties: false }
);
export type WorkerGuardConfig = Static<typeof WorkerGuardConfigSchema>;

/** Real directory, individually linked unchanged providers, plus one normally discovered guard.
 * In particular, never create a file through a repository extensions-directory symlink. */
export function enrollWorkerGuard(repository: string, project: string): string {
  const directory = path.join(project, ".pi/extensions");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Guard needs a real extensions directory");
  for (const entry of readdirSync(path.join(repository, ".pi/extensions"))) {
    const source = path.join(repository, ".pi/extensions", entry);
    if (lstatSync(source).isDirectory()) symlinkSync(source, path.join(directory, entry), "dir");
  }
  symlinkSync(path.join(repository, ".pi/lib"), path.join(project, ".pi/lib"), "dir");
  const guard = path.join(directory, WORKER_GUARD_NAME);
  // Jiti resolves relative imports from a file symlink's discovery path, not its target.
  // A normal single-file extension entry importing the original module preserves its dependencies.
  atomicBytes(
    guard,
    `export { default } from ${JSON.stringify(path.join(repository, "apps/orchestration/tests/ordinary-skills-live-guard.ts"))};\n`
  );
  return guard;
}

function sameTools(actual: readonly string[], expected: readonly string[]): boolean {
  return canonicalJson([...actual].sort()) === canonicalJson([...expected].sort());
}
function privatePath(file: string, directory: boolean): void {
  const info = lstatSync(file);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new Error("Untrusted guard custody");
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function loadConfig(file: string | undefined): { config: WorkerGuardConfig; events: string } {
  if (file === undefined || !path.isAbsolute(file)) throw new Error("Missing guard configuration");
  privatePath(file, false);
  const root = path.dirname(file);
  privatePath(root, true);
  const bytes = readFileSync(file, "utf8");
  const value: unknown = JSON.parse(bytes);
  const config = validateContract(WorkerGuardConfigSchema, value, "live worker guard");
  if (
    !ORDINARY_SKILLS.some((skill) => skill === config.skill) ||
    new Set(config.phases.map((phase) => phase.state_id)).size !== config.phases.length
  )
    throw new Error("Invalid guard registration");
  for (const target of [config.project, config.session_root]) {
    if (!path.isAbsolute(target) || !within(root, target) || realpathSync(target) !== target)
      throw new Error("Guard scope escaped private root");
    privatePath(target, true);
  }
  const events = path.join(root, "worker-guard-events");
  mkdirSync(events, { mode: 0o700, recursive: true });
  privatePath(events, true);
  return { config, events };
}

type GuardContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
function provenance(config: WorkerGuardConfig, ctx: GuardContext, tools: readonly string[]) {
  const manager = ctx.sessionManager;
  const entries = manager.getBranch();
  const owned = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === CATALOG_WORKER_SESSION_METADATA
  );
  const assignments = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === CATALOG_WORKER_CONTINUITY_METADATA
  );
  const first = entries[0];
  const metadataEntry = owned[0];
  const assignmentEntry = assignments[0];
  if (
    owned.length !== 1 ||
    assignments.length !== 1 ||
    first !== metadataEntry ||
    metadataEntry?.type !== "custom" ||
    assignmentEntry?.type !== "custom"
  )
    throw new Error("Missing or ambiguous owner provenance");
  const metadata = validateCatalogWorkerSessionMetadata(metadataEntry.data);
  const assignment = validateCatalogWorkerContinuityMetadata(assignmentEntry.data);
  for (const key of Object.keys(metadata)) {
    if (Reflect.get(metadata, key) !== Reflect.get(assignment, key))
      throw new Error("Owner continuity mismatch");
  }
  if (
    entries
      .slice(0, entries.indexOf(assignmentEntry))
      .some((entry) => entry.type === "message" || entry.type === "custom_message")
  )
    throw new Error("Owner continuity follows conversation");
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (
    ctx.cwd !== config.project ||
    manager.getCwd() !== config.project ||
    header?.cwd !== config.project ||
    header.parentSession !== undefined ||
    file === undefined ||
    !within(config.session_root, file) ||
    !existsSync(file) ||
    realpathSync(file) !== file ||
    metadata.project_id !== config.project_id ||
    metadata.run_id !== config.run_id ||
    metadata.workflow_session_id !== config.run_id
  )
    throw new Error("Owner run/session binding mismatch");
  const phase = config.phases.find(
    (item) => item.state_id === metadata.state_id && item.agent === metadata.agent
  );
  if (
    phase === undefined ||
    !sameTools(tools, phase.tools) ||
    assignment.input_artifacts.some((ref) => ref.run_id !== config.run_id) ||
    new Set(assignment.input_artifacts.map((ref) => ref.artifact_id)).size !==
      assignment.input_artifacts.length
  )
    throw new Error("Owner phase/tools/refs mismatch");
  return {
    metadata,
    assignment,
    fingerprint: sha256(canonicalJson({ metadata, assignment, session: manager.getSessionId() })),
  };
}

/** No tools, methods, schemas, or active names are replaced. Gate all model/nested calls. */
export default function ordinaryLiveGuard(pi: ExtensionAPI): void {
  let loaded: ReturnType<typeof loadConfig> | undefined;
  try {
    loaded = loadConfig(process.env[WORKER_GUARD_ENV]);
  } catch {
    /* Absent/malformed config never grants authority. */
  }
  let denied = false;
  let binding: string | undefined;
  const audit = (ctx: GuardContext, kind: "bound" | "allow" | "deny", reason: string): void => {
    if (loaded === undefined) return; // No trusted destination exists; still deny before execution.
    try {
      atomicJson(path.join(loaded.events, `${randomUUID()}.json`), {
        schema_version: 1,
        kind,
        reason,
        run_id: loaded.config.run_id,
        session_id: ctx.sessionManager.getSessionId(),
      });
    } finally {
      // Abort the owning parent too: native engine repair must not turn denial into extra dispatch.
      if (kind === "deny")
        denialChannel.publish({ project: loaded.config.project, run_id: loaded.config.run_id });
    }
  };
  const bind = (ctx: GuardContext) => {
    if (denied || loaded === undefined) throw new Error("Guard already failed or unauthorized");
    const owner = provenance(loaded.config, ctx, pi.getActiveTools());
    if (binding !== undefined && binding !== owner.fingerprint)
      throw new Error("Owner binding drift");
    if (binding === undefined) {
      audit(ctx, "bound", "owner_assignment_and_unchanged_tools");
      binding = owner.fingerprint;
    }
    return owner;
  };
  const bindBeforeRun = (_event: unknown, ctx: ExtensionContext): void => {
    try {
      bind(ctx);
    } catch {
      denied = true;
      try {
        audit(ctx, "deny", "invalid_provenance");
      } finally {
        ctx.abort();
      }
    }
  };
  pi.on("session_start", bindBeforeRun);
  // PiAgentClient prompts without bindExtensions(), so session_start is not emitted.
  // Owner continuity is complete by before_agent_start. Calls below also validate/bind
  // synchronously: no tool may execute unbound, or adopt provenance appended after messages.
  pi.on("before_agent_start", bindBeforeRun);
  // SDK rejects unknown tools and invalid schemas before tool_call. Preserve those failures too.
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.isError && !denied) {
      denied = true;
      try {
        audit(ctx, "deny", "sdk_tool_error");
      } finally {
        ctx.abort();
      }
    }
  });
  pi.on("tool_call", (event, ctx) => {
    let reason = "not_authorized";
    try {
      const owner = bind(ctx);
      // Delegated actions are unnecessary here, even if their leaf operation would be read-only.
      if (event.parentToolCallId !== undefined) throw new Error("Delegated action denied");
      if (event.toolName === "artifact_read") {
        const input = validateContract(AssignedReadSchema, event.input, "guard read");
        const ref = owner.assignment.input_artifacts.find(
          (ref) => ref.artifact_id === input.artifact
        );
        if (
          ref === undefined ||
          (input.range !== undefined &&
            (input.range.start > ref.byte_length ||
              (input.range.end !== undefined &&
                (input.range.end < input.range.start || input.range.end > ref.byte_length))))
        )
          throw new Error("Unassigned artifact or invalid range");
        reason = "assigned_artifact_read";
      } else if (event.toolName === "web_fetch") {
        const input = validateContract(
          Type.Object({ url: Type.Literal(PUBLIC_RESEARCH_URL) }, { additionalProperties: false }),
          event.input,
          "guard fetch"
        );
        const m = owner.metadata;
        if (
          input.url !== PUBLIC_RESEARCH_URL ||
          loaded?.config.skill !== "research" ||
          m.purpose !== "phase" ||
          !(
            (m.agent === "echo" && m.state_id === "researching") ||
            (m.agent === "vera" && m.state_id === "validating")
          )
        )
          throw new Error("Unapproved fetch phase");
        reason = "exact_research_rfc_fetch";
      } else throw new Error("Out-of-scope tool");
      audit(ctx, "allow", reason); // Audit failure throws before tool.execute too.
      return undefined;
    } catch {
      denied = true; // Sticky: a later plausible call never repairs a failed scenario.
      try {
        audit(ctx, "deny", "unauthorized_call_or_provenance");
      } finally {
        ctx.abort();
      }
      return { block: true, reason: "Live worker guard denied action; scenario failed, no retry" };
    }
  });
}
