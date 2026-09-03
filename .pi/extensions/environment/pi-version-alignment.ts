import { access, readFile } from "node:fs/promises";
import path from "node:path";

const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;
const CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

interface JsonRecord {
  readonly [key: string]: unknown;
}

export type PiVersionAlignment =
  | { readonly status: "not_penny_project" }
  | { readonly status: "aligned"; readonly projectRoot: string; readonly version: string }
  | {
      readonly status: "mismatch";
      readonly projectRoot: string;
      readonly hostVersion: string;
      readonly localVersions: ReadonlyArray<{
        readonly location: string;
        readonly version: string;
      }>;
    }
  | { readonly status: "invalid"; readonly projectRoot?: string; readonly reason: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION_PATTERN.exec(value);
  const invalidNumericPrerelease = match?.[4]
    ?.split(".")
    .some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"));
  return match && !invalidNumericPrerelease ? value : undefined;
}

async function readJsonObject(filePath: string): Promise<JsonRecord> {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${filePath} must contain a JSON object`);
  return parsed;
}

async function isPennyRoot(directory: string): Promise<boolean> {
  const manifestPath = path.join(directory, "package.json");
  const orchestrationManifestPath = path.join(directory, "apps", "orchestration", "package.json");
  try {
    await access(orchestrationManifestPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
  const manifest = await readJsonObject(manifestPath);
  return manifest.name === "penny";
}

export async function findPennyProjectRoot(startDirectory: string): Promise<string | undefined> {
  let current = path.resolve(startDirectory);
  for (;;) {
    if (await isPennyRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function dependencies(record: JsonRecord, field: string, label: string): JsonRecord {
  const value = record[field];
  if (!isRecord(value)) throw new Error(`${label}.${field} must be an object`);
  return value;
}

function requiredVersion(record: JsonRecord, packageName: string, label: string): string {
  const version = exactVersion(record[packageName]);
  if (!version) throw new Error(`${label}.${packageName} must be an exact semantic version`);
  return version;
}

export async function inspectPiVersionAlignment(
  startDirectory: string,
  hostVersion: string
): Promise<PiVersionAlignment> {
  const validHostVersion = exactVersion(hostVersion);
  if (!validHostVersion) {
    return { status: "invalid", reason: `Pi host reported an invalid version: ${hostVersion}` };
  }
  let projectRoot: string | undefined;
  try {
    projectRoot = await findPennyProjectRoot(startDirectory);
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!projectRoot) return { status: "not_penny_project" };
  try {
    const rootManifest = await readJsonObject(path.join(projectRoot, "package.json"));
    const orchestrationManifest = await readJsonObject(
      path.join(projectRoot, "apps", "orchestration", "package.json")
    );
    const rootDependencies = dependencies(rootManifest, "devDependencies", "package.json");
    const orchestrationDependencies = dependencies(
      orchestrationManifest,
      "dependencies",
      "apps/orchestration/package.json"
    );
    const localVersions = [
      ...PI_PACKAGES.map((packageName) => ({
        location: `root ${packageName}`,
        version: requiredVersion(rootDependencies, packageName, "package.json.devDependencies"),
      })),
      {
        location: `orchestration ${CODING_AGENT_PACKAGE}`,
        version: requiredVersion(
          orchestrationDependencies,
          CODING_AGENT_PACKAGE,
          "apps/orchestration/package.json.dependencies"
        ),
      },
    ];
    if (localVersions.every((entry) => entry.version === validHostVersion)) {
      return { status: "aligned", projectRoot, version: validHostVersion };
    }
    return { status: "mismatch", projectRoot, hostVersion: validHostVersion, localVersions };
  } catch (error) {
    return {
      status: "invalid",
      projectRoot,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function piVersionAlignmentWarning(alignment: PiVersionAlignment): string | undefined {
  if (alignment.status === "mismatch") {
    const versions = alignment.localVersions
      .map((entry) => `${entry.location}=${entry.version}`)
      .join(", ");
    return `Pi ${alignment.hostVersion} does not match Penny's SDK pins (${versions}). Run bun run pi:update before relying on this project.`;
  }
  if (alignment.status === "invalid") {
    return `Could not verify Penny's Pi SDK alignment: ${alignment.reason}`;
  }
  return undefined;
}
