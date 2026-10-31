import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ordinaryScaRuntime,
  createOrdinaryScaRuntime,
  type ScaOrdinaryProcessObservation,
  type ScaOrdinaryDeterministicObservation,
} from "../src/ordinary-runtime.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { buildHostStaticInventory } from "../../orchestration/dist/sca/ordinary-source.js";
import type {
  ScaHostRequest,
  ScaRuntimeControl,
  ScaGraphData,
} from "../../orchestration/dist/sca/ordinary-host.js";
import { ScaEvidenceSchema } from "../../orchestration/dist/sca/ordinary-contracts.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(coverage: "supported" | "unsupported" | "missing" = "supported") {
  const root = mkdtempSync(path.join(tmpdir(), "penny-ordinary-runtime-test-"));
  roots.push(root);
  const source = path.join(root, "target");
  mkdirSync(source);
  writeFileSync(
    path.join(source, "handler.ts"),
    "export function handler(input: string) { return exec(input); }\n"
  );
  const captured = buildHostStaticInventory({
    schema_version: 1,
    source_root: source,
    purpose: "Offline source analyzer adapter test",
    scope: { include: [], exclude: [] },
    execution_mode: "static_only",
    model: "deepseek-flash",
  });
  const file = (name: string, content: string) => {
    const selected = path.join(root, name);
    writeFileSync(selected, content);
    return selected;
  };
  let executableCount = 0;
  const executable = (name: string, body: string) => {
    const selected = path.join(root, `${name}-${executableCount++}`);
    writeFileSync(selected, `#!${process.execPath}\n${body}`, { flag: "wx", mode: 0o700 });
    return {
      executable: selected,
      sha256: sha256(readFileSync(selected)),
      version: "offline-fixture-v1",
    };
  };
  const semgrep = executable(
    "semgrep",
    `console.log(JSON.stringify({results:[{check_id:'synthetic.effect',path:'handler.ts',start:{line:1},end:{line:1}}],errors:[],paths:{scanned:['handler.ts']},skipped_rules:[]})); process.exitCode=1;`
  );
  const gitleaks = executable("gitleaks", "console.log('[]');");
  const frontend = executable(
    "frontend",
    "const fs=require('node:fs'); const p=process.argv.indexOf('--output'); fs.writeFileSync(process.argv[p+1], 'opaque-semantic-cpg-fixture');"
  );
  const sourceHash = sha256(readFileSync(path.join(source, "handler.ts")));
  const query = executable(
    "joern",
    `console.log(${JSON.stringify(canonicalJson({ schema_version: 1, complete: coverage !== "missing", files: coverage === "missing" ? [] : [{ path: "handler.ts", content_sha256: sourceHash, status: coverage, detail: "Offline per-file frontend support fixture; not native semantic accuracy proof." }], rows: [{ title: "Synthetic semantic effect edge", path: "handler.ts", start_line: 1, end_line: 1 }] }))});`
  );
  const rulePath = file("rules.yml", "rules: []\n");
  const scriptPath = file("query.sc", "// Caller-selected fixture query; never target source.\n");
  const request: ScaHostRequest = {
    schema_version: 1,
    stage: "preparation",
    run_id: "offline-native-adapter-fixture",
    input_bindings: [{ slot: "corpus", content_digest: sha256(captured.sourceCorpus) }],
    source_snapshot_sha256: captured.sourceSnapshotSha256,
    tools: {
      semgrep: {
        tool: semgrep,
        rules_path: rulePath,
        rules_sha256: sha256(readFileSync(rulePath)),
      },
      gitleaks: {
        tool: gitleaks,
        rules_path: rulePath,
        rules_sha256: sha256(readFileSync(rulePath)),
      },
      graph: {
        js_frontend: frontend,
        joern: query,
        queries: [
          { id: "effects", script_path: scriptPath, sha256: sha256(readFileSync(scriptPath)) },
        ],
      },
    },
  };
  let activity = 0;
  const controller = new AbortController();
  const control: ScaRuntimeControl = {
    signal: controller.signal,
    activity: () => {
      activity += 1;
    },
  };
  return {
    root,
    source,
    request,
    corpus: Buffer.from(captured.sourceCorpus),
    control,
    controller,
    activity: () => activity,
    scriptPath,
    executable,
  };
}
describe("ordinary source scanner/semantic runtime — offline executable fixtures", () => {
  it("connects real bounded process/scanner/dependency APIs and materializes captured graph/query evidence", async () => {
    const input = fixture();
    const prepared = await ordinaryScaRuntime.prepare(input);
    expect(prepared.preparation.capabilities.every((entry) => entry.status === "completed")).toBe(
      true
    );
    expect(prepared.preparation.leads.map((entry) => entry.origin)).toEqual(["semgrep", "graph"]);
    expect(prepared.graphs).toHaveLength(1);
    expect(prepared.graphs[0]?.query_observations[0]?.observation.files[0]?.status).toBe(
      "supported"
    );
    expect(input.activity()).toBeGreaterThan(0);
    const evidence = validateContract(
      ScaEvidenceSchema,
      await ordinaryScaRuntime.gather({
        ...input,
        request: { ...input.request, stage: "evidence" },
        graphs: prepared.graphs,
        actions: {
          schema_version: 1,
          gaps: [],
          actions: [
            {
              id: "observe",
              hypothesis_id: "h-1",
              kind: "graph",
              ranges: [],
              query_id: "effects",
              rationale: "Inspect the exact semantic effect relation",
              discriminating_observation:
                "Complete named source-to-effect edge with counterexample",
            },
          ],
        },
      }),
      "Runtime test evidence"
    );
    expect(evidence.results[0]?.status).toBe("completed");
    expect(evidence.results[0]?.observation).toContain("Synthetic semantic effect edge");
    expect(evidence.results[0]?.execution).toBe("NOT RUN");
    expect(evidence.results[0]?.receipt_refs).toEqual([]);
  });
  it.each(["unsupported", "missing"] as const)(
    "never upgrades %s graph support to completed coverage",
    async (status) => {
      const prepared = await ordinaryScaRuntime.prepare(fixture(status));
      expect(
        prepared.preparation.capabilities.find(
          (entry) => entry.id === "graph_javascript_typescript"
        )?.status
      ).toBe("partial");
      expect(prepared.preparation.leads.some((entry) => entry.origin === "graph")).toBe(true);
    }
  );
  it("retains tool/query identity drift as material failure and never falls back to syntax graphs", async () => {
    const input = fixture();
    writeFileSync(input.scriptPath, "// changed after caller admission\n");
    const prepared = await ordinaryScaRuntime.prepare(input);
    expect(
      prepared.preparation.capabilities.find((entry) => entry.id === "graph_javascript_typescript")
        ?.status
    ).toBe("failed");
    expect(prepared.preparation.leads.some((entry) => entry.origin === "semgrep")).toBe(true);
  });
  it("reports missing installed tools as unavailable instead of empty successful scanners", async () => {
    const input = fixture();
    const prepared = await ordinaryScaRuntime.prepare({
      ...input,
      request: { ...input.request, tools: {} },
    });
    expect(prepared.preparation.capabilities.find((entry) => entry.id === "semgrep")?.status).toBe(
      "unavailable"
    );
    expect(
      prepared.preparation.capabilities.find((entry) => entry.id === "graph_javascript_typescript")
        ?.status
    ).toBe("unavailable");
    expect(prepared.graphs).toEqual([]);
  });
});

