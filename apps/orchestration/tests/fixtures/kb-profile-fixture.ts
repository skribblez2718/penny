import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { KbSessionProfileGrantStore } from "../../src/kb/profile-grants.js";

/** Install an owner-only synthetic profile registry and active session grant. */
export function installGrantedProfile(input: {
  projectRoot: string;
  kbRoot: string;
  profileId: string;
  sessionId: string;
  allowCreate?: boolean;
  expectedKbId?: string;
}): void {
  const penny = path.join(input.projectRoot, ".penny");
  mkdirSync(penny, { recursive: true, mode: 0o700 });
  chmodSync(penny, 0o700);
  mkdirSync(input.kbRoot, { recursive: true, mode: 0o700 });
  chmodSync(input.kbRoot, 0o700);
  const registryPath = path.join(penny, "kb-profiles.json");
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
  new KbSessionProfileGrantStore(path.join(penny, "kb-host-grants", "profile-grants")).mint({
    session_id: input.sessionId,
    allowed_kb_profile_ids: [input.profileId],
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
}
