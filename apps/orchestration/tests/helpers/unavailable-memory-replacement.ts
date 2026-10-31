/** Host-owned unavailable memory fixture: replace only the exact ambient entry source. */
import path from "node:path";
import { Type } from "typebox";
import { registerTool } from "../../../../.pi/lib/pi-tool-registration.js";
import type { WorkerExtensionSourceReplacement } from "../../dist/model-client.js";

export function unavailableMemoryReplacement(
  projectRoot: string,
  names: readonly string[]
): WorkerExtensionSourceReplacement {
  return {
    source: path.join(projectRoot, ".pi", "extensions", "memory", "index.ts"),
    extension: {
      name: "unavailable-memory-fixture",
      hidden: true,
      factory: (pi) => {
        for (const name of names) {
          registerTool(pi, {
            name,
            label: name,
            description: "Typed unavailable optional-service test provider",
            parameters: Type.Object({}, { additionalProperties: true }),
            async execute() {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      ok: false,
                      error: { code: "MEMPALACE_UNAVAILABLE", retryable: true },
                    }),
                  },
                ],
                details: {},
              };
            },
          });
        }
      },
    },
  };
}
