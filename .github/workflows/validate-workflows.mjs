#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const WORKFLOW_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(WORKFLOW_DIRECTORY, "../..");
const TYPESCRIPT_WORKFLOW = "typescript-ci.yml";
const SUPPLEMENTAL_WORKFLOWS = ["powerpoint-pptx.yml", "word-docx.yml"];
const REMOTE_UNVERIFIED_MARKER =
  "intentionally unverified here; TS-430 did not authorize remote operations.";
const GITLEAKS_PIN = {
  version: "8.30.1",
  checksumsSha256: "061476c21adaf5441516f96f185c1a4706a83cd6329b9b38762271b3d4a52fae",
  archiveSha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  binarySha256: "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
};

const ACTION_PINS = new Map([
  [
    "actions/checkout",
    {
      sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      version: "v7.0.1",
    },
  ],
  [
    "actions/setup-python",
    {
      sha: "5fda3b95a4ea91299a34e894583c3862153e4b97",
      version: "v7.0.0",
    },
  ],
  [
    "oven-sh/setup-bun",
    {
      sha: "0c5077e51419868618aeaa5fe8019c62421857d6",
      version: "v2.2.0",
    },
  ],
]);

const REQUIRED_ROOT_COMMANDS = [
  "bun install --frozen-lockfile",
  "bun run format:check",
  "bun run lint",
  "bun run typecheck",
  "bun run typescript:inventory",
  "bun run typescript:architecture",
  "bun run typescript:guard-tests",
  "bun run test:typescript",
  "bun run build:observability",
  "bun run build:orchestration",
  "bun run security:secrets:provision",
  'bun run security:secrets:range -- "$scan_base..$scan_head"',
];

const errors = [];

function report(message) {
  errors.push(message);
}

function readRequiredFile(filePath, label) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    report(
      `${label}: cannot read required file: ${error instanceof Error ? error.message : String(error)}`
    );
    return "";
  }
}

function readWorkflow(name) {
  return readRequiredFile(path.join(WORKFLOW_DIRECTORY, name), name);
}

const workflowNames = readdirSync(WORKFLOW_DIRECTORY)
  .filter((name) => /\.ya?ml$/u.test(name))
  .sort();

for (const requiredName of [TYPESCRIPT_WORKFLOW, ...SUPPLEMENTAL_WORKFLOWS]) {
  if (!workflowNames.includes(requiredName))
    report(`${requiredName}: required workflow is missing`);
}

const pinCounts = new Map([...ACTION_PINS.keys()].map((action) => [action, 0]));
const exactActionPattern =
  /^\s*(?:-\s+)?uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})\s+#\s+(v\S+)\s*$/u;

for (const workflowName of workflowNames) {
  const source = readWorkflow(workflowName);
  const lines = source.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*(?:-\s+)?uses:/u.test(line)) continue;
    const rawReference = line.replace(/^\s*(?:-\s+)?uses:\s*/u, "").trim();
    if (rawReference.startsWith("./")) continue;

    const match = line.match(exactActionPattern);
    if (!match) {
      report(
        `${workflowName}:${index + 1}: action must use a lowercase immutable 40-character SHA with an adjacent version comment`
      );
      continue;
    }

    const [, action, sha, version] = match;
    const expected = ACTION_PINS.get(action);
    if (!expected) {
      report(`${workflowName}:${index + 1}: action is not in the verified pin set: ${action}`);
      continue;
    }
    if (sha !== expected.sha || version !== expected.version) {
      report(
        `${workflowName}:${index + 1}: ${action} must be ${expected.sha} # ${expected.version}`
      );
      continue;
    }
    pinCounts.set(action, (pinCounts.get(action) ?? 0) + 1);
  }
}

for (const [action, count] of pinCounts) {
  if (count === 0) report(`verified action pin is unused: ${action}`);
}

const typescript = readWorkflow(TYPESCRIPT_WORKFLOW);

