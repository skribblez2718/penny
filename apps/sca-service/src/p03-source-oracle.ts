import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import PHP from "tree-sitter-php";
import TypeScript from "tree-sitter-typescript";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import type { ScaP03QualificationFixtureCorpusV2 } from "../../orchestration/dist/sca/p03-contracts.js";
import {
  assertSourceOracleReceiptCorrespondence,
  sealSourceOracleValidationReceipt,
  type SourceOracleValidationReceipt,
} from "./p03-source-oracle-receipt.js";
import { inspectInstalledTreeSitterIdentitiesV2 } from "./adapters/tree-sitter-index.js";
import {
  parseSourceOracleBytes,
  projectSourceOracleCases,
  validateSourceFixture,
  type SourceFixture,
  type SourceMark,
} from "./p03-source-oracle-contracts.js";
export {
  validateSourceFixture,
  matchesSourceMark,
  matchesSourceRelationship,
  projectSourceOracleCases,
} from "./p03-source-oracle-contracts.js";
export type { SourceFixture, SourceMark } from "./p03-source-oracle-contracts.js";

/** Native identity verification is host-only; orchestration imports the pure contracts. */
export function validateSourceOracleBytes(bytes: Uint8Array) {
  const oracle = parseSourceOracleBytes(bytes);
  const identity = inspectInstalledTreeSitterIdentitiesV2();
  const parser = {
    runtime: identity.runtime,
    grammars: identity.grammars.filter((entry) =>
      ["javascript", "typescript", "php"].includes(entry.language)
    ),
  };
  if (
    canonicalJson(parser) !==
      canonicalJson({ runtime: oracle.parser.runtime, grammars: oracle.parser.grammars }) ||
    sha256(canonicalJson(parser)) !== oracle.parser.identity_sha256
  )
    throw new Error("P03 oracle parser identity drift");
  return oracle;
}

/** Validates exact reviewed bytes and AST before returning a host-sealable value. No persistence occurs here. */
export function validateAndSealSourceOracle(input: {
  readonly oracle_bytes: Uint8Array;
  readonly oracle_ref: ArtifactRef;
  readonly review_ref: ArtifactRef;
  readonly corpus_ref: ArtifactRef;
  readonly corpus: ScaP03QualificationFixtureCorpusV2;
  readonly fixtures: readonly {
    readonly ref: ArtifactRef;
    readonly fixture_id: string;
    readonly language: "php" | "javascript" | "typescript";
    readonly path: string;
    readonly content_sha256: string;
    readonly bytes: Uint8Array;
  }[];
  readonly validated_at: string;
}): SourceOracleValidationReceipt {
  const oracle = validateSourceOracleBytes(input.oracle_bytes);
  if (
    input.oracle_ref.byte_length !== input.oracle_bytes.byteLength ||
    input.oracle_ref.content_digest !== sha256(input.oracle_bytes) ||
    input.corpus_ref.content_digest !== sha256(canonicalJson(input.corpus)) ||
    input.corpus_ref.byte_length !== Buffer.byteLength(canonicalJson(input.corpus), "utf8")
  )
    throw new Error("p03_source_oracle_artifact_ref_mismatch");
  const ordered = (["php", "javascript", "typescript"] as const).map((language) => {
    const fixture = input.fixtures.find((f) => f.language === language);
    const reviewed = oracle.fixtures.find((f) => f.language === language);
    if (fixture === undefined || reviewed === undefined)
      throw new Error("p03_source_oracle_fixture_roster_mismatch");
    validateSourceFixture(reviewed, fixture.bytes);
    validateSourceSemantics(reviewed, fixture.bytes);
    return {
      fixture_id: reviewed.fixture_id,
      language,
      content_ref: fixture.ref,
      content_sha256: reviewed.content_sha256,
    };
  });
  const [php, javascript, typescript] = ordered;
  if (
    input.fixtures.length !== 3 ||
    php === undefined ||
    javascript === undefined ||
    typescript === undefined
  )
    throw new Error("p03_source_oracle_fixture_roster_mismatch");
  const receipt = sealSourceOracleValidationReceipt({
    oracle_ref: input.oracle_ref,
    oracle_sha256: oracle.oracle_sha256,
    review_ref: input.review_ref,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixtures: [php, javascript, typescript],
    corpus_ref: input.corpus_ref,
    corpus_sha256: input.corpus.corpus_sha256,
    expected_cases: projectSourceOracleCases(oracle),
    validated_at: input.validated_at,
  });
  assertSourceOracleReceiptCorrespondence({ ...input, oracle, receipt });
  return receipt;
}

