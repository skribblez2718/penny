import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  fsyncSync,
  renameSync,
  linkSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../../../../apps/orchestration/dist/canonical-json.js";
import { validateContract } from "../../../../apps/orchestration/dist/contracts.js";
import {
  ScaP03InitialHumanEventV1Schema,
  ScaP03InitialProposalBindingV1,
  type ScaP03InitialProposalV1,
  type ScaP03InitialHumanEventV1,
  type ScaP03TrustedInitialProfileV1,
} from "../../../../apps/orchestration/dist/sca/p03-initial-authorization.js";
import { verifyExecutionOwnerSignature } from "../../skill/execution-receipts.js";

const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const basename = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*(?:\\.json|\\.lock)?$",
});
const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  Type.Integer({ minimum, maximum });
/** No environment loader, default principal, automatic enrollment, or identity inference. */
export const ScaP03LocalOperatorAuthConfigV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    principal_id: id,
    policy_id: id,
    installation_id: id,
    project_id: id,
    state_authority_sha256: digest,
    backend_resource_sha256: digest,
    revocation_generation: integer(1, Number.MAX_SAFE_INTEGER - 1),
    permitted_effects: Type.Array(
      Type.Union([Type.Literal("fixture_qualification"), Type.Literal("bootstrap_verification")]),
      { minItems: 1, maxItems: 2, uniqueItems: true }
    ),
    directory: Type.String({ minLength: 1, maxLength: 4096 }),
    directory_dev: integer(0),
    directory_ino: integer(1),
    custody_uid: integer(0, 0xffffffff),
    descriptor_root: Type.Literal("/proc/self/fd"),
    record_name: basename,
    lock_name: basename,
    session_absolute_ms: integer(1000, 3_600_000),
    session_idle_ms: integer(1000, 900_000),
    max_attempts: integer(1, 10),
    attempt_delay_ms: integer(1000, 3_600_000),
  },
  { additionalProperties: false }
);
export type ScaP03LocalOperatorAuthConfigV1 = Static<typeof ScaP03LocalOperatorAuthConfigV1Schema>;
// OWASP scrypt minimum: N=2^17, r=8, p=1 (~128 MiB); Node/OpenSSL implementation.
// Fixed parameters, not attacker-controlled record options; 160 MiB maxmem includes overhead.
const KDF = Object.freeze({ name: "scrypt", N: 131072, r: 8, p: 1, key_bytes: 64 });
const MAX_SECRET_BYTES = 1024,
  MIN_SECRET_CODEPOINTS = 15,
  MAX_RECORD_BYTES = 16_384;
const recordSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    config_sha256: digest,
    credential_id: digest,
    kdf: Type.Object(
      {
        name: Type.Literal("scrypt"),
        N: Type.Literal(131072),
        r: Type.Literal(8),
        p: Type.Literal(1),
        key_bytes: Type.Literal(64),
      },
      { additionalProperties: false }
    ),
    salt: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    verifier: Type.String({ pattern: "^[a-f0-9]{128}$" }),
    generation: integer(1),
    revoked: Type.Boolean(),
    failures: integer(0, 10),
    next_attempt_at: integer(0),
    last_at: integer(0),
    epoch: digest,
  },
  { additionalProperties: false }
);
type CredentialRecord = Static<typeof recordSchema>;
interface Session {
  epoch: string;
  credential: string;
  wall: number;
  mono: number;
  touched: number;
}
export interface ScaP03LocalOperatorClockV1 {
  now(): Date;
  monotonicMs(): number;
}
export interface ScaP03LocalOperatorAuthV1 extends Disposable {
  readonly profile: ScaP03TrustedInitialProfileV1;
  registerCommands(pi: ExtensionAPI): void;
}
const denied = () => new Error("p03_local_auth_unavailable");
let kdfBusy = false;
async function derive(secret: Buffer, salt: Buffer): Promise<Buffer> {
  if (kdfBusy) throw denied();
  kdfBusy = true;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        secret,
        salt,
        KDF.key_bytes,
        { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 160 * 1024 * 1024 },
        (error, key) => {
          if (error) reject(denied());
          else resolve(key);
        }
      );
    });
  } finally {
    kdfBusy = false;
  }
}
function regular(st: Stats, uid: number): void {
  if (
    !st.isFile() ||
    st.uid !== uid ||
    (st.mode & 0o7777) !== 0o600 ||
    st.nlink !== 1 ||
    st.size > MAX_RECORD_BYTES
  )
    throw denied();
}
/** Linux dirfd anchoring: no path-based check-then-open of a writable ancestor.
 * Parent/root custody and the caller's exact leaf inode/device are checked on every use.
 * No chmod/mkdir, recursive cleanup, lock stealing, or automatic stale-lock recovery. */