if (!/^on:\n {2}pull_request:\n {2}push:\n/mu.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: pull_request and push must both be unrestricted triggers`);
}
if (/^\s+(?:branches|branches-ignore|paths|paths-ignore):/mu.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: trigger filters are prohibited`);
}
if (/pull_request_target:/u.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: pull_request_target is prohibited`);
}
if (!/^permissions:\n {2}contents: read\n\nenv:/mu.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: top-level permissions must be exactly contents: read`);
}
if ((typescript.match(/^\s*permissions:/gmu) ?? []).length !== 1) {
  report(`${TYPESCRIPT_WORKFLOW}: job-level permission overrides are prohibited`);
}
if (/^\s*(?:permissions:\s+write-all|[A-Za-z-]+:\s+write)\s*$/gmu.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: write permissions are prohibited`);
}
if (/\$\{\{\s*secrets\./u.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: repository secrets must not be exposed to workflow steps`);
}
for (const [variable, expected] of [
  ["PENNY_KB_MODEL_SMOKE", '"0"'],
  ["PENNY_MEMORY_MCP_TOKEN_ENV", '""'],
  ["PENNY_MEMORY_MCP_TOKEN_FILE", '""'],
  ["PENNY_PLAYWRIGHT_BROWSER_TESTS", '"0"'],
  ["PENNY_YOUTUBE_NETWORK_TESTS", '"0"'],
]) {
  const declarations = typescript
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${variable}:`));
  if (declarations.length !== 1 || declarations[0] !== `${variable}: ${expected}`) {
    report(`${TYPESCRIPT_WORKFLOW}: ${variable} must be declared exactly once as ${expected}`);
  }
}
if (/PENNY_KB_MODEL_SMOKE:\s+["']?1/u.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: the live-model gate must never be enabled`);
}
if (/PENNY_(?:PLAYWRIGHT_BROWSER_TESTS|YOUTUBE_NETWORK_TESTS):\s+["']?1/u.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: external browser/network suites must never be enabled`);
}
if (/bun run test:kb-model-smoke(?:\s|$)/mu.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: the live-model suite must not be invoked directly`);
}
if (!/fetch-depth:\s+0/u.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: Gitleaks range scanning requires full Git history`);
}
if (!/persist-credentials:\s+false/u.test(typescript)) {
  report(`${TYPESCRIPT_WORKFLOW}: checkout credentials must not persist`);
}
if (!typescript.includes(REMOTE_UNVERIFIED_MARKER)) {
  report(
    `${TYPESCRIPT_WORKFLOW}: remote exercise and status verification must remain marked unverified`
  );
}

for (const command of REQUIRED_ROOT_COMMANDS) {
  if (!typescript.includes(command)) {
    report(`${TYPESCRIPT_WORKFLOW}: missing required command: ${command}`);
  }
}

for (const validationCommand of [
  'bunx prettier --check ".github/workflows/*.{yml,yaml,mjs}"',
  "YAML.parse_file(path)",
  "node .github/workflows/validate-workflows.mjs",
]) {
  if (!typescript.includes(validationCommand)) {
    report(`${TYPESCRIPT_WORKFLOW}: missing static workflow validation: ${validationCommand}`);
  }
}

for (const supplementalName of SUPPLEMENTAL_WORKFLOWS) {
  const supplemental = readWorkflow(supplementalName);
  if (!/^\s+paths:/mu.test(supplemental)) {
    report(`${supplementalName}: supplemental workflow must retain its scoped path trigger`);
  }
}

const gitleaksProvisioner = readRequiredFile(
  path.join(PROJECT_ROOT, "scripts/security/provision-gitleaks.sh"),
  "Gitleaks provisioner"
);
const gitleaksWrapper = readRequiredFile(
  path.join(PROJECT_ROOT, "scripts/security/scan-secrets.sh"),
  "Gitleaks scan wrapper"
);
for (const [label, expected] of [
  ["GITLEAKS_VERSION", GITLEAKS_PIN.version],
  ["GITLEAKS_CHECKSUMS_SHA256", GITLEAKS_PIN.checksumsSha256],
  ["GITLEAKS_ARCHIVE_SHA256", GITLEAKS_PIN.archiveSha256],
  ["GITLEAKS_BINARY_SHA256", GITLEAKS_PIN.binarySha256],
]) {
  if (!gitleaksProvisioner.includes(`${label}='${expected}'`)) {
    report(`Gitleaks provisioner: missing approved ${label} pin ${expected}`);
  }
}
for (const [label, expected] of [
  ["GITLEAKS_VERSION", GITLEAKS_PIN.version],
  ["GITLEAKS_BINARY_SHA256", GITLEAKS_PIN.binarySha256],
]) {
  if (!gitleaksWrapper.includes(`${label}='${expected}'`)) {
    report(`Gitleaks scan wrapper: missing approved ${label} pin ${expected}`);
  }
}
if (!readRequiredFile(path.join(PROJECT_ROOT, ".gitleaks.toml"), ".gitleaks.toml")) {
  report(".gitleaks.toml: pinned scanner configuration must not be empty");
}

if (errors.length > 0) {
  process.stderr.write(
    `[workflow-validation] ${errors.length} error(s):\n${errors.map((error) => `- ${error}`).join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[workflow-validation] ${workflowNames.length} workflow(s) passed immutable-pin and TS-430 regression checks\n`
  );
}
