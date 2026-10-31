/** Genuine-owner integration assertions, not component fixtures or alternate journal rows. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

function sqliteModule(
  value: unknown
): value is { DatabaseSync: typeof import("node:sqlite").DatabaseSync } {
  return (
    typeof value === "object" &&
    value !== null &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}
const sqlite: unknown = createRequire(import.meta.url)("node:sqlite");
import { mock } from "node:test";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import type { OrchestrationService } from "../../orchestration/dist/service.js";

function logicalDatabase(file: string) {
  assert.ok(sqliteModule(sqlite));
  using db = new sqlite.DatabaseSync(file, { readOnly: true });
  db.exec("BEGIN");
  try {
    return db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((table) => {
        assert.equal(typeof table.name, "string");
        if (typeof table.name !== "string") throw new Error("table name required");
        // Only local SQLite schema identifiers, quoted rather than interpreted as SQL.
        const name = table.name.replaceAll('"', '""');
        const rows = db.prepare(`SELECT * FROM "${name}"`).all();
        return { table, rows: rows.map((row) => canonicalJson(row)).sort() };
      });
  } finally {
    db.exec("ROLLBACK");
  }
}
function objects(root: string): { path: string; sha256: string; bytes: number }[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) return objects(file);
      assert.ok(entry.isFile(), "immutable objects must be regular files");
      const bytes = readFileSync(file);
      return [{ path: file, sha256: sha256(bytes), bytes: bytes.byteLength }];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
/** Logical snapshots use SQLite read transactions, never raw active DB/WAL reads.
 * The guards also catch attempted mutations that would leave no lasting snapshot delta. */
export function assertP03FixtureReadOnlyV1<T>(input: {
  service: OrchestrationService;
  store: ArtifactStore;
  catalog_path: string;
  commands: () => number;
  read: () => T;
}): T {
  const snapshot = () =>
    canonicalJson({
      manifest: logicalDatabase(path.join(input.store.root, "manifest.db")),
      control: logicalDatabase(input.service.checkpointer.dbPath),
      catalog: logicalDatabase(input.catalog_path),
      objects: objects(path.join(input.store.root, "objects")),
      commands: input.commands(),
    });
  const before = snapshot();
  const forbidden = () => {
    throw new Error("historical reader attempted mutation/execution");
  };
  const guards = [
    mock.method(input.store, "persist", forbidden),
    mock.method(input.store, "select", forbidden),
    mock.method(input.service.artifacts, "persist", forbidden),
    mock.method(input.service.artifacts, "select", forbidden),
    mock.method(input.service, "execute", forbidden),
    mock.method(input.service.checkpointer, "transitionHostOperationCall", forbidden),
    mock.method(input.service.checkpointer, "saveRun", forbidden),
  ];
  try {
    return input.read();
  } finally {
    for (const guard of guards) {
      guard.mock.restore();
      assert.equal(guard.mock.callCount(), 0);
    }
    assert.equal(snapshot(), before, "historical read changed durable state or commands");
  }
}