class Vault implements Disposable {
  readonly fd: number;
  constructor(readonly c: ScaP03LocalOperatorAuthConfigV1) {
    if (
      process.platform !== "linux" ||
      !path.isAbsolute(c.directory) ||
      path.normalize(c.directory) !== c.directory ||
      c.directory === "/" ||
      c.record_name === c.lock_name
    )
      throw denied();
    const opened: number[] = [];
    try {
      let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(fd);
      this.parent(fstatSync(fd));
      for (const part of c.directory.split("/").filter(Boolean)) {
        fd = openSync(
          `${c.descriptor_root}/${fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        opened.push(fd);
        this.parent(fstatSync(fd));
      }
      this.fd = fd;
      this.check();
      opened.pop();
    } finally {
      for (const fd of opened) closeSync(fd);
    }
  }
  private parent(st: Stats): void {
    const stickyRoot = st.uid === 0 && (st.mode & 0o1000) !== 0;
    if (
      !st.isDirectory() ||
      (st.uid !== 0 && st.uid !== this.c.custody_uid) ||
      ((st.mode & 0o022) !== 0 && !stickyRoot)
    )
      throw denied();
  }
  check(): void {
    const st = fstatSync(this.fd);
    if (
      !st.isDirectory() ||
      st.uid !== this.c.custody_uid ||
      (st.mode & 0o7777) !== 0o700 ||
      st.dev !== this.c.directory_dev ||
      st.ino !== this.c.directory_ino ||
      st.nlink < 1
    )
      throw denied();
    // Rewalk separately to detect moved/replaced directories or changed ancestor protections.
    const opened: number[] = [];
    try {
      let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(fd);
      this.parent(fstatSync(fd));
      for (const part of this.c.directory.split("/").filter(Boolean)) {
        fd = openSync(
          `${this.c.descriptor_root}/${fd}/${part}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        opened.push(fd);
        this.parent(fstatSync(fd));
      }
      const current = fstatSync(fd);
      if (current.dev !== st.dev || current.ino !== st.ino) throw denied();
    } finally {
      for (const fd of opened) closeSync(fd);
    }
  }
  file(name: string): string {
    return `${this.c.descriptor_root}/${this.fd}/${name}`;
  }
  absent(name: string): boolean {
    try {
      lstatSync(this.file(name));
      return false;
    } catch (error) {
      if (isMissing(error)) return true;
      throw denied();
    }
  }
  read(locked = false): CredentialRecord {
    this.check();
    if (!locked && !this.absent(this.c.lock_name)) throw denied();
    const fd = openSync(
      this.file(this.c.record_name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = fstatSync(fd);
      regular(before, this.c.custody_uid);
      const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
      try {
        let n = 0,
          count: number;
        do {
          count = readSync(fd, bytes, n, bytes.length - n, null);
          n += count;
        } while (count > 0 && n < bytes.length);
        if (n !== before.size || n > MAX_RECORD_BYTES) throw denied();
        const after = fstatSync(fd),
          named = lstatSync(this.file(this.c.record_name));
        regular(after, this.c.custody_uid);
        if (
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          named.ino !== after.ino ||
          named.dev !== after.dev
        )
          throw denied();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n));
        const value: unknown = JSON.parse(text);
        const r = validateContract(recordSchema, value, "P03 local credential");
        if (
          canonicalJson(r) !== text ||
          r.config_sha256 !== sha256(canonicalJson(this.c)) ||
          r.generation !== this.c.revocation_generation + (r.revoked ? 1 : 0) ||
          r.failures > this.c.max_attempts
        )
          throw denied();
        return r;
      } finally {
        bytes.fill(0);
      }
    } finally {
      closeSync(fd);
    }
  }
  mutate<T>(work: () => T): T {
    this.check();
    const lock = this.file(this.c.lock_name);
    const fd = openSync(
      lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      regular(fstatSync(fd), this.c.custody_uid);
      fsyncSync(fd);
      fsyncSync(this.fd);
      return work();
    } finally {
      closeSync(fd);
      unlinkSync(lock);
      fsyncSync(this.fd);
    }
  }
  write(record: CredentialRecord, provision = false): void {
    this.check();
    // Validate BEFORE any file creation. Temporary and final names live under one held dirfd.
    const validated = validateContract(recordSchema, record, "P03 local credential");
    const bytes = Buffer.from(canonicalJson(validated));
    if (bytes.length > MAX_RECORD_BYTES) throw denied();
    const temp = this.file(`${this.c.record_name}.${randomBytes(16).toString("hex")}`);
    let fd: number | undefined;
    let failed = false;
    try {
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      regular(fstatSync(fd), this.c.custody_uid);
      let n = 0;
      while (n < bytes.length) {
        const wrote = writeSync(fd, bytes, n, bytes.length - n);
        if (wrote <= 0) throw denied();
        n += wrote;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.check();
      if (provision) {
        linkSync(temp, this.file(this.c.record_name));
        unlinkSync(temp);
      } else {
        regular(lstatSync(this.file(this.c.record_name)), this.c.custody_uid);
        renameSync(temp, this.file(this.c.record_name));
      }
      fsyncSync(this.fd);
    } catch {
      failed = true;
    } finally {
      bytes.fill(0);
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          failed = true;
        }
      }
    }
    try {
      unlinkSync(temp);
    } catch (error) {
      if (!isMissing(error)) failed = true;
    }
    if (failed) throw denied();
  }
  [Symbol.dispose](): void {
    closeSync(this.fd);
  }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Private component: never uses Input/Editor, history, kill ring, clipboard, messages,
 * artifacts, logs, environment, child processes, or a secret-bearing completion value.
 * Like the native gate, this trusts the entire native host/terminal and loaded extensions.
 * UI custom input is NOT an isolation mechanism against in-process raw input observers. */
