#!/usr/bin/env node

import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "./canonical-json.js";
import { describeScaSourceSnapshotV1 } from "./playbooks/sca.js";

interface SnapshotArgumentsV1 {
  readonly sourceRoot: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly output: string | null;
}

const HELP = [
  "Usage: penny-sca-snapshot --source-root=PATH [--include=PATH] [--exclude=PATH] [--output=PATH]",
  "",
  "Computes the exact portable source_snapshot_sha256 through the active SCA",
  "no-follow discovery/capture path. It performs no model, broker, network, or target execution.",
  "",
  "Options may be repeated for include/exclude. Use --include=. for the repository root.",
  "When --output is supplied, the new absolute path is created exclusively with mode 0600.",
  "Without --output, one canonical JSON object is written to stdout.",
  "",
].join("\n");

function oneValue(argument: string, name: string): string | null {
  const prefix = `--${name}=`;
  if (!argument.startsWith(prefix)) return null;
  const value = argument.slice(prefix.length);
  if (value.length === 0) throw new Error(`--${name} requires a value`);
  return value;
}

function parseArguments(args: readonly string[]): SnapshotArgumentsV1 | "help" {
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) throw new Error("--help cannot be combined with other arguments");
    return "help";
  }
  let sourceRoot: string | null = null;
  let output: string | null = null;
  const include: string[] = [];
  const exclude: string[] = [];
  for (const argument of args) {
    const rootValue = oneValue(argument, "source-root");
    if (rootValue !== null) {
      if (sourceRoot !== null) throw new Error("--source-root may be supplied only once");
      sourceRoot = rootValue;
      continue;
    }
    const includeValue = oneValue(argument, "include");
    if (includeValue !== null) {
      include.push(includeValue);
      continue;
    }
    const excludeValue = oneValue(argument, "exclude");
    if (excludeValue !== null) {
      exclude.push(excludeValue);
      continue;
    }
    const outputValue = oneValue(argument, "output");
    if (outputValue !== null) {
      if (output !== null) throw new Error("--output may be supplied only once");
      output = outputValue;
      continue;
    }
    throw new Error(`unknown argument '${argument}'`);
  }
  if (sourceRoot === null) throw new Error("--source-root is required");
  if (output !== null && (!path.isAbsolute(output) || output.includes("\0"))) {
    throw new Error("--output must be an absolute NUL-free path");
  }
  return { sourceRoot, include, exclude, output };
}

function writePrivateNewFile(output: string, bytes: Buffer): void {
  let descriptor: number | undefined;
  let created = false;
  let remove = true;
  try {
    descriptor = openSync(
      output,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    const stat = fstatSync(descriptor, { bigint: true });
    const uid = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      (stat.mode & 0o777n) !== 0o600n ||
      (uid !== undefined && stat.uid !== BigInt(uid))
    ) {
      throw new Error("snapshot output is not a private owner-controlled regular file");
    }
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
    remove = false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (remove && created) {
      try {
        unlinkSync(output);
      } catch {
        // The exclusive create may have failed before this process owned a path.
      }
    }
  }
}

export function runScaSnapshotCliV1(
  args: readonly string[],
  writeOutput: (value: string) => void = (value) => process.stdout.write(value)
): void {
  const parsed = parseArguments(args);
  if (parsed === "help") {
    writeOutput(HELP);
    return;
  }
  const description = describeScaSourceSnapshotV1({
    source_root: parsed.sourceRoot,
    scope: { include: parsed.include, exclude: parsed.exclude },
  });
  const output = Buffer.from(`${canonicalJson(description)}\n`, "utf8");
  if (parsed.output === null) writeOutput(output.toString("utf8"));
  else writePrivateNewFile(parsed.output, output);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    runScaSnapshotCliV1(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: "ScaSnapshotError", message })}\n`);
    process.exitCode = 1;
  }
}
