/** Test-only checkout-bound deployment. Never bundle orchestration owners or relax shipping guards. */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { assertCurrentShippingBuild } from "../../orchestration/dist/build-provenance.js";
import { sha256 } from "../../orchestration/dist/canonical-json.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const PackageSchema = Type.Object({
  name: Type.String(),
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const publicControls = new Set([
  ".nvmrc",
  "package.json",
  "bun.lock",
  ".pi/extensions/artifacts/artifact-runtime.ts",
  ".pi/extensions/artifacts/index.ts",
  ".pi/extensions/artifacts/owner-client.ts",
  ".pi/extensions/artifacts/types.ts",
  ".pi/extensions/lib/tool-result-budget.ts",
  ".pi/lib/compaction-policy.d.mts",
  ".pi/lib/compaction-policy.mjs",
  ".pi/lib/logger/logger.ts",
  ".pi/lib/pi-tool-registration.ts",
]);
function privateCopy(source: string, destination: string, digest?: string) {
  const stat = lstatSync(source);
  // Installed package-cache files may be hardlinked; the protected copy is always a new inode.
  if (!stat.isFile() || stat.isSymbolicLink() || (digest !== undefined && stat.nlink !== 1))
    throw new Error("p03_fixture_nonregular_input");
  const bytes = readFileSync(source);
  if (digest !== undefined && sha256(bytes) !== digest)
    throw new Error("p03_fixture_shipping_input_drift");
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
}
function packageRoot(name: string, from: string): string {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(name))
    throw new Error("p03_fixture_invalid_package_name");
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) {
      const root = path.dirname(realpathSync(candidate));
      if (!root.startsWith(path.join(repository, "node_modules") + path.sep))
        throw new Error("p03_fixture_nonpublic_runtime_package");
      return root;
    }
    if (dir === path.dirname(dir)) throw new Error(`p03_fixture_missing_runtime_package: ${name}`);
  }
}

/** Only provenance-declared public checkout bytes and installed production dependencies.
 * The entire closure lives INSIDE the existing measured dependency root: no ambient checkout,
 * additional node_modules root, symlinks, credentials, private state, or operator staging. */
export function protectedOrchestrationFixture(dependencies: string): string {
  const identity = assertCurrentShippingBuild();
  if (identity === undefined) throw new Error("p03_fixture_compiled_generation_required");
  const workspace = path.join(dependencies, ".p03-orchestration-checkout");
  const output = path.join(workspace, "apps/orchestration/dist");
  const provenance = identity.provenance;
  for (const [relative, digest] of Object.entries(provenance.inputs)) {
    if (
      !publicControls.has(relative) &&
      !/^apps\/orchestration\/(?:src\/[A-Za-z0-9_./-]+|scripts\/[A-Za-z0-9_-]+\.mjs|package\.json|tsconfig\.json)$/u.test(
        relative
      )
    )
      throw new Error(`p03_fixture_undeclared_checkout_input: ${relative}`);
    privateCopy(path.join(repository, relative), path.join(workspace, relative), digest);
  }
  for (const [relative, digest] of Object.entries(provenance.outputs))
    privateCopy(
      path.join(repository, "apps/orchestration/dist", relative),
      path.join(output, relative),
      digest
    );
  privateCopy(
    path.join(repository, "apps/orchestration/dist/build-provenance.json"),
    path.join(output, "build-provenance.json"),
    identity.generation
  );

  // Resolve each literal module edge under its actual import/require condition, including
  // unused re-exports. No dependency or engine code executes; owners stay external.
  const runtimeInventory = execFileSync(
    process.execPath,
    [
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "--eval",
      `
      import { existsSync, readFileSync, realpathSync } from 'node:fs';
      import path from 'node:path';
      import { createRequire, isBuiltin } from 'node:module';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const parent = ${JSON.stringify(path.join(repository, "apps/orchestration/package.json"))};
      const ts = createRequire(parent)('typescript');
      const roots = ['@earendil-works/pi-coding-agent', 'typebox', 'typebox/value', 'php-parser', 'typescript'];
      const files = new Set();
      const queue = roots.map(name => fileURLToPath(import.meta.resolve(name, pathToFileURL(parent))));
      for (const candidate of queue) {
        const file = realpathSync(candidate);
        if (files.has(file)) continue;
        files.add(file);
        if (!/\\.[cm]?js$/.test(file)) continue;
        const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node) {
          let literal, commonjs = false;
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
          else if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(ast);
            commonjs = callee === 'require' || callee === 'require.resolve';
            if (commonjs || node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
          }
          if (literal && ts.isStringLiteralLike(literal) && !isBuiltin(literal.text)) {
            try {
              const target = commonjs ? createRequire(file).resolve(literal.text) : fileURLToPath(import.meta.resolve(literal.text, pathToFileURL(file)));
              if (path.isAbsolute(target) && existsSync(target)) queue.push(target);
            } catch { /* An uninstalled optional or unsupported conditional branch stays absent. */ }
          }
          ts.forEachChild(node, visit);
        }
        visit(ast);
      }
      console.log(JSON.stringify([...files]));
      `,
    ],
    { cwd: repository, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 }
  );
  const inventory: unknown = JSON.parse(runtimeInventory);
  const runtimeFiles = new Set(
    validateContract(Type.Array(Type.String()), inventory, "fixture runtime inventory")
  );
  // Follow only reached production packages, retaining conflicting versions locally.
  // Keep literal JSON imports, package scope metadata and native assets, not unrelated JSON
  // datasets/locales from every declared dependency. Never copy an ambient package tree.
  const installed = new Map<string, string>();
  const copyRuntime = (source: string, destination: string) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (["node_modules", "test", "tests", "__tests__"].includes(entry.name)) continue;
      const file = path.join(source, entry.name);
      if (entry.isDirectory()) copyRuntime(file, path.join(destination, entry.name));
      else if (
        entry.name === "package.json" ||
        /\.(?:node|wasm)$/u.test(entry.name) ||
        runtimeFiles.has(realpathSync(file))
      )
        privateCopy(file, path.join(destination, entry.name));
    }
  };
  const install = (name: string, from: string, consumer: string) => {
    const source = packageRoot(name, from);
    if (![...runtimeFiles].some((file) => file.startsWith(source + path.sep))) return;
    for (let dir = consumer; ; dir = path.dirname(dir)) {
      const existing = installed.get(path.join(dir, "node_modules", name));
      if (existing !== undefined) {
        if (existing === source) return;
        break;
      }
      if (dir === path.dirname(dependencies)) break;
    }
    const primary = path.join(dependencies, name);
    const destination = installed.has(primary)
      ? path.join(consumer, "node_modules", name)
      : primary;
    if (installed.has(destination)) throw new Error("p03_fixture_runtime_version_conflict");
    installed.set(destination, source);
    const manifest: unknown = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
    const pkg = validateContract(PackageSchema, manifest, "fixture runtime package");
    if (pkg.name !== name) throw new Error("p03_fixture_runtime_package_identity");
    copyRuntime(source, destination);
    for (const dependency of Object.keys(pkg.dependencies ?? {}))
      install(dependency, source, destination);
  };
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(workspace, "apps/orchestration/package.json"), "utf8")
  );
  const pkg = validateContract(PackageSchema, manifest, "fixture orchestration package");
  // active-symbol-resolution.js imports TypeScript at runtime, despite its devDependency label.
  for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), "typescript"]))
    install(name, path.join(repository, "apps/orchestration"), path.dirname(dependencies));
  return output;
}