function setScanner(input: ReturnType<typeof fixture>, kind: "semgrep" | "gitleaks", body: string) {
  const config = input.request.tools[kind];
  if (config === undefined) throw new Error("Missing fixture scanner");
  config.tool = input.executable(`${kind}-replacement`, body);
}
describe("ordinary runtime fail-closed scanner handling", () => {
  it.each([
    ["malformed record", { results: [{ check_id: "bad" }], errors: [] }],
    [
      "foreign path",
      {
        results: [{ check_id: "bad", path: "other.ts", start: { line: 1 }, end: { line: 1 } }],
        errors: [],
      },
    ],
    [
      "escaped path",
      {
        results: [{ check_id: "bad", path: "../handler.ts", start: { line: 1 }, end: { line: 1 } }],
        errors: [],
      },
    ],
    [
      "invalid range",
      {
        results: [{ check_id: "bad", path: "handler.ts", start: { line: 2 }, end: { line: 1 } }],
        errors: [],
      },
    ],
  ])("does not publish completed before validating %s", async (_name, output) => {
    const input = fixture();
    setScanner(
      input,
      "semgrep",
      `console.log(${JSON.stringify(JSON.stringify(output))}); process.exitCode=1;`
    );
    const prepared = await ordinaryScaRuntime.prepare(input);
    expect(
      prepared.preparation.capabilities.filter((entry) => entry.id.startsWith("semgrep"))
    ).toMatchObject([{ id: "semgrep", status: "failed" }]);
    expect(prepared.preparation.leads.filter((entry) => entry.origin === "semgrep")).toEqual([]);
  });
  it.each(["semgrep", "gitleaks"] as const)(
    "rejects malformed, truncated and unreachable %s",
    async (kind) => {
      const input = fixture();
      for (const body of [
        "console.log('not-json');",
        "process.stdout.write('x'.repeat(8*1024*1024+1));",
        "process.stderr.write('x'.repeat(8*1024*1024+1));",
      ]) {
        setScanner(input, kind, body);
        const prepared = await ordinaryScaRuntime.prepare(input);
        expect(
          prepared.preparation.capabilities.filter((entry) => entry.id.startsWith(kind))
        ).toMatchObject([{ id: kind, status: "failed" }]);
      }
      const config = input.request.tools[kind];
      if (config === undefined) throw new Error("Missing fixture scanner");
      config.tool.executable = path.join(input.root, "missing-scanner");
      const prepared = await ordinaryScaRuntime.prepare(input);
      expect(
        prepared.preparation.capabilities.filter((entry) => entry.id.startsWith(kind))
      ).toMatchObject([{ id: kind, status: "failed" }]);
    }
  );
  it.each([
    { results: [], errors: [], paths: { scanned: [] }, skipped_rules: [] },
    { results: [], errors: [], paths: { scanned: ["handler.ts"] }, skipped_rules: [{}] },
    { results: [], errors: [] },
  ])("never reports missing/skipped Semgrep coverage as completed", async (output) => {
    const input = fixture();
    setScanner(input, "semgrep", `console.log(${JSON.stringify(JSON.stringify(output))});`);
    const prepared = await ordinaryScaRuntime.prepare(input);
    expect(prepared.preparation.capabilities.find((entry) => entry.id === "semgrep")?.status).toBe(
      "partial"
    );
  });
  it.each(["semgrep", "gitleaks"] as const)(
    "rejects %s finding-exit with no findings",
    async (kind) => {
      const input = fixture();
      setScanner(
        input,
        kind,
        `console.log('${kind === "semgrep" ? '{"results":[],"errors":[]}' : "[]"}'); process.exitCode=1;`
      );
      const prepared = await ordinaryScaRuntime.prepare(input);
      expect(prepared.preparation.capabilities.find((entry) => entry.id === kind)?.status).toBe(
        "failed"
      );
    }
  );
  it("propagates active and pre-aborted cancellation and cleans staged source", async () => {
    const input = fixture();
    const cwdFile = path.join(input.root, "staged-cwd");
    setScanner(
      input,
      "semgrep",
      `require('node:fs').writeFileSync(${JSON.stringify(cwdFile)},process.cwd()); console.log('started'); setInterval(()=>{},100);`
    );
    const operation = ordinaryScaRuntime.prepare(input);
    const wait = setInterval(() => {
      if (existsSync(cwdFile)) input.controller.abort(new Error("fixture cancellation"));
    }, 5);
    try {
      await expect(operation).rejects.toThrow("fixture cancellation");
    } finally {
      clearInterval(wait);
    }
    expect(existsSync(readFileSync(cwdFile, "utf8"))).toBe(false);
    const pre = fixture();
    pre.controller.abort(new Error("already cancelled"));
    await expect(ordinaryScaRuntime.prepare(pre)).rejects.toThrow("already cancelled");
  });
});

