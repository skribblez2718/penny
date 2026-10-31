/** Opt-in installed-scanner smoke. All tool/rule/output paths are supplied by the caller. */
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { ScaAnalysisToolsSchema } from "../../orchestration/dist/sca/ordinary-contracts.js";
import type { ScaHostRequest } from "../../orchestration/dist/sca/ordinary-host.js";
import { buildHostStaticInventory } from "../../orchestration/dist/sca/ordinary-source.js";
import {
  createOrdinaryScaRuntime,
  type ScaOrdinaryProcessObservation,
} from "../src/ordinary-runtime.js";

const configPath = process.env.PENNY_SCA_ORDINARY_NATIVE_CONFIG;
const ConfigSchema = Type.Object(
  { tools: ScaAnalysisToolsSchema, evidence_directory: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);
async function publish(file: string, content: string | Buffer) {
  const temporary = `${file}.pending`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

describe.skipIf(configPath === undefined)(
  "ordinary runtime — actual installed native scanners",
  () => {
    it.each(["vulnerable", "fixed", "no-alert"] as const)(
      "measures PHP/JS/TS %s without executing target code",
      async (variant) => {
        if (configPath === undefined) throw new Error("Caller native configuration required");
        const config = validateContract(
          ConfigSchema,
          JSON.parse(await readFile(configPath, "utf8")),
          "Caller native smoke configuration"
        );
        if (!path.isAbsolute(config.evidence_directory))
          throw new Error("Absolute evidence directory required");
        const semgrep = config.tools.semgrep;
        const gitleaks = config.tools.gitleaks;
        if (
          semgrep === undefined ||
          gitleaks === undefined ||
          config.tools.graph !== undefined ||
          config.tools.advisory_results !== undefined
        )
          throw new Error(
            "Exactly caller-selected Semgrep/Gitleaks required; no graph/advisory/network acquisition"
          );
        const retained = await mkdtemp(path.join(config.evidence_directory, `${variant}-`));
        const root = await mkdtemp(path.join(tmpdir(), "penny-ordinary-native-input-"));
        const processes: ScaOrdinaryProcessObservation[] = [];
        try {
          const source = path.join(root, "source");
          await mkdir(source);
          const marker =
            variant === "vulnerable" ? "// PENNY_NATIVE_FIXTURE_0123456789ABCDEF\n" : "";
          const php =
            variant === "vulnerable"
              ? "exec($input)"
              : variant === "fixed"
                ? "strlen($input)"
                : "shell_exec($input)";
          const js =
            variant === "vulnerable"
              ? "eval(input)"
              : variant === "fixed"
                ? "input.length"
                : "Function(input)";
          const files = {
            "handler.php": `<?php\nfunction handle($input) { return ${php}; }\n${marker}`,
            "handler.js": `export function handle(input) { return ${js}; }\n${marker}`,
            "handler.ts": `export function handle(input: string) { return ${js}; }\n${marker}`,
          };
          for (const [file, content] of Object.entries(files))
            await writeFile(path.join(source, file), content, { flag: "wx", mode: 0o600 });
          const captured = buildHostStaticInventory({
            schema_version: 1,
            source_root: source,
            purpose: `Harmless generated ${variant} native scanner measurement; NOT target execution or a safety verdict`,
            scope: { include: [], exclude: [] },
            execution_mode: "static_only",
            model: "deepseek-flash",
          });
          await publish(
            path.join(retained, "source-corpus.json"),
            Buffer.from(captured.sourceCorpus)
          );
          await publish(path.join(retained, "fixture-sources.json"), canonicalJson(files));
          for (const [kind, scanner] of [
            ["semgrep", semgrep],
            ["gitleaks", gitleaks],
          ] as const) {
            expect(sha256(await readFile(scanner.tool.executable))).toBe(scanner.tool.sha256);
            const rules = await readFile(scanner.rules_path);
            expect(sha256(rules)).toBe(scanner.rules_sha256);
            await publish(path.join(retained, `${kind}.rules`), rules);
          }
          const request: ScaHostRequest = {
            schema_version: 1,
            stage: "preparation",
            run_id: `ordinary-native-${variant}`,
            input_bindings: [{ slot: "corpus", content_digest: sha256(captured.sourceCorpus) }],
            source_snapshot_sha256: captured.sourceSnapshotSha256,
            tools: config.tools,
          };
          const runtime = createOrdinaryScaRuntime({
            async recordProcess(observation) {
              const index = processes.length;
              processes.push(observation);
              await publish(
                path.join(retained, `${index}.process.json`),
                canonicalJson(observation)
              );
              await publish(path.join(retained, `${index}.stdout`), observation.result.stdout);
              await publish(path.join(retained, `${index}.stderr`), observation.result.stderr);
            },
          });
          const prepared = await runtime.prepare({
            request,
            corpus: Buffer.from(captured.sourceCorpus),
            control: { signal: new AbortController().signal, activity() {} },
          });
          await publish(path.join(retained, "preparation.json"), canonicalJson(prepared));
          expect(processes).toHaveLength(2);
          expect(prepared.graphs).toEqual([]);
          for (const kind of ["semgrep", "gitleaks"] as const) {
            expect(
              prepared.preparation.capabilities.find((entry) => entry.id === kind)?.status
            ).toBe("completed");
            const leads = prepared.preparation.leads.filter((entry) => entry.origin === kind);
            expect(leads).toHaveLength(variant === "vulnerable" ? 3 : 0);
            if (variant === "vulnerable")
              expect(leads.map((lead) => lead.locations[0]?.path).sort()).toEqual(
                Object.keys(files).sort()
              );
          }
          for (const observed of processes) {
            expect(observed.result.stdout_truncated || observed.result.stderr_truncated).toBe(
              false
            );
            expect(observed.result.exit_code).toBe(variant === "vulnerable" ? 1 : 0);
            expect(sha256(observed.result.stdout)).toBe(observed.result.stdout_sha256);
            expect(sha256(observed.result.stderr)).toBe(observed.result.stderr_sha256);
            expect(existsSync(observed.request.cwd)).toBe(false);
          }
          const semgrepOutput = validateContract(
            Type.Object({ version: Type.String() }, { additionalProperties: true }),
            JSON.parse(processes[0]?.result.stdout ?? "null"),
            "Measured Semgrep version"
          );
          expect(semgrepOutput.version).toBe(semgrep.tool.version);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      // The process owner enforces renewable inactivity. Do not put a total-runtime deadline on productive scanners.
      Number.POSITIVE_INFINITY
    );
  }
);
