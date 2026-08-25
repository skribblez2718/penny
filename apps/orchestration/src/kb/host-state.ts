import path from "node:path";

import { resolvePennyProjectState } from "../state/setup.js";
import type { ProjectStatePaths } from "../state/paths.js";

/** Resolve the already-initialized, catalog-bound host-control partition. */
export function kbHostStatePaths(projectRoot: string): ProjectStatePaths["knowledgeBase"] {
  return resolvePennyProjectState(path.resolve(projectRoot)).paths.knowledgeBase;
}

/** Owner-only profile registry; canonical KB publication roots remain external. */
export function kbProfileRegistryPath(projectRoot: string): string {
  return kbHostStatePaths(projectRoot).profiles;
}

export function hostGrantAuthorityDir(projectRoot: string): string {
  return kbHostStatePaths(projectRoot).hostGrants;
}
