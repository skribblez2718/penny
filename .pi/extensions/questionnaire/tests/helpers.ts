/**
 * Shared test helpers for questionnaire extension tests
 */

import * as path from "node:path";

/**
 * Resolve the pi command for E2E tests.
 * Follows the same resolution logic as the subagent extension's getPiInvocation.
 */
export function getPiCommand(): string {
  // If running under node/bun runtime, pi should be on PATH
  const execName = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(execName)) {
    return "pi";
  }

  // Otherwise use the exec path directly (e.g., if pi is the runtime)
  return process.execPath;
}
