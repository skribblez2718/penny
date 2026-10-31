import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["smoke/sca-ordinary-deepseek.test.ts"],
    // Productive work has no elapsed deadline. Provider/process inactivity is renewable and abortable.
    testTimeout: 0,
    hookTimeout: 0,
    fileParallelism: false,
  },
});
