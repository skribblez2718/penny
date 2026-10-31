import { describe, expect, it } from "vitest";
import { createVmBrokerProcessRunner } from "../src/vm-broker-adapter.js";

describe("ordinary application-test bridge cancellation grace (real host transport, NOT target execution)", () => {
  it("allows bounded VM-stop proof to finish before escalation", async () => {
    const controller = new AbortController();
    const result = await createVmBrokerProcessRunner(1000).run(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('cleanup-proved');process.exit(0)},250)); process.stderr.write('PENNY_SCA_VM_PROGRESS:validated\\n');setInterval(()=>{},1000);",
      ],
      controller.signal,
      () => controller.abort()
    );
    expect(result).toEqual({ exitCode: 0, stdout: "cleanup-proved", terminated: true });
  });
  it("still forcibly terminates a bridge that misses the finite cleanup grace", async () => {
    const controller = new AbortController();
    const result = await createVmBrokerProcessRunner(100).run(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('too-late');process.exit(0)},5000));process.stderr.write('PENNY_SCA_VM_PROGRESS:validated\\n');setInterval(()=>{},1000);",
      ],
      controller.signal,
      () => controller.abort()
    );
    expect(result).toEqual({ exitCode: 1, stdout: "", terminated: true });
  });
  it("rejects nonfinite, oversized or zero host grace and pre-aborted dispatch", async () => {
    for (const grace of [0, 60_001, Infinity, NaN])
      expect(() => createVmBrokerProcessRunner(grace)).toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createVmBrokerProcessRunner(100).run(
        process.execPath,
        ["-e", "throw Error('must not run')"],
        controller.signal,
        () => {}
      )
    ).rejects.toThrow("cancelled");
  });
});