async function masked(
  ctx: ExtensionCommandContext,
  enrollment: boolean,
  signal: AbortSignal,
  labels: readonly string[],
  work: (secret: Buffer, signal: AbortSignal) => Promise<void>
): Promise<void> {
  signal.throwIfAborted();
  let failed = false;
  await ctx.ui.custom<void>((tui, _theme, keys, done) => {
    const secret = Buffer.alloc(MAX_SECRET_BYTES),
      confirmation = Buffer.alloc(MAX_SECRET_BYTES);
    const controller = new AbortController();
    let length = 0,
      confirmLength = 0,
      confirming = false,
      busy = false,
      closed = false,
      invalid = false;
    let status = "";
    const wipe = () => {
      secret.fill(0);
      confirmation.fill(0);
      length = 0;
      confirmLength = 0;
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      if (!busy) wipe();
      signal.removeEventListener("abort", cancel);
      done();
    };
    const cancel = () => {
      if (busy) {
        controller.abort();
        status = "Cancelling; waiting for password derivation to release memory.";
        tui.requestRender();
      } else finish();
    };
    signal.addEventListener("abort", cancel, { once: true });
    const submit = async () => {
      if (
        invalid ||
        length === 0 ||
        Array.from(secret.subarray(0, length).toString("utf8")).length < MIN_SECRET_CODEPOINTS
      ) {
        status = "Use at least 15 characters, at most 1024 UTF-8 bytes. Escape cancels.";
        return;
      }
      if (enrollment && !confirming) {
        confirming = true;
        status = "";
        return;
      }
      if (
        enrollment &&
        (confirmLength !== length ||
          !timingSafeEqual(secret.subarray(0, length), confirmation.subarray(0, confirmLength)))
      ) {
        wipe();
        confirming = false;
        status = "Passphrases did not match. Start again or Escape to cancel.";
        return;
      }
      busy = true;
      status = "Checking passphrase. Escape cancels.";
      try {
        controller.signal.throwIfAborted();
        await work(secret.subarray(0, length), controller.signal);
      } catch {
        failed = true;
      } finally {
        busy = false;
        wipe();
        finish();
      }
    };
    return {
      handleInput(data: string) {
        if (closed) return;
        if (keys.matches(data, "tui.select.cancel")) {
          cancel();
          return;
        }
        if (busy) return;
        if (keys.matches(data, "tui.input.submit")) {
          void submit().then(() => tui.requestRender());
          return;
        }
        if (keys.matches(data, "tui.editor.deleteCharBackward")) {
          const target = confirming ? confirmation : secret;
          let n = confirming ? confirmLength : length;
          if (n > 0) {
            n--;
            while (n > 0 && (target[n] ?? 0) >= 0x80 && (target[n] ?? 0) < 0xc0) n--;
            target.fill(0, n);
          }
          if (confirming) confirmLength = n;
          else length = n;
          invalid = false;
          return;
        }
        // Bracketed paste is accepted as DATA; no clipboard API is invoked. Reject all
        // controls/escapes/lone surrogates; never echo rejected data or silently truncate.
        const text =
          data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~") ? data.slice(6, -6) : data;
        if (text.length > MAX_SECRET_BYTES || /[\p{Cc}\p{Cs}]/u.test(text)) {
          invalid = true;
          status = "Unsupported or oversized input. Backspace to clear error, Escape to cancel.";
          return;
        }
        const bytes = Buffer.from(text);
        try {
          const n = confirming ? confirmLength : length;
          if (n + bytes.length > MAX_SECRET_BYTES) {
            invalid = true;
            status = "Input exceeds 1024 bytes. Backspace or Escape.";
            return;
          }
          bytes.copy(confirming ? confirmation : secret, n);
          if (confirming) confirmLength += bytes.length;
          else length += bytes.length;
        } finally {
          bytes.fill(0);
        }
      },
      render(width: number) {
        if (width < 1 || !Number.isSafeInteger(width)) return [];
        return [
          enrollment ? "P03 local operator enrollment" : "P03 local operator login",
          ...labels,
          confirming ? "Confirm passphrase: [hidden]" : "Passphrase: [hidden]",
          status || "15+ characters. Enter submits; Escape cancels. Input is hidden.",
        ].flatMap((line) => {
          const wrapped: string[] = [];
          for (let start = 0; start < line.length; start += width)
            wrapped.push(line.slice(start, start + width));
          return wrapped;
        });
      },
      invalidate() {},
      dispose() {
        cancel();
        if (!busy) wipe();
      },
    };
  });
  // The handler must invalidate before reporting any work failure. Never pass
  // secrets or failure details through the UI component's completion value.
  if (failed) throw denied();
}

