import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import * as fs from "node:fs";
import { scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import {
  requireFunction,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";
import { canonicalJson, sha256 } from "../../../../../apps/orchestration/dist/canonical-json.js";
import { ArtifactStore } from "../../../../../apps/orchestration/dist/artifact-store.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialHumanEventV1Schema,
  ScaP03InitialProposalBindingV1,
  validateScaP03InitialProposalV1,
} from "../../../../../apps/orchestration/dist/sca/p03-initial-authorization.js";
import {
  signTrustedHumanEvent,
  verifyExecutionOwnerSignature,
} from "../../../skill/execution-receipts.js";
import { createScaP03LocalOperatorAuthV1 } from "../../src/native-local-auth.js";
import { validateContract } from "../../../../../apps/orchestration/dist/contracts.js";

const faults = vi.hoisted(() => ({
  failWrite: false,
  afterRename: vi.fn<(target: fs.PathLike) => void>(),
  beforeFsync: vi.fn<(fd: number) => void>(),
  beforeClose: vi.fn<(fd: number) => void>(),
  beforeUnlink: vi.fn<(file: fs.PathLike) => void>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      original.renameSync(from, to);
      faults.afterRename(to);
    },
    fsyncSync(fd: number) {
      faults.beforeFsync(fd);
      original.fsyncSync(fd);
    },
    closeSync(fd: number) {
      faults.beforeClose(fd);
      original.closeSync(fd);
    },
    unlinkSync(file: fs.PathLike) {
      faults.beforeUnlink(file);
      original.unlinkSync(file);
    },
    writeSync(...args: Parameters<typeof original.writeSync>) {
      if (faults.failWrite) throw new Error("simulated interrupted write");
      return original.writeSync(...args);
    },
  };
});
const roots: string[] = [];
const stores: ArtifactStore[] = [];
afterEach(() => {
  faults.failWrite = false;
  faults.afterRename.mockReset();
  faults.beforeFsync.mockReset();
  faults.beforeClose.mockReset();
  faults.beforeUnlink.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const secret = "test-only long passphrase 12345";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "p03-auth-test-"));
  roots.push(root);
  const directory = mkdtempSync(path.join(root, "private-"));
  const store = new ArtifactStore(path.join(root, "artifacts"));
  stores.push(store);
  const persist = (kind: string, text: string, operation = kind) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: "auth-run",
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id: operation,
        version: 1,
        producer: "host:sca-p03-initial-authorization",
        media_type: "application/json",
        content_schema: { schema_id: `penny.${kind}.v1`, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: text,
    });
  const proof = persist("proof", "{}");
  let wall = Date.parse("2026-10-16T10:00:00.000Z"),
    mono = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(wall);
  const proposal = validateScaP03InitialProposalV1({
    schema_id: "penny.sca-p03-initial-proposal.v1",
    schema_version: 1,
    run_id: "auth-run",
    invocation_nonce: "auth-nonce",
    approval_id: "auth-approval",
    principal_id: "test-operator",
    policy_id: "test-policy",
    installation_id: "test-installation",
    project_id: "test-project",
    revocation_generation: 1,
    state_authority_sha256: sha256("state"),
    backend_resource_sha256: sha256("backend"),
    deployment_sha256: sha256("deployment"),
    configuration_sha256: sha256("configuration"),
    evidence_destination_sha256: sha256("destination"),
    fixture_cohort_sha256: sha256("cohort"),
    issued_at: new Date(wall - 1000).toISOString(),
    not_before: new Date(wall - 1000).toISOString(),
    expires_at: new Date(wall + 600_000).toISOString(),
    effect: "fixture_qualification",
    input_refs: [proof],
    resources: {
      cpus: 1,
      memory_bytes: 1024,
      pids: 1,
      tmp_bytes: 1,
      work_bytes: 100,
      command_output_bytes: 100,
      concurrency: 1,
      inactivity_ms: 60_000,
      cleanup_grace_ms: 100,
      max_commands: 1,
      max_source_bytes: 1,
      max_source_files: 1,
      max_graph_bytes: 1,
      max_query_bytes: 1,
      max_query_items: 1,
      max_page_items: 1,
      max_pages_per_query: 1,
      max_ast_depth: 1,
      max_ast_nodes: 1,
      max_num_def: 1,
      jvm_heap_bytes: 1,
      max_host_workspace_bytes: 1,
      max_evidence_bytes: 1,
    },
  });
  const ref = persist("sca-p03-initial-proposal", canonicalJson(proposal));
  const binding = new ScaP03InitialProposalBindingV1(store, ref);
  const st = statSync(directory);
  const config = {
    schema_version: 1,
    principal_id: proposal.principal_id,
    policy_id: proposal.policy_id,
    installation_id: proposal.installation_id,
    project_id: proposal.project_id,
    state_authority_sha256: proposal.state_authority_sha256,
    backend_resource_sha256: proposal.backend_resource_sha256,
    revocation_generation: 1,
    permitted_effects: [proposal.effect],
    directory,
    directory_dev: st.dev,
    directory_ino: st.ino,
    custody_uid: st.uid,
    descriptor_root: "/proc/self/fd",
    record_name: "operator.json",
    lock_name: "operator.lock",
    session_absolute_ms: 300_000,
    session_idle_ms: 60_000,
    max_attempts: 3,
    attempt_delay_ms: 1000,
  };
  const clock = { now: () => new Date(wall), monotonicMs: () => mono };
  const make = (
    mode: "provision" | "open_existing",
    selectedConfig: unknown = config,
    selectedBinding = binding
  ) =>
    createScaP03LocalOperatorAuthV1({
      mode,
      config: selectedConfig,
      binding: selectedBinding,
      clock,
      assertCurrentInputs(p) {
        binding.assertProposal(p);
      },
    });
  const event = () =>
    validateContract(
      ScaP03InitialHumanEventV1Schema,
      signTrustedHumanEvent({
        runId: proposal.run_id,
        gateId: "gate",
        challenge: "challenge",
        artifactRef: ref,
        transportRef: persist("sca-p03-initial-transport", "{}"),
        renderedQuestionsDigest: sha256("questions"),
        response: "approve",
      }),
      "test UI event"
    );
  return {
    root,
    directory,
    store,
    config,
    make,
    binding,
    proposal,
    event,
    persist,
    advance(ms: number) {
      wall += ms;
      mono += ms;
      vi.setSystemTime(wall);
    },
    rollback() {
      wall -= 1;
      vi.setSystemTime(wall);
    },
  };
}
type Auth = ReturnType<typeof createScaP03LocalOperatorAuthV1>;
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
}
async function command(
  auth: Auth,
  args: string,
  options: {
    inputs?: string[];
    mode?: string;
    cancelDuringWork?: boolean;
    inspect?: (component: Component) => void;
    lifecycleDuringWork?: string;
    signal?: AbortSignal;
    onNotify?: (message: string) => void;
  } = {}
) {
  let registered: unknown;
  const events = new Map<string, unknown>();
  auth.registerCommands({
    ...createTestExtensionApi({
      onRegisterCommand(_name, value) {
        registered = value;
      },
      onEvent(name, handler) {
        events.set(name, handler);
      },
      onRegisterTool() {
        throw new Error("authentication must not register model tools");
      },
      onAppendEntry() {
        throw new Error("authentication must not persist session data");
      },
    }),
    sendMessage() {
      throw new Error("no model messages");
    },
    sendUserMessage() {
      throw new Error("no model prompts");
    },
    exec() {
      throw new Error("no subprocesses");
    },
  });
  const handler = requireFunction(requireRecord(registered).handler);
  const notifications: string[] = [],
    rendered: string[] = [];
  let dialogs = 0;
  await handler(args, {
    mode: options.mode ?? "tui",
    hasUI: true,
    signal: options.signal,
    isIdle: () => true,
    ui: {
      notify(message: string) {
        notifications.push(message);
        options.onNotify?.(message);
      },
      async custom(
        factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Component
      ) {
        dialogs++;
        await new Promise<void>((resolve) => {
          const component = factory(
            { requestRender() {} },
            {},
            {
              matches(data: string, action: string) {
                return (
                  (action === "tui.input.submit" && data === "\r") ||
                  (action === "tui.select.cancel" && (data === "\x1b" || data === "\x03")) ||
                  (action === "tui.editor.deleteCharBackward" && data === "\x7f")
                );
              },
            },
            (result?: unknown) => {
              expect(result).toBeUndefined();
              resolve();
            }
          );
          for (const input of options.inputs ?? []) {
            component.handleInput?.(input);
            for (const width of [1, 12, 80]) rendered.push(...component.render(width));
          }
          options.inspect?.(component);
          if (options.cancelDuringWork) component.handleInput?.("\x03");
          if (options.lifecycleDuringWork !== undefined)
            void requireFunction(events.get(options.lifecycleDuringWork))();
        });
      },
    },
  });
  expect(rendered.join("\n")).not.toContain(secret);
  expect(notifications.join("\n")).not.toContain(secret);
  return { dialogs, rendered, notifications };
}
async function enroll(f: ReturnType<typeof fixture>) {
  using auth = f.make("provision");
  const result = await command(auth, "enroll", { inputs: [secret, "\r", secret, "\r"] });
  expect(result.notifications).toContain(
    "P03 operator enrolled. Restart with open_existing; enrollment is not login or approval."
  );
}
it("opens existing only, validates closed configuration, and never provisions at startup", () => {
  const f = fixture();
  expect(() => f.make("open_existing")).toThrow();
  expect(readdirSync(f.directory)).toEqual([]);
  expect(() => f.make("provision", { ...f.config, authenticated: true })).toThrow();
  expect(() => f.make("provision", { ...f.config, record_name: "../escape" })).toThrow();
  expect(() => f.make("provision", { ...f.config, lock_name: f.config.record_name })).toThrow();
  expect(() => f.make("provision", { ...f.config, directory_ino: 0 })).toThrow();
  for (const changes of [
    { max_attempts: 11 },
    { attempt_delay_ms: 0 },
    { session_absolute_ms: 3_600_001 },
    { session_idle_ms: 300_001 },
    { permitted_effects: [] },
    { descriptor_root: "/tmp" },
  ]) {
    expect(() => f.make("provision", { ...f.config, ...changes })).toThrow();
  }
});
it("rejects RPC/print and secret arguments without opening UI or writing", async () => {
  const f = fixture();
  using auth = f.make("provision");
  expect((await command(auth, "enroll", { mode: "rpc" })).dialogs).toBe(0);
  expect((await command(auth, `enroll ${secret}`)).dialogs).toBe(0);
  expect(readdirSync(f.directory)).toEqual([]);
});
it("cancels enrollment/mismatch and interruption during real KDF without credential or session", async () => {
  const f = fixture();
  using auth = f.make("provision");
  await command(auth, "enroll", { inputs: [secret, "\x1b"] });
  await command(auth, "enroll", {
    inputs: [secret, "\r", "different passphrase 12345", "\r", "\x1b"],
  });
  await command(auth, "enroll", { inputs: [secret, "\r", secret, "\r"], cancelDuringWork: true });
  expect(readdirSync(f.directory)).toEqual([]);
  expect(auth.profile.current().revoked).toBe(true);
});
it("uses real scrypt and protected verifier, and neither enrollment nor HMAC alone authenticates", async () => {
  const f = fixture();
  await enroll(f);
  const file = path.join(f.directory, f.config.record_name);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain(secret);
  const record = requireRecord(JSON.parse(text));
  expect(record.kdf).toEqual({ name: "scrypt", N: 131072, r: 8, p: 1, key_bytes: 64 });
  const independent = scryptSync(secret, Buffer.from(requireString(record.salt), "hex"), 64, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 160 * 1024 * 1024,
  });
  try {
    expect(independent.toString("hex")).toBe(record.verifier);
  } finally {
    independent.fill(0);
  }
  using auth = f.make("open_existing");
  expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
  expect((await command(auth, "enroll")).dialogs).toBe(0);
  await command(auth, "login", { inputs: [secret, "\r"] });
  const event = f.event();
  expect(auth.profile.authenticatedInteractivePrincipal(event)).toBe(f.proposal.principal_id);
  expect(
    auth.profile.authenticatedInteractivePrincipal({ ...event, signature: "0".repeat(64) })
  ).toBeUndefined();
  expect(
    auth.profile.authenticatedInteractivePrincipal({ ...event, run_id: "foreign" })
  ).toBeUndefined();
  const authorization = new ScaP03InitialAuthorizationV1(
    auth.profile,
    { verify: verifyExecutionOwnerSignature },
    f.binding
  );
  expect(() =>
    authorization.admit(
      f.proposal,
      {
        proposal_ref: f.binding.proposal_ref,
        transport_ref: event.questionnaire_transport_ref,
        gate_id: event.gate_id,
        challenge: event.challenge,
        rendered_questions_digest: event.rendered_questions_digest,
      },
      { ...event, signature: "0".repeat(64) }
    )
  ).toThrow();
  await command(auth, "logout");
  expect(auth.profile.authenticatedInteractivePrincipal(event)).toBeUndefined();
});
it("charges failed attempts durably, denies delay/restart bypass, and limits attempts", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  for (let i = 0; i < f.config.max_attempts; i++) {
    await command(auth, "login", { inputs: ["wrong long passphrase 12345", "\r"] });
    expect(auth.profile.current().revoked).toBe(true);
    using restarted = f.make("open_existing");
    expect((await command(restarted, "login")).dialogs).toBe(0);
    f.advance(1001);
  }
  expect((await command(auth, "login")).dialogs).toBe(0);
});
it("pins all proposal bytes and exact refs, rechecks inputs, and has finite nonrestored sessions", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  await command(auth, "login", { inputs: [secret, "\r"] });
  using restarted = f.make("open_existing");
  expect(restarted.profile.current().revoked).toBe(true);
  expect(() =>
    auth.profile.assertCurrentInputs({ ...f.proposal, invocation_nonce: "changed" })
  ).toThrow();
  const event = f.event();
  const otherRef = f.persist(
    "sca-p03-initial-proposal",
    canonicalJson({ ...f.proposal, approval_id: "other" }),
    "other-proposal"
  );
  expect(
    auth.profile.authenticatedInteractivePrincipal({ ...event, artifact_ref: otherRef })
  ).toBeUndefined();
  f.advance(f.config.session_idle_ms);
  expect(auth.profile.authenticatedInteractivePrincipal(event)).toBeUndefined();
  await command(auth, "login", { inputs: [secret, "\r"] });
  for (let i = 0; i < 4; i++) {
    f.advance(59_000);
    expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBe(f.proposal.principal_id);
  }
  f.advance(64_000);
  expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
});
it("checks proposal expiry and backwards clock without extending authority", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  f.advance(599_000);
  await command(auth, "login", { inputs: [secret, "\r"] });
  expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBe(f.proposal.principal_id);
  f.advance(1000);
  expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
  const g = fixture();
  await enroll(g);
  using second = g.make("open_existing");
  await command(second, "login", { inputs: [secret, "\r"] });
  g.rollback();
  expect(second.profile.authenticatedInteractivePrincipal(g.event())).toBeUndefined();
});
it("revokes across instances and invalidates an earlier login on a new failed login", async () => {
  const f = fixture();
  await enroll(f);
  using first = f.make("open_existing");
  using second = f.make("open_existing");
  await command(first, "login", { inputs: [secret, "\r"] });
  await command(second, "login", { inputs: ["wrong long passphrase 12345", "\r"] });
  expect(first.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
  f.advance(1001);
  await command(first, "login", { inputs: [secret, "\r"] });
  await command(second, "revoke");
  expect(first.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
  expect(first.profile.current().revocation_generation).toBe(2);
  expect((await command(first, "login")).dialogs).toBe(0);
});
it("fails closed on symlinks, custody/mode changes, oversized records, stale lock and config drift", async () => {
  const f = fixture();
  await enroll(f);
  expect(() => f.make("open_existing", { ...f.config, policy_id: "different" })).toThrow();
  chmodSync(path.join(f.directory, f.config.record_name), 0o644);
  expect(() => f.make("open_existing")).toThrow();
  const g = fixture();
  symlinkSync(path.join(g.root, "missing"), path.join(g.directory, g.config.record_name));
  expect(() => g.make("provision")).toThrow();
  const h = fixture();
  await enroll(h);
  using auth = h.make("open_existing");
  writeFileSync(path.join(h.directory, h.config.lock_name), "", { mode: 0o600 });
  expect((await command(auth, "login")).dialogs).toBe(0);
  expect(auth.profile.current().revoked).toBe(true);
  const j = fixture();
  await enroll(j);
  writeFileSync(path.join(j.directory, j.config.record_name), "x".repeat(16_385));
  expect(() => j.make("open_existing")).toThrow();
});
it("bounds masked input, wipes on dispose, and never invokes normal input/editor/clipboard/process APIs", async () => {
  const f = fixture();
  using auth = f.make("provision");
  const result = await command(auth, "enroll", {
    inputs: ["x".repeat(1025), "\r", "\x1b"],
    inspect(component) {
      expect(JSON.stringify(component)).not.toContain("xxx");
      component.dispose?.();
      expect(component.render(80).join("\n")).not.toContain("xxx");
    },
  });
  expect(result.dialogs).toBe(1);
  expect(result.rendered).toContain(`Principal: ${f.proposal.principal_id}`);
  expect(result.rendered).toContain(`Proposal: ${f.binding.proposal_ref.artifact_id}`);
  expect(readdirSync(f.directory)).toEqual([]);
});

it("rejects even correctly signed foreign proposal/run and predating events", async () => {
  const f = fixture();
  await enroll(f);
  const earlier = f.event();
  f.advance(10);
  using auth = f.make("open_existing");
  await command(auth, "login", { inputs: [secret, "\r"] });
  expect(verifyExecutionOwnerSignature(earlier)).toBe(true);
  expect(auth.profile.authenticatedInteractivePrincipal(earlier)).toBeUndefined();
  const event = f.event();
  const foreignRef = f.persist(
    "sca-p03-initial-proposal",
    canonicalJson({ ...f.proposal, invocation_nonce: "other" }),
    "other"
  );
  for (const changes of [
    { artifactRef: foreignRef, runId: f.proposal.run_id },
    { artifactRef: f.binding.proposal_ref, runId: "foreign" },
  ]) {
    const signed = validateContract(
      ScaP03InitialHumanEventV1Schema,
      signTrustedHumanEvent({
        ...changes,
        gateId: event.gate_id,
        challenge: event.challenge,
        transportRef: event.questionnaire_transport_ref,
        renderedQuestionsDigest: event.rendered_questions_digest,
        response: "approve",
      }),
      "signed negative event"
    );
    expect(verifyExecutionOwnerSignature(signed)).toBe(true);
    expect(auth.profile.authenticatedInteractivePrincipal(signed)).toBeUndefined();
  }
  const owner = new ScaP03InitialAuthorizationV1(
    auth.profile,
    { verify: verifyExecutionOwnerSignature },
    f.binding
  );
  const gate = {
    proposal_ref: f.binding.proposal_ref,
    transport_ref: event.questionnaire_transport_ref,
    gate_id: event.gate_id,
    challenge: event.challenge,
    rendered_questions_digest: event.rendered_questions_digest,
  };
  expect(owner.admit(f.proposal, gate, event)).toEqual(event);
  expect(() => owner.admit(f.proposal, { ...gate, challenge: "wrong" }, event)).toThrow();
  vi.spyOn(f.binding, "readControl").mockImplementation(() => {
    throw new Error("source custody changed");
  });
  expect(auth.profile.authenticatedInteractivePrincipal(event)).toBeUndefined();
});
it("cancels already-aborted and shutdown-during-KDF commands without late authentication", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  expect((await command(auth, "login", { signal: AbortSignal.abort() })).dialogs).toBe(0);
  await command(auth, "login", { inputs: [secret, "\r"], lifecycleDuringWork: "session_shutdown" });
  expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
  const record = requireRecord(
    JSON.parse(readFileSync(path.join(f.directory, f.config.record_name), "utf8"))
  );
  expect(record.failures).toBe(1);
  expect(readdirSync(f.directory)).toEqual([f.config.record_name]);
});
it("preserves the previous complete verifier on atomic write failure", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  const file = path.join(f.directory, f.config.record_name),
    before = readFileSync(file);
  faults.failWrite = true;
  await command(auth, "logout");
  faults.failWrite = false;
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(f.directory)).toEqual([f.config.record_name]);
  expect(auth.profile.current().revoked).toBe(true);
});
it("rejects directory replacement, ancestor links, hardlinks and record-selected KDF parameters", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  const moved = `${f.directory}-moved`;
  fs.renameSync(f.directory, moved);
  fs.mkdirSync(f.directory, { mode: 0o700 });
  expect((await command(auth, "login")).dialogs).toBe(0);
  const g = fixture();
  const alias = path.join(g.root, "alias");
  symlinkSync(g.directory, alias);
  expect(() => g.make("provision", { ...g.config, directory: alias })).toThrow();
  const h = fixture();
  await enroll(h);
  fs.linkSync(path.join(h.directory, h.config.record_name), path.join(h.directory, "alias"));
  expect(() => h.make("open_existing")).toThrow();
  const j = fixture();
  await enroll(j);
  const file = path.join(j.directory, j.config.record_name);
  const raw = requireRecord(JSON.parse(readFileSync(file, "utf8")));
  writeFileSync(
    file,
    canonicalJson({ ...raw, kdf: { name: "scrypt", N: 2, r: 1, p: 1, key_bytes: 64 } })
  );
  expect(() => j.make("open_existing")).toThrow();
});

