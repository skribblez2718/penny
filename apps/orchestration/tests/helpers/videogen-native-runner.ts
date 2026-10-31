import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../dist/canonical-json.js";
import {
  ConfinedNativeRunner,
  type NativeProcessPolicy,
} from "../../dist/host-operations/confined-native-runner.js";
export const NATIVE_TEST_POLICY: NativeProcessPolicy = {
  max_input_bytes: 1000000,
  max_output_bytes: 1000000,
  max_writable_bytes: 65536,
  max_writable_inodes: 128,
  max_diagnostic_bytes: 4096,
  inactivity_ms: 2000,
  max_elapsed_ms: 5000,
  address_space_bytes: 268435456,
  cpu_seconds: 3,
  max_processes: 65536,
  max_open_files: 64,
};
export class RunnerFixture implements Disposable {
  readonly root = mkdtempSync(path.join(tmpdir(), "penny-native-runner-"));
  readonly runner: ConfinedNativeRunner;
  readonly driver_digest: string;
  constructor(mode = 0, refuseMount = false) {
    chmodSync(this.root, 0o700);
    const driver = path.join(this.root, "driver");
    execFileSync(
      "/usr/bin/cc",
      [
        "-static",
        "-O2",
        `-DMODE=${mode}`,
        fileURLToPath(new URL("videogen-native-driver.c", import.meta.url)),
        "-o",
        driver,
      ],
      { timeout: 10000, stdio: "pipe" }
    );
    chmodSync(driver, 0o500);
    const pin = (p: string) => ({ path: realpathSync(p), sha256: sha256(readFileSync(p)) });
    this.driver_digest = sha256(readFileSync(driver));
    this.runner = new ConfinedNativeRunner({
      bubblewrap: pin("/usr/bin/bwrap"),
      prlimit: pin("/usr/bin/prlimit"),
      unshare: pin("/usr/bin/unshare"),
      mount: pin(refuseMount ? "/usr/bin/false" : "/usr/bin/mount"),
      shell: pin(realpathSync("/bin/sh")),
      driver: { source: driver, target: "/runtime/driver", sha256: sha256(readFileSync(driver)) },
      runtime_files: [],
      scratch_root: this.root,
      max_runtime_bytes: 10000000,
    });
  }
  [Symbol.dispose](): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
