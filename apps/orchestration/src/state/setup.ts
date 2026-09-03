import { ArtifactStore } from "../artifact-store.js";
import { rejectRetiredConfiguration } from "../config.js";
import { Checkpointer } from "../checkpointer.js";
import { ReceiptAuthority } from "../receipts.js";
import { ProjectCatalog, type ProjectBinding } from "./catalog.js";
import {
  assertOwnerDirectory,
  ensureOwnerDirectory,
  fsyncDirectory,
  pathExistsNoFollow,
} from "./custody.js";
import {
  assertExistingObservabilityDatabase,
  provisionObservabilityDatabase,
} from "./observability-store.js";
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
  | "STATE_CUSTODY_INVALID"
  | "STATE_COMPONENT_UNINITIALIZED";

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
  const state = pennyStatePaths(stateRoot);
  const catalogExists = pathExistsNoFollow(state.catalogDatabase);
  if (catalogExists) {
    using catalog = new ProjectCatalog(stateRoot, { create: false, readOnly: true });
    const existing = catalog.lookupProject(projectRoot);
    if (existing !== undefined) {
      // An active partition is retained state. Setup must validate it rather
      // than silently repair or replace part of its durable history.
      return resolvePennyStateStatus(projectRoot, options);
    }
  } else {
    // A canonical root without its catalog is retained, incomplete custody if
    // any other canonical component exists. Never replace that catalog: doing
    // so would orphan or silently adopt retained project/telemetry state. An
    // empty, owner-only target root remains a valid fresh-init destination.
    if (pathExistsNoFollow(state.root)) {
      ensureOwnerDirectory(state.root, "Penny state root");
      const retainedComponents = [
        ...globalStateDirectories(stateRoot).filter((candidate) => candidate !== state.root),
        `${state.catalogDatabase}-wal`,
        `${state.catalogDatabase}-shm`,
      ].filter(pathExistsNoFollow);
      if (retainedComponents.length !== 0) {
        throw new PennyStateResolutionError(
          "STATE_COMPONENT_UNINITIALIZED",
          "Penny state root has canonical components but its catalog is absent; use explicit recovery or migration rather than replacing retained state"
        );
      }
    }
    initializePennyStateInfrastructure(options);
  }

  if (!pathExistsNoFollow(state.observability.database)) {
    if (catalogExists) {
      throw new PennyStateResolutionError(
        "STATE_COMPONENT_UNINITIALIZED",
        "global observability state is absent; use the explicit migration flow rather than repairing retained state"
      );
    }
    provisionObservabilityDatabase(state.observability.database);
  } else {
    assertExistingObservabilityDatabase(state.observability.database);
  }

  using catalog = new ProjectCatalog(stateRoot, { create: false });
  const resolved = resolvedProjectState(catalog.registerProject(projectRoot));
  ensureProjectStateDirectories(resolved.paths);
  using _checkpointer = Checkpointer.provision(resolved.paths.orchestration.database, undefined, {
    projectId: resolved.projectId,
  });
  using _artifacts = ArtifactStore.provision(resolved.paths.artifacts.root, {
    projectId: resolved.projectId,
  });
  ReceiptAuthority.provision(resolved.paths.orchestration.receiptKey);
  fsyncDirectory(resolved.paths.root);
  fsyncDirectory(resolved.state.projects);
  fsyncDirectory(resolved.state.root);
  return resolvePennyStateStatus(projectRoot, options);
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
    using catalog = new ProjectCatalog(stateRoot, { create: false, readOnly: true });
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

/**
 * Resolve one complete canonical project partition for ordinary runtime. Every
 * component is opened create-never so missing, stale, or misbound state cannot
 * be repaired as an execution side effect.
 */
export function resolvePennyRuntimeState(
  projectRoot: string,
  options: ResolvePennyStateRootOptions = {}
): ResolvedProjectState {
  rejectRetiredConfiguration(options.env ?? process.env);
  const resolved = resolvePennyProjectState(projectRoot, options);
  try {
    Checkpointer.verifyExisting(resolved.paths.orchestration.database, {
      projectId: resolved.projectId,
    });
    ArtifactStore.verifyExisting(resolved.paths.artifacts.root, {
      projectId: resolved.projectId,
    });
    ReceiptAuthority.loadExisting(resolved.paths.orchestration.receiptKey);
    return resolved;
  } catch (error) {
    throw new PennyStateResolutionError(
      "STATE_COMPONENT_UNINITIALIZED",
      `Penny runtime state is incomplete or incompatible: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error
    );
  }
}

/** Administrative full-state check. Telemetry availability never gates ordinary workflow runtime. */
export function resolvePennyStateStatus(
  projectRoot: string,
  options: ResolvePennyStateRootOptions = {}
): ResolvedProjectState {
  const resolved = resolvePennyRuntimeState(projectRoot, options);
  try {
    assertExistingObservabilityDatabase(resolved.state.observability.database);
    return resolved;
  } catch (error) {
    throw new PennyStateResolutionError(
      "STATE_COMPONENT_UNINITIALIZED",
      `Penny observability state is incomplete or incompatible: ${
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