it("does not queue concurrent KDFs and never authenticates across concurrent revocation", async () => {
  const f = fixture(),
    g = fixture();
  using first = f.make("provision");
  using other = g.make("provision");
  const results = await Promise.all([
    command(first, "enroll", { inputs: [secret, "\r", secret, "\r"] }),
    command(other, "enroll", { inputs: [secret, "\r", secret, "\r"] }),
  ]);
  expect(
    results.filter((r) =>
      r.notifications.includes(
        "P03 operator enrolled. Restart with open_existing; enrollment is not login or approval."
      )
    )
  ).toHaveLength(1);
  expect(readdirSync(f.directory)).toEqual([f.config.record_name]);
  expect(readdirSync(g.directory)).toEqual([]);
  using login = f.make("open_existing");
  using revoker = f.make("open_existing");
  let revocation: ReturnType<typeof command> | undefined;
  await command(login, "login", {
    inputs: [secret, "\r"],
    inspect() {
      revocation = command(revoker, "revoke");
    },
  });
  if (revocation === undefined) throw new Error("revocation not exercised");
  await revocation;
  expect(login.profile.authenticatedInteractivePrincipal(f.event())).toBeUndefined();
  expect(login.profile.current().revocation_generation).toBe(2);
});

// Observe the charged record followed by the successful work commit, not a global
// fsync ordinal: setup/attempt charging must not satisfy these fault regressions.
for (const failure of [
  "commit directory fsync",
  "temporary cleanup",
  "lock close",
  "lock unlink",
  "final directory fsync",
]) {
  it(`denies authentication after the final work commit fails at ${failure}`, async () => {
    const f = fixture();
    await enroll(f);
    using auth = f.make("open_existing");
    const event = f.event();
    let charged = false,
      committed = false,
      lockCleanupReached = false,
      injected = false;
    let unclosedLock: number | undefined;
    let atDenial: { principal: string | undefined; revoked: boolean } | undefined;
    const fail = () => {
      injected = true;
      throw new Error(`simulated post-commit ${failure} failure`);
    };
    faults.afterRename.mockImplementation((target) => {
      if (!target.toString().endsWith(`/${f.config.record_name}`)) return;
      const record = requireRecord(JSON.parse(readFileSync(target, "utf8")));
      if (record.failures === 1) charged = true;
      if (charged && record.failures === 0 && record.next_attempt_at === 0) committed = true;
    });
    faults.beforeFsync.mockImplementation((fd) => {
      if (!committed || injected) return;
      const st = fs.fstatSync(fd);
      if (
        st.isDirectory() &&
        st.dev === f.config.directory_dev &&
        st.ino === f.config.directory_ino &&
        (failure === "commit directory fsync" ||
          (failure === "final directory fsync" && lockCleanupReached))
      )
        fail();
    });
    faults.beforeClose.mockImplementation((fd) => {
      if (committed && !injected && failure === "lock close" && fs.fstatSync(fd).isFile()) {
        unclosedLock = fd;
        fail();
      }
    });
    faults.beforeUnlink.mockImplementation((file) => {
      if (!committed || injected) return;
      const name = path.basename(file.toString());
      if (failure === "temporary cleanup" && name.startsWith(`${f.config.record_name}.`)) fail();
      if (name === f.config.lock_name) {
        lockCleanupReached = true;
        if (failure === "lock unlink") fail();
      }
    });
    const result = await command(auth, "login", {
      inputs: [secret, "\r"],
      onNotify(message) {
        if (message !== "P03 operator authentication unavailable or cancelled.") return;
        // Test-only removal of an injected scratch lock isolates the in-memory
        // invariant: denial must not depend on a leftover filesystem blocker.
        if (unclosedLock !== undefined) {
          fs.closeSync(unclosedLock);
          unclosedLock = undefined;
        }
        if (readdirSync(f.directory).includes(f.config.lock_name))
          fs.unlinkSync(path.join(f.directory, f.config.lock_name));
        atDenial = {
          principal: auth.profile.authenticatedInteractivePrincipal(event),
          revoked: auth.profile.current().revoked,
        };
      },
    });
    expect(charged).toBe(true);
    expect(committed).toBe(true);
    expect(injected).toBe(true);
    expect(result.notifications).toEqual(["P03 operator authentication unavailable or cancelled."]);
    expect(atDenial).toEqual({ principal: undefined, revoked: true });
    expect(auth.profile.authenticatedInteractivePrincipal(event)).toBeUndefined();
    expect(auth.profile.current().revoked).toBe(true);
    expect(readdirSync(f.directory)).toEqual([f.config.record_name]);
    const record = requireRecord(
      JSON.parse(readFileSync(path.join(f.directory, f.config.record_name), "utf8"))
    );
    expect(record.failures).toBe(0);
    expect(record.next_attempt_at).toBe(0);
    await command(auth, "login", { inputs: [secret, "\r"] });
    expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBe(f.proposal.principal_id);
    expect(auth.profile.current().revoked).toBe(false);
  });
}