function graphEvidence(input: ReturnType<typeof fixture>, graphs: readonly ScaGraphData[]) {
  return {
    ...input,
    request: { ...input.request, stage: "evidence" as const },
    graphs,
    actions: {
      schema_version: 1 as const,
      gaps: [],
      actions: [
        {
          id: "observe",
          hypothesis_id: "h-1",
          kind: "graph" as const,
          ranges: [],
          query_id: "effects",
          rationale: "Inspect semantic coverage",
          discriminating_observation: "Exact supported source accounting",
        },
      ],
    },
  };
}
describe("ordinary graph evidence and private raw capture", () => {
  it.each(["unsupported", "missing"] as const)(
    "rejects %s coverage during gather as well as prepare",
    async (coverage) => {
      const input = fixture(coverage);
      const prepared = await ordinaryScaRuntime.prepare(input);
      const gathered = await ordinaryScaRuntime.gather(graphEvidence(input, prepared.graphs));
      expect(gathered.results[0]?.status).toBe("failed");
      expect(gathered.results[0]?.pointers).toEqual([]);
    }
  );
  it("rejects graph/source snapshot substitution", async () => {
    const input = fixture();
    const prepared = await ordinaryScaRuntime.prepare(input);
    const graphs = prepared.graphs.map((graph) => ({
      ...graph,
      source_snapshot_sha256: "f".repeat(64),
    }));
    const gathered = await ordinaryScaRuntime.gather(graphEvidence(input, graphs));
    expect(gathered.results[0]?.status).toBe("failed");
    await expect(
      ordinaryScaRuntime.prepare({
        ...input,
        request: { ...input.request, source_snapshot_sha256: "f".repeat(64) },
      })
    ).rejects.toThrow("source snapshot mismatch");
  });
  it.each(["not-json", "{}"])(
    "does not export a graph after invalid query output %s",
    async (stdout) => {
      const input = fixture();
      const graph = input.request.tools.graph;
      if (graph === undefined) throw new Error("Missing fixture graph");
      graph.joern = input.executable("broken-query", `console.log(${JSON.stringify(stdout)});`);
      const prepared = await ordinaryScaRuntime.prepare(input);
      expect(prepared.graphs).toEqual([]);
      expect(prepared.preparation.leads.filter((entry) => entry.origin === "graph")).toEqual([]);
      expect(
        prepared.preparation.capabilities.find(
          (entry) => entry.id === "graph_javascript_typescript"
        )?.status
      ).toBe("failed");
    }
  );
  it("preserves full failed-process streams and exact invocation pins before parsing and cleans source/scratch", async () => {
    const input = fixture();
    setScanner(
      input,
      "semgrep",
      "console.log('malformed-json');console.error('fixture diagnostic');"
    );
    const semgrep = input.request.tools.semgrep;
    if (semgrep === undefined) throw new Error("Missing fixture scanner");
    input.request.tools = { semgrep };
    const observed: ScaOrdinaryProcessObservation[] = [];
    const runtime = createOrdinaryScaRuntime({
      async recordProcess(result) {
        observed.push(result);
      },
    });
    const prepared = await runtime.prepare(input);
    expect(prepared.preparation.capabilities.find((entry) => entry.id === "semgrep")?.status).toBe(
      "failed"
    );
    expect(observed).toHaveLength(1);
    const record = observed[0];
    if (record === undefined) throw new Error("Missing captured process");
    expect(record.result.stdout, record.result.stderr).toBe("malformed-json\n");
    expect(record.result.stderr).toBe("fixture diagnostic\n");
    expect(record.request.executable_sha256).toBe(semgrep.tool.sha256);
    const rules = record.request.arguments[record.request.arguments.indexOf("--config") + 1];
    expect(rules).not.toBe(semgrep.rules_path);
    expect(rules).toBe(path.join(path.dirname(record.request.cwd), "semgrep.yml"));
    expect(record.request.arguments.slice(0, 5)).toEqual([
      "scan",
      "--jobs",
      "1",
      "--max-memory",
      "512",
    ]);
    expect(record.source_corpus_sha256).toBe(sha256(input.corpus));
    expect(record.source_snapshot_sha256).toBe(input.request.source_snapshot_sha256);
    expect(sha256(canonicalJson(record.request))).toBe(record.result.request_sha256);
    expect(existsSync(path.dirname(record.request.cwd))).toBe(false);
    expect(existsSync(input.source)).toBe(true);
  });
  it("retains exact deterministic inventory input/result and zero-coordinate advisory accounting privately", async () => {
    const input = fixture();
    input.request.tools = {};
    const observations: ScaOrdinaryDeterministicObservation[] = [];
    const runtime = createOrdinaryScaRuntime({
      async recordDeterministic(observation) {
        observations.push(observation);
      },
    });
    const prepared = await runtime.prepare(input);
    expect(observations.map((entry) => entry.kind)).toEqual(["dependencies", "advisories"]);
    const dependency = observations[0];
    if (dependency === undefined) throw new Error("Missing dependency evidence");
    expect(dependency.source_corpus_sha256).toBe(sha256(input.corpus));
    expect(dependency.result).toMatchObject({
      status: "succeeded",
      source_snapshot_sha256: input.request.source_snapshot_sha256,
      inventory_sha256: prepared.preparation.capabilities.find(
        (entry) => entry.id === "dependencies"
      )?.evidence_sha256,
    });
    expect(canonicalJson(prepared)).not.toContain("source_corpus_sha256");
  });
  it("never downgrades deterministic raw-sink failure to an unavailable capability", async () => {
    const input = fixture();
    const runtime = createOrdinaryScaRuntime({
      async recordDeterministic() {
        throw new Error("deterministic sink refused");
      },
    });
    await expect(runtime.prepare(input)).rejects.toThrow("deterministic evidence capture failed");
  });
  it("never swallows evidence-sink failure or activity refusal", async () => {
    const input = fixture();
    let staged: string | undefined;
    const runtime = createOrdinaryScaRuntime({
      async recordProcess(record) {
        staged = record.request.cwd;
        throw new Error("sink unavailable");
      },
    });
    await expect(runtime.prepare(input)).rejects.toThrow("evidence capture failed");
    if (staged === undefined) throw new Error("Capture was not attempted");
    expect(existsSync(path.dirname(staged))).toBe(false);
    await expect(
      ordinaryScaRuntime.prepare({
        ...input,
        control: {
          signal: input.control.signal,
          activity() {
            throw new Error("lease refused");
          },
        },
      })
    ).rejects.toThrow("cancelled");
  });
  it("propagates graph-query cancellation and cleans evidence scratch", async () => {
    const input = fixture();
    const prepared = await ordinaryScaRuntime.prepare(input);
    const graph = input.request.tools.graph;
    if (graph === undefined) throw new Error("Missing fixture graph");
    const cwdFile = path.join(input.root, "query-cwd");
    graph.joern = input.executable(
      "waiting-query",
      `require('node:fs').writeFileSync(${JSON.stringify(cwdFile)},process.cwd()); console.log('started'); setInterval(()=>{},100);`
    );
    const operation = ordinaryScaRuntime.gather(graphEvidence(input, prepared.graphs));
    const wait = setInterval(() => {
      if (existsSync(cwdFile)) input.controller.abort(new Error("query cancelled"));
    }, 5);
    try {
      await expect(operation).rejects.toThrow("query cancelled");
    } finally {
      clearInterval(wait);
    }
    expect(existsSync(readFileSync(cwdFile, "utf8"))).toBe(false);
    await expect(ordinaryScaRuntime.gather(graphEvidence(input, prepared.graphs))).rejects.toThrow(
      "query cancelled"
    );
  });
});

