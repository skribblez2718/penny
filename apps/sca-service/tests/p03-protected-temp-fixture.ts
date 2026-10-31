import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertScaP03ProtectedPathV1 } from "../src/p03-production-sampler.js";

function assertNoAmbientDependencies(directory: string): void {
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    const modules = path.join(ancestor, "node_modules");
    try {
      lstatSync(modules); // A symlink (including a dangling one) is also an ambient candidate.
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        if (ancestor === path.dirname(ancestor)) return;
        continue;
      }
      throw error;
    }
    throw new Error(`p03_test_ambient_dependency_root: ${modules}`);
  }
}

/** Test deployment only: never change an existing parent's permissions or dependency tree.
 * TMPDIR is a preference, not authority. POSIX alternatives must independently satisfy the
 * unchanged native custody policy and have no ambient Node dependency candidates. Callers own
 * recursive cleanup of the returned private directory; no state survives failed allocation.
 */
export function createP03ProtectedTempFixture(
  prefix: string,
  options: {
    readonly parents?: readonly string[];
    readonly requireStickyParent?: boolean;
  } = {}
): string {
  if (prefix.length === 0 || path.basename(prefix) !== prefix || prefix === "." || prefix === "..")
    throw new Error("p03_test_temp_prefix_invalid");
  const failures: unknown[] = [];
  for (const candidate of new Set(options.parents ?? [tmpdir(), "/var/tmp", "/tmp"])) {
    let root: string | undefined;
    try {
      if (!path.isAbsolute(candidate)) throw new Error("p03_test_temp_parent_not_absolute");
      const parent = realpathSync(candidate);
      assertNoAmbientDependencies(parent);
      if (options.requireStickyParent) {
        const stat = lstatSync(parent);
        if (stat.uid !== 0 || (stat.mode & 0o1000) === 0 || (stat.mode & 0o022) === 0)
          throw new Error("p03_test_root_owned_sticky_parent_required");
      }
      root = mkdtempSync(path.join(parent, prefix)); // Atomically creates an owned 0700 directory.
      assertScaP03ProtectedPathV1(root, true);
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700)
        throw new Error("p03_test_private_temp_required");
      assertNoAmbientDependencies(root);
      return root;
    } catch (error) {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
      failures.push(
        new Error(`P03 test temporary parent rejected: ${candidate}`, { cause: error })
      );
    }
  }
  throw new AggregateError(failures, "p03_test_no_protected_temp_parent");
}