it("invalidates before reporting masked work failure even after a session was committed", async () => {
  const f = fixture();
  await enroll(f);
  using auth = f.make("open_existing");
  const event = f.event();
  let rejectedSuccess = false;
  let atDenial: { principal: string | undefined; revoked: boolean } | undefined;
  const result = await command(auth, "login", {
    inputs: [secret, "\r"],
    onNotify(message) {
      if (
        message ===
        "P03 operator authenticated for the pinned proposal. Signed questionnaire approval is still required."
      ) {
        rejectedSuccess = true;
        throw new Error("simulated authentication completion notification failure");
      }
      if (message === "P03 operator authentication unavailable or cancelled.")
        atDenial = {
          principal: auth.profile.authenticatedInteractivePrincipal(event),
          revoked: auth.profile.current().revoked,
        };
    },
  });
  expect(rejectedSuccess).toBe(true);
  expect(
    result.notifications.filter(
      (m) => m === "P03 operator authentication unavailable or cancelled."
    )
  ).toHaveLength(1);
  expect(atDenial).toEqual({ principal: undefined, revoked: true });
  expect(auth.profile.authenticatedInteractivePrincipal(event)).toBeUndefined();
  expect(auth.profile.current().revoked).toBe(true);
  await command(auth, "login", { inputs: [secret, "\r"] });
  expect(auth.profile.authenticatedInteractivePrincipal(f.event())).toBe(f.proposal.principal_id);
});
