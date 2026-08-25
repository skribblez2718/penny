import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite 5 predates node:sqlite and otherwise strips the node: prefix before
  // attempting to bundle it as a package named "sqlite".
  ssr: { external: ["node:sqlite"] },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
