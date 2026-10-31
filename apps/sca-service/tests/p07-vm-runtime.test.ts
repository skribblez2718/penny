import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  parseP07SerialResult,
  P07VmError,
  runP07Qualification,
  type P07GuestPlan,
  type P07VmConfig,
} from "../src/p07-vm-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const h = sha256("fixture");
const bindings = {
  plan_sha256: h,
  policy_sha256: h,
  input_sha256: h,
  image_sha256: h,
  runtime_sha256: h,
};
function serial(items: readonly string[] = []): Buffer {
  return Buffer.from(
    `boot\nPENNY_P07_RESULT_BEGIN\n${canonicalJson({ bindings, items })}\nPENNY_P07_RESULT_END\nshutdown\n`
  );
}
function rejected(code: P07VmError["code"]): { readonly code: P07VmError["code"] } {
  return { code };
}

it("accepts exactly one canonical, bounded, bound serial result and refuses ambiguity", () => {
  expect(parseP07SerialResult(serial(["ok"]), bindings, 1)).toEqual(["ok"]);
  const cases = [
    Buffer.concat([serial(), serial()]),
    Buffer.from(
      serial()
        .toString()
        .replace("PENNY_P07_RESULT_END", "PENNY_P07_RESULT_END\nPENNY_P07_RESULT_END")
    ),
    Buffer.from(serial().toString().replace(h, sha256("wrong"))),
    Buffer.from(serial().toString().replace('"items":[]', '"items":[],"items":[]')),
    Buffer.from(serial().toString().replace('"items":[]', '"items":[1]')),
    Buffer.from(serial().toString().replace('"items":[]', '"items":["a","b"]')),
    Buffer.from(serial().toString().replace("PENNY_P07_RESULT_END", "PENNY_P07_RESULT_ENX")),
    Buffer.from("PENNY_P07_RESULT_END\n" + serial().toString()),
    Buffer.concat([serial(), Buffer.from([0xff])]),
  ];
  for (const value of cases) {
    let caught: unknown;
    try {
      parseP07SerialResult(value, bindings, 1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject(rejected("result_invalid"));
  }
});

async function compile(root: string, name: string, body: string): Promise<string> {
  const source = path.join(root, `${name}.c`);
  const exe = path.join(root, name);
  await writeFile(
    source,
    `#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <sys/stat.h>\n${body}\n`
  );
  const result = spawnSync("cc", [source, "-o", exe], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(result.stderr || "cc failed");
  await chmod(exe, 0o700);
  return exe;
}
function lit(s: string): string {
  return JSON.stringify(s);
}
async function fixture(
  mode:
    | "ok"
    | "hang"
    | "hang_after"
    | "failure"
    | "overflow"
    | "bad"
    | "overlay"
    | "cleanup" = "bad"
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "p07-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  const work = path.join(root, "work");
  await (await import("node:fs/promises")).mkdir(work, { mode: 0o700 });
  const base = path.join(root, "base.qcow2");
  await writeFile(base, "fixture-base-image", { mode: 0o400 });
  await chmod(base, 0o400);
  const qemu = await compile(
    root,
    "qemu",
    `int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts("qemu-fixture"); return 0; }
    FILE *fp = fopen(${lit(path.join(root, "argv"))}, "w");
    FILE *pid = fopen(${lit(path.join(root, "pid"))}, "w"); fprintf(pid, "%d", getpid()); fclose(pid);
    for(int i=1;i<argc;i++) fprintf(fp, "%s\\n", argv[i]); fclose(fp);
    ${
      mode === "hang"
        ? "for (;;) sleep(1);"
        : mode === "failure"
          ? "return 7;"
          : mode === "ok" || mode === "hang_after" || mode === "cleanup"
            ? `char line[1024]; FILE *seed=fopen("user-data", "r"); if (!seed) return 8;
    while (fgets(line,sizeof(line),seed)) if (!strncmp(line,"# binding-json: ",16)) {
      char *binding=line+16; binding[strcspn(binding,"\\n")]=0;
      printf("PENNY_P07_RESULT_BEGIN\\n{\\"bindings\\":%s,\\"items\\":[]}\\nPENNY_P07_RESULT_END\\n",binding);
      fclose(seed); ${mode === "hang_after" ? "fflush(stdout); for (;;) sleep(1);" : mode === "cleanup" ? 'chmod(".",0500); return 0;' : "return 0;"}
    }
    return 9;`
            : `fputs(${lit(mode === "overflow" ? "Z".repeat(9000) : "PENNY_P07_RESULT_BEGIN\n{}\nPENNY_P07_RESULT_END\n")}, stdout); return 0;`
    }
  }`
  );
  const img = await compile(
    root,
    "qemu-img",
    `int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts("img-fixture"); return 0; }
    if (argc > 1 && !strcmp(argv[1], "info")) { puts("{\\"format\\":\\"qcow2\\",\\"virtual-size\\":1048576}"); return 0; }
    if (argc > 1 && !strcmp(argv[1], "create")) { FILE *f=fopen(argv[argc-2], "wb"); if (!f) return 4; fputs("overlay", f); ${mode === "overlay" ? "ftruncate(fileno(f), 2097152);" : ""} fclose(f); return 0; }
    return 5;
  }`
  );
  const iso = await compile(
    root,
    "iso",
    `int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts("iso-fixture"); return 0; }
    for (int i=1;i<argc-1;i++) if (!strcmp(argv[i], "-output")) { FILE *f=fopen(argv[i+1], "wb"); if (!f) return 5; ftruncate(fileno(f), 34816); fseek(f, 32768, SEEK_SET); fputc(1,f); fputs("CD001", f); fputc(1,f); fseek(f,32808,SEEK_SET); fputs("cidata                          ",f); fclose(f); return 0; }
    return 6;
  }`
  );
  const script = "printf '[]' > /var/lib/penny/items.json";
  const plan: P07GuestPlan = {
    plan_sha256: sha256(canonicalJson({ policy_sha256: h, input_sha256: h, script })),
    policy_sha256: h,
    input_sha256: h,
    script,
  };
  const pin = async (file: string) => ({ path: file, sha256: sha256(await readFile(file)) });
  const config: P07VmConfig = {
    qemu: await pin(qemu),
    qemu_img: await pin(img),
    iso_builder: await pin(iso),
    base: await pin(base),
    workspace_parent: work,
    expected_qemu_version: "qemu-fixture",
    expected_qemu_img_version: "img-fixture",
    expected_iso_version: "iso-fixture",
    base_virtual_bytes: 1_048_576,
    limits: {
      startup_ms: 1200,
      runtime_ms: 2000,
      output_bytes: 2048,
      overlay_bytes: 1_048_576,
      result_items: 2,
      termination_ms: 500,
    },
  };
  return { root, work, base, qemu, img, iso, config, plan };
}

describe("standalone supervisor (ELF test tools, no host shell)", () => {
  it("completes a bounded offline fixture with measured bindings and no retained overlay", async () => {
    const f = await fixture("ok");
    const baseBefore = sha256(await readFile(f.base));
    const result = await runP07Qualification(f.config, f.plan);
    expect(result.items).toEqual([]);
    expect(result.bindings.image_sha256).toBe(f.config.base.sha256);
    expect(result.bindings.plan_sha256).toBe(f.plan.plan_sha256);
    expect(result.measurements.seed_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.cleanup_proved && result.termination_proved).toBe(true);
    expect(await readdir(f.work)).toEqual([]);
    expect(sha256(await readFile(f.base))).toBe(baseBefore);
    const pid = Number(await readFile(path.join(f.root, "pid"), "utf8"));
    expect(() => process.kill(-pid, 0)).toThrow();
  });
  it("keeps network/device-looking guest text out of host argv", async () => {
    const f = await fixture("ok");
    const script =
      "printf '[]' > /var/lib/penny/items.json # -netdev user -device usb-host -virtfs local";
    const plan = {
      ...f.plan,
      script,
      plan_sha256: sha256(
        canonicalJson({
          policy_sha256: f.plan.policy_sha256,
          input_sha256: f.plan.input_sha256,
          script,
        })
      ),
    };
    await runP07Qualification(f.config, plan);
    const args = await readFile(path.join(f.root, "argv"), "utf8");
    expect(args).not.toMatch(/-netdev|-virtfs|usb-host/);
    await expect(
      runP07Qualification({ ...f.config, qemu_arguments: ["-netdev", "user"] }, plan)
    ).rejects.toMatchObject(rejected("invalid"));
    expect(await readdir(f.work)).toEqual([]);
  });
  it("rejects path and symlink custody before launch", async () => {
    const f = await fixture();
    const link = path.join(f.root, "link");
    await symlink(f.base, link);
    await expect(
      runP07Qualification({ ...f.config, base: { ...f.config.base, path: link } }, f.plan)
    ).rejects.toMatchObject(rejected("custody_drift"));
    await expect(
      runP07Qualification({ ...f.config, workspace_parent: "/tmp/../tmp" }, f.plan)
    ).rejects.toMatchObject(rejected("invalid"));
    expect(await readdir(f.work)).toEqual([]);
  });
  it("refuses image and tool drift, mutable base, and guest argv injection", async () => {
    const f = await fixture();
    await expect(
      runP07Qualification({ ...f.config, qemu: { ...f.config.qemu, sha256: h } }, f.plan)
    ).rejects.toMatchObject(rejected("tool_drift"));
    await expect(
      runP07Qualification({ ...f.config, base: { ...f.config.base, sha256: h } }, f.plan)
    ).rejects.toMatchObject(rejected("image_drift"));
    await chmod(f.base, 0o600);
    await expect(runP07Qualification(f.config, f.plan)).rejects.toMatchObject(
      rejected("custody_drift")
    );
    await chmod(f.base, 0o400);
    await expect(
      runP07Qualification(f.config, { ...f.plan, qemu_options: ["-netdev", "user"] })
    ).rejects.toMatchObject(rejected("invalid"));
    await expect(
      runP07Qualification(f.config, { ...f.plan, script: "different guest script" })
    ).rejects.toMatchObject(rejected("invalid"));
    expect(await readdir(f.work)).toEqual([]);
  });
  it("enforces the independent runtime deadline after the startup marker", async () => {
    const f = await fixture("hang_after");
    await expect(runP07Qualification(f.config, f.plan)).rejects.toMatchObject(
      rejected("runtime_timeout")
    );
    expect(await readdir(f.work)).toEqual([]);
    const pid = Number(await readFile(path.join(f.root, "pid"), "utf8"));
    expect(() => process.kill(-pid, 0)).toThrow();
  });
  it("keeps a failed-cleanup workspace for quarantine instead of claiming success", async () => {
    const f = await fixture("cleanup");
    try {
      await expect(runP07Qualification(f.config, f.plan)).rejects.toMatchObject({
        code: "cleanup_uncertain",
      });
      expect((await readdir(f.work)).length).toBe(1);
    } finally {
      const [workspace] = await readdir(f.work);
      if (workspace !== undefined) await chmod(path.join(f.work, workspace), 0o700);
    }
  });
  it("rejects an overlay beyond the configured ceiling before VM launch", async () => {
    const f = await fixture("overlay");
    await expect(runP07Qualification(f.config, f.plan)).rejects.toMatchObject(
      rejected("overlay_limit")
    );
    expect(await readdir(f.work)).toEqual([]);
    await expect(readFile(path.join(f.root, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["hang", "failure", "overflow", "bad"] as const)(
    "bounds %s and removes overlay without altering base or retaining a group",
    async (mode) => {
      const f = await fixture(mode);
      const before = sha256(await readFile(f.base));
      const code =
        mode === "hang"
          ? "startup_timeout"
          : mode === "failure"
            ? "qemu_failure"
            : mode === "overflow"
              ? "output_limit"
              : "result_invalid";
      await expect(runP07Qualification(f.config, f.plan)).rejects.toMatchObject(rejected(code));
      expect(await readdir(f.work)).toEqual([]);
      expect(sha256(await readFile(f.base))).toBe(before);
      const pid = Number(await readFile(path.join(f.root, "pid"), "utf8"));
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(() => process.kill(-pid, 0)).toThrow();
      const args = await readFile(path.join(f.root, "argv"), "utf8");
      expect(args).toContain("-nodefaults\n");
      expect(args).toContain("-nic\nnone\n");
      expect(args).toContain(
        "-sandbox\non,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny\n"
      );
      expect(args).not.toMatch(/-netdev|-virtfs|-chardev|guest-agent|socket|hostfwd/);
    }
  );
  it("cancels a launched VM and proves group termination and cleanup", async () => {
    const f = await fixture("hang");
    const abort = new AbortController();
    // Observe rejection immediately, including refusals before the PID file exists.
    const pending = runP07Qualification(f.config, f.plan, abort.signal).then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    const pidPath = path.join(f.root, "pid");
    try {
      for (let i = 0; i < 100; i++) {
        if (
          await lstat(pidPath).then(
            () => true,
            () => false
          )
        )
          break;
        const settled = await Promise.race([
          pending,
          new Promise<undefined>((resolve) => setTimeout(resolve, 20)),
        ]);
        if (settled !== undefined) {
          if (settled.status === "rejected") throw settled.error;
          throw new Error("qualification completed before cancellation");
        }
      }
      const pid = Number(await readFile(pidPath, "utf8"));
      abort.abort();
      expect(await pending).toMatchObject({
        status: "rejected",
        error: rejected("cancelled"),
      });
      expect(await readdir(f.work)).toEqual([]);
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      abort.abort();
      await pending;
    }
  });
});

it.skipIf(process.env.PENNY_P07_VM_LIVE_CONFIG === undefined)(
  "boots the external operator-pinned offline Jammy image",
  async () => {
    const file = process.env.PENNY_P07_VM_LIVE_CONFIG;
    if (file === undefined || !path.isAbsolute(file))
      throw new Error("set absolute PENNY_P07_VM_LIVE_CONFIG");
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.size > 65_536)
      throw new Error("live config must be a small regular file");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (value === null || typeof value !== "object" || !("config" in value) || !("plan" in value))
      throw new Error("live config requires config and plan");
    const result = await runP07Qualification(value.config, value.plan);
    expect(result.termination_proved).toBe(true);
    expect(result.cleanup_proved).toBe(true);
    expect(result.items.length).toBeLessThanOrEqual(128);
    expect(result.items.every((item) => typeof item === "string")).toBe(true);
  },
  4_000_000
);
