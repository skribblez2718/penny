import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import { TYPE_AWARE_LINT_TARGETS } from "./scripts/system/checks/typescript-lint.mjs";

const TYPE_SCRIPT_EXTENSIONS = ["ts", "tsx", "mts", "cts"];
const TYPE_AWARE_FILES = [
  ".pi/extensions/**/*.{ts,tsx,mts,cts}",
  ".pi/lib/**/*.{ts,tsx,mts,cts}",
  "apps/observability/**/*.{ts,tsx,mts,cts}",
  "apps/orchestration/**/*.{ts,tsx,mts,cts}",
  "apps/platform-memory/**/*.{ts,tsx,mts,cts}",
];
const MANDATORY_RULES = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-enum-comparison": "error",
  "@typescript-eslint/no-unsafe-unary-minus": "error",
  "@typescript-eslint/no-unsafe-type-assertion": "error",
};

function lintPatterns(target) {
  return [
    ...target.prefixes.flatMap((prefix) =>
      TYPE_SCRIPT_EXTENSIONS.map((extension) => `${prefix}/**/*.${extension}`)
    ),
    ...target.exactFiles,
  ];
}

function ignoredPatterns(target) {
  return target.excludedPrefixes.map((prefix) => `${prefix}/**`);
}

const typeCheckedRules = tseslint.configs.recommended.map((config) => ({
  ...config,
  files: TYPE_AWARE_FILES,
}));
const projectMappings = TYPE_AWARE_LINT_TARGETS.map((target) => ({
  name: `penny/type-aware-project/${target.id}`,
  files: lintPatterns(target),
  ignores: ignoredPatterns(target),
  languageOptions: {
    parserOptions: {
      project: [target.project],
      tsconfigRootDir: import.meta.dirname,
    },
  },
}));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".venv/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/coverage/**",
      "**/.cache/**",
      "**/.mempalace/**",
      "plans/**",
      "ideas/**",
      "research/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  eslint.configs.recommended,
  ...typeCheckedRules,
  ...projectMappings,
  {
    name: "penny/owned-typescript-contracts",
    files: TYPE_AWARE_FILES,
    rules: {
      ...MANDATORY_RULES,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  prettier
);
