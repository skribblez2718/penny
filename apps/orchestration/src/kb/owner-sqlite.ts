export { OwnerSqliteDatabase, type OwnerSqliteDatabaseOptions } from "../state/owner-sqlite.js";

/** Shared profile-session and parent-delivery authority database. */
export const HOST_GRANT_DATABASE_NAME = "grants.sqlite";
const HOST_GRANT_AUTHORITY_FILES = new Set([
  HOST_GRANT_DATABASE_NAME,
  `${HOST_GRANT_DATABASE_NAME}-wal`,
  `${HOST_GRANT_DATABASE_NAME}-shm`,
]);

/** Refuse every non-SQLite fragment instead of scanning or adopting legacy authority. */
export function isUnsafeHostGrantFragment(name: string): boolean {
  return !HOST_GRANT_AUTHORITY_FILES.has(name);
}
