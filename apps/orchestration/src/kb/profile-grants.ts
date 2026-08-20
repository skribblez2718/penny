/**
 * Host-owned KB profile grants (§5.1).
 *
 * A model-visible profile ID has no authority by itself. The active Pi session
 * must have one unexpired owner-minted grant that names the profile, and the
 * profile must independently resolve through the owner-only registry.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  KbSessionProfileGrantSchema,
  validateKbContract,
  type KbSessionProfileGrant,
} from "./contracts.js";

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnerDirectory(dir: string): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("KB profile-grant store must be a regular directory");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("KB profile-grant store must be owner-only (0700)");
  }
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("KB profile-grant store must be current-user-owned");
  }
}

function assertOwnerFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("KB profile grant must be a regular, single-link file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("KB profile grant must be owner-only (0600)");
  }
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("KB profile grant must be current-user-owned");
  }
}

function grantFileName(grantId: string): string {
  return `${grantId}.json`;
}

export class KbSessionProfileGrantStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    assertOwnerDirectory(path.dirname(root));
    assertOwnerDirectory(root);
  }

  mint(input: {
    session_id: string;
    allowed_kb_profile_ids: readonly string[];
    issued_at?: string;
    expires_at: string;
    grant_id?: string;
  }): KbSessionProfileGrant {
    const grant = validateKbContract(
      KbSessionProfileGrantSchema,
      {
        schema_version: 1,
        grant_id: input.grant_id ?? `kpg-${randomUUID()}`,
        session_id: input.session_id,
        allowed_kb_profile_ids: [...input.allowed_kb_profile_ids],
        issued_at: input.issued_at ?? new Date().toISOString(),
        expires_at: input.expires_at,
      },
      "KB session profile grant"
    );
    if (Date.parse(grant.expires_at) <= Date.parse(grant.issued_at)) {
      throw new Error("KB profile grant expiry must be after issuance");
    }

    const file = path.join(this.root, grantFileName(grant.grant_id));
    if (existsSync(file)) throw new Error(`KB profile grant already exists: ${grant.grant_id}`);
    const temporary = path.join(this.root, `.${grant.grant_id}.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(grant), { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    const directoryFd = openSync(this.root, "r");
    fsyncSync(directoryFd);
    closeSync(directoryFd);
    return grant;
  }

  list(): KbSessionProfileGrant[] {
    assertOwnerDirectory(this.root);
    const grants: KbSessionProfileGrant[] = [];
    for (const name of readdirSync(this.root).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.root, name);
      assertOwnerFile(file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(`KB profile grant is malformed: ${name}`);
      }
      const grant = validateKbContract(
        KbSessionProfileGrantSchema,
        raw,
        `KB profile grant ${name}`
      );
      if (grantFileName(grant.grant_id) !== name) {
        throw new Error(`KB profile grant filename mismatch: ${name}`);
      }
      grants.push(grant);
    }
    return grants;
  }

  allowedProfiles(sessionId: string, now = new Date()): ReadonlySet<string> {
    const at = now.getTime();
    const allowed = new Set<string>();
    for (const grant of this.list()) {
      if (grant.session_id !== sessionId) continue;
      if (Date.parse(grant.issued_at) > at || Date.parse(grant.expires_at) <= at) continue;
      for (const profileId of grant.allowed_kb_profile_ids) allowed.add(profileId);
    }
    return allowed;
  }
}
