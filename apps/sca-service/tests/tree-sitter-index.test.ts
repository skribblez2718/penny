import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ScaTreeSitterIndexError,
  buildScaTreeSitterIndexV2,
  inspectInstalledTreeSitterIdentitiesV2,
  validateScaTreeSitterIndexResultV2,
  type ScaTreeSitterIndexResultV2,
} from "../src/adapters/tree-sitter-index.js";

const SNAPSHOT = "a".repeat(64);

function source(path: string, admitted_language: string, content: string | Buffer) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return {
    path,
    encoding: "base64" as const,
    content_base64: bytes.toString("base64"),
    byte_count: bytes.byteLength,
    source_sha256: sha256(bytes),
    admitted_language,
  };
}

function input(files: ReturnType<typeof source>[]) {
  return {
    schema_id: "penny.sca-tree-sitter-index-input.v2",
    schema_version: 2,
    source_snapshot_sha256: SNAPSHOT,
    tool: inspectInstalledTreeSitterIdentitiesV2(),
    limits: {
      max_files: 32,
      max_source_bytes_per_file: 65_536,
      max_total_source_bytes: 262_144,
      max_nodes_per_file: 10_000,
      max_depth: 256,
      max_diagnostics_per_file: 16,
      max_symbols_per_file: 1_000,
      parse_timeout_micros: 2_000_000,
      query_match_limit: 10_000,
    },
    files,
  };
}

function redigest(result: ScaTreeSitterIndexResultV2): ScaTreeSitterIndexResultV2 {
  const { index_sha256: digest, ...unsigned } = result;
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  return { ...unsigned, index_sha256: sha256(canonicalJson(unsigned)) };
}

