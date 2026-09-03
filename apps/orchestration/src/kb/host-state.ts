import path from "node:path";

import { resolvePennyRuntimeState } from "../state/setup.js";
import type { ProjectStatePaths } from "../state/paths.js";

/** Resolve the already-initialized, catalog-bound host-control partition. */
export function kbHostStatePaths(projectRoot: string): ProjectStatePaths["knowledgeBase"] {
  return resolvePennyRuntimeState(path.resolve(projectRoot)).paths.knowledgeBase;
}

/** Owner-only profile registry; canonical KB publication roots remain external. */
export function kbProfileRegistryPath(projectRoot: string): string {
  return kbHostStatePaths(projectRoot).profiles;
}

export function hostGrantAuthorityDir(projectRoot: string): string {
  return kbHostStatePaths(projectRoot).hostGrants;
}
