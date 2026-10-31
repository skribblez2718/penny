import path from "node:path";
import process from "node:process";

import { generateSkillInvocationManifests } from "@penny/orchestration/skill-invocation-docs";

const mode = process.argv[2] ?? "--write";
if (mode !== "--write" && mode !== "--check") {
  throw new Error("usage: generate-skill-invocations.mjs [--write|--check]");
}
generateSkillInvocationManifests({
  projectRoot: path.resolve(process.cwd(), "..", ".."),
  check: mode === "--check",
});