function expectIndexError(run: () => unknown, code: ScaTreeSitterIndexError["code"]): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ScaTreeSitterIndexError);
    if (error instanceof ScaTreeSitterIndexError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected Tree-sitter index error '${code}'`);
}

describe("SCA-P02 in-process Tree-sitter index v2", () => {
  it("checks the worker result against the exact admitted input without a host rebuild", () => {
    const admitted = input([source("src/a.php", "php", "<?php function ready() {}")]);
    const result = buildScaTreeSitterIndexV2(admitted);
    expect(
      validateScaTreeSitterIndexResultV2(result, admitted, { deterministic_rebuild: false })
    ).toEqual(result);
    const altered = input([source("src/a.php", "php", "<?php function changed() {}")]);
    expectIndexError(
      () => validateScaTreeSitterIndexResultV2(result, altered, { deterministic_rebuild: false }),
      "semantic_mismatch"
    );
    const differentTool = {
      ...admitted,
      tool: { ...admitted.tool, implementation_sha256: "b".repeat(64) },
    };
    expectIndexError(
      () =>
        validateScaTreeSitterIndexResultV2(result, differentTool, { deterministic_rebuild: false }),
      "semantic_mismatch"
    );
    const tampered = redigest({
      ...result,
      files: result.files.map((file) => ({ ...file, source_sha256: "b".repeat(64), symbols: [] })),
    });
    expectIndexError(
      () =>
        validateScaTreeSitterIndexResultV2(tampered, admitted, { deterministic_rebuild: false }),
      "semantic_mismatch"
    );
  });
  it("parses every admitted grammar and binds identity to implementation, JS glue, and native bytes", () => {
    const admitted = input([
      source("src/fixed.php", "php", "<?php function safe($x) { return $x; } safe(1);"),
      source("web/no-alert.js", "javascript", "function safe(x) { return x; } safe(1);"),
      source("web/view.jsx", "jsx", "const View = () => <Panel />; View();"),
      source(
        "web/types.ts",
        "typescript",
        "interface Item { id: string } function keep(x: Item): Item { return x; }"
      ),
      source(
        "web/view.tsx",
        "tsx",
        "type Props = { name: string }; const App = (p: Props) => <div>{p.name}</div>;"
      ),
    ]);
    const result = buildScaTreeSitterIndexV2(admitted);

    expect(result.status).toBe("succeeded");
    expect(result.counts).toMatchObject({
      observed: 5,
      parsed: 5,
      parse_gap: 0,
      malformed: 0,
      unsupported: 0,
      truncated: 0,
    });
    expect(result.tool.implementation_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.tool.capture_profile_sha256).toBe(result.capture_profile.profile_sha256);
    expect(result.tool.indexer_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.tool.runtime.version).toBe("0.21.1");
    expect(result.tool.runtime.javascript_entrypoint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.tool.runtime.native_binding_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.tool.grammars.map(({ language, version }) => ({ language, version }))).toEqual([
      { language: "php", version: "0.23.11" },
      { language: "javascript", version: "0.23.1" },
      { language: "jsx", version: "0.23.1" },
      { language: "typescript", version: "0.23.2" },
      { language: "tsx", version: "0.23.2" },
    ]);
    expect(
      result.tool.grammars.every((grammar) =>
        /^[a-f0-9]{64}$/u.test(grammar.javascript_entrypoint_sha256)
      )
    ).toBe(true);
    expect(result.capture_profile.coverage.some((entry) => entry.includes("declarations"))).toBe(
      true
    );
    expect(result.capture_profile.coverage.some((entry) => entry.includes("imports"))).toBe(true);
    expect(result.capture_profile.coverage.some((entry) => entry.includes("destructuring"))).toBe(
      true
    );
    expect(result.capture_profile.coverage.some((entry) => entry.includes("php"))).toBe(true);
    expect(
      result.capture_profile.limitations.some((entry) => entry.includes("no-cross-file"))
    ).toBe(true);
    expect(
      result.capture_profile.limitations.some((entry) => entry.includes("computed-or-dynamic"))
    ).toBe(true);
    expect(validateScaTreeSitterIndexResultV2(result, admitted)).toEqual(result);
  });

  it("uses context-specific captures for definitions, references, imports, members, aliases, and destructuring", () => {
    const typescript =
      'import Default, {Foo as Bar, Baz} from "pkg"; ' +
      "interface Item extends Base { id: string } type Alias = Item; " +
      "class C implements Item { method(x: Alias): Bar { const {a: local, b} = x; " +
      "const [first] = arr; return x.member; } } new C(); fn(local);";
    const php =
      "<?php namespace App; use Vendor\\Package\\Thing as Alias; use Vendor\\Other; " +
      "class C extends \\Base\\Root implements Alias { " +
      "public function run(Alias $x): \\Vendor\\Result { $x->member(); Alias::make(); " +
      "return new Vendor\\Package\\Thing(); } } function helper(){} helper();";
    const result = buildScaTreeSitterIndexV2(
      input([
        source("constructs.ts", "typescript", typescript),
        source("constructs.php", "php", php),
      ])
    );
    const symbols = result.files.flatMap((file) => file.symbols);

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record_kind: "definition",
          symbol_kind: "interface",
          name: "Item",
        }),
        expect.objectContaining({ record_kind: "reference", symbol_kind: "type", name: "Base" }),
        expect.objectContaining({ record_kind: "reference", symbol_kind: "type", name: "Item" }),
        expect.objectContaining({
          record_kind: "definition",
          symbol_kind: "import",
          name: "Default",
        }),
        expect.objectContaining({ record_kind: "reference", symbol_kind: "import", name: "Foo" }),
        expect.objectContaining({ record_kind: "definition", symbol_kind: "import", name: "Bar" }),
        expect.objectContaining({
          record_kind: "definition",
          symbol_kind: "variable",
          name: "local",
        }),
        expect.objectContaining({ record_kind: "definition", symbol_kind: "variable", name: "b" }),
        expect.objectContaining({
          record_kind: "definition",
          symbol_kind: "variable",
          name: "first",
        }),
        expect.objectContaining({
          record_kind: "reference",
          symbol_kind: "member",
          name: "member",
        }),
        expect.objectContaining({ record_kind: "reference", symbol_kind: "construct", name: "C" }),
        expect.objectContaining({
          record_kind: "reference",
          symbol_kind: "import",
          name: "Vendor\\Package\\Thing",
        }),
        expect.objectContaining({
          record_kind: "definition",
          symbol_kind: "import",
          name: "Alias",
        }),
        expect.objectContaining({
          record_kind: "reference",
          symbol_kind: "type",
          name: "\\Base\\Root",
        }),
        expect.objectContaining({
          record_kind: "reference",
          symbol_kind: "construct",
          name: "Vendor\\Package\\Thing",
        }),
        expect.objectContaining({ record_kind: "reference", symbol_kind: "call", name: "helper" }),
      ])
    );
    const itemDefinition = symbols.find(
      (symbol) => symbol.record_kind === "definition" && symbol.name === "Item"
    );
    if (itemDefinition === undefined) throw new Error("expected Item declaration capture");
    expect(
      symbols.some(
        (symbol) =>
          symbol.record_kind === "reference" &&
          symbol.name === "Item" &&
          symbol.range.start_byte === itemDefinition.range.start_byte &&
          symbol.range.end_byte === itemDefinition.range.end_byte
      )
    ).toBe(false);
  });

  it("records parse gaps, unsupported languages, strict UTF-8 failures, and bounded truncation", () => {
    const request = input([
      source("broken.php", "php", "<?php function broken( {"),
      source("unsupported.rb", "ruby", "def value; 1; end"),
      source("malformed.js", "javascript", Buffer.from([0xc3, 0x28])),
      source("large.js", "javascript", "function many() { return 1 + 2 + 3; }"),
    ]);
    request.limits.max_nodes_per_file = 1;
    const result = buildScaTreeSitterIndexV2(request);

    expect(result.status).toBe("partial");
    expect(result.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "broken.php", status: "limit_exceeded" },
      { path: "large.js", status: "limit_exceeded" },
      { path: "malformed.js", status: "malformed" },
      { path: "unsupported.rb", status: "unsupported" },
    ]);
    expect(result.counts.truncated).toBe(2);
    expect(result.files.find((file) => file.path === "malformed.js")?.diagnostics[0]?.code).toBe(
      "invalid_utf8"
    );
  });

  it("is deterministic under replay and caller file ordering", () => {
    const files = [
      source("b.ts", "typescript", "const b = () => 2; b();"),
      source("a.js", "javascript", "function a() { return 1; } a();"),
    ];
    const first = buildScaTreeSitterIndexV2(input(files));
    const replay = buildScaTreeSitterIndexV2(input([...files].reverse()));
    expect(replay).toEqual(first);
  });

  it("semantic validation rejects recomputed-digest ID, count, status, and tool mutations", () => {
    const admitted = input([source("src/a.js", "javascript", "function a() { return 1; } a();")]);
    const result = buildScaTreeSitterIndexV2(admitted);
    const file = result.files[0];
    const symbol = file?.symbols[0];
    if (file === undefined || symbol === undefined)
      throw new Error("expected indexed symbol fixture");

    const countMutation = redigest({
      ...result,
      counts: { ...result.counts, definitions: result.counts.definitions + 1 },
    });
    expectIndexError(
      () => validateScaTreeSitterIndexResultV2(countMutation, admitted),
      "semantic_mismatch"
    );

    const idMutation = redigest({
      ...result,
      files: [
        {
          ...file,
          symbols: [{ ...symbol, record_id: `sym_${"f".repeat(64)}` }, ...file.symbols.slice(1)],
        },
      ],
    });
    expectIndexError(
      () => validateScaTreeSitterIndexResultV2(idMutation, admitted),
      "semantic_mismatch"
    );

    const statusMutation = redigest({ ...result, status: "partial" });
    expectIndexError(
      () => validateScaTreeSitterIndexResultV2(statusMutation, admitted),
      "semantic_mismatch"
    );

    const { indexer_sha256: observedIndexer, ...forgedToolUnsigned } = {
      ...result.tool,
      runtime: { ...result.tool.runtime, package_name: "forged-runtime" },
      grammars: result.tool.grammars.map((grammar, index) =>
        index === 0 ? { ...grammar, package_name: "forged-grammar" } : grammar
      ),
    };
    expect(observedIndexer).toMatch(/^[a-f0-9]{64}$/u);
    const forgedTool = {
      ...forgedToolUnsigned,
      indexer_sha256: sha256(canonicalJson(forgedToolUnsigned)),
    };
    const forgedIdentity = redigest({ ...result, tool: forgedTool });
    expectIndexError(
      () => validateScaTreeSitterIndexResultV2(forgedIdentity, admitted),
      "semantic_mismatch"
    );
    expectIndexError(
      () =>
        validateScaTreeSitterIndexResultV2(forgedIdentity, {
          ...admitted,
          tool: forgedTool,
        }),
      "tool_identity_mismatch"
    );
  });

  it("rejects noncanonical sources, byte drift, collisions, and installed identity drift", () => {
    const valid = input([source("src/a.js", "javascript", "const a = 1;")]);
    expectIndexError(
      () =>
        buildScaTreeSitterIndexV2({ ...valid, files: [{ ...valid.files[0], path: "../a.js" }] }),
      "unsafe_path"
    );
    expectIndexError(
      () =>
        buildScaTreeSitterIndexV2({
          ...valid,
          files: [
            { ...valid.files[0], path: "SRC/a.js" },
            { ...valid.files[0], path: "src/A.js" },
          ],
        }),
      "path_collision"
    );
    expectIndexError(
      () =>
        buildScaTreeSitterIndexV2({
          ...valid,
          files: [{ ...valid.files[0], source_sha256: "b".repeat(64) }],
        }),
      "source_mismatch"
    );
    expectIndexError(
      () =>
        buildScaTreeSitterIndexV2({
          ...valid,
          tool: { ...valid.tool, implementation_sha256: "b".repeat(64) },
        }),
      "tool_identity_mismatch"
    );
  });
});
