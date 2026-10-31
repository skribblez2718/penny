import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateSourceFixture,
  validateSourceOracleBytes,
  validateSourceSemantics,
} from "../src/p03-source-oracle.js";

const root = fileURLToPath(new URL("./fixtures/p03-v2/", import.meta.url));

/** Test fixture loader; all oracle authority lives in the production service. */
export async function readSourceOracle(fixtureRoot = root) {
  const oracle = validateSourceOracleBytes(await readFile(path.join(fixtureRoot, "oracle.json")));
  const fixtures = await Promise.all(
    oracle.fixtures.map(async (fixture) => {
      if (
        fixture.file !==
          ({ javascript: "express.js", typescript: "nest.ts", php: "wordpress.php" } as const)[
            fixture.language
          ] ||
        fixture.path !== `src/${fixture.file}`
      )
        throw new Error("P03 oracle path drift");
      const bytes = await readFile(path.join(fixtureRoot, fixture.file));
      validateSourceFixture(fixture, bytes);
      validateSourceSemantics(fixture, bytes);
      return { ...fixture, bytes };
    })
  );
  return { oracle, fixtures };
}
