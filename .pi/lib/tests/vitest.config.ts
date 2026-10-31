import { defineConfig } from "vitest/config";

export default defineConfig({
  // Current-result validation uses the same compiled orchestration generation as extensions.
  ssr: { external: ["node:sqlite"] },
  test: {
    include: [".pi/lib/tests/**/*.test.ts"],
  },
});
