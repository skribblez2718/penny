import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";

const Hex = Type.String({ pattern: "^[a-f0-9]{64}$" });
const PinnedFile = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 4096 }), sha256: Hex },
  { additionalProperties: false }
);
const Limits = Type.Object(
  {
    startup_ms: Type.Integer({ minimum: 100, maximum: 300_000 }),
    runtime_ms: Type.Integer({ minimum: 100, maximum: 3_600_000 }),
    output_bytes: Type.Integer({ minimum: 256, maximum: 1_048_576 }),
    overlay_bytes: Type.Integer({ minimum: 1_048_576, maximum: 8_589_934_592 }),
    result_items: Type.Integer({ minimum: 1, maximum: 128 }),
    termination_ms: Type.Integer({ minimum: 100, maximum: 10_000 }),
  },
  { additionalProperties: false }
);
export const P07_VM_CONFIG_SCHEMA = Type.Object(
  {
    qemu: PinnedFile,
    qemu_img: PinnedFile,
    iso_builder: PinnedFile,
    base: PinnedFile,
    workspace_parent: Type.String({ minLength: 1, maxLength: 4096 }),
    expected_qemu_version: Type.String({ minLength: 1, maxLength: 512 }),
    expected_qemu_img_version: Type.String({ minLength: 1, maxLength: 512 }),
    expected_iso_version: Type.String({ minLength: 1, maxLength: 512 }),
    base_virtual_bytes: Type.Integer({ minimum: 1, maximum: 17_179_869_184 }),
    limits: Limits,
  },
  { additionalProperties: false }
);
export const P07_GUEST_PLAN_SCHEMA = Type.Object(
  {
    plan_sha256: Hex,
    policy_sha256: Hex,
    input_sha256: Hex,
    script: Type.String({ minLength: 1, maxLength: 8192 }),
  },
  { additionalProperties: false }
);
export type P07VmConfig = Static<typeof P07_VM_CONFIG_SCHEMA>;
export type P07GuestPlan = Static<typeof P07_GUEST_PLAN_SCHEMA>;

export type P07Failure =
  | "invalid"
  | "custody_drift"
  | "tool_drift"
  | "image_drift"
  | "startup_timeout"
  | "runtime_timeout"
  | "output_limit"
  | "overlay_limit"
  | "result_invalid"
  | "qemu_failure"
  | "cancelled"
  | "termination_uncertain"
  | "cleanup_uncertain";
export class P07VmError extends Error {
  constructor(
    readonly code: P07Failure,
    readonly workspace: string | null = null,
    options?: ErrorOptions
  ) {
    super(`p07_${code}`, options);
    this.name = "P07VmError";
  }
}
export interface P07VmResult {
  readonly bindings: Readonly<{
    plan_sha256: string;
    policy_sha256: string;
    input_sha256: string;
    image_sha256: string;
    runtime_sha256: string;
  }>;
  readonly items: readonly string[];
  readonly measurements: Readonly<{
    qemu_version: string;
    qemu_img_version: string;
    iso_version: string;
    base_virtual_bytes: number;
    base_bytes: number;
    qemu_bytes: number;
    qemu_img_bytes: number;
    iso_bytes: number;
    seed_sha256: string;
  }>;
  readonly termination_proved: true;
  readonly cleanup_proved: true;
}

