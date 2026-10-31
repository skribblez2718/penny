import { spawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateMediaPolicy, type MediaDecodePolicyV1 } from "../videogen/media-contracts.js";

export interface MediaRuntimeFileV1 {
  readonly source: string;
  readonly target: string;
  readonly sha256: string;
}
export interface MediaExecutableBindingV1 {
  readonly path: string;
  readonly sha256: string;
}
/** Construction-time trusted host bindings, never request/model data. No PATH lookup or installation. */
export interface ConfinedMediaBindingsV1 {
  readonly bubblewrap: MediaExecutableBindingV1;
  readonly prlimit: MediaExecutableBindingV1;
  readonly ffmpeg: MediaRuntimeFileV1;
  readonly ffprobe: MediaRuntimeFileV1;
  readonly runtime_files: readonly MediaRuntimeFileV1[];
  readonly scratch_root: string;
  readonly max_runtime_bytes: number;
}
export type MediaDecodeVerb =
  | "probe"
  | "video_rgba"
  | "audio_s16le"
  | "normalize_avc"
  | "av_probe"
  | "av_frames"
  | "av_video_rgba"
  | "av_audio_s16le";
export interface ConfinedMediaOutputV1 {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function pinnedFile(source: string, digest: string, maxBytes: number): Buffer {
  if (
    !path.isAbsolute(source) ||
    realpathSync(source) !== source ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new Error("media binding requires canonical pinned file");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o022) !== 0 || s.size < 1 || s.size > maxBytes)
      throw new Error("unsafe media runtime file");
    const bytes = readFileSync(fd);
    if (bytes.length !== s.size || sha256(bytes) !== digest)
      throw new Error("media runtime digest mismatch");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function targetPath(target: string): void {
  if (
    !/^\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/u.test(target) ||
    target.split("/").some((x) => x === "." || x === "..") ||
    ["/input", "/dev", "/proc", "/tmp"].some((x) => target === x || target.startsWith(`${x}/`))
  )
    throw new Error("unsafe media runtime target");
}
/** Linux seccomp: no networking, new tasks (including threads), namespace/mount or tracing.
 * Fixed decoder commands are single-threaded. Architecture is checked before syscall numbers. */
export function mediaSeccompFilter(arch: string): Buffer {
  const archId = arch === "x64" ? 0xc000003e : arch === "arm64" ? 0xc00000b7 : undefined;
  if (archId === undefined) throw new Error("unsupported media seccomp architecture");
  const denied =
    arch === "x64"
      ? [
          41, 42, 43, 49, 50, 53, 56, 57, 58, 101, 165, 166, 175, 176, 272, 298, 308, 313, 321, 425,
          426, 427, 435,
        ]
      : [
          198, 199, 200, 201, 202, 203, 220, 117, 40, 39, 97, 105, 106, 241, 268, 273, 280, 425,
          426, 427, 435,
        ];
  const instructions: number[][] = [];
  const add = (code: number, jt: number, jf: number, k: number): void => {
    instructions.push([code, jt, jf, k]);
  };
  add(0x20, 0, 0, 4);
  add(0x15, 1, 0, archId);
  add(0x06, 0, 0, 0x80000000);
  add(0x20, 0, 0, 0);
  // Block x32 syscall ABI as well as native calls.
  if (arch === "x64") {
    add(0x45, 0, 1, 0x40000000);
    add(0x06, 0, 0, 0x80000000);
  }
  // Deny io_uring bypasses, kernel module actions and perf counters explicitly, independent
  // of host sysctls/capabilities. Host process counters are not decoder authority.
  for (const syscall of denied) {
    add(0x15, 0, 1, syscall);
    add(0x06, 0, 0, 0x00050001);
  }
  // The isolated decoder remains one task, independently of the host UID's task count.
  // This is stricter than any admitted positive max_processes and avoids RLIMIT_NPROC's
  // host-wide real-UID accounting, which is not a per-operation confinement boundary.
  add(0x06, 0, 0, 0x7fff0000);
  const result = Buffer.alloc(instructions.length * 8);
  instructions.forEach((i, index) => {
    result.writeUInt16LE(i[0] ?? 0, index * 8);
    result[index * 8 + 2] = i[1] ?? 0;
    result[index * 8 + 3] = i[2] ?? 0;
    result.writeUInt32LE(i[3] ?? 0, index * 8 + 4);
  });
  return result;
}
const runners = new WeakSet<object>();
/** No writable sandbox filesystem, host /proc, GPU, sockets, HOME, PATH or inherited environment.
 * Limits are set before bwrap; seccomp forbids child processes, PID namespace contains cleanup.
 * Bootstrap executables must be deployment-controlled immutable files (hash checked each call).
 * This is confinement, not decoder patch/deployment qualification. */
export class ConfinedMediaRunner {
  private readonly bindings: ConfinedMediaBindingsV1;
  private active = false;
  constructor(bindings: ConfinedMediaBindingsV1) {
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("media confinement requires non-root Linux");
    if (
      !Number.isSafeInteger(bindings.max_runtime_bytes) ||
      bindings.max_runtime_bytes < 1 ||
      bindings.max_runtime_bytes > 1_073_741_824 ||
      bindings.runtime_files.length > 256
    )
      throw new Error("media runtime binding limit");
    const scratch = lstatSync(bindings.scratch_root);
    if (
      !path.isAbsolute(bindings.scratch_root) ||
      realpathSync(bindings.scratch_root) !== bindings.scratch_root ||
      !scratch.isDirectory() ||
      scratch.uid !== process.getuid?.() ||
      (scratch.mode & 0o077) !== 0
    )
      throw new Error("media scratch root must be private and canonical");
    const files = [bindings.ffmpeg, bindings.ffprobe, ...bindings.runtime_files];
    files.forEach((f) => targetPath(f.target));
    if (
      new Set(files.map((f) => f.target)).size !== files.length ||
      files.some((a) => files.some((b) => a !== b && b.target.startsWith(`${a.target}/`)))
    )
      throw new Error("duplicate/overlapping runtime targets");
    this.bindings = structuredClone(bindings);
    runners.add(this);
  }
  get runtimeDigest(): string {
    const b = this.bindings;
    return sha256(
      canonicalJson({
        bubblewrap: b.bubblewrap.sha256,
        prlimit: b.prlimit.sha256,
        files: [b.ffmpeg, b.ffprobe, ...b.runtime_files]
          .map((f) => ({ target: f.target, sha256: f.sha256 }))
          .sort((a, c) => a.target.localeCompare(c.target)),
      })
    );
  }
  static isTrusted(value: unknown): value is ConfinedMediaRunner {
    return typeof value === "object" && value !== null && runners.has(value);
  }
  async run(input: {
    readonly verb: MediaDecodeVerb;
    readonly bytes: Uint8Array;
    readonly policy: MediaDecodePolicyV1;
    readonly signal: AbortSignal;
  }): Promise<ConfinedMediaOutputV1> {
    if (this.active) throw new Error("media runner concurrency limit");
    const p = validateMediaPolicy(input.policy);
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > p.max_input_bytes)
      throw new Error("media source limit");
    if (
      ![
        "probe",
        "video_rgba",
        "audio_s16le",
        "normalize_avc",
        "av_probe",
        "av_frames",
        "av_video_rgba",
        "av_audio_s16le",
      ].includes(input.verb)
    )
      throw new Error("unknown fixed media verb");
    const deadline = performance.now() + p.max_elapsed_ms;
    const checkBudget = (): void => {
      input.signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("media explicit elapsed limit");
    };
    checkBudget();
    this.active = true;
    let stage: string | undefined;
    try {
      const b = this.bindings;
      const root = lstatSync(b.scratch_root);
      if (
        !root.isDirectory() ||
        realpathSync(b.scratch_root) !== b.scratch_root ||
        root.uid !== process.getuid?.() ||
        (root.mode & 0o077) !== 0
      )
        throw new Error("media scratch root custody changed");
      stage = mkdtempSync(path.join(b.scratch_root, "decode-"));
      const stageRoot = stage;
      let runtimeBytes = 0;
      // Execute private verified snapshots, closing the hash→exec pathname replacement window.
      const bootstrap = (name: string, binding: MediaExecutableBindingV1): string => {
        checkBudget();
        const target = path.join(stageRoot, name);
        const bytes = pinnedFile(binding.path, binding.sha256, b.max_runtime_bytes - runtimeBytes);
        runtimeBytes += bytes.length;
        writeFileSync(target, bytes, { flag: "wx", mode: 0o500 });
        return target;
      };
      const bubblewrap = bootstrap("bubblewrap", b.bubblewrap);
      const prlimit = bootstrap("prlimit", b.prlimit);
      const args = [
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
        "OPENBLAS_NUM_THREADS",
        "1",
      ];
      for (const [index, f] of [b.ffmpeg, b.ffprobe, ...b.runtime_files].entries()) {
        checkBudget();
        const bytes = pinnedFile(f.source, f.sha256, b.max_runtime_bytes - runtimeBytes);
        runtimeBytes += bytes.length;
        const source = path.join(stage, `runtime-${index}`);
        writeFileSync(source, bytes, { flag: "wx", mode: 0o500 });
        args.push("--ro-bind", source, f.target);
      }
      const media = path.join(stage, "media");
      writeFileSync(media, input.bytes, { flag: "wx", mode: 0o400 });
      const filter = path.join(stage, "seccomp");
      writeFileSync(filter, mediaSeccompFilter(process.arch), { flag: "wx", mode: 0o400 });
      const normalized = input.verb === "normalize_avc" ? path.join(stage, "normalized.mp4") : null;
      if (normalized !== null) {
        // One fixed output file, not a writable directory or general filesystem capability.
        writeFileSync(normalized, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
        args.push("--bind", normalized, "/output/video.mp4");
      }
      args.push(
        "--ro-bind",
        media,
        "/input/media",
        "--chdir",
        "/input",
        "--remount-ro",
        "/",
        "--seccomp",
        "3",
        "--"
      );
      const common = [
        "-hide_banner",
        "-nostdin",
        "-xerror",
        "-err_detect",
        "explode",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,wav",
        "-noautorotate",
      ];
      if (input.verb === "normalize_avc") {
        args.push(
          b.ffmpeg.target,
          ...common,
          "-v",
          "error",
          "-c:v",
          "h264",
          "-i",
          "/input/media",
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-profile:v",
          "baseline",
          "-bf",
          "0",
          "-pix_fmt",
          "yuv420p",
          "-vsync",
          "0",
          "-crf",
          "18",
          "-color_primaries",
          "unknown",
          "-color_trc",
          "unknown",
          "-colorspace",
          "unknown",
          "-bsf:v",
          "filter_units=remove_types=6",
          "-use_editlist",
          "0",
          "-fflags",
          "+bitexact",
          "-flags:v",
          "+bitexact",
          "-f",
          "mp4",
          "-y",
          "/output/video.mp4"
        );
      } else if (input.verb === "av_probe" || input.verb === "av_frames") {
        args.push(
          b.ffprobe.target,
          "-v",
          "error",
          "-err_detect",
          "explode",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          "mov",
          "-threads",
          "1",
          ...(input.verb === "av_probe"
            ? ["-show_packets", "-show_streams", "-show_format"]
            : ["-show_frames"]),
          "-show_entries",
          input.verb === "av_probe"
            ? "stream=index,id,codec_name,profile,codec_type,width,height,pix_fmt,has_b_frames,time_base,start_pts,duration_ts,nb_frames,sample_rate,channels,channel_layout,sample_fmt:stream_tags:stream_disposition:stream_side_data_list:packet=stream_index,pts,dts,duration,pos,size:packet_side_data_list:format=format_name:format_tags"
            : "frame=media_type,stream_index,pts,pkt_pts,pkt_dts,best_effort_timestamp,pkt_duration,pkt_pos,pkt_size,width,height,pix_fmt,pict_type,interlaced_frame,repeat_pict,nb_samples,channels,channel_layout,sample_fmt:frame_side_data_list",
          "-of",
          "json",
          "-i",
          "/input/media"
        );
      } else if (input.verb === "av_video_rgba" || input.verb === "av_audio_s16le") {
        const video = input.verb === "av_video_rgba";
        args.push(
          b.ffmpeg.target,
          ...common,
          "-v",
          "level+info",
          ...(video ? ["-c:v", "h264"] : ["-c:a", "aac"]),
          "-copyts",
          "-i",
          "/input/media",
          "-map",
          video ? "0:0" : "0:1",
          ...(video
            ? [
                "-an",
                "-sn",
                "-dn",
                "-vf",
                "showinfo",
                "-vsync",
                "0",
                "-threads",
                "1",
                "-c:v",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-f",
                "rawvideo",
              ]
            : [
                "-vn",
                "-sn",
                "-dn",
                "-af",
                "aformat=sample_fmts=s16,ashowinfo",
                "-threads",
                "1",
                "-c:a",
                "pcm_s16le",
                "-f",
                "s16le",
              ]),
          "pipe:1"
        );
      } else if (input.verb === "probe") {
        args.push(
          b.ffprobe.target,
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          "mov,wav",
          "-threads",
          "1",
          "-show_packets",
          "-show_streams",
          "-show_format",
          "-show_entries",
          "stream=index,codec_name,codec_type,width,height,pix_fmt,time_base,duration_ts,nb_frames,sample_rate,channels:stream_tags:stream_side_data_list:packet=stream_index,pts,dts,duration,pos,size:packet_side_data_list:format=format_name:format_tags",
          "-of",
          "json",
          "-i",
          "/input/media"
        );
      } else if (input.verb === "video_rgba") {
        args.push(
          b.ffmpeg.target,
          ...common,
          "-v",
          "info",
          "-c:v",
          "h264",
          "-copyts",
          "-i",
          "/input/media",
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-vf",
          "showinfo",
          "-vsync",
          "0",
          "-threads",
          "1",
          "-c:v",
          "rawvideo",
          "-pix_fmt",
          "rgba",
          "-f",
          "rawvideo",
          "pipe:1"
        );
      } else {
        args.push(
          b.ffmpeg.target,
          ...common,
          "-v",
          "error",
          "-c:a",
          "pcm_s16le",
          "-i",
          "/input/media",
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-threads",
          "1",
          "-c:a",
          "pcm_s16le",
          "-f",
          "s16le",
          "pipe:1"
        );
      }
      const fd = openSync(filter, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        checkBudget();
        const output = await this.execute(
          prlimit,
          [
            `--as=${p.address_space_bytes}:${p.address_space_bytes}`,
            `--cpu=${p.cpu_seconds}:${p.cpu_seconds}`,
            normalized === null
              ? "--fsize=0:0"
              : `--fsize=${p.max_output_bytes}:${p.max_output_bytes}`,
            "--core=0:0",
            `--nofile=${p.max_open_files}:${p.max_open_files}`,
            "--",
            bubblewrap,
            ...args,
          ],
          fd,
          p,
          ["probe", "av_probe", "av_frames"].includes(input.verb)
            ? p.max_probe_bytes
            : p.max_decoded_bytes,
          input.signal,
          stage,
          Math.max(1, Math.floor(deadline - performance.now()))
        );
        if (normalized === null) return output;
        if (output.stdout.length || output.stderr.length)
          throw new Error("normalization diagnostics");
        const result = lstatSync(normalized);
        if (
          !result.isFile() ||
          result.nlink !== 1 ||
          result.size < 1 ||
          result.size > p.max_output_bytes
        )
          throw new Error("normalization output bound");
        return { stdout: readFileSync(normalized), stderr: output.stderr };
      } finally {
        closeSync(fd);
      }
    } finally {
      if (stage !== undefined) rmSync(stage, { recursive: true, force: true });
      this.active = false;
    }
  }
  private async execute(
    executable: string,
    args: string[],
    filterFd: number,
    p: MediaDecodePolicyV1,
    outputCap: number,
    signal: AbortSignal,
    cwd: string,
    remainingMs: number
  ): Promise<ConfinedMediaOutputV1> {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: {},
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", filterFd],
      });
      const stdout = child.stdout;
      const stderr = child.stderr;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outSize = 0;
      let errSize = 0;
      let failure: Error | undefined;
      const kill = (reason: string): void => {
        failure ??= new Error(reason);
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* close/error is authoritative */
          }
        }
      };
      const abort = (): void => kill("media decode cancelled");
      const timer = setTimeout(() => kill("media explicit elapsed limit"), remainingMs);
      let idle = setTimeout(() => kill("media output inactivity limit"), p.inactivity_ms);
      const activity = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => kill("media output inactivity limit"), p.inactivity_ms);
      };
      signal.addEventListener("abort", abort, { once: true });
      stdout?.once("error", () => kill("media stdout read failed"));
      stderr?.once("error", () => kill("media diagnostic read failed"));
      stdout?.on("data", (value: unknown) => {
        if (!Buffer.isBuffer(value)) return kill("invalid media pipe bytes");
        outSize += value.length;
        if (outSize > outputCap) return kill("media stdout limit");
        out.push(value);
        activity();
      });
      stderr?.on("data", (value: unknown) => {
        if (!Buffer.isBuffer(value)) return kill("invalid media diagnostic bytes");
        errSize += value.length;
        if (errSize > p.max_diagnostic_bytes) return kill("media diagnostic limit");
        err.push(value);
        activity();
      });
      child.once("error", () => {
        failure ??= new Error("media sandbox launch failed");
      });
      child.once("close", (code, childSignal) => {
        clearTimeout(timer);
        clearTimeout(idle);
        signal.removeEventListener("abort", abort);
        if (failure !== undefined) reject(failure);
        else if (code !== 0 || childSignal !== null)
          reject(new Error("media sandbox or decoder refused"));
        else resolve({ stdout: Buffer.concat(out, outSize), stderr: Buffer.concat(err, errSize) });
      });
      if (stdout === null || stderr === null) kill("media sandbox pipes unavailable");
      if (signal.aborted) abort();
    });
  }
}
