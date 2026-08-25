import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";

export const PENNY_STATE_LAYOUT_VERSION = 1 as const;
export const PENNY_STATE_DIRECTORY_NAME = "penny" as const;
export const PENNY_STATE_ROOT_ENV = "PENNY_STATE_ROOT" as const;
export const CATALOG_DATABASE_NAME = "catalog.db" as const;
export const ORCHESTRATION_DATABASE_NAME = "orchestration.db" as const;
export const ARTIFACT_MANIFEST_DATABASE_NAME = "manifest.db" as const;
export const OBSERVABILITY_DATABASE_NAME = "observability.db" as const;
export const PROJECT_ID_PATTERN = /^prj_[a-f0-9]{32}$/u;

export interface PennyStatePaths {
  readonly root: string;
  readonly catalogDatabase: string;
  readonly locks: string;
  readonly migrations: string;
  readonly quarantine: string;
  readonly observability: {
    readonly root: string;
    readonly database: string;
  };
  readonly projects: string;
}

export interface ProjectStatePaths {
  readonly projectId: string;
  readonly root: string;
  readonly orchestration: {
    readonly root: string;
    readonly database: string;
    readonly receiptKey: string;
    readonly inputs: string;
  };
  readonly artifacts: {
    readonly root: string;
    readonly manifestDatabase: string;
    readonly objects: string;
  };
  readonly skillChains: string;
  readonly subagentSessions: string;
  readonly knowledgeBase: {
    readonly root: string;
    readonly profiles: string;
    readonly hostGrants: string;
    readonly capabilities: string;
    readonly saveClaims: string;
    readonly operationReceipts: string;
    readonly approval: string;
  };
}

export interface ResolvePennyStateRootOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test/embedding seam; production callers use Pi's exported getAgentDir(). */
  readonly agentDir?: string;
}

function normalizedAbsolutePath(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(candidate);
}

/**
 * Resolve Penny's sole state root without touching the filesystem.
 *
 * The default follows Pi relocation through getAgentDir(), which already honors
 * PI_CODING_AGENT_DIR. PENNY_STATE_ROOT is the only Penny-specific path
 * selector and must be absolute when set.
 */
export function resolvePennyStateRoot(options: ResolvePennyStateRootOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env[PENNY_STATE_ROOT_ENV]?.trim();
  if (configured) return normalizedAbsolutePath(configured, PENNY_STATE_ROOT_ENV);

  const agentDir = options.agentDir ?? getAgentDir();
  return path.join(
    normalizedAbsolutePath(agentDir, "Pi agent directory"),
    PENNY_STATE_DIRECTORY_NAME
  );
}

export function pennyStatePaths(root: string): PennyStatePaths {
  const resolvedRoot = normalizedAbsolutePath(root, "Penny state root");
  const observabilityRoot = path.join(resolvedRoot, "observability");
  return {
    root: resolvedRoot,
    catalogDatabase: path.join(resolvedRoot, CATALOG_DATABASE_NAME),
    locks: path.join(resolvedRoot, "locks"),
    migrations: path.join(resolvedRoot, "migrations"),
    quarantine: path.join(resolvedRoot, "quarantine"),
    observability: {
      root: observabilityRoot,
      database: path.join(observabilityRoot, OBSERVABILITY_DATABASE_NAME),
    },
    projects: path.join(resolvedRoot, "projects"),
  };
}

export function projectStatePathsAtRoot(projectRoot: string, projectId: string): ProjectStatePaths {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("project ID is not canonical");
  const resolvedProjectRoot = normalizedAbsolutePath(projectRoot, "Penny project state root");
  const orchestrationRoot = path.join(resolvedProjectRoot, "orchestration");
  const artifactRoot = path.join(resolvedProjectRoot, "artifacts");
  const knowledgeBaseRoot = path.join(resolvedProjectRoot, "kb");
  return {
    projectId,
    root: resolvedProjectRoot,
    orchestration: {
      root: orchestrationRoot,
      database: path.join(orchestrationRoot, ORCHESTRATION_DATABASE_NAME),
      receiptKey: path.join(orchestrationRoot, "receipt-key"),
      inputs: path.join(orchestrationRoot, "inputs"),
    },
    artifacts: {
      root: artifactRoot,
      manifestDatabase: path.join(artifactRoot, ARTIFACT_MANIFEST_DATABASE_NAME),
      objects: path.join(artifactRoot, "objects"),
    },
    skillChains: path.join(resolvedProjectRoot, "skill-chains"),
    subagentSessions: path.join(resolvedProjectRoot, "subagent-sessions"),
    knowledgeBase: {
      root: knowledgeBaseRoot,
      profiles: path.join(knowledgeBaseRoot, "profiles.json"),
      hostGrants: path.join(knowledgeBaseRoot, "host-grants"),
      capabilities: path.join(knowledgeBaseRoot, "capabilities"),
      saveClaims: path.join(knowledgeBaseRoot, "save-claims"),
      operationReceipts: path.join(knowledgeBaseRoot, "operation-receipts"),
      approval: path.join(knowledgeBaseRoot, "approval"),
    },
  };
}

export function projectStatePaths(state: PennyStatePaths, projectId: string): ProjectStatePaths {
  return projectStatePathsAtRoot(path.join(state.projects, projectId), projectId);
}