/** Explicit host-private composition only. Provision mode can enroll once but NEVER
 * authenticate; normal startup MUST use open_existing. The caller owns current-source
 * validation and the exact binding; this module does not instantiate a service or gate. */
export function createScaP03LocalOperatorAuthV1(input: {
  readonly mode: "provision" | "open_existing";
  readonly config: unknown;
  readonly binding: ScaP03InitialProposalBindingV1;
  readonly clock: ScaP03LocalOperatorClockV1;
  readonly assertCurrentInputs: (proposal: ScaP03InitialProposalV1) => void;
}): ScaP03LocalOperatorAuthV1 {
  const { mode, binding, clock, assertCurrentInputs } = input;
  const c = structuredClone(
    validateContract(
      ScaP03LocalOperatorAuthConfigV1Schema,
      input.config,
      "P03 local authentication config"
    )
  );
  if (
    c.session_idle_ms > c.session_absolute_ms ||
    !(binding instanceof ScaP03InitialProposalBindingV1) ||
    (mode !== "provision" && mode !== "open_existing")
  )
    throw denied();
  const vault = new Vault(c);
  const proposal = binding.proposal,
    ref = binding.proposal_ref;
  // All displayed values are validated public identifiers, never paths or secret input.
  const labels = Object.freeze([
    `Principal: ${c.principal_id}`,
    `Policy: ${c.policy_id}`,
    `Installation: ${c.installation_id}`,
    `Project: ${c.project_id}`,
    `Proposal: ${ref.artifact_id}`,
    `Proposal expires: ${proposal.expires_at}`,
    "Authentication is not approval.",
  ]);
  let session: Session | undefined,
    closed = false,
    commandBusy = false;
  let pending: AbortController | undefined;
  function clearSession() {
    session = undefined;
    pending?.abort();
  }
  let lastWall = 0,
    lastMono = 0;
  function now() {
    const wall = clock.now().getTime(),
      mono = clock.monotonicMs();
    if (
      !Number.isSafeInteger(wall) ||
      wall < lastWall ||
      !Number.isFinite(mono) ||
      mono < lastMono
    ) {
      session = undefined;
      throw denied();
    }
    lastWall = wall;
    lastMono = mono;
    return { wall, mono };
  }
  function checkProposal(p = proposal) {
    if (closed) throw denied();
    binding.assertProposal(p);
    binding.assertRef(ref);
    binding.readControl(ref, "proposal");
    assertCurrentInputs(p);
    const t = now();
    if (
      t.wall < Date.parse(p.not_before) ||
      t.wall >= Date.parse(p.expires_at) ||
      c.principal_id !== p.principal_id ||
      c.policy_id !== p.policy_id ||
      c.installation_id !== p.installation_id ||
      c.project_id !== p.project_id ||
      c.state_authority_sha256 !== p.state_authority_sha256 ||
      c.backend_resource_sha256 !== p.backend_resource_sha256 ||
      c.revocation_generation !== p.revocation_generation ||
      !c.permitted_effects.includes(p.effect)
    )
      throw denied();
    return t;
  }
  function read(locked = false) {
    if (closed) throw denied();
    const r = vault.read(locked);
    if (now().wall < r.last_at) throw denied();
    return r;
  }
  function authenticated() {
    checkProposal();
    const r = read(),
      t = now(),
      s = session;
    if (
      mode !== "open_existing" ||
      r.revoked ||
      s === undefined ||
      r.epoch !== s.epoch ||
      r.credential_id !== s.credential ||
      t.wall >= Date.parse(proposal.expires_at) ||
      t.wall >= s.wall + c.session_absolute_ms ||
      t.mono >= s.mono + c.session_absolute_ms ||
      t.mono >= s.touched + c.session_idle_ms
    ) {
      session = undefined;
      throw denied();
    }
    return { t, r, s };
  }
  try {
    checkProposal();
    if (mode === "open_existing") read();
    else {
      vault.check();
      if (!vault.absent(c.record_name) || !vault.absent(c.lock_name)) throw denied();
    }
  } catch {
    vault[Symbol.dispose]();
    throw denied();
  }
  const profile: ScaP03TrustedInitialProfileV1 = Object.freeze({
    current() {
      let revoked = true,
        generation = c.revocation_generation;
      try {
        const r = read();
        generation = r.generation;
        authenticated();
        revoked = false;
      } catch {
        session = undefined;
      }
      return Object.freeze({
        principal_id: c.principal_id,
        policy_id: c.policy_id,
        installation_id: c.installation_id,
        project_id: c.project_id,
        state_authority_sha256: c.state_authority_sha256,
        backend_resource_sha256: c.backend_resource_sha256,
        revocation_generation: generation,
        revoked,
        permitted_effects: Object.freeze([...c.permitted_effects]),
      });
    },
    now: () => new Date(now().wall),
    assertCurrentInputs(p: ScaP03InitialProposalV1) {
      checkProposal(p);
      authenticated();
    },
    authenticatedInteractivePrincipal(event: ScaP03InitialHumanEventV1) {
      try {
        const e = validateContract(ScaP03InitialHumanEventV1Schema, event, "P03 local UI event");
        const { t, s } = authenticated();
        if (
          !verifyExecutionOwnerSignature(e) ||
          canonicalJson(e.artifact_ref) !== canonicalJson(ref) ||
          e.run_id !== proposal.run_id ||
          e.decision !== e.response ||
          Date.parse(e.timestamp) < s.wall ||
          Date.parse(e.timestamp) > t.wall
        )
          return undefined;
        s.touched = t.mono;
        return c.principal_id;
      } catch {
        session = undefined;
        return undefined;
      }
    },
  });
  function invalidate(durable: boolean, revoke: boolean) {
    session = undefined;
    if (durable)
      vault.mutate(() => {
        const r = read(true);
        if (r.revoked) return;
        vault.write({
          ...r,
          epoch: randomBytes(32).toString("hex"),
          last_at: now().wall,
          revoked: revoke,
          generation: c.revocation_generation + (revoke ? 1 : 0),
        });
      });
  }
  async function enroll(secret: Buffer, signal: AbortSignal) {
    const salt = randomBytes(32),
      verifier = await derive(secret, salt);
    try {
      signal.throwIfAborted();
      checkProposal();
      vault.mutate(() => {
        signal.throwIfAborted();
        if (!vault.absent(c.record_name)) throw denied();
        vault.write(
          {
            schema_version: 1,
            config_sha256: sha256(canonicalJson(c)),
            credential_id: randomBytes(32).toString("hex"),
            kdf: KDF,
            salt: salt.toString("hex"),
            verifier: verifier.toString("hex"),
            generation: c.revocation_generation,
            revoked: false,
            failures: 0,
            next_attempt_at: 0,
            last_at: now().wall,
            epoch: randomBytes(32).toString("hex"),
          },
          true
        );
      });
    } finally {
      salt.fill(0);
      verifier.fill(0);
    }
  }
  function eligible(r: CredentialRecord) {
    const t = checkProposal();
    if (r.revoked || r.failures >= c.max_attempts || t.wall < r.next_attempt_at) throw denied();
  }
  async function login(secret: Buffer, signal: AbortSignal) {
    // Reserve and durably charge BEFORE KDF. An interrupted/failed attempt counts.
    const charged = vault.mutate(() => {
      const r = read(true);
      eligible(r);
      signal.throwIfAborted();
      const next = {
        ...r,
        failures: r.failures + 1,
        next_attempt_at: now().wall + c.attempt_delay_ms,
        last_at: now().wall,
        epoch: randomBytes(32).toString("hex"),
      };
      vault.write(next);
      return next;
    });
    const verifier = await derive(secret, Buffer.from(charged.salt, "hex"));
    try {
      signal.throwIfAborted();
      const expected = Buffer.from(charged.verifier, "hex");
      try {
        if (!timingSafeEqual(verifier, expected)) throw denied();
      } finally {
        expected.fill(0);
      }
      const nextSession = vault.mutate(() => {
        const r = read(true),
          t = checkProposal();
        signal.throwIfAborted();
        if (r.revoked || r.epoch !== charged.epoch || r.credential_id !== charged.credential_id)
          throw denied();
        vault.write({ ...r, failures: 0, next_attempt_at: 0, last_at: t.wall });
        return {
          epoch: r.epoch,
          credential: r.credential_id,
          wall: t.wall,
          mono: t.mono,
          touched: t.mono,
        };
      });
      // Publish only after commit, lock cleanup, and final directory fsync succeed.
      signal.throwIfAborted();
      session = nextSession;
    } finally {
      verifier.fill(0);
    }
  }
  return Object.freeze({
    profile,
    registerCommands(pi: ExtensionAPI) {
      pi.on("session_shutdown", clearSession);
      pi.on("session_before_switch", clearSession);
      pi.on("session_before_fork", clearSession);
      pi.on("session_before_tree", clearSession);
      pi.on("session_before_compact", clearSession);
      pi.registerCommand("sca-p03-auth", {
        description:
          "Host-private P03 operator enrollment/login/logout/revocation. Never an approval or broker tool. No passphrase arguments.",
        async handler(args, ctx) {
          if (
            closed ||
            commandBusy ||
            ctx.mode !== "tui" ||
            !ctx.hasUI ||
            !ctx.isIdle() ||
            !["enroll", "login", "logout", "revoke"].includes(args)
          ) {
            ctx.ui.notify(
              "P03 operator authentication unavailable. Use enroll | login | logout | revoke without secret arguments.",
              "error"
            );
            return;
          }
          commandBusy = true;
          pending = new AbortController();
          const signal = AbortSignal.any(
            ctx.signal === undefined ? [pending.signal] : [pending.signal, ctx.signal]
          );
          try {
            signal.throwIfAborted();
            if (args === "logout" || args === "revoke") {
              invalidate(mode === "open_existing", args === "revoke");
              ctx.ui.notify("P03 operator session cleared.", "info");
              return;
            }
            session = undefined;
            checkProposal();
            if (args === "enroll") {
              if (mode !== "provision" || !vault.absent(c.record_name)) throw denied();
              await masked(ctx, true, signal, labels, async (secret, signal) => {
                await enroll(secret, signal);
                ctx.ui.notify(
                  "P03 operator enrolled. Restart with open_existing; enrollment is not login or approval.",
                  "info"
                );
              });
            } else {
              if (mode !== "open_existing") throw denied();
              eligible(read());
              // A new login invalidates even an existing session in a different host instance.
              invalidate(true, false);
              await masked(ctx, false, signal, labels, async (secret, signal) => {
                await login(secret, signal);
                ctx.ui.notify(
                  "P03 operator authenticated for the pinned proposal. Signed questionnaire approval is still required.",
                  "info"
                );
              });
            }
          } catch {
            session = undefined;
            ctx.ui.notify("P03 operator authentication unavailable or cancelled.", "error");
          } finally {
            pending = undefined;
            commandBusy = false;
          }
        },
      });
    },
    [Symbol.dispose]() {
      if (!closed) {
        clearSession();
        closed = true;
        vault[Symbol.dispose]();
      }
    },
  });
}
