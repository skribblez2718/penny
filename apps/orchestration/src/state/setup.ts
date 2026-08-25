import { ProjectCatalog, type ProjectBinding } from "./catalog.js";
import {
  assertOwnerDirectory,
  ensureOwnerDirectory,
  fsyncDirectory,
  pathExistsNoFollow,
} from "./custody.js";
import {
  pennyStatePaths,
  projectStatePaths,
  resolvePennyStateRoot,
  type ProjectStatePaths,
  type ResolvePennyStateRootOptions,
} from "./paths.js";

export interface ResolvedProjectState extends ProjectBinding {
  readonly paths: ProjectStatePaths;
}

export type PennyStateResolutionErrorCode =
  | "STATE_UNINITIALIZED"
  | "PROJECT_UNREGISTERED"
  | "PROJECT_NOT_ACTIVE"
  | "STATE_CUSTODY_INVALID";

export class PennyStateResolutionError extends Error {
  readonly code: PennyStateResolutionErrorCode;

  constructor(code: PennyStateResolutionErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`, { cause });
    this.name = "PennyStateResolutionError";
    this.code = code;
  }
}

export function globalStateDirectories(stateRoot: string): readonly string[] {
  const state = pennyStatePaths(stateRoot);
  return [
    state.root,
    state.locks,
    state.migrations,
    state.quarantine,
    state.observability.root,
    state.projects,
  ];
}

export function projectStateDirectories(paths: ProjectStatePaths): readonly string[] {
  return [
    paths.root,
    paths.orchestration.root,
    paths.orchestration.inputs,
    paths.artifacts.root,
    paths.artifacts.objects,
    paths.skillChains,
    paths.subagentSessions,
    paths.knowledgeBase.root,
    paths.knowledgeBase.hostGrants,
    paths.knowledgeBase.capabilities,
    paths.knowledgeBase.saveClaims,
    paths.knowledgeBase.operationReceipts,
    paths.knowledgeBase.approval,
  ];
}

function resolvedProjectState(binding: ProjectBinding): ResolvedProjectState {
  return { ...binding, paths: projectStatePaths(binding.state, binding.projectId) };
}

/** Initialize shared state infrastructure without activating a project partition. */
export function initializePennyStateInfrastructure(
  options: ResolvePennyStateRootOptions = {}
): ReturnType<typeof pennyStatePaths> {
  const stateRoot = resolvePennyStateRoot(options);
  for (const directory of globalStateDirectories(stateRoot)) {
    ensureOwnerDirectory(directory, `Penny state directory ${directory}`);
  }
  using _catalog = new ProjectCatalog(stateRoot, { create: true });
  fsyncDirectory(pennyStatePaths(stateRoot).root);
  return pennyStatePaths(stateRoot);
}

export function ensureProjectStateDirectories(paths: ProjectStatePaths): void {
  for (const directory of projectStateDirectories(paths)) {
    ensureOwnerDirectory(directory, `Penny project state directory ${directory}`);
  }
}

/** Explicit, idempotent target-state initialization. Ordinary runtime never calls this. */
export function initializePennyState(
  projectRoot: string,
  options: ResolvePennyStateRootOptions = {}
): ResolvedProjectState {
  const stateRoot = resolvePennyStateRoot(options);
  initializePennyStateInfrastructure(options);

  using catalog = new ProjectCatalog(stateRoot, { create: true });
  const resolved = resolvedProjectState(catalog.registerProject(projectRoot));
  ensureProjectStateDirectories(resolved.paths);
  fsyncDirectory(resolved.paths.root);
  fsyncDirectory(resolved.state.projects);
  fsyncDirectory(resolved.state.root);
  return resolved;
}

/** Resolve an already-initialized project without creating state or importing legacy roots. */
export function resolvePennyProjectState(
  projectRoot: string,
  options: ResolvePennyStateRootOptions = {}
): ResolvedProjectState {
  const stateRoot = resolvePennyStateRoot(options);
  const state = pennyStatePaths(stateRoot);
  if (!pathExistsNoFollow(state.root) || !pathExistsNoFollow(state.catalogDatabase)) {
    throw new PennyStateResolutionError(
      "STATE_UNINITIALIZED",
      "Penny state has not been explicitly initialized or migrated; run explicit state setup for a new project or the migration flow for retained state"
    );
  }
  try {
    using catalog = new ProjectCatalog(stateRoot, { create: false });
    let binding: ProjectBinding | undefined;
    try {
      binding = catalog.lookupProject(projectRoot);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("project catalog entry is ")) {
        throw new PennyStateResolutionError(
          "PROJECT_NOT_ACTIVE",
          `the project catalog binding is not active (${error.message})`,
          error
        );
      }
      throw error;
    }
    if (binding === undefined) {
      throw new PennyStateResolutionError(
        "PROJECT_UNREGISTERED",
        "the project is not registered in Penny state; run explicit state setup only for a new project"
      );
    }
    const resolved = resolvedProjectState(binding);
    for (const directory of globalStateDirectories(stateRoot)) {
      assertOwnerDirectory(directory, `Penny state directory ${directory}`);
    }
    for (const directory of projectStateDirectories(resolved.paths)) {
      assertOwnerDirectory(directory, `Penny project state directory ${directory}`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof PennyStateResolutionError) throw error;
    throw new PennyStateResolutionError(
      "STATE_CUSTODY_INVALID",
      `Penny state failed ownership, layout, or integrity validation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error
    );
  }
}

/** Explicitly bind an existing opaque partition to a replacement canonical project root. */
export function relinkPennyProject(
  projectId: string,
  currentProjectRoot: string,
  replacementProjectRoot: string,
  options: ResolvePennyStateRootOptions = {}
): ResolvedProjectState {
  const stateRoot = resolvePennyStateRoot(options);
  using catalog = new ProjectCatalog(stateRoot, { create: false });
  const project = catalog.relinkProject(projectId, currentProjectRoot, replacementProjectRoot);
  const binding = catalog.lookupProject(replacementProjectRoot);
  if (binding === undefined || binding.projectId !== project.projectId) {
    throw new Error("project relink verification failed");
  }
  return resolvedProjectState(binding);
}
