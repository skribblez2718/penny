/** Build-time source closure. Compiler inputs + relative runtime/helper graph, not mtimes. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export function treeFiles(directory, prefix = "") {
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("Build input directory must be real");
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
      const name = prefix + entry.name;
      if (entry.isDirectory()) return treeFiles(candidate, name + "/");
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Build inputs must be regular single-link files");
      return [name];
    })
    .sort();
}
export function fileDigests(root, files) {
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ])
  );
}
function relativeClosure(workspace, entries) {
  const seen = new Set();
  const queue = [...entries];
  for (const file of queue) {
    if (seen.has(file)) continue;
    if (file.startsWith("../") || path.isAbsolute(file))
      throw new Error("Build input escapes workspace");
    seen.add(file);
    if (!/\.(?:[cm]?[jt]s)$/u.test(file)) continue;
    const source = readFileSync(path.join(workspace, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        specifier = node.arguments[0].text;
      if (specifier?.startsWith(".")) {
        const runtimeFile = path.resolve(workspace, path.dirname(file), specifier);
        const result = ts.resolveModuleName(
          specifier,
          path.join(workspace, file),
          {
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            allowJs: true,
            resolveJsonModule: true,
          },
          ts.sys
        ).resolvedModule;
        if (result === undefined && !existsSync(runtimeFile))
          throw new Error(`Unresolved build input ${file}: ${specifier}`);
        if (result !== undefined)
          queue.push(path.relative(workspace, result.resolvedFileName).split(path.sep).join("/"));
        if (existsSync(runtimeFile))
          queue.push(path.relative(workspace, runtimeFile).split(path.sep).join("/"));
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return [...seen].sort();
}
export function captureBuildInputs(packageRoot) {
  const workspace = path.resolve(packageRoot, "../..");
  const sourceFiles = treeFiles(path.join(packageRoot, "src"));
  const helperInputs = relativeClosure(workspace, [".pi/extensions/artifacts/index.ts"]);
  const sourceInputs = relativeClosure(
    workspace,
    sourceFiles.map((name) => "apps/orchestration/src/" + name)
  );
  const controls = [
    "apps/orchestration/package.json",
    "apps/orchestration/tsconfig.json",
    "package.json",
    "bun.lock",
    ".nvmrc",
    ...treeFiles(path.join(packageRoot, "scripts"))
      .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      .map((name) => "apps/orchestration/scripts/" + name),
  ];
  return {
    inputs: fileDigests(workspace, [...sourceInputs, ...helperInputs, ...controls]),
    source_files: sourceFiles,
    helper_inputs: helperInputs,
  };
}
