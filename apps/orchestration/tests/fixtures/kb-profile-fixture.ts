import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { KbSessionProfileGrantStore } from "../../src/kb/profile-grants.js";
import { installTestProjectState } from "./penny-state-fixture.js";

/** Install an owner-only synthetic profile registry and active session grant. */
export function installGrantedProfile(input: {
  projectRoot: string;
  kbRoot: string;
  profileId: string;
  sessionId: string;
  allowCreate?: boolean;
  expectedKbId?: string;
}): void {
  const state = installTestProjectState(input.projectRoot);
  mkdirSync(input.kbRoot, { recursive: true, mode: 0o700 });
  chmodSync(input.kbRoot, 0o700);
  const registryPath = state.paths.knowledgeBase.profiles;
  writeFileSync(
    registryPath,
    JSON.stringify({
      schema_version: 1,
      profiles: [
        {
          schema_version: 1,
          kb_profile_id: input.profileId,
          kb_root: input.kbRoot,
          ...(input.expectedKbId === undefined ? {} : { expected_kb_id: input.expectedKbId }),
          allow_create: input.allowCreate ?? true,
          repository_admission: { mode: "outside_worktree" },
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(registryPath, 0o600);
  const grantStore = new KbSessionProfileGrantStore(state.paths.knowledgeBase.hostGrants);
  try {
    grantStore.mint({
      session_id: input.sessionId,
      kb_profile_id: input.profileId,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
  } finally {
    grantStore.close();
  }
}