describe("ordinary captured rule/script identity", () => {
  it.each(["semgrep", "gitleaks"] as const)(
    "executes captured %s rules even when the original path is transiently swapped and restored",
    async (kind) => {
      const input = fixture();
      const config = input.request.tools[kind];
      if (config === undefined) throw new Error("Missing fixture scanner");
      const marker = path.join(input.root, "used-rules.json");
      setScanner(
        input,
        kind,
        `
        const fs=require('node:fs');
        const original=${JSON.stringify(config.rules_path)};
        const selected=process.argv[process.argv.indexOf('--config')+1];
        const saved=original+'.saved'; fs.renameSync(original,saved);
        fs.writeFileSync(original,'SWAPPED RULES', {flag:'wx',mode:0o600});
        const content=fs.readFileSync(selected,'utf8');
        fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({selected,content,mode:fs.statSync(selected).mode&0o777}));
        fs.rmSync(original);fs.renameSync(saved,original);
        const id=content==='rules: []\\n'?'admitted-rules':'swapped-rules';
        console.log(JSON.stringify(${kind === "semgrep" ? "{results:[{check_id:id,path:'handler.ts',start:{line:1},end:{line:1}}],errors:[],paths:{scanned:['handler.ts']},skipped_rules:[]}" : "[{RuleID:id,File:'handler.ts',StartLine:1,EndLine:1}]"}));
        process.exitCode=1;
      `
      );
      const prepared = await ordinaryScaRuntime.prepare(input);
      expect(prepared.preparation.capabilities.find((entry) => entry.id === kind)?.status).toBe(
        "completed"
      );
      expect(
        prepared.preparation.leads
          .filter((entry) => entry.origin === kind)
          .map((entry) => entry.title)
      ).toEqual(["admitted-rules"]);
      expect(readFileSync(marker, "utf8")).toContain('"mode":256');
      expect(readFileSync(config.rules_path, "utf8")).toBe("rules: []\n");
    }
  );
  it("executes captured query script bytes in both preparation and evidence gathering", async () => {
    const input = fixture();
    const config = input.request.tools.graph;
    if (config === undefined) throw new Error("Missing fixture graph");
    const original = readFileSync(input.scriptPath, "utf8");
    const response = {
      schema_version: 1,
      complete: true,
      files: [
        {
          path: "handler.ts",
          content_sha256: sha256(readFileSync(path.join(input.source, "handler.ts"))),
          status: "supported",
          detail: "Fixture support",
        },
      ],
    };
    config.joern = input.executable(
      "swapping-query",
      `
      const fs=require('node:fs');const original=${JSON.stringify(input.scriptPath)};
      const script=process.argv[process.argv.indexOf('--script')+1];
      fs.renameSync(original,original+'.saved');fs.writeFileSync(original,'SWAPPED SCRIPT',{flag:'wx',mode:0o600});
      const content=fs.readFileSync(script,'utf8');
      fs.rmSync(original);fs.renameSync(original+'.saved',original);
      console.log(JSON.stringify({...${JSON.stringify(response)},rows:[{title:content,path:'handler.ts',start_line:1,end_line:1}]}));
    `
    );
    const observed: ScaOrdinaryProcessObservation[] = [];
    const runtime = createOrdinaryScaRuntime({
      async recordProcess(record) {
        observed.push(record);
      },
    });
    const prepared = await runtime.prepare(input);
    expect(prepared.graphs[0]?.query_observations[0]?.observation.rows[0]?.title).toBe(original);
    const gathered = await runtime.gather(graphEvidence(input, prepared.graphs));
    expect(gathered.results[0]?.status).toBe("completed");
    expect(gathered.results[0]?.observation).not.toContain("SWAPPED SCRIPT");
    const queries = observed.filter((record) => record.request.arguments.includes("--script"));
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.request.arguments).not.toContain(input.scriptPath);
      const selected = query.request.arguments[query.request.arguments.indexOf("--script") + 1];
      if (selected === undefined) throw new Error("Missing captured script argument");
      expect(existsSync(selected)).toBe(false);
    }
  });
});

