import { Type } from "typebox";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  statfsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { MediaExecutableBindingV1, MediaRuntimeFileV1 } from "./confined-media-runner.js";
import { validatePortablePath } from "../videogen/portable-package.js";

import {
  NATIVE_VERBS,
  NATIVE_DRIVER_PROTOCOL,
  decodeNativePhase,
  PACKAGED_NATIVE_DRIVER_SHA256,
  nativeInputDigest,
  type NativeVerb,
  type NativePhaseObservation,
} from "../videogen/native-phase-protocol.js";
export { NATIVE_VERBS, type NativeVerb } from "../videogen/native-phase-protocol.js";
const closed = { additionalProperties: false } as const;
const digestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const locationSchema = Type.String({ minLength: 1, maxLength: 4096 });
const runtimeFileSchema = Type.Object(
  { source: locationSchema, target: locationSchema, sha256: digestSchema },
  closed
);
const executableSchema = Type.Object({ path: locationSchema, sha256: digestSchema }, closed);
export const ConfinedNativeBindingsSchema = Type.Object(
  {
    bubblewrap: executableSchema,
    prlimit: executableSchema,
    unshare: executableSchema,
    mount: executableSchema,
    shell: executableSchema,
    driver: runtimeFileSchema,
    runtime_files: Type.Array(runtimeFileSchema, { maxItems: 32768 }),
    scratch_root: locationSchema,
    max_runtime_bytes: Type.Integer({ minimum: 1, maximum: 2147483648 }),
    evidence_protocol: Type.Optional(
      Type.Object(
        {
          protocol: Type.Literal(NATIVE_DRIVER_PROTOCOL),
          editor_target: locationSchema,
          renderer_target: locationSchema,
        },
        closed
      )
    ),
  },
  closed
);
export interface ConfinedNativeBindings {
  readonly bubblewrap: MediaExecutableBindingV1;
  readonly prlimit: MediaExecutableBindingV1;
  /** Trusted namespace/mount bootstrap, snapshotted like Bubblewrap. No host mounts or install.
   * Missing user-namespace/mount support refuses before the driver can run. */
  readonly unshare: MediaExecutableBindingV1;
  readonly mount: MediaExecutableBindingV1;
  readonly shell: MediaExecutableBindingV1;
  /** Deployment-controlled adapter executable, NOT an invented Kdenlive command-line API.
   * Fixed protocol: argv[1]=verb; read-only project at /input/project.kdenlive and assets at
   * /input/<relative_path>; stdout=complete saved project for first three verbs, render bytes
   * for render_compare. Driver must own private GUI/display/bus if the editor requires them.
   * The executable+all dependencies are snapshots, never a request-selected callback. */
  readonly driver: MediaRuntimeFileV1;
  readonly runtime_files: readonly MediaRuntimeFileV1[];
  readonly scratch_root: string;
  readonly max_runtime_bytes: number;
  /** Additive verified ABI. Only the packaged driver can produce phase observations. */
  readonly evidence_protocol?: {
    readonly protocol: typeof NATIVE_DRIVER_PROTOCOL;
    readonly editor_target: string;
    readonly renderer_target: string;
  };
}
export interface NativeProcessPolicy {
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  /** Aggregate allocation and inode ceilings for the ONE writable mounted filesystem. */
  readonly max_writable_bytes: number;
  readonly max_writable_inodes: number;
  readonly max_diagnostic_bytes: number;
  readonly inactivity_ms: number;
  readonly max_elapsed_ms?: number;
  readonly address_space_bytes: number;
  readonly cpu_seconds: number;
  readonly max_processes: number;
  readonly max_open_files: number;
}
const trusted = new WeakSet<object>();
const observations = new WeakMap<object, () => boolean>();
function observationDigest(o: NativePhaseObservation): string {
  return sha256(
    canonicalJson({
      header: o.header,
      bytes: sha256(o.bytes),
      driver_sha256: o.driver_sha256,
      elapsed_ms: o.elapsed_ms,
    })
  );
}
function fail(message: string): never {
  throw new Error(`native runner: ${message}`);
}
function pinned(source: string, digest: string, cap: number): Buffer {
  if (
    !path.isAbsolute(source) ||
    realpathSync(source) !== source ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    fail("canonical pin required");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o022) !== 0 || s.size < 0 || s.size > cap)
      fail("unsafe runtime file");
    const bytes = readFileSync(fd);
    if (bytes.length !== s.size || sha256(bytes) !== digest) fail("runtime pin drift");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
