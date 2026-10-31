import { describe, expect, it, vi } from "vitest";

import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { requireRecord, requireString } from "../../../../lib/tests/test-narrowers.js";

const forbiddenImports = vi.hoisted(() => ({
  native: vi.fn(() => {
    throw new Error("ordinary registration imported native ingress");
  }),
  authentication: vi.fn(() => {
    throw new Error("ordinary registration imported enrollment/login");
  }),
  qualification: vi.fn(() => {
    throw new Error("ordinary registration imported qualification");
  }),
  activation: vi.fn(() => {
    throw new Error("ordinary registration imported activation");
  }),
  permission: vi.fn(() => {
    throw new Error("ordinary registration imported native permission checks");
  }),
}));

vi.mock("../../src/native-operator.js", () => forbiddenImports.native());
vi.mock("../../src/native-local-auth.js", () => forbiddenImports.authentication());
vi.mock("../../../../../apps/orchestration/dist/sca/p03-initial-qualification.js", () =>
  forbiddenImports.qualification()
);
vi.mock("../../../../../apps/orchestration/dist/sca/phase-activation.js", () =>
  forbiddenImports.activation()
);
vi.mock("../../../../../apps/orchestration/dist/sca/p03-initial-authorization.js", () =>
  forbiddenImports.permission()
);

describe("ordinary SCA registration", () => {
  it("imports and registers only broker tools without native/auth commands or prerequisite checks", async () => {
    const { default: register, createScaExtensionV1 } = await import("../../index.js");
    for (const entrypoint of [register, createScaExtensionV1()]) {
      const tools: string[] = [];
      const command = vi.fn(() => {
        throw new Error("ordinary SCA must not register commands");
      });
      // The shared tool adapter installs one error-result bridge, not SCA setup.
      const event = vi.fn((name: string) => {
        if (name !== "tool_result") {
          throw new Error("ordinary SCA must not install native/auth hooks");
        }
      });
      entrypoint(
        createTestExtensionApi({
          onRegisterTool(value) {
            tools.push(requireString(requireRecord(value).name));
          },
          onRegisterCommand: command,
          onEvent: event,
        })
      );
      expect(tools).toEqual(["sca_source_query", "sca_graph_query", "sca_application_test"]);
      expect(command).not.toHaveBeenCalled();
      expect(event).toHaveBeenCalledTimes(1);
      expect(event).toHaveBeenCalledWith("tool_result", expect.any(Function));
    }
    for (const forbidden of Object.values(forbiddenImports)) {
      expect(forbidden).not.toHaveBeenCalled();
    }
  });
});