describe("ordinary native graph CLI and source binding", () => {
  it("uses Joern 4 singular --param and binds exact CPG, manifest, frontend, tool and query pins privately", async () => {
    const input = fixture();
    const observed: ScaOrdinaryProcessObservation[] = [];
    const runtime = createOrdinaryScaRuntime({
      async recordProcess(record) {
        observed.push(record);
        if (record.graph === undefined) return;
        const parameter = record.request.arguments.find((arg) => arg.startsWith("cpgFile="));
        if (parameter === undefined) throw new Error("Missing cpgFile parameter");
        const cpg = parameter.slice("cpgFile=".length);
        expect(record.request.arguments).toContain("--param");
        expect(record.request.arguments).not.toContain("--params");
        expect(sha256(readFileSync(cpg))).toBe(record.graph.graph_sha256);
        expect(sha256(readFileSync(`${cpg}.manifest.json`))).toBe(record.graph.manifest_sha256);
        expect(record.graph.manifest.source_corpus_sha256).toBe(sha256(input.corpus));
        expect(record.graph.frontend).toEqual(input.request.tools.graph?.js_frontend);
        expect(record.graph.joern).toEqual(input.request.tools.graph?.joern);
        expect(record.graph.query.sha256).toBe(sha256(readFileSync(input.scriptPath)));
        expect(record.graph.manifest.files).toEqual([
          {
            path: "handler.ts",
            content_sha256: sha256(readFileSync(path.join(input.source, "handler.ts"))),
          },
        ]);
      },
    });
    await runtime.prepare(input);
    const native = observed.filter((record) => record.graph !== undefined);
    expect(native).toHaveLength(1);
    expect(
      observed.some((record) => record.request.arguments.includes("--enable-file-content"))
    ).toBe(true);
  });
  it.each([
    "escaped coverage",
    "foreign coverage",
    "duplicate coverage",
    "wrong digest",
    "escaped row",
    "foreign row",
  ])("fails closed on %s even if the query claims complete", async (failure) => {
    const input = fixture();
    const graph = input.request.tools.graph;
    if (graph === undefined) throw new Error("Missing graph");
    const file = {
      path: "handler.ts",
      content_sha256: sha256(readFileSync(path.join(input.source, "handler.ts"))),
      status: "supported",
      detail: "Fixture native boundary test",
    };
    const output = {
      schema_version: 1,
      complete: true,
      files:
        failure === "duplicate coverage"
          ? [file, file]
          : [
              {
                ...file,
                path:
                  failure === "escaped coverage"
                    ? "../handler.ts"
                    : failure === "foreign coverage"
                      ? "other.php"
                      : file.path,
                content_sha256: failure === "wrong digest" ? "a".repeat(64) : file.content_sha256,
              },
            ],
      rows: [
        {
          title: "Untrusted graph row",
          path:
            failure === "escaped row"
              ? "../handler.ts"
              : failure === "foreign row"
                ? "other.php"
                : "handler.ts",
          start_line: 1,
          end_line: 1,
        },
      ],
    };
    graph.joern = input.executable(
      "misbound-native-query",
      `console.log(${JSON.stringify(JSON.stringify(output))});`
    );
    const prepared = await ordinaryScaRuntime.prepare(input);
    expect(prepared.graphs).toEqual([]);
    expect(
      prepared.preparation.capabilities.find((entry) => entry.id === "graph_javascript_typescript")
        ?.status
    ).toBe("failed");
  });
  it.each(["stdout", "stderr", "nonzero"] as const)(
    "retains and rejects native query %s failure",
    async (failure) => {
      const input = fixture();
      const graph = input.request.tools.graph;
      if (graph === undefined) throw new Error("Missing graph");
      graph.joern = input.executable(
        "limited-native-query",
        failure === "nonzero"
          ? "console.error('native failed');process.exitCode=2;"
          : `process.${failure}.write('x'.repeat(8*1024*1024+1));`
      );
      const observations: ScaOrdinaryProcessObservation[] = [];
      const runtime = createOrdinaryScaRuntime({
        async recordProcess(record) {
          observations.push(record);
        },
      });
      const prepared = await runtime.prepare(input);
      expect(prepared.graphs).toEqual([]);
      const query = observations.find((record) => record.graph !== undefined);
      if (query === undefined) throw new Error("Missing private failed graph receipt");
      expect(query.result.status).toBe(failure === "nonzero" ? "nonzero_exit" : "output_limit");
      if (failure !== "nonzero") expect(query.result[`${failure}_truncated`]).toBe(true);
      expect(existsSync(query.request.cwd)).toBe(false);
    }
  );
  it("rejects noncanonical graph bytes before rerunning a native query", async () => {
    const input = fixture();
    const prepared = await ordinaryScaRuntime.prepare(input);
    const graphs = prepared.graphs.map((graph) => ({
      ...graph,
      bytes_base64: `${graph.bytes_base64}\n`,
    }));
    const gathered = await ordinaryScaRuntime.gather(graphEvidence(input, graphs));
    expect(gathered.results[0]?.status).toBe("failed");
  });
});

