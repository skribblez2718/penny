import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initializePennyState, type ResolvedProjectState } from "../../src/state/index.js";

const TEST_STATE_ROOT = path.join(tmpdir(), `penny-orchestration-state-${process.pid}`);

/**
 * Bind one synthetic project to an isolated target-state catalog.
 *
 * Tests opt into this helper explicitly so production resolvers remain
 * create-never and no project-local legacy root is needed.
 */
export function installTestProjectState(projectRoot: string): ResolvedProjectState {
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  process.env.PENNY_STATE_ROOT = TEST_STATE_ROOT;
  return initializePennyState(projectRoot, { env: process.env });
}
