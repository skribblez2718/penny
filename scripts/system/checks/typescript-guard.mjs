#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";

export const MANDATORY_ESLINT_RULES = Object.freeze([
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/no-unsafe-assignment",
  "@typescript-eslint/no-unsafe-argument",
  "@typescript-eslint/no-unsafe-call",
  "@typescript-eslint/no-unsafe-member-access",
  "@typescript-eslint/no-unsafe-return",
  "@typescript-eslint/no-unsafe-enum-comparison",
  "@typescript-eslint/no-unsafe-unary-minus",
  "@typescript-eslint/no-unsafe-type-assertion",
]);

export const MANDATORY_COMPILER_OPTIONS = Object.freeze([
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
  "noImplicitThis",
  "alwaysStrict",
  "noEmit",
]);

export const SUPPORTED_PI_PACKAGES = Object.freeze([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

export const EXACT_TEST_HOST_EXCEPTIONS = Object.freeze([
  Object.freeze({
    path: "apps/orchestration/tests/kb-loader-policy.test.ts",
    site: "147:34:unusedContextHost as unknown as ExtensionContext",
    rule: "DOUBLE_ASSERTION",
    eslintRule: "@typescript-eslint/no-unsafe-type-assertion",
    suppressionLine: 146,
    rationale:
      "Pi requires a complete ExtensionContext argument although these context-free KB tools do not read it.",
    removalCondition:
      "Remove when Pi makes ExtensionContext optional for context-free tools or exports a supported test factory.",
    focusedTest:
      "apps/orchestration/tests/kb-loader-policy.test.ts#terminates on typed submit without host-context reads and rejects duplicate/body metadata",
  }),
  Object.freeze({
    path: ".pi/extensions/powerpoint/tests/helpers/contracts.ts",
    site: "123:15:guardedHost as ExtensionAPI",
    rule: "UNSAFE_ASSERTION",
    eslintRule: "@typescript-eslint/no-unsafe-type-assertion",
    suppressionLine: 122,
    rationale:
      "Pi extension factories require a complete ExtensionAPI although these tests exercise only registration methods.",
    removalCondition:
      "Remove when Pi exposes a registration-only API accepted by extension factories.",
    focusedTest:
      ".pi/extensions/powerpoint/tests/unit/extension.test.ts#fails fast when the exact partial ExtensionAPI seam is exceeded",
  }),
  Object.freeze({
    path: ".pi/extensions/questionnaire/tests/helpers.ts",
    site: "182:15:guardedHost as ExtensionAPI",
    rule: "UNSAFE_ASSERTION",
    eslintRule: "@typescript-eslint/no-unsafe-type-assertion",
    suppressionLine: 181,
    rationale:
      "Pi extension factories require a complete ExtensionAPI although these tests exercise only registration methods.",
    removalCondition:
      "Remove when Pi exposes a registration-only API accepted by extension factories.",
    focusedTest:
      ".pi/extensions/questionnaire/tests/unit/questionnaire.test.ts#fails fast when the exact partial ExtensionAPI seam is exceeded",
  }),
  Object.freeze({
    path: ".pi/extensions/questionnaire/tests/helpers.ts",
    site: "214:15:guardedTui as TUI",
    rule: "UNSAFE_ASSERTION",
    eslintRule: "@typescript-eslint/no-unsafe-type-assertion",
    suppressionLine: 213,
    rationale:
      "The mocked Editor and questionnaire UI exercise only requestRender and fg/bg/bold on partial Pi hosts.",
    removalCondition:
      "Remove when the production helper accepts those narrowed TUI and Theme contracts.",
    focusedTest:
      ".pi/extensions/questionnaire/tests/unit/questionnaire.test.ts#fails fast when the exact partial TUI or Theme seam is exceeded",
  }),
  Object.freeze({
    path: ".pi/extensions/questionnaire/tests/helpers.ts",
    site: "220:17:guardedTheme as Theme",
    rule: "UNSAFE_ASSERTION",
    eslintRule: "@typescript-eslint/no-unsafe-type-assertion",
    suppressionLine: 219,
    rationale:
      "The mocked Editor and questionnaire UI exercise only requestRender and fg/bg/bold on partial Pi hosts.",
    removalCondition:
      "Remove when the production helper accepts those narrowed TUI and Theme contracts.",
    focusedTest:
      ".pi/extensions/questionnaire/tests/unit/questionnaire.test.ts#fails fast when the exact partial TUI or Theme seam is exceeded",
  }),
]);

const TEST_HOST_EXCEPTION_RULES = new Set(["DOUBLE_ASSERTION", "UNSAFE_ASSERTION"]);
const TEST_HOST_ESLINT_RULE = "@typescript-eslint/no-unsafe-type-assertion";

const GENERATED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".mempalace",
]);
const TYPESCRIPT_FILE_PATTERN = /(?:\.d)?\.tsx?$/u;
const TYPESCRIPT_CONFIG_PATTERN = /^tsconfig(?:\.[^.]+)*\.json$/u;
const STRICT_DEPENDENT_OPTIONS = new Set(
  MANDATORY_COMPILER_OPTIONS.filter((option) => option !== "strict" && option !== "noEmit")
);
const INVENTORY_VIOLATION_CODES = new Set([
  "ROOT_MISSING",
  "ESLINT_CONFIG_ERROR",
  "ESLINT_OMITTED",
  "ESLINT_RULE_DOWNGRADE",
  "TSC_CONFIG_ERROR",
  "TSC_OPTION_DOWNGRADE",
  "TSC_OMITTED",
  "TSC_DECLARATION_SKIPPED",
  "TEST_RUNNER_UNMAPPED",
  "SYNTAX_ERROR",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativePath(root, filePath) {
  const relative = toPosix(path.relative(root, filePath));
  return relative === "" ? "." : relative;
}

function canonicalPath(filePath) {
  return path.resolve(filePath);
}

function locationFor(sourceFile, node) {
  const start = node.getStart(sourceFile, false);
  const location = sourceFile.getLineAndCharacterOfPosition(start);
  return { line: location.line + 1, column: location.character + 1 };
}

function compactSnippet(text) {
  return text.replace(/\s+/gu, " ").trim().slice(0, 160);
}

function createViolation(code, filePath, detail, options = {}) {
  const violation = {
    code,
    path: filePath,
    detail,
    baselineKey: `${code}\u0000${filePath}`,
  };
  if (options.line !== undefined) violation.line = options.line;
  if (options.column !== undefined) violation.column = options.column;
  if (options.snippet) violation.snippet = compactSnippet(options.snippet);
  return violation;
}

function exactNodeSite(sourceFile, node) {
  const location = locationFor(sourceFile, node);
  const expression = node.getText(sourceFile).replace(/\s+/gu, " ").trim();
  return `${location.line}:${location.column}:${expression}`;
}

function addNodeViolation(violations, code, relative, detail, sourceFile, node, options = {}) {
  const violation = createViolation(code, relative, detail, {
    ...locationFor(sourceFile, node),
    snippet: node.getText(sourceFile),
  });
  if (options.includeExactSite) violation.site = exactNodeSite(sourceFile, node);
  violations.push(violation);
}

function discoverFiles(root, roots) {
  const files = [];
  const missingRoots = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!GENERATED_DIRECTORY_NAMES.has(entry.name)) visit(absolute);
        continue;
      }
      if (entry.isFile() && TYPESCRIPT_FILE_PATTERN.test(entry.name)) files.push(absolute);
    }
  }

  for (const configuredRoot of roots) {
    const absolute = canonicalPath(path.resolve(root, configuredRoot));
    if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) {
      missingRoots.push(relativePath(root, absolute));
      continue;
    }
    visit(absolute);
  }

  files.sort((left, right) => relativePath(root, left).localeCompare(relativePath(root, right)));
  return { files, missingRoots };
}

