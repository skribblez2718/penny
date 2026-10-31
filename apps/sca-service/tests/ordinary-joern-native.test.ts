import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { ScaAnalysisToolsSchema } from "../../orchestration/dist/sca/ordinary-contracts.js";
import { buildHostStaticInventory } from "../../orchestration/dist/sca/ordinary-source.js";
import type { ScaHostRequest } from "../../orchestration/dist/sca/ordinary-host.js";
import {
  createOrdinaryScaRuntime,
  type ScaOrdinaryRuntimeOptions,
} from "../src/ordinary-runtime.js";

/** Caller explicitly selects installed/pinned native tools and a private evidence destination.
 * No tool discovery, image name, host path, download, network, bootstrap or model calls.
 * Config queries: call, control, dataflow, page (same call query, limit=1).
 * Generate scripts with ordinaryJoernQueryScript; sink="sink", sourceMethod=".*".
 */
describe.skipIf(process.env.PENNY_ORDINARY_JOERN_CONFIG === undefined)(
  "opt-in LIVE ordinary native Joern — generated source only",
  () => {
    it("observes native call/control/dataflow edges, fixed/no-alert negatives and bounded pages", async () => {
      const configPath = process.env.PENNY_ORDINARY_JOERN_CONFIG;
      const evidenceParent = process.env.PENNY_ORDINARY_JOERN_EVIDENCE_DIR;
      if (configPath === undefined || evidenceParent === undefined)
        throw new Error("Both caller config and private evidence directory are required");
      if (!path.isAbsolute(configPath) || !path.isAbsolute(evidenceParent))
        throw new Error("Native config/evidence paths must be caller-provided absolute paths");
      const tools = validateContract(
        ScaAnalysisToolsSchema,
        JSON.parse(readFileSync(configPath, "utf8")),
        "Caller native Joern tools"
      );
      if (tools.graph === undefined || Object.keys(tools).some((key) => key !== "graph"))
        throw new Error("Source-only native suite accepts graph tools only");
      for (const id of ["call", "control", "dataflow", "page"])
        if (!tools.graph.queries.some((query) => query.id === id))
          throw new Error(`Missing pinned native query: ${id}`);
      const evidence = mkdtempSync(path.join(evidenceParent, "native-"));
      const source = path.join(evidence, "source");
      mkdirSync(source, { mode: 0o700 });
      const fixtures = {
        "flow.php": `<?php
function sink($value) { return $value; }
function vulnerable($input) {
  if ($input !== "") {
    $copy = $input;
    return sink($copy);
  }
}
function fixed($input) { return sink("constant"); }
`,
        "flow.js": `function sink(value) { return value; }
function vulnerable(input) {
  if (input !== "") {
    const copy = input;
    return sink(copy);
  }
}
function fixed(input) { return sink("constant"); }
`,
        "typed.ts": `function sink(value: string): string { return value; }
function vulnerable(input: string): string {
  if (input !== "") {
    const copy: string = input;
    return sink(copy);
  }
  return "";
}
function fixed(input: string): string { return sink("constant"); }
`,
        "no-alert.php": "<?php\nfunction quiet($input) { return strlen($input); }\n",
        "no-alert.js": "function quiet(input) { return input.length; }\n",
        "no-alert.ts": "function quiet(input: string): number { return input.length; }\n",
        "no-alert quote' $(not-a-command).ts":
          "function harmless(value: string) { return value; }\n",
      };
      const save = (name: string, value: unknown) =>
        writeFileSync(path.join(evidence, name), canonicalJson(value), {
          flag: "wx",
          mode: 0o600,
        });
      for (const [name, content] of Object.entries(fixtures))
        writeFileSync(path.join(source, name), content, { flag: "wx", mode: 0o600 });
      save(
        "source-hashes.json",
        Object.entries(fixtures).map(([path, bytes]) => ({ path, sha256: sha256(bytes) }))
      );
      save("tools.json", tools);
      const captured = buildHostStaticInventory({
        schema_version: 1,
        source_root: source,
        purpose: "Native semantic graph verification on generated harmless fixtures",
        scope: { include: [], exclude: [] },
        execution_mode: "static_only",
        model: "deepseek-flash",
      });
      const corpus = Buffer.from(captured.sourceCorpus);
      writeFileSync(path.join(evidence, "corpus.json"), corpus, { flag: "wx", mode: 0o600 });
      const request: ScaHostRequest = {
        schema_version: 1,
        stage: "preparation",
        run_id: "ordinary-native-generated-fixtures",
        input_bindings: [{ slot: "corpus", content_digest: sha256(corpus) }],
        source_snapshot_sha256: captured.sourceSnapshotSha256,
        tools,
      };
      const controller = new AbortController();
      const control = { signal: controller.signal, activity() {} };
      let count = 0;
      const staging = new Set<string>();
      const options: ScaOrdinaryRuntimeOptions = {
        async recordProcess(observation) {
          const prefix = `process-${String(count++).padStart(3, "0")}`;
          save(`${prefix}.json`, observation);
          writeFileSync(path.join(evidence, `${prefix}.stdout`), observation.result.stdout, {
            flag: "wx",
            mode: 0o600,
          });
          writeFileSync(path.join(evidence, `${prefix}.stderr`), observation.result.stderr, {
            flag: "wx",
            mode: 0o600,
          });
          staging.add(observation.request.cwd);
          if (observation.graph !== undefined) {
            const parameter = observation.request.arguments.find((arg) =>
              arg.startsWith("cpgFile=")
            );
            if (parameter === undefined) throw new Error("Missing native graph parameter");
            const file = parameter.slice("cpgFile=".length);
            const cpg = readFileSync(file);
            expect(sha256(cpg)).toBe(observation.graph.graph_sha256);
            writeFileSync(path.join(evidence, `${prefix}.cpg`), cpg, { flag: "wx", mode: 0o600 });
            save(`${prefix}.manifest.json`, observation.graph.manifest);
            const script =
              observation.request.arguments[observation.request.arguments.indexOf("--script") + 1];
            if (script === undefined) throw new Error("Missing captured query");
            const query = readFileSync(script);
            expect(sha256(query)).toBe(observation.graph.query.sha256);
            writeFileSync(path.join(evidence, `${prefix}.query.sc`), query, {
              flag: "wx",
              mode: 0o600,
            });
          }
        },
        async recordDeterministic(observation) {
          save(`${observation.kind}.json`, observation);
        },
      };
      const runtime = createOrdinaryScaRuntime(options);
      try {
        const prepared = await runtime.prepare({ request, corpus, control });
        save("prepared.json", prepared);
        for (const graph of prepared.graphs)
          writeFileSync(
            path.join(evidence, `${graph.language}.cpg`),
            Buffer.from(graph.bytes_base64, "base64"),
            { flag: "wx", mode: 0o600 }
          );
        expect(prepared.graphs).toHaveLength(2);
        for (const graph of prepared.graphs) {
          const query = (id: string) => {
            const observation = graph.query_observations.find(
              (entry) => entry.query_id === id
            )?.observation;
            if (observation === undefined)
              throw new Error(`Missing native ${graph.language}/${id}`);
            return observation;
          };
          const call = query("call"),
            control = query("control"),
            flow = query("dataflow"),
            page = query("page");
          for (const observation of [call, control, flow]) {
            expect(observation.complete, canonicalJson(observation)).toBe(true);
            expect(observation.files.every((file) => file.status === "supported")).toBe(true);
            expect(observation.rows.some((row) => row.path.startsWith("no-alert"))).toBe(false);
          }
          const expectedPaths = graph.language === "php" ? ["flow.php"] : ["flow.js", "typed.ts"];
          for (const file of expectedPaths) {
            const calls = call.rows.filter((row) => row.path === file);
            expect(calls).toHaveLength(2);
            expect(calls.some((row) => row.title.startsWith("CALL vulnerable -> "))).toBe(true);
            expect(calls.some((row) => row.title.startsWith("CALL fixed -> "))).toBe(true);
            const controls = control.rows.filter((row) => row.path === file);
            expect(controls).toHaveLength(1);
            expect(controls[0]?.start_line).toBe(file === "flow.php" ? 6 : 5);
            expect(
              call.rows
                .filter((row) => row.path === file)
                .map((row) => row.title)
                .join("\n")
            ).toContain("sink");
            expect(
              control.rows
                .filter((row) => row.path === file)
                .map((row) => row.title)
                .join("\n")
            ).toContain("input");
            const flows = flow.rows.filter((row) => row.path === file);
            expect(flows, canonicalJson(flow)).toHaveLength(1);
            expect(flows.map((row) => row.title).join("\n")).toContain("copy");
            expect(flows.some((row) => row.title.includes("constant"))).toBe(false);
            expect(flows.every((row) => row.start_line === (file === "flow.php" ? 6 : 5))).toBe(
              true
            );
          }
          expect(page.complete).toBe(false);
          expect(page.rows).toHaveLength(1);
          expect(page.files.every((file) => file.detail.includes("truncated=true"))).toBe(true);
        }
        expect(
          prepared.preparation.capabilities
            .filter((entry) => entry.id.startsWith("graph_"))
            .every((entry) => entry.status === "partial")
        ).toBe(true);
        const gather = await runtime.gather({
          request: { ...request, stage: "evidence" },
          corpus,
          control,
          graphs: prepared.graphs,
          actions: {
            schema_version: 1,
            gaps: [],
            actions: ["dataflow", "page"].map((id) => ({
              id,
              hypothesis_id: "flow-check",
              kind: "graph" as const,
              ranges: [],
              query_id: id,
              rationale: "Check native flow and bounded-page accounting",
              discriminating_observation: "Native edges or explicitly incomplete page",
            })),
          },
        });
        save("gathered.json", gather);
        expect(gather.results.map((entry) => entry.status)).toEqual(["completed", "failed"]);
        expect(gather.results.every((entry) => entry.execution === "NOT RUN")).toBe(true);
        const cancelling = new AbortController();
        let ticks = 0;
        const beforeCancel = count;
        await expect(
          runtime.gather({
            request: { ...request, stage: "evidence" },
            corpus,
            graphs: prepared.graphs,
            control: {
              signal: cancelling.signal,
              activity() {
                if (++ticks >= 3)
                  cancelling.abort(new Error("native graph verification cancelled"));
              },
            },
            actions: {
              schema_version: 1,
              gaps: [],
              actions: [
                {
                  id: "cancel",
                  hypothesis_id: "cleanup",
                  kind: "graph",
                  ranges: [],
                  query_id: "dataflow",
                  rationale: "Verify native cancellation and owned cleanup",
                  discriminating_observation:
                    "Cancellation propagates instead of a clean graph result",
                },
              ],
            },
          })
        ).rejects.toThrow("native graph verification cancelled");
        expect(count).toBe(beforeCancel + 1);
        const cancelled: unknown = JSON.parse(
          readFileSync(
            path.join(evidence, `process-${String(beforeCancel).padStart(3, "0")}.json`),
            "utf8"
          )
        );
        expect(cancelled).toMatchObject({
          result: { status: "cancelled", failure_code: "cancelled" },
        });
        // Failed source parsing must be visible per file, never turned into an empty clean graph.
        writeFileSync(path.join(source, "broken.php"), "<?php\nfunction broken( {\n", {
          flag: "wx",
          mode: 0o600,
        });
        writeFileSync(path.join(source, "broken.js"), "function broken( {\n", {
          flag: "wx",
          mode: 0o600,
        });
        writeFileSync(path.join(source, "broken.ts"), "function broken(: : {\n", {
          flag: "wx",
          mode: 0o600,
        });
        const broken = buildHostStaticInventory({
          schema_version: 1,
          source_root: source,
          purpose: "Native unsupported-source accounting",
          scope: { include: [], exclude: [] },
          execution_mode: "static_only",
          model: "deepseek-flash",
        });
        const brokenCorpus = Buffer.from(broken.sourceCorpus);
        writeFileSync(path.join(evidence, "broken-corpus.json"), brokenCorpus, {
          flag: "wx",
          mode: 0o600,
        });
        const brokenRuntime = createOrdinaryScaRuntime({ recordProcess: options.recordProcess });
        const unsupported = await brokenRuntime.prepare({
          request: {
            ...request,
            source_snapshot_sha256: broken.sourceSnapshotSha256,
            input_bindings: [{ slot: "corpus", content_digest: sha256(brokenCorpus) }],
            tools: {
              graph: {
                ...tools.graph,
                queries: tools.graph.queries.filter((query) => query.id === "call"),
              },
            },
          },
          corpus: brokenCorpus,
          control,
        });
        save("unsupported.json", unsupported);
        expect(unsupported.graphs).toHaveLength(2);
        for (const graph of unsupported.graphs) {
          const observed = graph.query_observations[0]?.observation;
          if (observed === undefined) throw new Error("Missing native unsupported observation");
          const paths = graph.language === "php" ? ["broken.php"] : ["broken.js", "broken.ts"];
          for (const file of paths)
            expect(observed.files.find((entry) => entry.path === file)?.status).toBe("unsupported");
          expect(observed.complete).toBe(false);
        }
      } finally {
        const cleanup = [...staging].map((path) => ({ path, absent: !existsSync(path) }));
        save("cleanup.json", cleanup);
        rmSync(source, { recursive: true, force: true });
        expect(cleanup.every((entry) => entry.absent)).toBe(true);
      }
    }, 0);
  }
);