function fail(code: P07Failure): never {
  throw new P07VmError(code);
}
function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function validPath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    !value.includes("\0") &&
    !value.split(path.sep).includes("..")
  );
}
async function ownedPath(
  value: string,
  directory: boolean,
  immutable: boolean
): Promise<import("node:fs").Stats> {
  if (!validPath(value)) fail("custody_drift");
  const resolved = await realpath(value).catch(() => fail("custody_drift"));
  if (resolved !== value) fail("custody_drift");
  const s = await lstat(value).catch(() => fail("custody_drift"));
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    uid === 0 ||
    (directory || immutable ? s.uid !== uid : s.uid !== uid && s.uid !== 0) ||
    (!directory && s.nlink !== 1) ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (s.mode & (directory ? 0o077 : immutable ? 0o222 : 0o022)) !== 0
  )
    fail("custody_drift");
  return s;
}
async function digestFile(file: string, max: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() =>
    fail("custody_drift")
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > max)
      fail("custody_drift");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(65_536);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - offset),
        offset
      );
      if (bytesRead === 0) fail("custody_drift");
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const name = await lstat(file);
    if (
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      name.ino !== before.ino
    )
      fail("custody_drift");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function measurePinned(pin: P07VmConfig["base"], max: number, image: boolean): Promise<void> {
  const s = await ownedPath(pin.path, false, image);
  if (s.size > max || (!image && (s.mode & constants.S_IXUSR) === 0)) fail("custody_drift");
  if (!image) {
    const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const magic = Buffer.alloc(4);
      if (
        (await handle.read(magic, 0, 4, 0)).bytesRead !== 4 ||
        !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      )
        fail("custody_drift");
    } finally {
      await handle.close();
    }
  }
  if ((await digestFile(pin.path, max)) !== pin.sha256) fail(image ? "image_drift" : "tool_drift");
}
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if (plain(e)?.code === "ESRCH") return false;
    return true;
  }
}
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Each command has a separate monotonic deadline; a child group is never assumed dead from a root exit alone. */
async function command(
  exe: string,
  argv: readonly string[],
  cwd: string,
  ms: number,
  max: number,
  terminationMs: number,
  signal?: AbortSignal,
  inspect?: () => Promise<void>,
  startupMs?: number,
  timeoutKind: "startup_timeout" | "runtime_timeout" = "runtime_timeout"
): Promise<Buffer> {
  if (signal?.aborted) fail("cancelled");
  const child = spawn(exe, [...argv], {
    cwd,
    shell: false,
    detached: true,
    env: { PATH: "/usr/bin:/bin", HOME: cwd, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnedError = false;
  child.on("error", () => {
    spawnedError = true;
  });
  const pid = child.pid;
  if (pid === undefined) fail("qemu_failure");
  const chunks: Buffer[] = [];
  let markerSeen = false;
  let markerTail = "";
  let bytes = 0;
  let reason: P07Failure | null = null;
  let closed = false;
  let exitCode: number | null = null;
  const started = performance.now();
  const stop = (why: P07Failure): void => {
    reason ??= why;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* checked below */
    }
  };
  const onAbort = (): void => stop("cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) stop("cancelled");
  const take = (data: Buffer): void => {
    bytes += data.length;
    if (bytes > max) stop("output_limit");
    else {
      chunks.push(data);
      if (startupMs !== undefined && !markerSeen) {
        const combined = markerTail + data.toString("latin1");
        markerSeen = combined.includes("PENNY_P07_RESULT_BEGIN");
        markerTail = combined.slice(-32);
      }
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("close", (code) => {
    exitCode = code;
    closed = true;
  });
  try {
    while (!closed && reason === null) {
      if (startupMs !== undefined && performance.now() - started >= startupMs && !markerSeen) {
        stop("startup_timeout");
        break;
      }
      if (performance.now() - started >= ms) {
        stop(timeoutKind);
        break;
      }
      if (inspect !== undefined) {
        try {
          await inspect();
        } catch (e) {
          stop(e instanceof P07VmError ? e.code : "overlay_limit");
          break;
        }
      }
      await tick(Math.min(50, Math.max(1, ms - (performance.now() - started))));
    }
    if (reason !== null) {
      const deadline = performance.now() + terminationMs;
      while (!closed && performance.now() < deadline) await tick(20);
      if (groupExists(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* checked below */
        }
      }
      while ((!closed || groupExists(pid)) && performance.now() < deadline + terminationMs)
        await tick(20);
    } else if (groupExists(pid)) {
      // A root process can leave descendants. Terminate and reject rather than credit its result.
      stop("termination_uncertain");
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* checked below */
      }
      const deadline = performance.now() + terminationMs;
      while (groupExists(pid) && performance.now() < deadline) await tick(20);
    }
    if (!closed || groupExists(pid)) fail("termination_uncertain");
    if (reason !== null) fail(reason);
    if (spawnedError || exitCode !== 0) fail("qemu_failure");
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function parseResult(
  serial: Buffer,
  bindings: P07VmResult["bindings"],
  maxItems: number
): readonly string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(serial);
  } catch {
    fail("result_invalid");
  }
  const start = "PENNY_P07_RESULT_BEGIN\n";
  const end = "\nPENNY_P07_RESULT_END";
  const i = text.indexOf(start);
  if (
    i < 0 ||
    text.slice(0, i).includes("PENNY_P07_RESULT_") ||
    text.indexOf(start, i + start.length) !== -1
  )
    fail("result_invalid");
  const j = text.indexOf(end, i + start.length);
  if (
    j < 0 ||
    text.indexOf(end, j + end.length) !== -1 ||
    text.includes("PENNY_P07_RESULT_", j + end.length)
  )
    fail("result_invalid");
  const body = text.slice(i + start.length, j);
  if (Buffer.byteLength(body) > 16_384 || !body.startsWith("{") || body.includes("\n"))
    fail("result_invalid");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    fail("result_invalid");
  }
  const obj = plain(value);
  if (
    obj === null ||
    !exactKeys(obj, ["bindings", "items"]) ||
    canonicalJson(value) !== body ||
    canonicalJson(obj.bindings) !== canonicalJson(bindings) ||
    !Array.isArray(obj.items) ||
    obj.items.length > maxItems ||
    !obj.items.every((x: unknown) => typeof x === "string" && Buffer.byteLength(x) <= 1024)
  )
    fail("result_invalid");
  const items: readonly unknown[] = obj.items;
  return items.map((item) => {
    if (typeof item !== "string") fail("result_invalid");
    return item;
  });
}
export { parseResult as parseP07SerialResult };

function guestSeed(plan: P07GuestPlan, bindings: P07VmResult["bindings"]): string {
  // The caller's script is base64 guest data. Only the guest's bash interpreter executes it.
  const script = Buffer.from(plan.script).toString("base64");
  const runner = `#!/bin/bash\nset +e\nbash /var/lib/penny/plan.sh >/dev/null 2>&1\nstatus=$?\n# Cloud-init prefixes command stdout in the console log. Emit the one framed\n# result directly to the serial device with newline translation disabled.\nstty -F /dev/ttyS0 -opost || exit 1\nSTATUS="$status" python3 - <<'PY' > /dev/ttyS0\nimport json, os\nbindings = ${JSON.stringify(bindings)}\nitems = []\nif os.environ['STATUS'] != '0': raise SystemExit(1)\ntry:\n with open('/var/lib/penny/items.json', 'rb') as f: raw = f.read(16385)\n if len(raw) > 16384: raise ValueError('items too large')\n items = json.loads(raw)\nexcept FileNotFoundError: pass\nprint('PENNY_P07_RESULT_BEGIN')\nprint(json.dumps({'bindings': bindings, 'items': items}, sort_keys=True, separators=(',', ':'), ensure_ascii=False))\nprint('PENNY_P07_RESULT_END', flush=True)\nPY\nshutdown -h now\n`;
  return `#cloud-config\n# binding-json: ${canonicalJson(bindings)}\nwrite_files:\n  - path: /var/lib/penny/plan.sh\n    encoding: b64\n    permissions: '0400'\n    content: ${script}\n  - path: /var/lib/penny/runner.sh\n    encoding: b64\n    permissions: '0500'\n    content: ${Buffer.from(runner).toString("base64")}\nruncmd:\n  - [ bash, /var/lib/penny/runner.sh ]\n`;
}

/** Opt-in qualification only: no broker registration, artifact authority or production containment claim. */
export async function runP07Qualification(
  configValue: unknown,
  planValue: unknown,
  signal?: AbortSignal
): Promise<P07VmResult> {
  let config: P07VmConfig;
  let plan: P07GuestPlan;
  try {
    config = validateContract(P07_VM_CONFIG_SCHEMA, configValue, "P07 VM config");
    plan = validateContract(P07_GUEST_PLAN_SCHEMA, planValue, "P07 guest plan");
  } catch {
    fail("invalid");
  }
  if (
    plan.plan_sha256 !==
      sha256(
        canonicalJson({
          policy_sha256: plan.policy_sha256,
          input_sha256: plan.input_sha256,
          script: plan.script,
        })
      ) ||
    plan.script.includes("\0") ||
    Buffer.byteLength(plan.script) > 8192 ||
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    ![config.qemu, config.qemu_img, config.iso_builder, config.base].every((p) =>
      validPath(p.path)
    ) ||
    !validPath(config.workspace_parent) ||
    /[,\r\n]/.test(config.workspace_parent) ||
    /[,\r\n]/.test(config.base.path)
  )
    fail("invalid");
  const kvm = await open("/dev/kvm", constants.O_RDWR).catch(() => fail("custody_drift"));
  try {
    if (!(await kvm.stat()).isCharacterDevice()) fail("custody_drift");
  } finally {
    await kvm.close();
  }
  await ownedPath(config.workspace_parent, true, false);
  for (const tool of [config.qemu, config.qemu_img, config.iso_builder])
    await measurePinned(tool, 256 * 1024 * 1024, false);
  await measurePinned(config.base, 17_179_869_184, true);
  if (signal?.aborted) fail("cancelled");
  const work = await mkdtemp(path.join(config.workspace_parent, "p07-"));
  let terminationUncertain = false;
  let outcome: P07VmResult | undefined;
  let error: unknown;
  try {
    const short = (exe: string, argv: readonly string[], max = 4096) =>
      command(
        exe,
        argv,
        work,
        config.limits.startup_ms,
        max,
        config.limits.termination_ms,
        signal,
        undefined,
        undefined,
        "startup_timeout"
      );
    const version = async (
      exe: string,
      argv: readonly string[],
      expected: string
    ): Promise<string> => {
      const measured = (await short(exe, argv)).toString("utf8").trim();
      if (measured !== expected) fail("tool_drift");
      return measured;
    };
    const qemuVersion = await version(
      config.qemu.path,
      ["--version"],
      config.expected_qemu_version
    );
    const imgVersion = await version(
      config.qemu_img.path,
      ["--version"],
      config.expected_qemu_img_version
    );
    const isoVersion = await version(
      config.iso_builder.path,
      ["--version"],
      config.expected_iso_version
    );
    let info: unknown;
    try {
      info = JSON.parse(
        (await short(config.qemu_img.path, ["info", "--output=json", config.base.path])).toString(
          "utf8"
        )
      );
    } catch (error) {
      if (error instanceof P07VmError) throw error;
      fail("image_drift");
    }
    const imageInfo = plain(info);
    if (
      imageInfo?.format !== "qcow2" ||
      imageInfo["virtual-size"] !== config.base_virtual_bytes ||
      imageInfo["backing-filename"] !== undefined ||
      imageInfo["backing-filename-format"] !== undefined
    )
      fail("image_drift");
    await measurePinned(config.base, 17_179_869_184, true);
    const runtimeSha = sha256(
      canonicalJson({
        qemu: config.qemu.sha256,
        qemu_img: config.qemu_img.sha256,
        iso: config.iso_builder.sha256,
        qemuVersion,
        imgVersion,
        isoVersion,
        profile: "p07-q35-kvm-nicless-v1",
        limits: config.limits,
        base_virtual_bytes: config.base_virtual_bytes,
      })
    );
    const bindings = {
      plan_sha256: plan.plan_sha256,
      policy_sha256: plan.policy_sha256,
      input_sha256: plan.input_sha256,
      image_sha256: config.base.sha256,
      runtime_sha256: runtimeSha,
    };
    await writeFile(path.join(work, "user-data"), guestSeed(plan, bindings), {
      flag: "wx",
      mode: 0o400,
    });
    await writeFile(
      path.join(work, "meta-data"),
      `instance-id: p07-${sha256(canonicalJson(bindings))}\nlocal-hostname: p07-offline\n`,
      { flag: "wx", mode: 0o400 }
    );
    const seed = path.join(work, "seed.iso");
    await short(config.iso_builder.path, [
      "-quiet",
      "-output",
      seed,
      "-volid",
      "cidata",
      "-joliet",
      "-rock",
      "user-data",
      "meta-data",
    ]);
    const seedStat = await lstat(seed);
    if (
      !seedStat.isFile() ||
      seedStat.nlink !== 1 ||
      seedStat.size < 34_816 ||
      seedStat.size > 1_048_576
    )
      fail("custody_drift");
    const seedHandle = await open(seed, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await seedHandle.stat()).ino !== seedStat.ino) fail("custody_drift");
      await seedHandle.chmod(0o400);
    } finally {
      await seedHandle.close();
    }
    const seedSha = await digestFile(seed, 1_048_576);
    const seedBytes = await readFile(seed, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    if (
      seedBytes.length !== seedStat.size ||
      sha256(seedBytes) !== seedSha ||
      seedBytes[32_768] !== 1 ||
      seedBytes.toString("ascii", 32_769, 32_774) !== "CD001" ||
      seedBytes[32_774] !== 1 ||
      seedBytes.toString("ascii", 32_808, 32_840).trim().toLowerCase() !== "cidata"
    )
      fail("custody_drift");
    const overlay = path.join(work, "overlay.qcow2");
    await short(config.qemu_img.path, [
      "create",
      "-f",
      "qcow2",
      "-F",
      "qcow2",
      "-b",
      config.base.path,
      overlay,
      String(config.base_virtual_bytes),
    ]);
    const overlaySize = async (): Promise<void> => {
      const s = await lstat(overlay);
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.size > config.limits.overlay_bytes ||
        s.blocks * 512 > config.limits.overlay_bytes
      )
        fail("overlay_limit");
    };
    await overlaySize();
    for (const tool of [config.qemu, config.qemu_img, config.iso_builder])
      await measurePinned(tool, 256 * 1024 * 1024, false);
    await measurePinned(config.base, 17_179_869_184, true);
    const serial = await command(
      config.qemu.path,
      [
        "-nodefaults",
        "-no-user-config",
        "-machine",
        "q35,accel=kvm",
        "-enable-kvm",
        "-smp",
        "1",
        "-m",
        "1024",
        "-display",
        "none",
        "-vga",
        "none",
        "-monitor",
        "none",
        "-parallel",
        "none",
        "-serial",
        "stdio",
        "-nic",
        "none",
        "-no-reboot",
        "-sandbox",
        "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
        "-drive",
        `file=${overlay},if=virtio,format=qcow2,cache=none`,
        "-drive",
        `file=${seed},if=none,id=seed,format=raw,readonly=on,media=cdrom`,
        "-device",
        "virtio-scsi-pci,id=scsi0",
        "-device",
        "scsi-cd,drive=seed",
      ],
      work,
      config.limits.runtime_ms,
      config.limits.output_bytes,
      config.limits.termination_ms,
      signal,
      overlaySize,
      config.limits.startup_ms
    );
    await overlaySize();
    if ((await digestFile(seed, 1_048_576)) !== seedSha) fail("custody_drift");
    for (const tool of [config.qemu, config.qemu_img, config.iso_builder])
      await measurePinned(tool, 256 * 1024 * 1024, false);
    await measurePinned(config.base, 17_179_869_184, true);
    const items = parseResult(serial, bindings, config.limits.result_items);
    outcome = {
      bindings,
      items,
      measurements: {
        qemu_version: qemuVersion,
        qemu_img_version: imgVersion,
        iso_version: isoVersion,
        base_virtual_bytes: config.base_virtual_bytes,
        base_bytes: (await lstat(config.base.path)).size,
        qemu_bytes: (await lstat(config.qemu.path)).size,
        qemu_img_bytes: (await lstat(config.qemu_img.path)).size,
        iso_bytes: (await lstat(config.iso_builder.path)).size,
        seed_sha256: seedSha,
      },
      termination_proved: true,
      cleanup_proved: true,
    };
  } catch (e) {
    error = e;
    terminationUncertain = e instanceof P07VmError && e.code === "termination_uncertain";
  }
  if (terminationUncertain) throw new P07VmError("termination_uncertain", work, { cause: error });
  try {
    await rm(work, { recursive: true, force: false });
    try {
      await stat(work);
      throw new Error("workspace still present");
    } catch (e) {
      if (plain(e)?.code !== "ENOENT") throw e;
    }
  } catch (e) {
    throw new P07VmError("cleanup_uncertain", work, { cause: { error, cleanup: e } });
  }
  if (error !== undefined) throw error;
  if (outcome === undefined) fail("result_invalid");
  return outcome;
}
