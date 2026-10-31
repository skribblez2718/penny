#!/usr/bin/env bun
/** Keep the installed orchestration generation external even when bundling local service code. */
import { build } from "bun";
import process from "node:process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { rewriteOrchestrationImports } from "../../orchestration/scripts/shipping-imports.mjs";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, "dist");
const stage = path.join(root, "build");
const orchestration = path.resolve(root, "../orchestration");
const manifest = JSON.parse(readFileSync(path.join(orchestration, "package.json"), "utf8"));
const externalOrchestration = {
  name: "one-orchestration-generation",
  setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/u }, (args) => ({
      contents: rewriteOrchestrationImports(
        readFileSync(args.path, "utf8"),
        args.path,
        orchestration,
        manifest.exports,
        destination
      ),
      loader: /\.[cm]?tsx?$/u.test(args.path)
        ? args.path.endsWith("x")
          ? "tsx"
          : "ts"
        : args.path.endsWith("x")
          ? "jsx"
          : "js",
    }));
  },
};

mkdirSync(stage, { mode: 0o700 }); // Never reuse/delete staging owned by another invocation.
try {
  for (const [entries, options] of [
    [["index", "p01-joern-root", "p03-bootstrap-cli", "job-store-cli"], { packages: "external" }],
    [
      [
        "process",
        "ordinary-runtime",
        "ordinary-application-tests",
        "ordinary-application-container",
        "ordinary-rule-learning",
      ],
      { external: ["typebox", "typescript"] },
    ],
    [
      ["p02-inventory-worker"],
      {
        external: [
          "tree-sitter",
          "tree-sitter-javascript",
          "tree-sitter-php",
          "tree-sitter-typescript",
        ],
      },
    ],
  ]) {
    const result = await build({
      entrypoints: entries.map((entry) => path.join(root, "src", entry + ".ts")),
      outdir: stage,
      target: "node",
      format: "esm",
      plugins: [externalOrchestration],
      ...options,
      external: [...(options.external ?? []), "../../orchestration/dist/*"],
    });
    if (!result.success) throw new AggregateError(result.logs, "SCA service bundling failed");
  }
  for (const file of [
    "p02-host-worker.mjs",
    "p02-osv-worker.mjs",
    "p02-scratch-launcher.mjs",
    "ordinary-application-tests-bridge.py",
    "ordinary-application-tests-guest.py",
  ]) {
    copyFileSync(path.join(root, "src", file), path.join(stage, file));
  }
  mkdirSync(path.join(root, "out"), { recursive: true });
  const previousRoot = mkdtempSync(path.join(root, "out/previous-"));
  const previous = path.join(previousRoot, "dist");
  let movedPrevious = false;
  let preservePrevious = false;
  try {
    try {
      renameSync(destination, previous);
      movedPrevious = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (movedPrevious) {
        try {
          renameSync(previous, destination);
        } catch (rollbackError) {
          preservePrevious = true;
          throw new AggregateError(
            [error, rollbackError],
            `SCA publication failed; previous build preserved at ${previous}`
          );
        }
      }
      throw error;
    }
  } finally {
    if (!preservePrevious) rmSync(previousRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.stdout.write("SCA service built with external compiled orchestration imports.\n");