function discoverNamedFiles(root, roots, predicate) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!GENERATED_DIRECTORY_NAMES.has(entry.name)) visit(absolute);
      } else if (entry.isFile() && predicate(entry.name, absolute)) {
        files.push(absolute);
      }
    }
  }
  for (const configuredRoot of roots) {
    const absolute = path.resolve(root, configuredRoot);
    if (existsSync(absolute) && lstatSync(absolute).isDirectory()) visit(absolute);
  }
  return files.sort((left, right) =>
    relativePath(root, left).localeCompare(relativePath(root, right))
  );
}

function classifyFile(relative) {
  const basename = path.posix.basename(relative);
  if (relative.endsWith(".d.ts")) return "declaration";
  if (/\/(?:smoke)\//u.test(`/${relative}`)) {
    return /\.(?:test|spec)\.tsx?$/u.test(basename) ? "smoke" : "helper";
  }
  if (/\.(?:test|spec)\.tsx?$/u.test(basename)) return "test";
  if (/\/(?:tests?)\/(?:fixtures?|helpers?)\//u.test(`/${relative}`)) return "fixture/helper";
  if (/\/(?:tests?)\//u.test(`/${relative}`)) return "fixture/helper";
  if (/config\.tsx?$/u.test(basename)) return "config";
  return "runtime";
}

function parseJsonFile(filePath) {
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function collectPackageManifests(root, roots) {
  const candidates = new Set([path.join(root, "package.json")]);
  for (const filePath of discoverNamedFiles(root, roots, (name) => name === "package.json")) {
    candidates.add(filePath);
  }
  const manifests = [];
  for (const filePath of [...candidates].sort()) {
    if (!existsSync(filePath)) continue;
    const parsed = parseJsonFile(filePath);
    manifests.push({
      path: filePath,
      relative: relativePath(root, filePath),
      directory: path.dirname(filePath),
      data: parsed.value,
      error: parsed.error,
    });
  }
  return manifests;
}

function nearestPackageManifest(filePath, manifests, root) {
  let directory = path.dirname(filePath);
  const byDirectory = new Map(
    manifests.map((manifest) => [canonicalPath(manifest.directory), manifest])
  );
  while (directory.startsWith(root)) {
    const found = byDirectory.get(canonicalPath(directory));
    if (found) return found;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return byDirectory.get(canonicalPath(root));
}

function compilerOverridesFromCommand(commandTail) {
  const overrides = {};
  for (const option of MANDATORY_COMPILER_OPTIONS) {
    const explicit = commandTail.match(
      new RegExp(`(?:^|\\s)--${option}(?:=|\\s+)(true|false)(?=\\s|$)`, "u")
    );
    if (explicit) overrides[option] = explicit[1] === "true";
    else if (new RegExp(`(?:^|\\s)--${option}(?=\\s|$)`, "u").test(commandTail)) {
      overrides[option] = true;
    }
  }
  return overrides;
}

function extractTscInvocations(script, packageDirectory) {
  const invocations = [];
  const commandPattern = /(?:^|[;&|()]|\s)(?:bunx\s+|npx\s+)?tsc\b([^;&|)]*)/gu;
  for (const match of script.matchAll(commandPattern)) {
    const tail = match[1] ?? "";
    const projectMatch = tail.match(
      /(?:^|\s)(?:-p|--project)(?:\s+|=)(?:["']([^"']+)["']|([^\s]+))/u
    );
    const configured = projectMatch?.[1] ?? projectMatch?.[2] ?? "tsconfig.json";
    const withExtension = path.extname(configured) === "" ? `${configured}.json` : configured;
    invocations.push({
      configPath: path.resolve(packageDirectory, withExtension),
      compilerOverrides: compilerOverridesFromCommand(tail),
      command: compactSnippet(match[0]),
    });
  }
  return invocations;
}

function typecheckInvocations(manifests) {
  const byConfig = new Map();
  for (const manifest of manifests) {
    if (
      !manifest.data ||
      typeof manifest.data.scripts !== "object" ||
      manifest.data.scripts === null
    ) {
      continue;
    }
    for (const [scriptName, scriptValue] of Object.entries(manifest.data.scripts)) {
      if (!scriptName.startsWith("typecheck") || typeof scriptValue !== "string") continue;
      for (const invocation of extractTscInvocations(scriptValue, manifest.directory)) {
        const key = canonicalPath(invocation.configPath);
        const entries = byConfig.get(key) ?? [];
        entries.push({
          package: manifest.relative,
          script: scriptName,
          compilerOverrides: invocation.compilerOverrides,
          command: invocation.command,
        });
        byConfig.set(key, entries);
      }
    }
  }
  return byConfig;
}

function effectiveCompilerVector(options, overrides = {}) {
  const effectiveOptions = { ...options, ...overrides };
  const vector = {};
  for (const option of MANDATORY_COMPILER_OPTIONS) {
    if (option === "strict") vector[option] = effectiveOptions.strict === true;
    else if (option === "noEmit") vector[option] = effectiveOptions.noEmit === true;
    else if (STRICT_DEPENDENT_OPTIONS.has(option)) {
      vector[option] = ts.getStrictOptionValue(effectiveOptions, option);
    }
  }
  return vector;
}

function loadTypeScriptProjects(root, roots, files, manifests, violations) {
  const configPaths = discoverNamedFiles(root, roots, (name) =>
    TYPESCRIPT_CONFIG_PATTERN.test(name)
  );
  const invocationsByConfig = typecheckInvocations(manifests);
  const ownedPaths = new Set(files.map(canonicalPath));
  const projects = [];
  const memberships = new Map();

  for (const configPath of configPaths) {
    const configDiagnostics = [];
    const host = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        configDiagnostics.push(diagnostic);
      },
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    const relative = relativePath(root, configPath);
    if (!parsed) {
      const detail = configDiagnostics.length
        ? ts.flattenDiagnosticMessageText(configDiagnostics[0].messageText, " ")
        : "TypeScript could not parse this project";
      violations.push(createViolation("TSC_CONFIG_ERROR", relative, detail));
      projects.push({ config: relative, invokedBy: [], error: detail, members: [] });
      continue;
    }
    for (const diagnostic of [...configDiagnostics, ...parsed.errors]) {
      violations.push(
        createViolation(
          "TSC_CONFIG_ERROR",
          relative,
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
        )
      );
    }

    const invocations = invocationsByConfig.get(canonicalPath(configPath)) ?? [];
    const configuredVector = effectiveCompilerVector(parsed.options);
    const runnerVectors = invocations.map((invocation) => ({
      ...invocation,
      options: effectiveCompilerVector(parsed.options, invocation.compilerOverrides),
    }));
    const qualifying = runnerVectors.some((runner) =>
      MANDATORY_COMPILER_OPTIONS.every((key) => runner.options[key])
    );
    for (const runner of runnerVectors) {
      for (const [option, enabled] of Object.entries(runner.options)) {
        if (!enabled) {
          violations.push(
            createViolation(
              "TSC_OPTION_DOWNGRADE",
              relative,
              `effective compiler option ${option} is not true for ${runner.package}#${runner.script}`
            )
          );
        }
      }
    }

    let program;
    const memberPaths = [];
    if (invocations.length > 0 && parsed.fileNames.length > 0) {
      const qualifyingRunner = runnerVectors.find((runner) =>
        MANDATORY_COMPILER_OPTIONS.every((key) => runner.options[key])
      );
      const selectedOverrides =
        qualifyingRunner?.compilerOverrides ?? runnerVectors[0]?.compilerOverrides;
      const effectiveOptions = { ...parsed.options, ...selectedOverrides };
      try {
        program = ts.createProgram({
          rootNames: parsed.fileNames,
          options: effectiveOptions,
          projectReferences: parsed.projectReferences,
        });
        for (const sourceFile of program.getSourceFiles()) {
          const absolute = canonicalPath(sourceFile.fileName);
          if (!ownedPaths.has(absolute)) continue;
          memberPaths.push(absolute);
          const membership = memberships.get(absolute) ?? [];
          membership.push({
            config: relative,
            qualifying,
            skipLibCheck: effectiveOptions.skipLibCheck === true,
          });
          memberships.set(absolute, membership);
        }
      } catch (error) {
        violations.push(
          createViolation(
            "TSC_CONFIG_ERROR",
            relative,
            `program creation failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    }

    projects.push({
      config: relative,
      invokedBy: invocations,
      configuredOptions: configuredVector,
      runnerVectors,
      skipLibCheck: parsed.options.skipLibCheck === true,
      qualifying,
      members: memberPaths.map((member) => relativePath(root, member)).sort(),
    });
  }

  return { projects, memberships };
}

function createAnalysisProgram(files) {
  return ts.createProgram({
    rootNames: files,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
  });
}

function normalizeRuleSeverity(setting) {
  const value = Array.isArray(setting) ? setting[0] : setting;
  if (value === 2 || value === "error") return "error";
  if (value === 1 || value === "warn" || value === "warning") return "warn";
  return "off";
}

async function inspectEslint(root, files, sourceTexts, violations) {
  let eslint;
  try {
    eslint = new ESLint({
      cwd: root,
      errorOnUnmatchedPattern: false,
      overrideConfig: { linterOptions: { reportUnusedDisableDirectives: "error" } },
    });
  } catch (error) {
    violations.push(
      createViolation(
        "ESLINT_CONFIG_ERROR",
        "eslint.config",
        error instanceof Error ? error.message : String(error)
      )
    );
    return new Map();
  }

  const results = new Map();
  for (const filePath of files) {
    const relative = relativePath(root, filePath);
    try {
      const ignored = await eslint.isPathIgnored(filePath);
      if (ignored) {
        violations.push(
          createViolation(
            "ESLINT_OMITTED",
            relative,
            "file is ignored by effective ESLint configuration"
          )
        );
        results.set(filePath, { ignored: true, typeAware: false, rules: {} });
        continue;
      }
      const config = await eslint.calculateConfigForFile(filePath);
      const parserOptions = config?.languageOptions?.parserOptions ?? {};
      const typeAware = Boolean(parserOptions.project || parserOptions.projectService);
      if (!config || !typeAware) {
        violations.push(
          createViolation(
            "ESLINT_OMITTED",
            relative,
            config
              ? "file has no effective type-aware ESLint project"
              : "file has no effective ESLint configuration"
          )
        );
      }
      const rules = {};
      for (const rule of MANDATORY_ESLINT_RULES) {
        const severity = normalizeRuleSeverity(config?.rules?.[rule]);
        rules[rule] = severity;
        if (severity !== "error") {
          violations.push(
            createViolation(
              "ESLINT_RULE_DOWNGRADE",
              relative,
              `${rule} resolves to ${severity}, not error`
            )
          );
        }
      }
      results.set(filePath, { ignored: false, typeAware, rules });

      const text = sourceTexts.get(filePath) ?? "";
      if (/eslint-(?:disable|enable)/u.test(text)) {
        const lintResults = await eslint.lintText(text, { filePath, warnIgnored: false });
        for (const message of lintResults.flatMap((result) => result.messages)) {
          if (message.ruleId === null && /Unused eslint-disable directive/u.test(message.message)) {
            violations.push(
              createViolation("ESLINT_UNUSED_SUPPRESSION", relative, message.message, {
                line: message.line,
                column: message.column,
              })
            );
          }
        }
      }
    } catch (error) {
      violations.push(
        createViolation(
          "ESLINT_CONFIG_ERROR",
          relative,
          error instanceof Error ? error.message : String(error)
        )
      );
      results.set(filePath, { ignored: false, typeAware: false, rules: {} });
    }
  }
  return results;
}

function moduleSpecifierText(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
  }
  if (ts.isCallExpression(node)) {
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    const argument = node.arguments[0];
    if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument))
      return argument.text;
  }
  return undefined;
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith(".")) return undefined;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function isAssertionExpression(node) {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function assertionChain(node) {
  const chain = [node];
  let expression = unwrapParentheses(node.expression);
  while (isAssertionExpression(expression)) {
    chain.push(expression);
    expression = unwrapParentheses(expression.expression);
  }
  return chain;
}

function assertionIsUnsafe(node, checker) {
  if (!checker) return true;
  try {
    const source = checker.getTypeAtLocation(node.expression);
    const target = checker.getTypeFromTypeNode(node.type);
    if ((source.flags & ts.TypeFlags.Any) !== 0 || (target.flags & ts.TypeFlags.Any) !== 0)
      return true;
    return !checker.isTypeAssignableTo(source, target);
  } catch {
    return true;
  }
}

function isFunctionBoundary(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isProcessEnvAccess(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    );
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "env"
  );
}

function isAtModuleScope(node) {
  let parent = node.parent;
  while (parent && !ts.isSourceFile(parent)) {
    if (isFunctionBoundary(parent)) return false;
    parent = parent.parent;
  }
  return true;
}

function isExtensionRuntime(relative, extensionRoot) {
  if (!extensionRoot) return false;
  const prefix = `${toPosix(extensionRoot).replace(/\/$/u, "")}/`;
  if (!relative.startsWith(prefix)) return false;
  return classifyFile(relative) === "runtime";
}

function commentRanges(text, sourceFile) {
  const ranges = new Map();
  function add(found) {
    for (const range of found ?? []) ranges.set(`${range.pos}:${range.end}`, range);
  }
  function visit(node) {
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...ranges.values()].sort((left, right) => left.pos - right.pos);
}

function scanComments(relative, text, sourceFile, violations, options = {}) {
  const directives = [];
  const suppressions = [];
  const unusedExpectErrorLines = options.unusedExpectErrorLines ?? new Set();
  for (const range of commentRanges(text, sourceFile)) {
    const comment = text.slice(range.pos, range.end);
    const lineInfo = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const line = lineInfo.line + 1;
    const column = lineInfo.character + 1;

    for (const directiveMatch of comment.matchAll(
      /@ts-(nocheck|ignore|expect-error)\b([^\r\n]*)/gu
    )) {
      const kind = directiveMatch[1];
      const description = directiveMatch[2].replace(/^[\s:–—-]+/u, "").trim();
      const record = {
        kind: `@ts-${kind}`,
        line,
        text: compactSnippet(comment),
        description,
      };
      directives.push(record);
      if (kind === "nocheck") {
        violations.push(
          createViolation("TS_NOCHECK", relative, "@ts-nocheck is prohibited", { line, column })
        );
      } else if (kind === "ignore") {
        violations.push(
          createViolation("TS_IGNORE", relative, "@ts-ignore is prohibited", { line, column })
        );
      } else {
        const classification = classifyFile(relative);
        const isTestSource = ["test", "smoke", "fixture/helper"].includes(classification);
        const isNegativeCompileContract =
          isTestSource &&
          /\bnegative (?:compile|type)(?:\s+(?:contract|test))?\b/iu.test(description);
        const isTemporaryUpstreamDefect =
          /\bupstream (?:typing )?defect\b/iu.test(description) &&
          /\bremoval condition\s*:/iu.test(description);
        const problems = [];
        if (description.length < 10) problems.push("same-line description is missing or too short");
        if (!isNegativeCompileContract && !isTemporaryUpstreamDefect) {
          problems.push(
            "directive is neither an exact negative compile contract nor an upstream defect with a removal condition"
          );
        }
        if (unusedExpectErrorLines.has(line)) {
          problems.push("TypeScript reports the directive as unused");
        }
        if (problems.length > 0) {
          violations.push(
            createViolation("TS_EXPECT_ERROR_INVALID", relative, problems.join("; "), {
              line,
              column,
            })
          );
        }
      }
    }

    const eslintMatch = comment.match(
      /eslint-(disable(?:-next-line|-line)?|enable)\b([\s\S]*?)(?:\*\/|$)/u
    );
    if (!eslintMatch) continue;
    const action = eslintMatch[1];
    const rawRules = eslintMatch[2]
      .replace(/--.*$/su, "")
      .split(/[\s,]+/u)
      .map((rule) => rule.trim())
      .filter(Boolean);
    suppressions.push({
      action,
      rules: rawRules,
      line,
      column,
      text: compactSnippet(comment),
    });
    if (action.startsWith("disable") && rawRules.length === 0) {
      violations.push(
        createViolation("ESLINT_BROAD_SUPPRESSION", relative, `${action} disables all rules`, {
          line,
          column,
        })
      );
    }
    const contractRules = rawRules.filter((rule) => MANDATORY_ESLINT_RULES.includes(rule));
    if (action.startsWith("disable") && contractRules.length > 0) {
      const violation = createViolation(
        "ESLINT_CONTRACT_SUPPRESSION",
        relative,
        `${action} suppresses mandatory rule(s): ${contractRules.join(", ")}`,
        { line, column }
      );
      violation.action = action;
      violation.rules = contractRules;
      violations.push(violation);
    }
  }
  return { directives, suppressions };
}

function scanSourceFile({
  root,
  filePath,
  sourceFile,
  checker,
  adapterRelative,
  extensionRootRelative,
  violations,
}) {
  const relative = relativePath(root, filePath);
  const imports = [];
  const seenAssertions = new Set();
  const extensionRuntime = isExtensionRuntime(relative, extensionRootRelative);

  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      addNodeViolation(violations, "EXPLICIT_ANY", relative, "explicit any type", sourceFile, node);
    }
    if (ts.isNonNullExpression(node)) {
      addNodeViolation(
        violations,
        "POSTFIX_NON_NULL",
        relative,
        "postfix non-null assertion is prohibited",
        sourceFile,
        node
      );
    }
    if (
      (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.exclamationToken !== undefined
    ) {
      addNodeViolation(
        violations,
        "DEFINITE_ASSIGNMENT",
        relative,
        "definite-assignment assertion is prohibited",
        sourceFile,
        node.exclamationToken
      );
    }

    if (isAssertionExpression(node) && !seenAssertions.has(node)) {
      const chain = assertionChain(node);
      for (const item of chain) seenAssertions.add(item);
      if (chain.length > 1) {
        const includesUnknownBridge = chain.some(
          (item) => item.type.kind === ts.SyntaxKind.UnknownKeyword
        );
        addNodeViolation(
          violations,
          "DOUBLE_ASSERTION",
          relative,
          includesUnknownBridge
            ? "unsafe double assertion includes an unknown bridge"
            : "unsafe double assertion is prohibited",
          sourceFile,
          node,
          { includeExactSite: true }
        );
      } else if (assertionIsUnsafe(node, checker)) {
        addNodeViolation(
          violations,
          "UNSAFE_ASSERTION",
          relative,
          "type assertion narrows or escapes the source type",
          sourceFile,
          node,
          { includeExactSite: true }
        );
      }
    }

    const specifier = moduleSpecifierText(node);
    if (specifier) {
      imports.push(specifier);
      if (specifier === "@mariozechner" || specifier.startsWith("@mariozechner/")) {
        addNodeViolation(
          violations,
          "UNSUPPORTED_PI_IMPORT",
          relative,
          `unsupported Pi package import: ${specifier}`,
          sourceFile,
          node
        );
      }
    }
    if (
      ts.isModuleDeclaration(node) &&
      ts.isStringLiteralLike(node.name) &&
      (node.name.text === "@mariozechner" || node.name.text.startsWith("@mariozechner/"))
    ) {
      addNodeViolation(
        violations,
        "UNSUPPORTED_PI_AMBIENT",
        relative,
        `unsupported ambient Pi declaration: ${node.name.text}`,
        sourceFile,
        node
      );
    }

    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression))
    ) {
      const property = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.argumentExpression &&
            ts.isStringLiteralLike(node.expression.argumentExpression)
          ? node.expression.argumentExpression.text
          : undefined;
      const receiver = unwrapParentheses(node.expression.expression);
      if (
        property === "registerTool" &&
        ts.isIdentifier(receiver) &&
        receiver.text === "pi" &&
        relative !== adapterRelative
      ) {
        addNodeViolation(
          violations,
          "RAW_PI_REGISTER_TOOL",
          relative,
          `raw pi.registerTool call is only allowed in ${adapterRelative}`,
          sourceFile,
          node.expression
        );
      }
      if (
        extensionRuntime &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "console" &&
        ["log", "warn", "error"].includes(node.expression.name.text)
      ) {
        addNodeViolation(
          violations,
          "EXT_CONSOLE",
          relative,
          `extension runtime console.${node.expression.name.text} call is prohibited`,
          sourceFile,
          node.expression
        );
      }
    }

    if (extensionRuntime && isProcessEnvAccess(node) && isAtModuleScope(node)) {
      addNodeViolation(
        violations,
        "EXT_MODULE_ENV",
        relative,
        "module-scope process.env read is prohibited in extension runtime",
        sourceFile,
        node
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

function focusedTestReference(value) {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("#");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { path: value.slice(0, separator), name: value.slice(separator + 1) };
}

function sourceDeclaresFocusedTest(root, sourceTexts, reference) {
  if (!reference || !["test", "smoke"].includes(classifyFile(reference.path))) return false;
  const absolute = canonicalPath(path.resolve(root, reference.path));
  const text = sourceTexts.get(absolute);
  if (text === undefined) return false;
  const sourceFile = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const direct = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      const qualified =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
          ? node.expression.expression.text
          : undefined;
      const title = node.arguments[0];
      if (
        (direct === "it" || direct === "test" || qualified === "it" || qualified === "test") &&
        title &&
        ts.isStringLiteralLike(title) &&
        title.text === reference.name
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function localExceptionDocumentation(text, line) {
  const lines = text.split(/\r?\n/u);
  return lines.slice(Math.max(0, line - 9), Math.max(0, line - 1)).join("\n");
}

function isExactTestHostException(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.path === "string" &&
    typeof value.site === "string" &&
    typeof value.rule === "string" &&
    TEST_HOST_EXCEPTION_RULES.has(value.rule) &&
    value.eslintRule === TEST_HOST_ESLINT_RULE &&
    Number.isInteger(value.suppressionLine) &&
    value.suppressionLine > 0 &&
    typeof value.rationale === "string" &&
    value.rationale.length > 0 &&
    typeof value.removalCondition === "string" &&
    value.removalCondition.length > 0 &&
    focusedTestReference(value.focusedTest) !== undefined &&
    ["test", "smoke", "fixture/helper"].includes(classifyFile(value.path))
  );
}

function applyExactTestHostExceptions({
  root,
  sourceTexts,
  commentsByFile,
  violations,
  exceptions,
}) {
  const registered = Array.isArray(exceptions) ? [...exceptions] : [];
  const accepted = [];
  const invalid = [];
  const suppressed = new Set();
  const recordCounts = countBy(
    registered.filter(isExactTestHostException),
    (exception) =>
      `${exception.rule}\u0000${exception.path}\u0000${exception.site}\u0000${exception.eslintRule}\u0000${exception.suppressionLine}`
  );

  for (const [index, exception] of registered.entries()) {
    if (!isExactTestHostException(exception)) {
      invalid.push(
        createViolation(
          "TEST_HOST_EXCEPTION_INVALID",
          typeof exception?.path === "string" ? exception.path : "typescript-guard.mjs",
          `test-host exception record ${index + 1} is incomplete or malformed`
        )
      );
      continue;
    }

    const recordKey = `${exception.rule}\u0000${exception.path}\u0000${exception.site}\u0000${exception.eslintRule}\u0000${exception.suppressionLine}`;
    const findings = violations.filter(
      (violation) =>
        violation.code === exception.rule &&
        violation.path === exception.path &&
        violation.site === exception.site
    );
    const suppressionViolations = violations.filter(
      (violation) =>
        violation.code === "ESLINT_CONTRACT_SUPPRESSION" &&
        violation.path === exception.path &&
        violation.line === exception.suppressionLine &&
        violation.action === "disable-next-line" &&
        violation.rules?.length === 1 &&
        violation.rules[0] === exception.eslintRule
    );
    const absolutePath = canonicalPath(path.resolve(root, exception.path));
    const matchingComments = (commentsByFile.get(absolutePath)?.suppressions ?? []).filter(
      (suppression) =>
        suppression.line === exception.suppressionLine &&
        suppression.action === "disable-next-line" &&
        suppression.rules.length === 1 &&
        suppression.rules[0] === exception.eslintRule &&
        suppression.text.includes(" -- ")
    );
    const problems = [];
    if ((recordCounts[recordKey] ?? 0) !== 1) problems.push("registry record is duplicated");
    if (findings.length !== 1) {
      problems.push(`expected one exact AST finding but matched ${findings.length}`);
    }
    if (suppressionViolations.length !== 1 || matchingComments.length !== 1) {
      problems.push(
        `expected one exact eslint-disable-next-line at ${exception.suppressionLine} for ${exception.eslintRule}`
      );
    }

    const finding = findings[0];
    const suppressionViolation = suppressionViolations[0];
    if (finding && suppressed.has(finding)) problems.push("AST finding is claimed more than once");
    if (suppressionViolation && suppressed.has(suppressionViolation)) {
      problems.push("ESLint suppression is claimed more than once");
    }
    if (finding && exception.suppressionLine !== finding.line - 1) {
      problems.push("registered suppression is not immediately before the exact AST site");
    }
    const sourceText = sourceTexts.get(absolutePath);
    if (sourceText === undefined) {
      problems.push("source path is absent from the live inventory");
    } else if (finding) {
      const documentation = localExceptionDocumentation(sourceText, finding.line);
      for (const required of [
        `Test-host exception rule: ${exception.rule}`,
        `Rationale: ${exception.rationale}`,
        `Removal condition: ${exception.removalCondition}`,
        `Focused test: ${exception.focusedTest}`,
      ]) {
        if (!documentation.includes(required)) {
          problems.push(`missing matching local documentation: ${required}`);
        }
      }
    }

    const focusedTest = focusedTestReference(exception.focusedTest);
    if (!sourceDeclaresFocusedTest(root, sourceTexts, focusedTest)) {
      problems.push(`focused test is absent or renamed: ${exception.focusedTest}`);
    }

    if (problems.length > 0) {
      invalid.push(
        createViolation(
          "TEST_HOST_EXCEPTION_INVALID",
          exception.path,
          problems.join("; "),
          finding ? { line: finding.line, column: finding.column } : {}
        )
      );
      continue;
    }

    suppressed.add(finding);
    suppressed.add(suppressionViolation);
    accepted.push({
      ...exception,
      line: finding.line,
      column: finding.column,
    });
  }

  const retained = violations.filter((violation) => !suppressed.has(violation));
  violations.splice(0, violations.length, ...retained, ...invalid);
  return { registered, accepted };
}

function isExactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);
}

function commandOrder(script) {
  const commands = script.split(/&&|\|\||;/u).map((command) => command.trim());
  const typecheck = commands.findIndex(
    (command) =>
      /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?typecheck(?:\s|$)/u.test(command) ||
      /\btsc\b/u.test(command)
  );
  const test = commands.findIndex(
    (command) =>
      /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?(?:\s|$)/u.test(command) &&
      !/\btypecheck\b/u.test(command)
  );
  return { typecheck, test };
}

function inspectExtensionPackages({
  root,
  extensionRoot,
  files,
  importsByFile,
  manifests,
  projects,
  violations,
}) {
  if (!extensionRoot) return [];
  const absoluteExtensionRoot = path.resolve(root, extensionRoot);
  if (!existsSync(absoluteExtensionRoot)) return [];
  const manifestByDirectory = new Map(
    manifests.map((manifest) => [canonicalPath(manifest.directory), manifest])
  );
  const extensions = [];
  const usedRootPackages = new Set(["typescript"]);

  for (const entry of readdirSync(absoluteExtensionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || GENERATED_DIRECTORY_NAMES.has(entry.name))
      continue;
    const directory = path.join(absoluteExtensionRoot, entry.name);
    const relativeDirectory = relativePath(root, directory);
    const extensionFiles = files.filter((filePath) =>
      filePath.startsWith(`${directory}${path.sep}`)
    );
    if (extensionFiles.length === 0) continue;
    const manifest = manifestByDirectory.get(canonicalPath(directory));
    if (!manifest) {
      violations.push(
        createViolation(
          "PKG_MANIFEST_MISSING",
          `${relativeDirectory}/package.json`,
          "extension has no package manifest"
        )
      );
      extensions.push({
        directory: relativeDirectory,
        files: extensionFiles.length,
        compliant: false,
      });
      continue;
    }
    if (manifest.error || !manifest.data || typeof manifest.data !== "object") {
      violations.push(
        createViolation(
          "PKG_MANIFEST_INVALID",
          manifest.relative,
          manifest.error ?? "extension package manifest is not an object"
        )
      );
      extensions.push({
        directory: relativeDirectory,
        files: extensionFiles.length,
        compliant: false,
      });
      continue;
    }

    const usedPackages = new Set();
    for (const filePath of extensionFiles) {
      for (const specifier of importsByFile.get(filePath) ?? []) {
        const packageName = packageNameFromSpecifier(specifier);
        if (!packageName) continue;
        if (
          packageName === "@sinclair/typebox" ||
          (packageName.endsWith("typebox") && packageName !== "typebox")
        ) {
          violations.push(
            createViolation(
              "PKG_TYPEBOX_IMPORT",
              relativePath(root, filePath),
              `TypeBox must be imported from typebox, not ${specifier}`
            )
          );
        }
        if (
          packageName.startsWith("@earendil-works/") &&
          !SUPPORTED_PI_PACKAGES.includes(packageName)
        ) {
          violations.push(
            createViolation(
              "PKG_UNSUPPORTED_PI_PACKAGE",
              relativePath(root, filePath),
              `unsupported @earendil-works package: ${packageName}`
            )
          );
        }
        if (SUPPORTED_PI_PACKAGES.includes(packageName) || packageName === "typebox") {
          usedPackages.add(packageName);
          usedRootPackages.add(packageName);
        }
      }
    }

    const peerDependencies = manifest.data.peerDependencies ?? {};
    for (const packageName of usedPackages) {
      if (peerDependencies[packageName] !== "*") {
        violations.push(
          createViolation(
            "PKG_PEER_DEPENDENCY",
            manifest.relative,
            `${packageName} must be declared in peerDependencies with range "*"`
          )
        );
      }
      for (const field of ["dependencies", "devDependencies"]) {
        if (manifest.data[field]?.[packageName] !== undefined) {
          violations.push(
            createViolation(
              "PKG_DEPENDENCY_PLACEMENT",
              manifest.relative,
              `${packageName} must rely on the root pin and extension peerDependency, not ${field}`
            )
          );
        }
      }
    }

    const scripts = manifest.data.scripts ?? {};
    if (typeof scripts.typecheck !== "string" || !/\b(?:tsc|typecheck:)/u.test(scripts.typecheck)) {
      violations.push(
        createViolation(
          "PKG_TYPECHECK_SCRIPT",
          manifest.relative,
          "extension must provide a TypeScript typecheck script"
        )
      );
    }
    if (typeof scripts["test:all"] !== "string") {
      violations.push(
        createViolation("PKG_TEST_ALL", manifest.relative, "extension must provide test:all")
      );
    } else {
      const order = commandOrder(scripts["test:all"]);
      if (order.typecheck < 0 || order.test < 0 || order.typecheck > order.test) {
        violations.push(
          createViolation(
            "PKG_TEST_ALL",
            manifest.relative,
            "test:all must run typecheck before its test command(s)"
          )
        );
      }
    }

    const mainConfig = `${relativeDirectory}/tsconfig.json`;
    const project = projects.find((candidate) => candidate.config === mainConfig);
    if (!project || !project.qualifying || project.invokedBy.length === 0) {
      violations.push(
        createViolation(
          "PKG_TSCONFIG",
          mainConfig,
          "extension tsconfig must be invoked by typecheck with the complete strict/noEmit vector"
        )
      );
    }

    const packageLock = path.join(directory, "package-lock.json");
    if (existsSync(packageLock)) {
      violations.push(
        createViolation(
          "PKG_PACKAGE_LOCK",
          relativePath(root, packageLock),
          "package-lock.json is prohibited; use Bun"
        )
      );
    }
    extensions.push({
      directory: relativeDirectory,
      files: extensionFiles.length,
      usedPackages: [...usedPackages].sort(),
    });
  }

  const rootManifest = manifests.find(
    (manifest) => canonicalPath(manifest.directory) === canonicalPath(root)
  );
  const rootDevelopmentDependencies = rootManifest?.data?.devDependencies ?? {};
  for (const packageName of [...usedRootPackages].sort()) {
    const version = rootDevelopmentDependencies[packageName];
    if (!isExactVersion(version)) {
      violations.push(
        createViolation(
          "PKG_ROOT_PIN",
          rootManifest?.relative ?? "package.json",
          `${packageName} must have an exact root devDependency pin; found ${JSON.stringify(version)}`
        )
      );
    }
  }
  return extensions;
}

function extractStaticArray(sourceFile, propertyName) {
  let value;
  function visit(node) {
    if (value !== undefined) return;
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
          ? node.name.text
          : undefined;
      if (name === propertyName && ts.isArrayLiteralExpression(node.initializer)) {
        const items = [];
        for (const element of node.initializer.elements) {
          if (!ts.isStringLiteralLike(element)) return;
          items.push(element.text);
        }
        value = items;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return value;
}

function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/u);
  if (!match || match.index === undefined) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1].split(",").flatMap((choice) => expandBraces(`${before}${choice}${after}`));
}

function globToRegExp(pattern) {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        result += "(?:.*/)?";
        index += 2;
      } else {
        result += ".*";
        index += 1;
      }
    } else if (character === "*") result += "[^/]*";
    else if (character === "?") result += "[^/]";
    else if ("\\.^$+()[]|".includes(character)) result += `\\${character}`;
    else result += character;
  }
  return new RegExp(`${result}$`, "u");
}

function matchesPatterns(relative, includes, excludes) {
  const included = includes.some((pattern) =>
    expandBraces(pattern).some((item) => globToRegExp(item).test(relative))
  );
  if (!included) return false;
  return !excludes.some((pattern) =>
    expandBraces(pattern).some((item) => globToRegExp(item).test(relative))
  );
}

function scriptReferences(script) {
  const references = [];
  const pattern = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/gu;
  for (const match of script.matchAll(pattern)) references.push(match[1]);
  return references;
}

function reachableScripts(scripts, start) {
  const reached = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const scriptName = pending.pop();
    if (!scriptName || reached.has(scriptName) || typeof scripts[scriptName] !== "string") continue;
    reached.add(scriptName);
    for (const referenced of scriptReferences(scripts[scriptName])) pending.push(referenced);
  }
  return reached;
}

function configFromVitestScript(script, packageDirectory) {
  if (!/\bvitest\b/u.test(script)) return undefined;
  const match = script.match(/--config(?:\s+|=)(?:["']([^"']+)["']|([^\s]+))/u);
  const configured = match?.[1] ?? match?.[2] ?? "vitest.config.ts";
  return path.resolve(packageDirectory, configured);
}

function inspectRunnerMappings({ root, files, manifests, violations }) {
  const runnerConfigs = [];
  const mappingsByFile = new Map();

  for (const manifest of manifests) {
    const scripts = manifest.data?.scripts;
    if (!scripts || typeof scripts !== "object") continue;
    const aggregateScripts = reachableScripts(scripts, "test:all");
    const scriptsByConfig = new Map();
    for (const [scriptName, scriptValue] of Object.entries(scripts)) {
      if (typeof scriptValue !== "string") continue;
      const configPath = configFromVitestScript(scriptValue, manifest.directory);
      if (!configPath) continue;
      const entries = scriptsByConfig.get(canonicalPath(configPath)) ?? [];
      entries.push({ script: scriptName, aggregate: aggregateScripts.has(scriptName) });
      scriptsByConfig.set(canonicalPath(configPath), entries);
    }

    for (const [configPath, scriptEntries] of scriptsByConfig) {
      if (!existsSync(configPath)) continue;
      const text = readFileSync(configPath, "utf8");
      const sourceFile = ts.createSourceFile(
        configPath,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const includes = extractStaticArray(sourceFile, "include") ?? [
        "**/*.test.ts",
        "**/*.spec.ts",
      ];
      const excludes = extractStaticArray(sourceFile, "exclude") ?? [
        "**/node_modules/**",
        "**/dist/**",
      ];
      const configRelative = relativePath(root, configPath);
      const matched = [];
      for (const filePath of files) {
        if (nearestPackageManifest(filePath, manifests, root) !== manifest) continue;
        const packageRelative = toPosix(path.relative(manifest.directory, filePath));
        if (!matchesPatterns(packageRelative, includes, excludes)) continue;
        const relative = relativePath(root, filePath);
        matched.push(relative);
        const mappings = mappingsByFile.get(filePath) ?? [];
        for (const entry of scriptEntries) {
          mappings.push({
            config: configRelative,
            script: entry.script,
            aggregate: entry.aggregate,
          });
        }
        mappingsByFile.set(filePath, mappings);
      }
      runnerConfigs.push({
        config: configRelative,
        package: manifest.relative,
        include: includes,
        exclude: excludes,
        scripts: scriptEntries,
        matched: matched.sort(),
      });
    }
  }

  for (const filePath of files) {
    const classification = classifyFile(relativePath(root, filePath));
    if (classification !== "test" && classification !== "smoke") continue;
    const mappings = mappingsByFile.get(filePath) ?? [];
    if (!mappings.some((mapping) => mapping.aggregate)) {
      violations.push(
        createViolation(
          "TEST_RUNNER_UNMAPPED",
          relativePath(root, filePath),
          mappings.length === 0
            ? "test/smoke file matches no configured runner script"
            : "test/smoke file has no runner reachable from package test:all"
        )
      );
    }
  }
  return { runnerConfigs, mappingsByFile };
}

function countBy(items, keySelector) {
  const counts = {};
  for (const item of items) {
    const key = keySelector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function eslintMatrices(files) {
  const groups = new Map();
  for (const file of files) {
    const eslint = file.eslint;
    const signature = eslint.ignored
      ? "ignored"
      : `${eslint.typeAware ? "type-aware" : "not-type-aware"}|${MANDATORY_ESLINT_RULES.map(
          (rule) => `${rule}:${eslint.rules[rule] ?? "off"}`
        ).join("|")}`;
    const group = groups.get(signature) ?? { signature, count: 0, sample: [], rules: eslint.rules };
    group.count += 1;
    if (group.sample.length < 5) group.sample.push(file.path);
    groups.set(signature, group);
  }
  return [...groups.values()].sort(
    (left, right) => right.count - left.count || left.signature.localeCompare(right.signature)
  );
}

function validateBaselineLocation(root, baselinePath) {
  const absolute = canonicalPath(baselinePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || (path.isAbsolute(relative) && !absolute.startsWith(root)))
    return;
  const check = spawnSync("git", ["check-ignore", "--quiet", "--", toPosix(relative)], {
    cwd: root,
    stdio: "ignore",
  });
  if (check.status !== 0) {
    throw new Error("baseline must be outside the repository or ignored by Git");
  }
}

function loadBaseline(root, baselinePath) {
  if (!baselinePath) return undefined;
  const absolute = path.resolve(root, baselinePath);
  validateBaselineLocation(root, absolute);
  const parsed = parseJsonFile(absolute);
  if (parsed.error) throw new Error(`cannot read baseline: ${parsed.error}`);
  if (!parsed.value || !Array.isArray(parsed.value.violations)) {
    throw new Error("baseline must be a guard JSON report containing a violations array");
  }
  return { path: absolute, violations: parsed.value.violations };
}

function compareBaseline(violations, baseline) {
  const currentCounts = new Map(
    Object.entries(countBy(violations, (violation) => violation.baselineKey))
  );
  const baselineCounts = new Map(
    Object.entries(
      countBy(
        baseline?.violations ?? [],
        (violation) => violation.baselineKey ?? `${violation.code}\u0000${violation.path}`
      )
    )
  );
  const increases = [];
  let acceptedDebt = 0;
  let resolvedDebt = 0;
  for (const [key, current] of currentCounts) {
    const previous = baselineCounts.get(key) ?? 0;
    acceptedDebt += Math.min(current, previous);
    if (current > previous)
      increases.push({ key, previous, current, increase: current - previous });
  }
  for (const [key, previous] of baselineCounts) {
    const current = currentCounts.get(key) ?? 0;
    if (previous > current) resolvedDebt += previous - current;
  }
  const supplied = baseline !== undefined;
  const exitPass = supplied ? increases.length === 0 : violations.length === 0;
  const fullCompliance = violations.length === 0;
  let status;
  if (!supplied && violations.length === 0) status = "FULL_COMPLIANCE";
  else if (!supplied) status = "UNBASELINED_FAIL";
  else if (increases.length > 0) status = "BASELINE_REGRESSION";
  else if (violations.length > 0) status = "BASELINE_AWARE_PASS_WITH_DEBT";
  else status = "FULL_COMPLIANCE";
  return {
    supplied,
    baselineViolations: baseline?.violations.length ?? 0,
    currentViolations: violations.length,
    acceptedDebt,
    resolvedDebt,
    increases,
    exitPass,
    fullCompliance,
    status,
  };
}

function selectViolations(violations, mode) {
  if (mode === "inventory")
    return violations.filter((violation) => INVENTORY_VIOLATION_CODES.has(violation.code));
  return violations;
}

export async function analyzeTypeScriptGuard(options) {
  const root = canonicalPath(options.projectRoot ?? process.cwd());
  const roots = [...(options.roots ?? [])];
  if (roots.length === 0) throw new Error("at least one scoped TypeScript root is required");
  const extensionRootRelative = options.extensionRoot ? toPosix(options.extensionRoot) : undefined;
  const adapterRelative = toPosix(options.toolAdapter ?? "");
  const configuredTestHostExceptions = options.testHostExceptions ?? EXACT_TEST_HOST_EXCEPTIONS;
  const violations = [];
  const { files, missingRoots } = discoverFiles(root, roots);
  for (const missing of missingRoots) {
    violations.push(
      createViolation(
        "ROOT_MISSING",
        missing,
        "configured TypeScript inventory root does not exist"
      )
    );
  }

  const sourceTexts = new Map();
  for (const filePath of files) sourceTexts.set(filePath, readFileSync(filePath, "utf8"));
  const manifests = collectPackageManifests(root, roots);
  const typeScript = loadTypeScriptProjects(root, roots, files, manifests, violations);
  const analysisProgram = createAnalysisProgram(files);
  const analysisChecker = analysisProgram.getTypeChecker();
  const eslint = await inspectEslint(root, files, sourceTexts, violations);
  const importsByFile = new Map();
  const commentsByFile = new Map();
  const parseDiagnosticsByFile = new Map();

  for (const filePath of files) {
    const text = sourceTexts.get(filePath) ?? "";
    const programSourceFile = analysisProgram.getSourceFile(filePath);
    const sourceFile =
      programSourceFile ??
      ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
    const checker = programSourceFile ? analysisChecker : undefined;
    const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
    const unusedExpectErrorLines = new Set();
    if (programSourceFile && text.includes("@ts-expect-error")) {
      for (const diagnostic of analysisProgram.getSemanticDiagnostics(programSourceFile)) {
        if (diagnostic.code !== 2578 || diagnostic.start === undefined) continue;
        const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
        unusedExpectErrorLines.add(location.line + 1);
      }
    }
    parseDiagnosticsByFile.set(filePath, parseDiagnostics);
    for (const diagnostic of parseDiagnostics) {
      const start = diagnostic.start ?? 0;
      const location = sourceFile.getLineAndCharacterOfPosition(start);
      violations.push(
        createViolation(
          "SYNTAX_ERROR",
          relativePath(root, filePath),
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
          { line: location.line + 1, column: location.character + 1 }
        )
      );
    }
    importsByFile.set(
      filePath,
      scanSourceFile({
        root,
        filePath,
        sourceFile,
        checker,
        adapterRelative,
        extensionRootRelative,
        violations,
      })
    );
    commentsByFile.set(
      filePath,
      scanComments(relativePath(root, filePath), text, sourceFile, violations, {
        unusedExpectErrorLines,
      })
    );
  }

  const testHostExceptions = applyExactTestHostExceptions({
    root,
    sourceTexts,
    commentsByFile,
    violations,
    exceptions: configuredTestHostExceptions,
  });

  const extensionPackages = inspectExtensionPackages({
    root,
    extensionRoot: options.extensionRoot,
    files,
    importsByFile,
    manifests,
    projects: typeScript.projects,
    violations,
  });
  const runners = inspectRunnerMappings({ root, files, manifests, violations });

  const fileReports = files.map((filePath) => {
    const relative = relativePath(root, filePath);
    const memberships = typeScript.memberships.get(canonicalPath(filePath)) ?? [];
    const qualifying = memberships.filter(
      (membership) =>
        membership.qualifying && !(relative.endsWith(".d.ts") && membership.skipLibCheck)
    );
    if (
      relative.endsWith(".d.ts") &&
      memberships.some((membership) => membership.qualifying && membership.skipLibCheck)
    ) {
      violations.push(
        createViolation(
          "TSC_DECLARATION_SKIPPED",
          relative,
          "owned declaration is only in a qualifying project with skipLibCheck enabled"
        )
      );
    }
    if (qualifying.length === 0) {
      violations.push(
        createViolation(
          "TSC_OMITTED",
          relative,
          "file belongs to no invoked project with the strict/noEmit vector"
        )
      );
    }
    return {
      path: relative,
      classification: classifyFile(relative),
      eslint: eslint.get(filePath) ?? { ignored: false, typeAware: false, rules: {} },
      programs: memberships,
      qualifyingPrograms: qualifying.map((membership) => membership.config),
      runnerMappings: runners.mappingsByFile.get(filePath) ?? [],
      syntaxDebt: (parseDiagnosticsByFile.get(filePath) ?? []).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      ),
      directives: commentsByFile.get(filePath)?.directives ?? [],
      suppressions: commentsByFile.get(filePath)?.suppressions ?? [],
    };
  });

  violations.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.path.localeCompare(right.path) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.detail.localeCompare(right.detail)
  );
  const baseline = loadBaseline(root, options.baselinePath);
  const evaluation = compareBaseline(violations, baseline);
  return {
    schemaVersion: 1,
    scope: {
      roots: roots.map(toPosix),
      extensionRoot: extensionRootRelative,
      toolAdapter: adapterRelative,
    },
    summary: {
      files: fileReports.length,
      classifications: countBy(fileReports, (file) => file.classification),
      eslintCovered: fileReports.filter((file) => !file.eslint.ignored && file.eslint.typeAware)
        .length,
      strictProgramCovered: fileReports.filter((file) => file.qualifyingPrograms.length > 0).length,
      runnerMapped: fileReports.filter(
        (file) =>
          !["test", "smoke"].includes(file.classification) ||
          file.runnerMappings.some((mapping) => mapping.aggregate)
      ).length,
      violationCounts: countBy(violations, (violation) => violation.code),
      directiveCounts: countBy(
        fileReports.flatMap((file) => file.directives),
        (directive) => directive.kind
      ),
      suppressionCount: fileReports.reduce((count, file) => count + file.suppressions.length, 0),
      testHostExceptionsRegistered: testHostExceptions.registered.length,
      testHostExceptionsAccepted: testHostExceptions.accepted.length,
    },
    testHostExceptions,
    eslintMatrices: eslintMatrices(fileReports),
    projects: typeScript.projects,
    runners: runners.runnerConfigs,
    extensions: extensionPackages,
    files: fileReports,
    violations,
    evaluation,
  };
}

function modeEvaluation(report, mode, baselinePath, projectRoot) {
  const violations = selectViolations(report.violations, mode);
  const baseline = loadBaseline(projectRoot, baselinePath);
  return {
    ...report,
    mode,
    summary: {
      ...report.summary,
      violationCounts: countBy(violations, (violation) => violation.code),
    },
    violations,
    evaluation: compareBaseline(violations, baseline),
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`TypeScript ${report.mode} guard`);
  lines.push(`Scope (${report.scope.roots.length} roots): ${report.scope.roots.join(", ")}`);
  lines.push(`Owned TypeScript: ${report.summary.files}`);
  lines.push(
    `Coverage: ESLint ${report.summary.eslintCovered}/${report.summary.files}; strict program ${report.summary.strictProgramCovered}/${report.summary.files}`
  );
  const testCount = report.files.filter((file) =>
    ["test", "smoke"].includes(file.classification)
  ).length;
  const mappedTests = report.files.filter(
    (file) =>
      ["test", "smoke"].includes(file.classification) &&
      file.runnerMappings.some((mapping) => mapping.aggregate)
  ).length;
  lines.push(
    `Runner mappings: ${mappedTests}/${testCount} test/smoke files reachable from package test:all`
  );
  lines.push(
    `TypeScript projects: ${report.projects.length}; ESLint matrices: ${report.eslintMatrices.length}`
  );
  lines.push(
    `Exact test-host exceptions: ${report.summary.testHostExceptionsAccepted}/${report.summary.testHostExceptionsRegistered} centrally registered sites accepted`
  );
  lines.push("Debt/violation counts:");
  const counts = Object.entries(report.summary.violationCounts);
  if (counts.length === 0) lines.push("  none detected");
  else for (const [code, count] of counts) lines.push(`  ${code}: ${count}`);
  const directiveCounts = Object.entries(report.summary.directiveCounts);
  lines.push(
    `Directives: ${directiveCounts.length ? directiveCounts.map(([kind, count]) => `${kind}=${count}`).join(", ") : "none"}; ESLint suppressions=${report.summary.suppressionCount}`
  );

  if (!report.evaluation.supplied) {
    lines.push("Baseline: NOT SUPPLIED — enforcement checks the current tree directly.");
  } else {
    lines.push(
      `Baseline: supplied; baseline=${report.evaluation.baselineViolations}, current=${report.evaluation.currentViolations}, accepted debt=${report.evaluation.acceptedDebt}, resolved=${report.evaluation.resolvedDebt}, increases=${report.evaluation.increases.length}`
    );
    if (report.evaluation.currentViolations > 0 && report.evaluation.increases.length === 0) {
      lines.push("Baseline debt remains explicit; this is a migration pass, not full compliance.");
    }
  }
  lines.push(`Status: ${report.evaluation.status}`);

  const display =
    report.evaluation.supplied && report.evaluation.increases.length > 0
      ? report.violations.filter((violation) =>
          report.evaluation.increases.some((increase) => increase.key === violation.baselineKey)
        )
      : report.violations;
  const limit = 200;
  if (display.length > 0) {
    lines.push("Findings:");
    for (const violation of display.slice(0, limit)) {
      const location = violation.line
        ? `:${violation.line}${violation.column ? `:${violation.column}` : ""}`
        : "";
      lines.push(`  [${violation.code}] ${violation.path}${location} — ${violation.detail}`);
    }
    if (display.length > limit) {
      lines.push(
        `  ... ${display.length - limit} additional findings; use --format json for the complete exact-path report.`
      );
    }
  }
  return lines.join("\n");
}

function parseArguments(argv) {
  const result = { roots: [], format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "inventory" || argument === "architecture") result.mode = argument;
    else if (argument === "--root") result.roots.push(argv[++index]);
    else if (argument === "--extension-root") result.extensionRoot = argv[++index];
    else if (argument === "--tool-adapter") result.toolAdapter = argv[++index];
    else if (argument === "--baseline") result.baselinePath = argv[++index];
    else if (argument === "--format") result.format = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.mode) throw new Error("first argument must be inventory or architecture");
  if (!result.roots.every((root) => typeof root === "string" && root.length > 0)) {
    throw new Error("every --root requires a path");
  }
  if (!["text", "json"].includes(result.format)) throw new Error("--format must be text or json");
  return result;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const projectRoot = process.cwd();
    const fullReport = await analyzeTypeScriptGuard({ projectRoot, ...options });
    const report = modeEvaluation(fullReport, options.mode, options.baselinePath, projectRoot);
    process.stdout.write(
      options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${formatText(report)}\n`
    );
    process.exitCode = report.evaluation.exitPass ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `typescript guard error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
