import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".pi/lib/tests/**/*.test.ts"],
  },
});
