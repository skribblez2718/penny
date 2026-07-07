import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: [
      "node_modules/**",
      ".venv/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/.mempalace/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/*.config.ts",
      ".pi/types/**",
      "plans/**",
      "docs/**",
      "ideas/**",
      // Non-production sources — deliberately-vulnerable examples and research
      // artifacts, not runtime code we ship. Linting them is meaningless (their
      // whole purpose is to contain the anti-patterns eslint flags):
      //   - semgrep's rule library / pattern fixtures (data for semgrep, not TS)
      //   - CVE proof-of-concept research
      //   - the jsa vulnerable-app test fixtures
      ".pi/extensions/semgrep/rules/**",
      "research/**",
      "**/tests/fixtures/**",
    ],
  },
  {
    rules: {
      // TypeScript-specific rules
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",

      // General rules
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Type-aware linting requires a tsconfig.json in every directory that
    // contains .ts files. The ignore list above exempts directories that
    // do not need type-aware linting:
    //   - test configs (vitest.config.ts)
    //   - ambient type declarations (.pi/types/)
    //   - design docs and schema sketches (plans/, docs/)
    //   - test files themselves (*.test.ts, *.spec.ts)
    //
    // For directories that DO contain runtime TypeScript (extensions,
    // .pi/test-utils/), either add a tsconfig.json or add to ignores.
    // See docs/agents/architecture/project-standards.md.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: true,
      },
    },
  }
);
