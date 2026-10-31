/** Runtime floor includes SQLite's WAL-reset and broken-POSIX-lock fixes. */
export function assertSupportedSqliteVersion(version: string | undefined): void {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\.|$)/u);
  const major = Number(parts?.[1]);
  const minor = Number(parts?.[2]);
  const patch = Number(parts?.[3]);
  if (!parts || major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    throw new Error(
      `Penny requires SQLite >=3.51.3; this runtime supplies ${version ?? "no SQLite version"}. Use the Node version in .nvmrc and restart Pi; do not bypass database checks.`
    );
  }
}
