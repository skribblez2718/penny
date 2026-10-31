/** Source-only trusted analyzers: descriptor process harness, pinned tracer and inherited seccomp.
 * Not a hostile-target/analyzer sandbox. Interpreter/library/filesystem closure is host-owned.
 */
import path from "node:path";
import { constants, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import {
  ScaProcessRequestV1Schema,
  ScaProcessResultV1Schema,
  type ScaProcessRequestV1,
  type ScaProcessResultV1,
} from "./ordinary-advanced-contracts.js";
import { ScaToolPathSchema } from "./ordinary-contracts.js";

export const ScaOfflineRunnerConfigSchema = Type.Object(
  {
    kind: Type.Literal("trusted-analyzer-socket-denial-v1"),
    workRoot: Type.String({ minLength: 1, maxLength: 4096 }),
    tracer: ScaToolPathSchema,
    /** Host-approved Python for the fixed silent seccomp launcher. Absence denies all socketpair. */
    ipc_python: Type.Optional(ScaToolPathSchema),
    trusted_analyzers_only: Type.Literal(true),
  },
  { additionalProperties: false }
);
export type ScaOfflineRunnerConfig = Static<typeof ScaOfflineRunnerConfigSchema>;
interface ProcessModule {
  runBoundedScaProcess(
    value: ScaProcessRequestV1,
    signal?: AbortSignal,
    activity?: () => void
  ): Promise<ScaProcessResultV1>;
}
function isProcessModule(value: unknown): value is ProcessModule {
  return (
    value !== null &&
    typeof value === "object" &&
    "runBoundedScaProcess" in value &&
    typeof value.runBoundedScaProcess === "function"
  );
}

// Linux seccomp-data offsets/ABI numbers, not a source- or model-selected program.
// Fail closed for other architectures, compat/x32 syscalls and filter installation failures.
// AF_TIPC also implements socketpair on Linux: only AF_UNIX, SOCK_STREAM (+ flags), protocol 0
// is admitted. Python asyncio's self-pipe uses this exact anonymous IPC form.
const IPC_LAUNCHER = `import ctypes, errno, json, os, platform, socket, sys
from ctypes import c_ushort, c_ubyte, c_uint, c_void_p, POINTER, Structure

class Filter(Structure):
    _fields_ = [("code", c_ushort), ("jt", c_ubyte), ("jf", c_ubyte), ("k", c_uint)]
class Program(Structure):
    _fields_ = [("len", c_ushort), ("filter", POINTER(Filter))]

machine = platform.machine()
if machine == "x86_64":
    arch, pair, sendto = 0xc000003e, 53, 44
    denied = [41, 42, 43, 46, 47, 49, 50, 288, 299, 307, 425, 426, 427, 438]
elif machine == "aarch64":
    arch, pair, sendto = 0xc00000b7, 199, 206
    denied = [198, 200, 201, 202, 203, 211, 212, 242, 243, 269, 425, 426, 427, 438]
else:
    raise RuntimeError("unsupported_offline_ipc_architecture")

# The descriptor harness supplies only /dev/null and anonymous local stdio pipes. Refuse
# network or named/control-plane stdio; close every other fd before analyzer/descendant exec.
for fd in range(3):
    try:
        s = socket.socket(fileno=os.dup(fd))
    except OSError as e:
        if e.errno != errno.ENOTSOCK:
            raise
    else:
        try:
            if s.family != socket.AF_UNIX or s.getsockname() not in ("", b"") or s.getpeername() not in ("", b""):
                raise RuntimeError("inherited_network_or_named_socket")
        finally:
            s.close()
os.closerange(3, os.sysconf("SC_OPEN_MAX"))

# Classic BPF. Each argument check includes its high word; no truncation/compat aliases.
code = [(0x20,0,0,4), (0x15,1,0,arch), (0x06,0,0,0x80000000),
        (0x20,0,0,0), (0x45,0,1,0x40000000), (0x06,0,0,0x50000 | errno.EPERM)]
for nr in denied:
    code += [(0x15,0,1,nr), (0x06,0,0,0x50000 | errno.EPERM)]
# send/sendto with no destination can write the self-pipe; addressed sends are forbidden.
checks = [(16,1), (20,0), (28,0), (32,0), (36,0)]
# type arg low word is masked to remove only NONBLOCK/CLOEXEC, then must be STREAM.
block = []
for offset, expected in checks:
    block += [(0x20,0,0,offset)]
    block += [(0x15,1,0,expected), (0x06,0,0,0x50000 | errno.EPERM)]
block += [(0x20,0,0,24), (0x54,0,0,0xffffffff ^ (socket.SOCK_NONBLOCK | socket.SOCK_CLOEXEC)),
          (0x15,1,0,socket.SOCK_STREAM), (0x06,0,0,0x50000 | errno.EPERM), (0x06,0,0,0x7fff0000)]
code += [(0x15,0,len(block),pair)] + block
block = []
for offset in (48,52,56,60):
    block += [(0x20,0,0,offset), (0x15,1,0,0), (0x06,0,0,0x50000 | errno.EPERM)]
block += [(0x06,0,0,0x7fff0000)]
code += [(0x15,0,len(block),sendto)] + block + [(0x06,0,0,0x7fff0000)]
filters = (Filter * len(code))(*(Filter(*row) for row in code))
program = Program(len(code), filters)
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
libc.prctl.restype = ctypes.c_int
if libc.prctl(38,1,0,0,0) != 0 or libc.prctl(22,2,ctypes.addressof(program),0,0) != 0:
    raise OSError(ctypes.get_errno(), "offline_seccomp_install_failed")
os.execve(sys.argv[2], sys.argv[2:], json.loads(sys.argv[1]))
`;

async function sealExecutable(
  tool: { executable: string; sha256: string },
  file: string,
  signal?: AbortSignal
) {
  const source = await open(tool.executable, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size > 536870912 || (before.mode & 0o111) === 0)
      throw new Error("Offline tool must be a bounded executable regular file");
    const sealed = await open(file, "wx+", 0o600);
    try {
      const hash = createHash("sha256"),
        chunk = Buffer.alloc(65536);
      let size = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await source.read(chunk, 0, chunk.length, size);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > 536870912) throw new Error("Offline tool grew beyond limit");
        const bytes = chunk.subarray(0, bytesRead);
        hash.update(bytes);
        await sealed.writeFile(bytes);
      }
      const after = await source.stat();
      if (
        hash.digest("hex") !== tool.sha256 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Offline tool identity drift");
      await sealed.chmod(0o500);
    } finally {
      await sealed.close();
    }
    return await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } finally {
    await source.close();
  }
}

