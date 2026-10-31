/** Real executable wire fixtures, NOT Semgrep/schema/semantic-fidelity evidence. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../../dist/canonical-json.js";
import {
  createScaOfflineRunner,
  type ScaOfflineRunnerConfig,
} from "../../dist/sca/ordinary-offline-runner.js";
import { advancedFixture } from "./sca-advanced-workflow.js";

// Reads fixture source as DATA. Never imports, evaluates or executes target/fixture programs.
const ANALYZER = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-c')) process.exit(0);
if (args.includes('-check_rules')) {
  console.log('.\\n'+JSON.stringify({version:'wire-fixture',results:[],errors:[],skipped_rules:[]}));
  process.exit(0);
}
const config = args[args.indexOf('--config')+1];
const targets = args.slice(args.indexOf('--')+1);
const lines = file => fs.readFileSync(file,'utf8').split('\\n').flatMap((line,index)=>/exec\\(/.test(line)?[index+1]:[]);
if (args.includes('--test')) {
  const matches = Object.fromEntries(targets.map(file=>[fs.realpathSync(file), {expected_lines:lines(file),reported_lines:lines(file)}]));
  console.log(JSON.stringify({config_missing_tests:[],config_missing_fixtests:[],config_with_errors:[],results:{[config]:{checks:{'test.handler':{passed:true,matches,errors:[]}}}},fixtest_results:{}}));
} else {
  const results=targets.flatMap(file=>lines(file).map(line=>({check_id:'test.handler',path:file,start:{line},end:{line}})));
  console.log(JSON.stringify({version:'wire-fixture',results,errors:[],paths:{scanned:targets},skipped_rules:[]}));
  process.exitCode=results.length?1:0;
}
`;
export function configuredOfflineFixture() {
  const fixture = advancedFixture("unsupported");
  const workRoot = fixture.host.learning?.workRoot;
  const chosen = fixture.advanced.learning[0];
  if (workRoot === undefined || chosen === undefined) throw new Error("Missing fixture corpus");
  const root = path.dirname(workRoot);
  const executable = path.join(root, "wire-analyzer.cjs");
  writeFileSync(executable, ANALYZER, { mode: 0o700, flag: "wx" });
  chosen.tool = { executable, sha256: sha256(ANALYZER), version: "wire-fixture" };
  const metachecks = path.join(root, "metachecks.json");
  const bytes = JSON.stringify({ rules: [{ id: "wire-metacheck" }] });
  writeFileSync(metachecks, bytes, { mode: 0o600, flag: "wx" });
  chosen.offline_validation = {
    python: chosen.tool,
    core: chosen.tool,
    metachecks: {
      rules_path: metachecks,
      rules_sha256: sha256(bytes),
      rule_ids: ["wire-metacheck"],
    },
  };
  chosen.limits.max_processes = 20;
  const runnerConfig: ScaOfflineRunnerConfig = {
    kind: "trusted-analyzer-socket-denial-v1",
    workRoot,
    tracer: {
      executable: "/usr/bin/strace",
      sha256: sha256(readFileSync("/usr/bin/strace")),
      version: "host-selected",
    },
    ipc_python: {
      executable: "/usr/bin/python3",
      sha256: sha256(readFileSync("/usr/bin/python3")),
      version: "host-selected",
    },
    trusted_analyzers_only: true,
  };
  return { ...fixture, runnerConfig, runner: createScaOfflineRunner(runnerConfig), root };
}
