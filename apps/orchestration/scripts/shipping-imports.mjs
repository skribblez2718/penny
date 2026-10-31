#!/usr/bin/env node
/** Closed compiled workspace boundary. No import rewriting or source aliases in shipping. */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import ts from "typescript";

export function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !["node_modules", "dist", "build", "out", ".git"].includes(entry.name))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(file)
        : /\.(?:[cm]?[jt]sx?)$/u.test(file)
          ? [file]
          : [];
    });
}

/** Only syntactic module edges: never interpret ordinary source/diagnostic strings as imports. */
export function moduleSpecifiers(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      literal = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      literal = node.argument.literal;
    else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        [
          "require",
          "require.resolve",
          "vi.mock",
          "vi.doMock",
          "vi.importActual",
          "vi.importMock",
          "jest.mock",
          "jest.doMock",
          "jest.requireActual",
          "jest.requireMock",
        ].includes(callee)
      )
        literal = node.arguments[0];
    } else if (ts.isExternalModuleReference(node)) literal = node.expression;
    if (literal && ts.isStringLiteralLike(literal))
      imports.push({ specifier: literal.text, start: literal.getStart(ast), end: literal.end });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function physicalPath(candidate) {
  // Resolve existing ancestors too, so symlinked directories cannot hide private targets.
  try {
    return realpathSync(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    const parent = path.dirname(candidate);
    return parent === candidate
      ? candidate
      : path.join(physicalPath(parent), path.basename(candidate));
  }
}

/** Canonical path comparison shared by the bundler and shipping checker. AST decoding above
 * handles JS escapes; URL decoding, separators, dot segments and real paths are handled here. */
export function orchestrationImportTarget(specifier, file, packageRoot) {
  const decoded = decodeURIComponent(specifier).replaceAll("\\", "/");
  if (!decoded.startsWith(".") && !path.isAbsolute(decoded) && !decoded.startsWith("file:"))
    return undefined;
  const resolved = fileURLToPath(new URL(decoded, pathToFileURL(file)));
  const physical = physicalPath(resolved);
  for (const area of ["src", "dist"]) {
    const directory = path.join(packageRoot, area);
    if (within(directory, resolved) || within(physicalPath(directory), physical))
      return { area, resolved, physical };
  }
  return undefined;
}

export function declaredOrchestrationTarget(target, packageRoot, exports) {
  if (target.area !== "dist") return false;
  return Object.values(exports)
    .flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry)))
    .some((entry) => {
      const declared = path.resolve(packageRoot, entry);
      return (
        within(path.join(packageRoot, "dist"), declared) &&
        within(physicalPath(path.join(packageRoot, "dist")), target.physical) &&
        physicalPath(declared) === target.physical
      );
    });
}

function orchestrationPackageKey(specifier) {
  if (specifier === "@penny/orchestration") return ".";
  if (specifier.startsWith("@penny/orchestration/"))
    return "./" + specifier.slice("@penny/orchestration/".length);
  return undefined;
}

/** Rewrites actual import tokens only, after validating their canonical shipping targets. */
export function rewriteOrchestrationImports(source, file, packageRoot, exports, destination) {
  let rewritten = source;
  for (const imported of moduleSpecifiers(source, file).sort((a, b) => b.start - a.start)) {
    const key = orchestrationPackageKey(imported.specifier);
    if (key !== undefined && !Object.hasOwn(exports, key))
      throw new Error("Undeclared orchestration shipping import");
    const entry = key === undefined ? undefined : exports[key];
    const specifier =
      entry === undefined
        ? imported.specifier
        : path.resolve(packageRoot, typeof entry === "string" ? entry : entry.default);
    const target = orchestrationImportTarget(specifier, file, packageRoot);
    if (target === undefined) continue;
    if (!declaredOrchestrationTarget(target, packageRoot, exports))
      throw new Error("Undeclared orchestration shipping import");
    const relative = path.relative(destination, target.physical).split(path.sep).join("/");
    const literal = JSON.stringify(relative.startsWith(".") ? relative : "./" + relative);
    rewritten = rewritten.slice(0, imported.start) + literal + rewritten.slice(imported.end);
  }
  return rewritten;
}

export function shippingImportFindings(source, file, workspace, exports) {
  const findings = [];
  const packageRoot = path.join(workspace, "apps/orchestration");
  const ownSource = within(path.join(packageRoot, "src"), file);
  for (const { specifier } of moduleSpecifiers(source, file)) {
    let target;
    try {
      target = orchestrationImportTarget(specifier, file, packageRoot);
    } catch {
      findings.push(`${file}: invalid module path ${specifier}`);
      continue;
    }
    if (!ownSource && target !== undefined) {
      // Tests exercise private compiled internals; shipping consumers never receive this exception.
      const compiledTest = /\/(?:tests|smoke)\//u.test(file) && target.area === "dist";
      if (!compiledTest && !declaredOrchestrationTarget(target, packageRoot, exports))
        findings.push(`${file}: use an explicit compiled orchestration export, not ${specifier}`);
    }
    const key = orchestrationPackageKey(specifier);
    if (key !== undefined && !Object.hasOwn(exports, key))
      findings.push(`${file}: undeclared orchestration export ${specifier}`);
  }
  return findings;
}

export function checkShippingImports(workspace) {
  const manifest = JSON.parse(
    readFileSync(path.join(workspace, "apps/orchestration/package.json"), "utf8")
  );
  const findings = [];
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key.includes("*") || key === "./source")
      findings.push(`Unsupported shipping export ${key}`);
    const targets = typeof target === "string" ? [target] : Object.values(target);
    if (targets.some((value) => typeof value !== "string" || !value.startsWith("./dist/")))
      findings.push(`Non-compiled export ${key}`);
    if (typeof target === "object" && target.types !== target.default.replace(/\.js$/u, ".d.ts"))
      findings.push(`Declaration generation mismatch ${key}`);
  }
  for (const root of [".pi/extensions", ".pi/lib", "apps"]) {
    for (const file of sourceFiles(path.join(workspace, root))) {
      findings.push(
        ...shippingImportFindings(readFileSync(file, "utf8"), file, workspace, manifest.exports)
      );
    }
  }
  if (findings.length > 0) throw new Error(findings.join("\n"));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkShippingImports(path.resolve(import.meta.dirname, "../../.."));
  process.stdout.write("Orchestration shipping imports are compiled-only.\n");
}