/** Fixed installed module and fixed launcher; no source/model-selected command or fallback. */
export function createScaOfflineRunner(configValue: unknown) {
  const config = validateContract(ScaOfflineRunnerConfigSchema, configValue, "Offline host runner");
  for (const file of [
    config.workRoot,
    config.tracer.executable,
    ...(config.ipc_python === undefined ? [] : [config.ipc_python.executable]),
  ])
    if (!path.isAbsolute(file) || file.includes("\0"))
      throw new Error("Offline host paths invalid");
  const root = lstatSync(config.workRoot);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid?.() ||
    (root.mode & 0o777) !== 0o700 ||
    realpathSync(config.workRoot) !== config.workRoot
  )
    throw new Error("Offline work root must be canonical and owner-private");
  return {
    workRoot: config.workRoot,
    async runOffline(
      value: ScaProcessRequestV1,
      signal?: AbortSignal,
      activity?: () => void
    ): Promise<ScaProcessResultV1> {
      const request = validateContract(ScaProcessRequestV1Schema, value, "Offline process");
      signal?.throwIfAborted();
      const directory = await mkdtemp(path.join(config.workRoot, "offline-executable-"));
      try {
        const executable = await sealExecutable(
          { executable: request.executable, sha256: request.executable_sha256 },
          path.join(directory, "analyzer"),
          signal
        );
        try {
          const python =
            config.ipc_python === undefined
              ? undefined
              : await sealExecutable(config.ipc_python, path.join(directory, "python"), signal);
          try {
            const module: unknown = await import(
              new URL("../../../sca-service/dist/process.js", import.meta.url).href
            );
            if (!isProcessModule(module))
              throw new Error("Installed bounded process harness absent");
            const analyzer = `/proc/${process.pid}/fd/${executable.fd}`;
            const wrapped = {
              ...request,
              executable: config.tracer.executable,
              executable_sha256: config.tracer.sha256,
              // Analyzer-specific loader settings must not affect the tracer/launcher ABI.
              // Restore the exact original environment only at the final filtered exec.
              environment:
                python === undefined
                  ? request.environment
                  : request.environment.filter(
                      (x) => !x.name.startsWith("LD_") && !x.name.startsWith("PYTHON")
                    ),
              arguments: [
                "-f",
                "-qq",
                "-e",
                "trace=socket,connect",
                "-o",
                "/dev/null",
                "-e",
                "inject=socket:error=EPERM",
                "-e",
                "inject=connect:error=EPERM",
                ...(python === undefined
                  ? ["-e", "inject=socketpair:error=EPERM", "--", analyzer]
                  : [
                      "--",
                      `/proc/${process.pid}/fd/${python.fd}`,
                      "-I",
                      "-S",
                      "-B",
                      "-c",
                      IPC_LAUNCHER,
                      JSON.stringify(
                        Object.fromEntries(request.environment.map((x) => [x.name, x.value]))
                      ),
                      analyzer,
                    ]),
                ...request.arguments,
              ],
            };
            const result = validateContract(
              ScaProcessResultV1Schema,
              await module.runBoundedScaProcess(wrapped, signal, activity),
              "Confined analyzer result"
            );
            if (result.request_sha256 !== sha256(canonicalJson(wrapped)))
              throw new Error("Confined process request drift");
            // Translate only the wrapper address. Native status/streams/digests remain untouched.
            return { ...result, request_sha256: sha256(canonicalJson(request)) };
          } finally {
            await python?.close();
          }
        } finally {
          await executable.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