describe("ordinary runtime identity and graph file bounds", () => {
  it.each(["tool", "rules"] as const)(
    "fails closed on scanner %s identity drift",
    async (identity) => {
      const input = fixture();
      const config = input.request.tools.semgrep;
      if (config === undefined) throw new Error("Missing fixture scanner");
      if (identity === "tool") writeFileSync(config.tool.executable, "changed");
      else writeFileSync(config.rules_path, "changed");
      const prepared = await ordinaryScaRuntime.prepare(input);
      expect(
        prepared.preparation.capabilities.filter((entry) => entry.id === "semgrep")
      ).toMatchObject([{ id: "semgrep", status: "failed" }]);
      expect(prepared.preparation.leads.some((entry) => entry.origin === "semgrep")).toBe(false);
    }
  );
  it.each(["empty", "oversized", "symlink", "nonzero"] as const)(
    "rejects %s frontend output and cleans its scratch",
    async (failure) => {
      const input = fixture();
      const graph = input.request.tools.graph;
      if (graph === undefined) throw new Error("Missing fixture graph");
      const cwdFile = path.join(input.root, "frontend-cwd");
      const prefix = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(cwdFile)},process.cwd()); const target=process.argv[process.argv.indexOf('--output')+1];`;
      const body =
        failure === "empty"
          ? "fs.writeFileSync(target,'');"
          : failure === "oversized"
            ? "const fd=fs.openSync(target,'w');fs.ftruncateSync(fd,32*1024*1024+1);fs.closeSync(fd);"
            : failure === "symlink"
              ? `fs.symlinkSync(${JSON.stringify(input.scriptPath)},target);`
              : "fs.writeFileSync(target,'partial'); process.exitCode=2;";
      graph.js_frontend = input.executable("invalid-frontend", prefix + body);
      const prepared = await ordinaryScaRuntime.prepare(input);
      expect(prepared.graphs).toEqual([]);
      expect(
        prepared.preparation.capabilities.find(
          (entry) => entry.id === "graph_javascript_typescript"
        )?.status
      ).toBe("failed");
      expect(existsSync(readFileSync(cwdFile, "utf8"))).toBe(false);
    }
  );
});
