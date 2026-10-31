import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPiInvocation } from "../../agent-runner.js";

const originalExecPath = process.execPath;
const originalArgv = [...process.argv];
afterEach(() => {
  Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
  process.argv = [...originalArgv];
});

function executable(value: string) {
  Object.defineProperty(process, "execPath", { value, configurable: true });
}

describe("direct SDK child invocation", () => {
  it.each(["/runtime/node", "/runtime/bun", "/runtime/node.exe"])(
    "uses the supported TypeScript runtime %s",
    (runtime) => {
      executable(runtime);
      process.argv[1] = "/unrelated/test-or-cli.js";
      const args = ["--mode", "json", "-p", "--tools", "read", "Task: finish"];
      const result = getPiInvocation(args);
      expect(result.command).toBe(runtime);
      expect(path.basename(result.args[0] ?? "")).toBe("direct-agent-runtime.ts");
      expect(result.args.slice(1)).toEqual(args);
      expect(result.args).not.toContain(process.argv[1]);
    }
  );

  it("never re-enters a bundled Pi binary or upstream CLI main that cannot enforce settings", () => {
    executable("/runtime/pi");
    process.argv[1] = "/runtime/pi/dist/bundle/cli.js";
    const result = getPiInvocation([]);
    expect(result.command).toBe("node");
    expect(result.args).toHaveLength(1);
    expect(path.basename(result.args[0] ?? "")).toBe("direct-agent-runtime.ts");
  });
});
