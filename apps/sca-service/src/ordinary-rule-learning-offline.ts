/** Full offline validation uses the installed Python schema API AND the core's supported
 * -check_rules metacheck input. This is not fabricated `semgrep --validate` output.
 * The host must approve the exact retained metacheck bundle and interpreter/core pins.
 */
import path from "node:path";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { parseScaP10NativeJson } from "../../orchestration/dist/sca/p10-native-tests.js";
import { absolutePath, readExactFile } from "./ordinary-rule-learning-io.js";
import type { ScaRuleLearningRequest } from "./ordinary-rule-learning-contracts.js";

// Same full JSON-schema/config resolver called by installed Semgrep scan --validate.
// Isolated Python ignores PYTHONPATH/user-site; no monkeypatching, registry resolution,
// subprocess, native-result rewriting or success output. Core runs separately with raw receipts.
const SCHEMA_PROGRAM = `import logging
import sys
from semgrep import __VERSION__
from semgrep.config_resolver import Config
from semgrep.rule_lang import RuleValidationMode

def main() -> int:
    if __VERSION__ != sys.argv[1]:
        raise ValueError("schema_tool_version_drift")
    for config_path, expected in ((sys.argv[2], [sys.argv[4]]), (sys.argv[3], sys.argv[5].split(","))):
        config, errors = Config.from_config_list([config_path], None, force_jsonschema=True, validation_mode=RuleValidationMode.FULL)
        for error in errors:
            logging.error("%s", error)
        if errors or config.missed_rule_count or sorted(rule.id for rule in config.get_rules(True)) != sorted(expected):
            return 2
    return 0

sys.exit(main())
`;
export function captureOfflineMetachecks(request: ScaRuleLearningRequest): Buffer | undefined {
  const offline = request.offline_validation;
  if (offline === undefined) return undefined;
  if (offline.core_library_directory !== undefined) absolutePath(offline.core_library_directory);
  if (offline.core.version !== request.tool.version) throw new Error("core_version_pin_drift");
  const bytes = readExactFile(
    offline.metachecks.rules_path,
    request.limits.max_file_bytes,
    offline.metachecks.rules_sha256
  );
  const pack = validateContract(
    Type.Object(
      {
        rules: Type.Array(
          Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
          { minItems: 1, maxItems: 256 }
        ),
      },
      { additionalProperties: false }
    ),
    parseScaP10NativeJson(bytes.toString("utf8")),
    "Caller-approved offline metachecks"
  );
  if (
    new Set(pack.rules.map((r) => r.id)).size !== pack.rules.length ||
    canonicalJson(pack.rules.map((r) => r.id).sort()) !==
      canonicalJson([...offline.metachecks.rule_ids].sort())
  )
    throw new Error("metacheck_identity_drift");
  return bytes;
}
export function offlineValidationInvocation(
  request: ScaRuleLearningRequest,
  cwd: string,
  schema: boolean
) {
  const offline = request.offline_validation;
  if (offline === undefined || request.candidate === null)
    throw new Error("offline_validation_pins_required");
  const candidate = path.join(cwd, "candidate.yaml"),
    metachecks = path.join(cwd, "metachecks.json");
  return schema
    ? {
        tool: offline.python,
        library_directory: undefined,
        arguments: [
          "-I",
          "-B",
          "-c",
          SCHEMA_PROGRAM,
          request.tool.version,
          candidate,
          metachecks,
          request.candidate.rule_id,
          offline.metachecks.rule_ids.join(","),
        ],
      }
    : {
        tool: offline.core,
        library_directory: offline.core_library_directory,
        arguments: [
          "-json",
          "-check_rules",
          metachecks,
          candidate,
          "-j",
          "1",
          "-max_memory",
          String(request.limits.max_memory_mb),
        ],
      };
}
export function offlineCorePassed(stdout: string, stderr: string, version: string): boolean {
  // Core's streaming protocol emits one progress line per checked YAML file. Requiring it
  // also catches the native zero-exit/empty-errors trap for a .json config that was never checked.
  if (!stdout.startsWith(".\n{") || stderr !== "") return false;
  const report = validateContract(
    Type.Object(
      {
        version: Type.String(),
        results: Type.Array(Type.Unknown()),
        errors: Type.Array(Type.Unknown()),
        skipped_rules: Type.Array(Type.Unknown()),
      },
      { additionalProperties: true }
    ),
    parseScaP10NativeJson(stdout.slice(2)),
    "Raw native core metacheck result"
  );
  return (
    report.version === version &&
    !report.results.length &&
    !report.errors.length &&
    !report.skipped_rules.length
  );
}
export const offlineSchemaProgramSha256 = sha256(SCHEMA_PROGRAM);