/** Linux x86-64 seccomp ABI. Unknown architectures (including compat/x32 syscalls) refuse.
 * Dropping capabilities alone is insufficient: a child could otherwise create a new user/mount
 * namespace and mount an uncapped tmpfs, or allocate an anonymous writable memfd filesystem.
 * Classic BPF uses struct sock_filter {u16 code,u8 jt,u8 jf,u32 k}. The filter is inherited across
 * exec/fork and cannot be weakened. No external filter/allow callback is accepted. */
function nativeFilesystemFilter(): Buffer {
  if (process.arch !== "x64") fail("bounded filesystem seccomp architecture unsupported");
  const instructions: { code: number; jt: number; jf: number; k: number }[] = [];
  const add = (code: number, k: number, jt = 0, jf = 0): void => {
    instructions.push({ code, jt, jf, k });
  };
  add(0x20, 4); // seccomp_data.arch
  add(0x15, 0xc000003e, 1, 0); // AUDIT_ARCH_X86_64
  add(0x06, 0x80000000); // KILL_PROCESS for a compat architecture
  add(0x20, 0); // seccomp_data.nr
  add(0x35, 0x40000000, 0, 1); // x32 syscall bit, including alternate ABI numbers
  add(0x06, 0x00050026); // ERRNO ENOSYS
  // pivot_root, chroot, mount, umount2, unshare, setns, memfd_create, open_tree,
  // move_mount, fsopen, fsconfig, fsmount, mount_setattr (Linux UAPI unistd_64.h).
  for (const number of [155, 161, 165, 166, 272, 308, 319, 428, 429, 430, 431, 432, 442]) {
    add(0x15, number, 0, 1);
    add(0x06, 0x00050001); // ERRNO EPERM
  }
  add(0x06, 0x7fff0000); // ALLOW remaining syscalls; other process/FS/network controls still apply
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => {
    bytes.writeUInt16LE(instruction.code, index * 8);
    bytes.writeUInt8(instruction.jt, index * 8 + 2);
    bytes.writeUInt8(instruction.jf, index * 8 + 3);
    bytes.writeUInt32LE(instruction.k, index * 8 + 4);
  });
  return bytes;
}
export class ConfinedNativeRunner {
  readonly #b: ConfinedNativeBindings;
  #active = false;
  constructor(binding: ConfinedNativeBindings) {
    binding = validateSkillSchema(ConfinedNativeBindingsSchema, binding, "native runtime bindings");
    if (
      new.target !== ConfinedNativeRunner ||
      process.platform !== "linux" ||
      process.getuid?.() === 0 ||
      !Number.isSafeInteger(binding.max_runtime_bytes) ||
      binding.max_runtime_bytes < 1 ||
      binding.max_runtime_bytes > 2147483648 ||
      binding.runtime_files.length > 32768
    )
      fail("bounded nonroot Linux bindings required");
    if (!binding.unshare || !binding.mount || !binding.shell)
      fail("bounded writable filesystem bootstrap bindings required");
    nativeFilesystemFilter();
    if (
      new Set([binding.driver, ...binding.runtime_files].map((f) => f.target.split("/")[1])).size >
      512
    )
      fail("runtime namespace count limit");
    this.#b = structuredClone(binding);
    this.scratch();
    const files = [binding.driver, ...binding.runtime_files],
      targets = files.map((f) => f.target);
    for (const target of targets)
      if (
        !/^\/(?:[A-Za-z0-9_+.-]+\/)*[A-Za-z0-9_+.-]+$/u.test(target) ||
        target.split("/").some((p) => p === ".." || p === ".") ||
        ["/input", "/tmp", "/proc", "/dev", "/work"].some(
          (p) => target === p || target.startsWith(`${p}/`)
        )
      )
        fail("unsafe runtime target");
    if (
      new Set(targets).size !== targets.length ||
      targets.some((a) => targets.some((b) => a !== b && b.startsWith(`${a}/`)))
    )
      fail("runtime target collision");
    if (binding.evidence_protocol !== undefined) {
      const e = binding.evidence_protocol;
      if (
        e.protocol !== NATIVE_DRIVER_PROTOCOL ||
        binding.driver.sha256 !== PACKAGED_NATIVE_DRIVER_SHA256 ||
        ![e.editor_target, e.renderer_target].every((t) =>
          binding.runtime_files.some((f) => f.target === t)
        )
      )
        fail("packaged evidence driver and runtime pins required");
    }
    trusted.add(this);
    Object.freeze(this);
  }
  static isTrusted(value: unknown): value is ConfinedNativeRunner {
    return typeof value === "object" && value !== null && trusted.has(value);
  }
  /** Exact build pins must name files that this runner actually snapshots. */
  hasRuntimeDigest(digest: string): boolean {
    return [this.#b.driver, ...this.#b.runtime_files].some((f) => f.sha256 === digest);
  }
  private scratch(): void {
    const s = lstatSync(this.#b.scratch_root);
    if (
      !path.isAbsolute(this.#b.scratch_root) ||
      realpathSync(this.#b.scratch_root) !== this.#b.scratch_root ||
      !s.isDirectory() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0
    )
      fail("private scratch root required");
  }
  get editorDigest(): string | undefined {
    return this.#b.runtime_files.find((f) => f.target === this.#b.evidence_protocol?.editor_target)
      ?.sha256;
  }
  get rendererDigest(): string | undefined {
    return this.#b.runtime_files.find(
      (f) => f.target === this.#b.evidence_protocol?.renderer_target
    )?.sha256;
  }
  get supportsPhaseEvidence(): boolean {
    return this.#b.evidence_protocol !== undefined;
  }
  async run(input: Parameters<ConfinedNativeRunner["runObserved"]>[0]): Promise<Buffer> {
    return this.#b.evidence_protocol === undefined
      ? this.execute(input)
      : (await this.runObserved(input)).bytes;
  }
  async runObserved(input: {
    readonly verb: NativeVerb;
    readonly files: readonly { relative_path: string; bytes: Uint8Array }[];
    readonly policy: NativeProcessPolicy;
    readonly signal: AbortSignal;
  }): Promise<NativePhaseObservation> {
    const e = this.#b.evidence_protocol;
    if (e === undefined || this.#b.driver.sha256 !== PACKAGED_NATIVE_DRIVER_SHA256)
      fail("packaged phase evidence driver required");
    if (input.files.some((f) => f.relative_path === "native-call.json"))
      fail("reserved native correlation input");
    const nonce = randomBytes(32).toString("hex");
    const inputs_sha256 = nativeInputDigest(input.files);
    const runtime_sha256 = sha256(
      canonicalJson(
        [this.#b.driver, ...this.#b.runtime_files].map((f) => ({
          target: f.target,
          sha256: f.sha256,
        }))
      )
    );
    const manifest = input.files.map((f) => ({
      relative_path: f.relative_path,
      sha256: sha256(f.bytes),
      bytes: f.bytes.byteLength,
    }));
    const control = Buffer.from(
      canonicalJson({
        protocol: NATIVE_DRIVER_PROTOCOL,
        nonce,
        verb: input.verb,
        inputs_sha256,
        runtime_sha256,
        files: manifest,
      })
    );
    const started = performance.now();
    const output = await this.execute({
      ...input,
      files: [...input.files, { relative_path: "native-call.json", bytes: control }],
    });
    const pin = (target: string) =>
      this.#b.runtime_files.find((f) => f.target === target)?.sha256 ??
      fail("phase executable pin missing");
    const checked = decodeNativePhase({
      output,
      verb: input.verb,
      nonce,
      inputs_sha256,
      runtime_sha256,
      editor_sha256: pin(e.editor_target),
      renderer_sha256: pin(e.renderer_target),
      files: input.files,
      runtime_files: this.#b.runtime_files,
    });
    const result: NativePhaseObservation = Object.freeze({
      ...checked,
      driver_sha256: this.#b.driver.sha256,
      elapsed_ms: Math.ceil(performance.now() - started),
    });
    const fingerprint = observationDigest(result);
    observations.set(result, () => observationDigest(result) === fingerprint);
    return result;
  }
  static isObserved(value: unknown): value is NativePhaseObservation {
    return typeof value === "object" && value !== null && observations.get(value)?.() === true;
  }
  private async execute(input: {
    readonly verb: NativeVerb;
    readonly files: readonly { relative_path: string; bytes: Uint8Array }[];
    readonly policy: NativeProcessPolicy;
    readonly signal: AbortSignal;
  }): Promise<Buffer> {
    if (this.#active || !NATIVE_VERBS.includes(input.verb)) fail("fixed verb/concurrency boundary");
    const p = input.policy;
    if (!Number.isSafeInteger(p.max_writable_bytes) || !Number.isSafeInteger(p.max_writable_inodes))
      fail("aggregate writable filesystem policy required");
    for (const n of Object.values(p))
      if (!Number.isSafeInteger(n) || n < 1) fail("finite process limits required");
    input.signal.throwIfAborted();
    this.scratch();
    if (
      input.files.length < 1 ||
      input.files.length > 1024 ||
      input.files.reduce((n, f) => n + BigInt(f.bytes.byteLength), 0n) > BigInt(p.max_input_bytes)
    )
      fail("input cap");
    const names = input.files.map((f) => validatePortablePath(f.relative_path));
    if (
      !names.includes("project.kdenlive") ||
      new Set(names.map((n) => n.toLowerCase())).size !== names.length
    )
      fail("project/path collision");
    this.#active = true;
    let stage: string | undefined;
    let seccompFd: number | undefined;
    const started = performance.now();
    try {
      stage = mkdtempSync(path.join(this.#b.scratch_root, "native-"));
      const root = stage;
      let total = 0;
      const snapshot = (name: string, source: string, digest: string): string => {
        input.signal.throwIfAborted();
        const bytes = pinned(source, digest, this.#b.max_runtime_bytes - total);
        total += bytes.length;
        const target = path.join(root, name);
        writeFileSync(target, bytes, { flag: "wx", mode: 0o500 });
        return target;
      };
      const bwrap = snapshot("bwrap", this.#b.bubblewrap.path, this.#b.bubblewrap.sha256),
        prlimit = snapshot("prlimit", this.#b.prlimit.path, this.#b.prlimit.sha256),
        unshare = snapshot("unshare", this.#b.unshare.path, this.#b.unshare.sha256),
        mount = snapshot("mount", this.#b.mount.path, this.#b.mount.sha256),
        shell = snapshot("shell", this.#b.shell.path, this.#b.shell.sha256);
      // Linux rounds tmpfs size to pages; round DOWN so policy can never be exceeded.
      const tmpfs = statfsSync("/dev/shm");
      // Linux tmpfs reports its kernel allocation/page unit as f_bsize. Refuse unsupported
      // hosts instead of assuming a 4 KiB page and accidentally rounding a cap upward.
      if (tmpfs.type !== 0x01021994 || !Number.isSafeInteger(tmpfs.bsize) || tmpfs.bsize < 1)
        fail("tmpfs allocation unit unavailable");
      const writableBytes = Math.floor(p.max_writable_bytes / tmpfs.bsize) * tmpfs.bsize;
      if (writableBytes < tmpfs.bsize || p.max_writable_inodes < 4)
        fail("writable filesystem minimum");
      const writable = path.join(root, "writable");
      mkdirSync(writable, { mode: 0o700 });
      const filterPath = path.join(root, "filesystem-filter");
      writeFileSync(filterPath, nativeFilesystemFilter(), { flag: "wx", mode: 0o400 });
      seccompFd = openSync(filterPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const args = [
        "--seccomp",
        "3",
        "--unshare-all",
        "--unshare-user",
        "--unshare-net",
        "--unshare-pid",
        "--as-pid-1",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--setenv",
        "LC_ALL",
        "C",
        "--setenv",
        "HOME",
        "/tmp",
        ...(this.#b.evidence_protocol === undefined
          ? []
          : ["--proc", "/proc", "--remount-ro", "/proc"]),
        "--dev",
        "/dev",
        "--remount-ro",
        "/dev",
        "--bind",
        writable,
        "/work",
        "--dir",
        "/work/tmp",
        "--symlink",
        "/work/tmp",
        "/tmp",
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--dir",
        "/input",
      ];
      // Snapshot the exact closed file manifest into a new no-link tree. Bind only its
      // top-level directories, not thousands of per-file mounts (bwrap has an argv cap).
      const runtimeRoot = path.join(root, "runtime-tree");
      mkdirSync(runtimeRoot, { mode: 0o700 });
      for (const f of [this.#b.driver, ...this.#b.runtime_files]) {
        const name = path.join("runtime-tree", f.target.slice(1));
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true, mode: 0o700 });
        snapshot(name, f.source, f.sha256);
      }
      for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isFile()) fail("unsafe runtime namespace entry");
        args.push("--ro-bind", path.join(runtimeRoot, entry.name), `/${entry.name}`);
      }
      const inputs = path.join(root, "inputs");
      mkdirSync(inputs, { mode: 0o700 });
      for (const f of input.files) {
        const target = path.join(inputs, f.relative_path);
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, f.bytes, { flag: "wx", mode: 0o400 });
      }
      // Relocation uses a different mount root, with NO original /input name available.
      const relocated = input.verb === "relocate_reopen_readback";
      args.push(
        "--ro-bind",
        inputs,
        relocated ? "/relocated" : "/input",
        "--chdir",
        relocated ? "/relocated" : "/input",
        "--remount-ro",
        "/",
        "--",
        this.#b.driver.target,
        input.verb
      );
      const remaining =
        p.max_elapsed_ms === undefined
          ? undefined
          : p.max_elapsed_ms - (performance.now() - started);
      if (remaining !== undefined && remaining <= 0) fail("explicit elapsed cap");
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
          prlimit,
          [
            `--as=${p.address_space_bytes}:${p.address_space_bytes}`,
            `--cpu=${p.cpu_seconds}:${p.cpu_seconds}`,
            `--nproc=${p.max_processes}:${p.max_processes}`,
            `--nofile=${p.max_open_files}:${p.max_open_files}`,
            `--fsize=${p.max_output_bytes}:${p.max_output_bytes}`,
            "--core=0:0",
            "--",
            unshare,
            "--user",
            "--map-root-user",
            "--mount",
            "--net",
            "--pid",
            "--fork",
            "--kill-child=SIGKILL",
            shell,
            "-c",
            // Fixed launcher grammar: all variable values are positional, never shell source.
            // Mount exists only in this disposable user/mount namespace. A failure cannot fall
            // back to an uncapped directory. Bubblewrap removes mount capabilities for the driver.
            '"$1" -t tmpfs -o "size=$2,nr_inodes=$3,nodev,nosuid,noexec" tmpfs "$4" || exit 125; shift 4; exec "$@"',
            "native-bounded-bootstrap",
            mount,
            String(writableBytes),
            String(p.max_writable_inodes),
            writable,
            bwrap,
            ...args,
          ],
          {
            cwd: root,
            env: {},
            shell: false,
            detached: true,
            stdio: ["ignore", "pipe", "pipe", seccompFd],
          }
        );
        let failure: Error | undefined,
          size = 0,
          diagnostics = 0;
        const chunks: Buffer[] = [];
        const diagnosticChunks: Buffer[] = [];
        const kill = (reason: string): void => {
          failure ??= new Error(`native runner: ${reason}`);
          if (child.pid !== undefined)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* close is authoritative */
            }
        };
        const abort = (): void => kill("cancelled");
        input.signal.addEventListener("abort", abort, { once: true });
        const elapsed =
          remaining === undefined
            ? undefined
            : setTimeout(() => kill("explicit elapsed cap"), remaining);
        // Only complete output renews progress at the owner; stderr trickles never renew this clock.
        const idle = setTimeout(() => kill("output inactivity"), p.inactivity_ms);
        const stdout = child.stdout,
          stderr = child.stderr;
        if (stdout === null || stderr === null) kill("missing bounded process pipes");
        if (stdout !== null && stderr !== null) {
          stdout.on("data", (v: unknown) => {
            if (!Buffer.isBuffer(v)) return kill("invalid stdout");
            size += v.length;
            if (size > p.max_output_bytes) return kill("stdout limit");
            chunks.push(v);
          });
          stderr.on("data", (v: unknown) => {
            if (!Buffer.isBuffer(v)) return kill("invalid stderr");
            diagnostics += v.length;
            if (diagnostics > p.max_diagnostic_bytes) kill("diagnostic limit");
            else diagnosticChunks.push(v);
          });
          stdout.once("error", () => kill("stdout failed"));
          stderr.once("error", () => kill("stderr failed"));
        }
        child.once("error", () => {
          failure ??= new Error("native runner: launch failed");
        });
        child.once("close", (code, signal) => {
          if (elapsed !== undefined) clearTimeout(elapsed);
          clearTimeout(idle);
          input.signal.removeEventListener("abort", abort);
          if (failure !== undefined) reject(failure);
          else if (code !== 0 || signal !== null || size === 0)
            reject(
              new Error("native runner: driver/sandbox failed", {
                cause: { exit_code: code, signal, diagnostics: Buffer.concat(diagnosticChunks) },
              })
            );
          else resolve(Buffer.concat(chunks, size));
        });
        if (input.signal.aborted) abort();
      });
    } finally {
      if (seccompFd !== undefined) closeSync(seccompFd);
      if (stage !== undefined) rmSync(stage, { recursive: true, force: true });
      this.#active = false;
    }
  }
}

Object.freeze(ConfinedNativeRunner.prototype);
Object.freeze(ConfinedNativeRunner);