/** Rewrite syntactic compiled edges before Bun can traverse the guarded JS.
 * Private dist imports remain a TEST-ONLY exception, not new production package exports. */
export function buildP03CompiledFixture(input: {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly orchestration: string;
  readonly initial?: boolean;
}) {
  execFileSync(
    "bun",
    [
      "--eval",
      `
      import path from 'node:path';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import { moduleSpecifiers, orchestrationImportTarget } from ${JSON.stringify(path.join(repository, "apps/orchestration/scripts/shipping-imports.mjs"))};
      const input = ${JSON.stringify(input)};
      const original = ${JSON.stringify(path.join(repository, "apps/orchestration"))};
      const exports = JSON.parse(readFileSync(path.join(original, 'package.json'), 'utf8')).exports;
      const result = await Bun.build({
        entrypoints: [input.entrypoint], outdir: path.dirname(input.outfile), naming: path.basename(input.outfile),
        target: 'node', format: 'esm', packages: 'bundle',
        external: ['vitest', 'tree-sitter', 'tree-sitter-javascript', 'tree-sitter-php', 'tree-sitter-typescript', input.orchestration + '/*'],
        ...(input.initial ? { banner: 'process.argv[1] = undefined;' } : {}),
        plugins: [{name: 'test-only-one-compiled-generation', setup(builder) {
          builder.onLoad({filter: /\\.[cm]?[jt]sx?$/}, args => {
            let contents = readFileSync(args.path, 'utf8');
            for (const imported of moduleSpecifiers(contents, args.path).sort((a,b) => b.start - a.start)) {
              let specifier = imported.specifier;
              if (specifier === '@penny/orchestration' || specifier.startsWith('@penny/orchestration/')) {
                const key = specifier === '@penny/orchestration' ? '.' : './' + specifier.slice('@penny/orchestration/'.length);
                const entry = exports[key];
                if (entry === undefined) throw new Error('Undeclared orchestration shipping import');
                specifier = path.resolve(original, typeof entry === 'string' ? entry : entry.default);
              }
              const target = orchestrationImportTarget(specifier, args.path, original);
              if (target === undefined) continue;
              if (target.area !== 'dist') throw new Error('p03_fixture_source_alias_refused');
              const url = new URL(specifier, pathToFileURL(args.path));
              const literal = JSON.stringify(path.join(input.orchestration, path.relative(path.join(original, 'dist'), target.physical)) + url.search + url.hash);
              contents = contents.slice(0, imported.start) + literal + contents.slice(imported.end);
            }
            const loader = args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') || args.path.endsWith('.mts') ? 'ts' : args.path.endsWith('.jsx') ? 'jsx' : 'js';
            return {contents, loader};
          });
        }}],
      });
      if (!result.success) throw new AggregateError(result.logs, 'P03 fixture bundling failed');
      `,
    ],
    { timeout: 30_000, maxBuffer: 1_048_576 }
  );
}