/** Source-derived fixture semantics: AST shape, containment and operand identity, never graph or oracle-fed vertices. */
export function validateSourceSemantics(fixture: SourceFixture, bytes: Uint8Array): void {
  const parser = new Parser();
  parser.setLanguage(
    fixture.language === "javascript"
      ? JavaScript
      : fixture.language === "typescript"
        ? TypeScript.typescript
        : PHP.php
  );
  const rootNode = parser.parse(Buffer.from(bytes).toString("utf8")).rootNode;
  if (rootNode.hasError) throw new Error("P03 source syntax drift");
  type Node = Parser.SyntaxNode;
  const field = (node: Node, key: string): Node => {
    const value = node.childForFieldName(key);
    if (value === null) throw new Error(`P03 AST missing ${key}`);
    return value;
  };
  const at = (node: Node, mark: SourceMark) => node.startPosition.row + 1 === mark.line;
  const named = (node: Node, mark: SourceMark) => node.text === mark.name && at(node, mark);
  const find = (node: Node, predicate: (n: Node) => boolean): Node => {
    const hits = [
      node,
      ...node.descendantsOfType([
        "function_declaration",
        "function_definition",
        "method_definition",
        "class_declaration",
        "if_statement",
        "call_expression",
        "function_call_expression",
        "variable_declarator",
        "assignment_expression",
        "decorator",
        "required_parameter",
        "simple_parameter",
      ]),
    ].filter(predicate);
    const hit = hits[0];
    if (hits.length !== 1 || hit === undefined) throw new Error("P03 source AST relation drift");
    return hit;
  };
  const declaration = (mark: SourceMark) =>
    find(
      rootNode,
      (n) =>
        ["function_declaration", "function_definition", "method_definition"].includes(n.type) &&
        named(field(n, "name"), mark)
    );
  const caller = declaration(fixture.call.caller);
  const callee = declaration(fixture.call.callee);
  if (caller === callee) throw new Error("P03 call caller drift");
  const calls = (node: Node) =>
    node.descendantsOfType(["call_expression", "function_call_expression"]);
  const calleeName = (call: Node) => field(call, "function").text;
  const site = find(
    caller,
    (n) =>
      ["call_expression", "function_call_expression"].includes(n.type) &&
      at(n, fixture.call.site) &&
      calleeName(n) === fixture.call.callee.name
  );
  const guard = find(caller, (n) => n.type === "if_statement" && at(n, fixture.guard.condition));
  const condition = field(guard, "condition");
  const positive = field(guard, fixture.language === "php" ? "body" : "consequence");
  const alternative = field(guard, "alternative");
  const negative =
    alternative.type === "else_clause"
      ? (alternative.childForFieldName("body") ?? alternative.firstNamedChild ?? alternative)
      : alternative;
  const expression =
    condition.type === "parenthesized_expression" ? condition.firstNamedChild : condition;
  if (
    expression?.type !== "binary_expression" ||
    expression.text !== fixture.guard.condition.name ||
    site.startIndex < positive.startIndex ||
    site.endIndex > positive.endIndex
  )
    throw new Error("P03 guard true-branch drift");
  if (
    !positive
      .descendantsOfType(["variable_declarator", "assignment_expression"])
      .some(
        (n) =>
          at(n, fixture.guard.action) &&
          field(n, fixture.language === "php" ? "left" : "name").text === fixture.guard.action.name
      )
  )
    throw new Error("P03 guard action drift");
  const decoy = calls(negative).find(
    (n) => at(n, fixture.guard.negative) && calleeName(n) === fixture.guard.negative.name
  );
  if (
    !decoy ||
    calls(positive).includes(decoy) ||
    fixture.guard.negative_branch !== "false" ||
    fixture.guard.expected_branch !== "true"
  )
    throw new Error("P03 guard false-branch drift");
  const args = field(site, "arguments").namedChildren;
  const sinkArg = fixture.language === "php" ? args[0]?.namedChildren[0] : args[0];
  if (
    sinkArg?.text !== fixture.reaching_definition.sink.name ||
    !at(site, fixture.reaching_definition.sink)
  )
    throw new Error("P03 sink operand drift");
  let previous = fixture.reaching_definition.source.name;
  if (
    !at(caller, fixture.reaching_definition.source) &&
    !caller
      .descendantsOfType("variable_declarator")
      .some((n) => at(n, fixture.reaching_definition.source) && field(n, "name").text === previous)
  )
    throw new Error("P03 source drift");
  for (const mark of fixture.reaching_definition.assignments) {
    const node = find(
      caller,
      (n) =>
        ["variable_declarator", "assignment_expression"].includes(n.type) &&
        at(n, mark) &&
        field(n, fixture.language === "php" ? "left" : "name").text === mark.name
    );
    if (
      field(node, fixture.language === "php" ? "right" : "value").text !== previous ||
      node.startIndex >= site.startIndex
    )
      throw new Error("P03 reaching-definition chain drift");
    previous = mark.name;
  }
  if (
    previous !== sinkArg.text ||
    calleeName(decoy) === fixture.call.callee.name ||
    fixture.call.negative.line !== decoy.startPosition.row + 1
  )
    throw new Error("P03 negative call/chain drift");
  const callback = declaration(fixture.registration.callback);
  const registration =
    fixture.language === "typescript"
      ? find(
          rootNode,
          (n) =>
            n.type === "decorator" &&
            at(n, fixture.registration.site) &&
            n.parent?.type === "class_body" &&
            n.nextNamedSibling === callback &&
            field(n.namedChildren[0] ?? n, "function").text === "Get"
        )
      : find(
          rootNode,
          (n) =>
            ["call_expression", "function_call_expression"].includes(n.type) &&
            at(n, fixture.registration.site) &&
            calleeName(n) === fixture.registration.form
        );
  if (fixture.language !== "typescript") {
    const params = field(registration, "arguments").namedChildren;
    const callbackArg = fixture.language === "php" ? params[1]?.namedChildren[0] : params[1];
    if (
      !callbackArg ||
      (fixture.language === "php" ? callbackArg.text.slice(1, -1) : callbackArg.text) !==
        fixture.registration.callback.name
    )
      throw new Error("P03 registration callback drift");
  }
  if (
    registration.startPosition.row + 1 !== fixture.registration.site.line ||
    fixture.registration.negative.line === fixture.registration.site.line ||
    fixture.registration.negative.name === fixture.registration.callback.name
  )
    throw new Error("P03 registration negative drift");
  if (fixture.language === "typescript") {
    const other = find(
      rootNode,
      (n) => n.type === "decorator" && at(n, fixture.registration.negative)
    );
    if (
      other.nextNamedSibling?.type !== "method_definition" ||
      field(other.nextNamedSibling, "name").text !== "decoyHandler" ||
      other.nextNamedSibling === callback
    )
      throw new Error("P03 registration negative relation drift");
  } else {
    const other = find(
      rootNode,
      (n) =>
        ["call_expression", "function_call_expression"].includes(n.type) &&
        at(n, fixture.registration.negative)
    );
    const args = field(other, "arguments").namedChildren;
    const target =
      fixture.language === "php" ? args[1]?.firstNamedChild?.text.slice(1, -1) : args[1]?.text;
    if (
      calleeName(other) !== fixture.registration.form ||
      target === fixture.registration.callback.name ||
      target !== fixture.registration.negative.name
    )
      throw new Error("P03 registration negative relation drift");
  }
}
