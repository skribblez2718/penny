import path from "node:path";

import { Engine as PhpParserEngine } from "php-parser";
import * as ts from "typescript";

import { canonicalJson, sha256 } from "../canonical-json.js";

const SUPPORTED_SCRIPT_KINDS = new Map<
  string,
  { readonly language: "javascript" | "typescript"; readonly kind: ts.ScriptKind }
>([
  [".cjs", { language: "javascript", kind: ts.ScriptKind.JS }],
  [".cts", { language: "typescript", kind: ts.ScriptKind.TS }],
  [".js", { language: "javascript", kind: ts.ScriptKind.JS }],
  [".jsx", { language: "javascript", kind: ts.ScriptKind.JSX }],
  [".mjs", { language: "javascript", kind: ts.ScriptKind.JS }],
  [".mts", { language: "typescript", kind: ts.ScriptKind.TS }],
  [".ts", { language: "typescript", kind: ts.ScriptKind.TS }],
  [".tsx", { language: "typescript", kind: ts.ScriptKind.TSX }],
]);

const PHP_EXTENSIONS = new Set([".php", ".php3", ".php4", ".php5", ".phtml"]);

export const SCA_PHP_PARSER_NAME = "php-parser";
export const SCA_PHP_PARSER_VERSION = "3.7.0";
export const SCA_PHP_LANGUAGE_VERSION = "8.5";
const PHP_PARSER_ID = `${SCA_PHP_PARSER_NAME}-${SCA_PHP_PARSER_VERSION}-php${SCA_PHP_LANGUAGE_VERSION}`;

export type ScaStructuralLanguage = "javascript" | "typescript" | "php";

export type ScaStructuralParserCapability =
  | {
      readonly status: "available";
      readonly language: ScaStructuralLanguage;
      readonly parser_id: string;
    }
  | {
      readonly status: "not_applicable";
    };

export type ScaStructuralSymbolResolution =
  | {
      readonly status: "resolved";
      readonly language: ScaStructuralLanguage;
      readonly parser_id: string;
      readonly symbol: string;
    }
  | {
      readonly status: "unsupported";
      readonly reason_code:
        | "unsupported_language"
        | "parser_dependency_unavailable"
        | "parser_diagnostics"
        | "unresolvable_symbol";
      readonly detail: string;
    };

export type ScaStructuralWitnessResolution =
  | {
      readonly status: "resolved";
      readonly language: ScaStructuralLanguage;
      readonly parser_id: string;
      readonly symbol: string;
      readonly syntax_kinds: readonly string[];
      readonly has_data_flow_node: boolean;
      readonly has_effect_node: boolean;
    }
  | Extract<ScaStructuralSymbolResolution, { status: "unsupported" }>;

export interface ScaFindingFingerprintV1 {
  readonly schema_version: 1;
  readonly path: string;
  readonly symbol: string;
  readonly vulnerability_class: string;
  readonly sha256: string;
}

interface ParsedScript {
  readonly source: ts.SourceFile;
  readonly language: "javascript" | "typescript";
  readonly parserId: string;
}

interface PhpPosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

interface PhpLocation {
  readonly start: PhpPosition;
  readonly end: PhpPosition;
}

interface PhpAstNode {
  readonly kind: string;
  readonly loc: PhpLocation;
  readonly [key: string]: unknown;
}

interface ParsedPhp {
  readonly root: PhpAstNode;
  readonly parents: ReadonlyMap<PhpAstNode, PhpAstNode | null>;
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface OwnerResolution<TNode> {
  readonly owner: TNode;
  readonly ambiguousLine: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhpPosition(value: unknown): value is PhpPosition {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.line) &&
    typeof value.line === "number" &&
    value.line >= 1 &&
    Number.isSafeInteger(value.column) &&
    typeof value.column === "number" &&
    value.column >= 0 &&
    Number.isSafeInteger(value.offset) &&
    typeof value.offset === "number" &&
    value.offset >= 0
  );
}

function isPhpLocation(value: unknown): value is PhpLocation {
  return (
    isRecord(value) &&
    isPhpPosition(value.start) &&
    isPhpPosition(value.end) &&
    value.end.offset >= value.start.offset
  );
}

function isPhpAstNode(value: unknown): value is PhpAstNode {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    value.kind.length > 0 &&
    isPhpLocation(value.loc)
  );
}

function phpChildNodes(node: PhpAstNode): readonly PhpAstNode[] {
  const children: PhpAstNode[] = [];
  for (const value of Object.values(node)) {
    if (isPhpAstNode(value)) {
      children.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) if (isPhpAstNode(item)) children.push(item);
  }
  return children;
}

function indexPhpTree(root: PhpAstNode): ReadonlyMap<PhpAstNode, PhpAstNode | null> {
  const parents = new Map<PhpAstNode, PhpAstNode | null>();
  const visit = (node: PhpAstNode, parent: PhpAstNode | null): void => {
    if (parents.has(node)) return;
    parents.set(node, parent);
    for (const child of phpChildNodes(node)) visit(child, node);
  };
  visit(root, null);
  return parents;
}

function canonicalPropertyName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function canonicalCalleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (expression.kind === ts.SyntaxKind.SuperKeyword) return "super";
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = canonicalCalleeName(expression.expression);
    return owner === null ? null : `${owner}.${expression.name.text}`;
  }
  if (ts.isElementAccessExpression(expression)) {
    const owner = canonicalCalleeName(expression.expression);
    const argument = expression.argumentExpression;
    if (owner === null || argument === undefined) return null;
    if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
      return `${owner}[${JSON.stringify(argument.text)}]`;
    }
  }
  return null;
}

function encodeIdentityValue(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "~");
}

function typescriptLiteralKey(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return `string:${encodeIdentityValue(expression.text)}`;
  if (ts.isNumericLiteral(expression)) return `number:${encodeIdentityValue(expression.text)}`;
  if (ts.isBigIntLiteral(expression)) return `bigint:${encodeIdentityValue(expression.text)}`;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return "boolean:true";
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return "boolean:false";
  if (expression.kind === ts.SyntaxKind.NullKeyword) return "null";
  return null;
}

function typescriptCallKey(node: ts.CallExpression): string | null {
  const callee = canonicalCalleeName(node.expression);
  if (callee === null) return null;
  const keys = node.arguments.flatMap((argument, index) => {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return [];
    const literal = typescriptLiteralKey(argument);
    return literal === null ? [] : [`arg${index + 1}=${literal}`];
  });
  return keys.length === 0 ? callee : `${callee}[${keys.join(",")}]`;
}

function isTsAnonymousFunction(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || (ts.isFunctionExpression(node) && node.name === undefined);
}

function isTsNamedFunctionOwner(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    (ts.isFunctionExpression(node) && node.name !== undefined)
  );
}

function isTsFunctionOwner(node: ts.Node): boolean {
  return isTsNamedFunctionOwner(node) || isTsAnonymousFunction(node);
}

function isTsPropertyOwner(
  node: ts.Node
): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.PropertyDeclaration {
  return (
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node)
  );
}

function isTsOwnerCandidate(node: ts.Node): boolean {
  return (
    ts.isModuleDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    isTsFunctionOwner(node) ||
    ts.isVariableDeclaration(node) ||
    isTsPropertyOwner(node) ||
    ts.isCallExpression(node)
  );
}

function tsAncestorChain(owner: ts.Node): readonly ts.Node[] {
  const reverse: ts.Node[] = [];
  let current: ts.Node | undefined = owner;
  while (current !== undefined && !ts.isSourceFile(current)) {
    reverse.push(current);
    current = current.parent;
  }
  return reverse.reverse();
}

function tsClassName(node: ts.ClassDeclaration | ts.ClassExpression): string | null {
  const declared = canonicalPropertyName(node.name);
  if (declared !== null) return declared;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return canonicalPropertyName(parent.name);
  }
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  ) {
    return canonicalPropertyName(parent.name);
  }
  return null;
}

function tsAnonymousSegment(node: ts.ArrowFunction | ts.FunctionExpression): string | null {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return null;
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  ) {
    return null;
  }
  if (ts.isCallExpression(parent)) {
    const argumentIndex = parent.arguments.findIndex((argument) => argument === node);
    const callKey = typescriptCallKey(parent);
    return argumentIndex < 0 || callKey === null
      ? null
      : `callback:${callKey}:arg${argumentIndex + 1}`;
  }
  return null;
}

function buildTsIdentity(owner: ts.Node): string | null {
  const chain = tsAncestorChain(owner);
  const namesStructuralDescendant = chain.some(
    (node) => isTsAnonymousFunction(node) || (ts.isClassExpression(node) && node.name === undefined)
  );
  const needsNamingChain =
    namesStructuralDescendant ||
    ts.isVariableDeclaration(owner) ||
    isTsPropertyOwner(owner) ||
    ts.isCallExpression(owner);
  const segments: string[] = [];
  for (const node of chain) {
    if (ts.isModuleDeclaration(node)) {
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`namespace:${name}`);
      continue;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = tsClassName(node);
      if (name === null) return null;
      segments.push(`class:${name}`);
      continue;
    }
    if (ts.isFunctionDeclaration(node)) {
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`function:${name}`);
      continue;
    }
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`method:${name}`);
      continue;
    }
    if (ts.isGetAccessorDeclaration(node)) {
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`getter:${name}`);
      continue;
    }
    if (ts.isSetAccessorDeclaration(node)) {
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`setter:${name}`);
      continue;
    }
    if (ts.isConstructorDeclaration(node)) {
      segments.push("constructor");
      continue;
    }
    if (ts.isFunctionExpression(node) && node.name !== undefined) {
      segments.push(`function:${node.name.text}`);
      continue;
    }
    if (ts.isVariableDeclaration(node) && (node === owner || needsNamingChain)) {
      if (
        node.initializer !== undefined &&
        ts.isClassExpression(node.initializer) &&
        node.initializer === owner
      )
        continue;
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`binding:${name}`);
      continue;
    }
    if (isTsPropertyOwner(node) && (node === owner || needsNamingChain)) {
      const name = canonicalPropertyName(node.name);
      if (name === null) return null;
      segments.push(`property:${name}`);
      continue;
    }
    if (isTsAnonymousFunction(node)) {
      const segment = tsAnonymousSegment(node);
      if (segment !== null) segments.push(segment);
      else if (
        !(
          (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) ||
          ((ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent)) &&
            node.parent.initializer === node)
        )
      ) {
        return null;
      }
      continue;
    }
    if (ts.isCallExpression(node) && node === owner) {
      const callKey = typescriptCallKey(node);
      if (callKey === null) return null;
      segments.push(`call:${callKey}`);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}

function containsTsPosition(node: ts.Node, source: ts.SourceFile, position: number): boolean {
  return node.getStart(source, false) <= position && position < node.getEnd();
}

function tsPathAtPosition(source: ts.SourceFile, position: number): readonly ts.Node[] {
  let result: readonly ts.Node[] = [];
  const visit = (node: ts.Node, ancestors: readonly ts.Node[]): boolean => {
    if (!containsTsPosition(node, source, position)) return false;
    const next = [...ancestors, node];
    result = next;
    let foundChild = false;
    node.forEachChild((child) => {
      if (!foundChild && visit(child, next)) foundChild = true;
    });
    return true;
  };
  visit(source, []);
  return result;
}

function nodeIntersectsRange(start: number, end: number, range: SourceRange): boolean {
  return end > range.start && start < range.end;
}

function anonymousTsFunctionsOnLine(
  source: ts.SourceFile,
  range: SourceRange,
  containingOwner: ts.Node | undefined
): readonly (ts.ArrowFunction | ts.FunctionExpression)[] {
  const matches: Array<ts.ArrowFunction | ts.FunctionExpression> = [];
  const visit = (node: ts.Node): void => {
    const start = node.getStart(source, false);
    const end = node.getEnd();
    if (!nodeIntersectsRange(start, end, range)) return;
    if (
      isTsAnonymousFunction(node) &&
      (containingOwner === undefined ||
        (containingOwner.getStart(source, false) <= start && end <= containingOwner.getEnd())) &&
      buildTsIdentity(node) !== null
    ) {
      matches.push(node);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return matches;
}

function resolveTsOwner(
  source: ts.SourceFile,
  pathNodes: readonly ts.Node[],
  lineRange: SourceRange
): OwnerResolution<ts.Node> | null {
  const containingFunction = [...pathNodes].reverse().find(isTsFunctionOwner);
  const anonymousOnLine = anonymousTsFunctionsOnLine(source, lineRange, containingFunction);
  if (anonymousOnLine.length === 1) {
    const owner = anonymousOnLine[0];
    if (owner !== undefined) return { owner, ambiguousLine: false };
  }
  if (anonymousOnLine.length > 1) {
    const owner = anonymousOnLine[0];
    if (owner !== undefined) return { owner, ambiguousLine: true };
  }
  if (containingFunction !== undefined) return { owner: containingFunction, ambiguousLine: false };
  const owner = [...pathNodes].reverse().find(isTsOwnerCandidate);
  return owner === undefined ? null : { owner, ambiguousLine: false };
}

function tsIdentityNeedsUniqueness(owner: ts.Node): boolean {
  return (
    isTsAnonymousFunction(owner) ||
    ts.isVariableDeclaration(owner) ||
    isTsPropertyOwner(owner) ||
    ts.isCallExpression(owner)
  );
}

function tsIdentityIsAmbiguous(source: ts.SourceFile, owner: ts.Node, symbol: string): boolean {
  if (!tsIdentityNeedsUniqueness(owner)) return false;
  const comparable = (node: ts.Node): boolean => {
    if (isTsAnonymousFunction(owner)) return isTsAnonymousFunction(node);
    if (ts.isVariableDeclaration(owner)) return ts.isVariableDeclaration(node);
    if (isTsPropertyOwner(owner)) return isTsPropertyOwner(node);
    return ts.isCallExpression(owner) && ts.isCallExpression(node);
  };
  let matches = 0;
  const visit = (node: ts.Node): void => {
    if (comparable(node) && buildTsIdentity(node) === symbol) matches += 1;
    node.forEachChild(visit);
  };
  visit(source);
  return matches !== 1;
}

function firstCodePosition(source: ts.SourceFile, line: number): number {
  const starts = source.getLineStarts();
  const start = starts[line - 1];
  if (start === undefined) return -1;
  const next = starts[line] ?? source.getEnd();
  let position = start;
  while (position < next) {
    const code = source.text.charCodeAt(position);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) return position;
    position += 1;
  }
  return start;
}

function tsLineRange(source: ts.SourceFile, line: number): SourceRange | null {
  const starts = source.getLineStarts();
  const start = starts[line - 1];
  if (start === undefined) return null;
  return { start, end: starts[line] ?? source.getEnd() };
}

function parserDiagnosticDetail(diagnostics: readonly ts.Diagnostic[]): string {
  const first = diagnostics[0];
  if (first === undefined) return "The structural parser rejected the source.";
  const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
  return `The structural parser reported diagnostic TS${first.code}: ${message}`;
}

function parseScript(input: {
  readonly path: string;
  readonly source: string;
}):
  | { readonly status: "parsed"; readonly value: ParsedScript }
  | Extract<ScaStructuralSymbolResolution, { status: "unsupported" }> {
  const extension = path.posix.extname(input.path).toLowerCase();
  const support = SUPPORTED_SCRIPT_KINDS.get(extension);
  if (support === undefined) {
    return {
      status: "unsupported",
      reason_code: "unsupported_language",
      detail: `No qualified structural parser is active for '${extension || "extensionless"}' source.`,
    };
  }
  const source = ts.createSourceFile(
    input.path,
    input.source,
    ts.ScriptTarget.Latest,
    true,
    support.kind
  );
  const transpiled = ts.transpileModule(input.source, {
    fileName: input.path,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.Latest,
    },
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    return {
      status: "unsupported",
      reason_code: "parser_diagnostics",
      detail: parserDiagnosticDetail(diagnostics),
    };
  }
  return {
    status: "parsed",
    value: {
      source,
      language: support.language,
      parserId: `typescript-${ts.version}`,
    },
  };
}

function phpDiagnosticDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "The PHP parser rejected the source.";
  return `The PHP structural parser reported a diagnostic: ${message}`;
}

function parsePhp(input: {
  readonly path: string;
  readonly source: string;
}):
  | { readonly status: "parsed"; readonly value: ParsedPhp }
  | Extract<ScaStructuralSymbolResolution, { status: "unsupported" }> {
  try {
    const parser = new PhpParserEngine({
      parser: { suppressErrors: false, version: SCA_PHP_LANGUAGE_VERSION },
      ast: { withPositions: true },
    });
    const parsed: unknown = parser.parseCode(input.source, input.path);
    if (!isPhpAstNode(parsed) || parsed.kind !== "program") {
      return {
        status: "unsupported",
        reason_code: "parser_diagnostics",
        detail: "The PHP structural parser returned a malformed program AST.",
      };
    }
    const errors = parsed.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return {
        status: "unsupported",
        reason_code: "parser_diagnostics",
        detail: "The PHP structural parser returned one or more program diagnostics.",
      };
    }
    return {
      status: "parsed",
      value: { root: parsed, parents: indexPhpTree(parsed) },
    };
  } catch (error) {
    return {
      status: "unsupported",
      reason_code: "parser_diagnostics",
      detail: phpDiagnosticDetail(error),
    };
  }
}

function resolveSymbolFromParsedScript(input: {
  readonly parsed: ParsedScript;
  readonly line: number;
}): ScaStructuralSymbolResolution {
  const { source } = input.parsed;
  const lineRange = tsLineRange(source, input.line);
  if (lineRange === null) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail: "The identity citation line is outside the parsed source.",
    };
  }
  const position = firstCodePosition(source, input.line);
  const pathNodes = tsPathAtPosition(source, position);
  let owner = resolveTsOwner(source, pathNodes, lineRange);
  if (owner === null) {
    let fallback: ts.Node | null = null;
    const visit = (node: ts.Node): void => {
      const start = node.getStart(source, false);
      if (start >= lineRange.start && start < lineRange.end && isTsOwnerCandidate(node)) {
        fallback = node;
      }
      node.forEachChild(visit);
    };
    visit(source);
    if (fallback !== null) owner = { owner: fallback, ambiguousLine: false };
  }
  if (owner === null || owner.ambiguousLine) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail:
        owner?.ambiguousLine === true
          ? "The cited line contains multiple anonymous scopes without one unambiguous stable owner."
          : "The cited location has no stable named or structural scope; module fallback identities are prohibited.",
    };
  }
  const symbol = buildTsIdentity(owner.owner);
  if (symbol === null || tsIdentityIsAmbiguous(source, owner.owner, symbol)) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail:
        symbol === null
          ? "The cited location has no stable named or structural scope; module fallback identities are prohibited."
          : "The cited anonymous or structural scope does not have a unique stable source-level owner.",
    };
  }
  return {
    status: "resolved",
    language: input.parsed.language,
    parser_id: input.parsed.parserId,
    symbol,
  };
}

function phpNodeName(node: PhpAstNode): string | null {
  const name = node.name;
  if (typeof name === "string" && name.length > 0) return name;
  if (isRecord(name) && typeof name.name === "string" && name.name.length > 0) return name.name;
  return null;
}

function phpVariableName(value: unknown): string | null {
  if (!isPhpAstNode(value) || value.kind !== "variable") return null;
  return typeof value.name === "string" && value.name.length > 0 ? `$${value.name}` : null;
}

function phpCalleeName(value: unknown): string | null {
  if (!isPhpAstNode(value)) return null;
  if (value.kind === "name" || value.kind === "identifier") return phpNodeName(value);
  if (value.kind === "variable") return phpVariableName(value);
  if (
    value.kind === "propertylookup" ||
    value.kind === "nullsafepropertylookup" ||
    value.kind === "staticlookup"
  ) {
    const owner = phpCalleeName(value.what);
    const offset = value.offset;
    const member = isPhpAstNode(offset) ? (phpNodeName(offset) ?? phpVariableName(offset)) : null;
    return owner === null || member === null ? null : `${owner}.${member}`;
  }
  return null;
}

function phpLiteralKey(value: unknown): string | null {
  if (!isPhpAstNode(value)) return null;
  if (value.kind === "string" && typeof value.value === "string") {
    return `string:${encodeIdentityValue(value.value)}`;
  }
  if (
    value.kind === "number" &&
    (typeof value.value === "number" || typeof value.value === "string")
  ) {
    return `number:${encodeIdentityValue(String(value.value))}`;
  }
  if (value.kind === "boolean" && typeof value.value === "boolean") {
    return `boolean:${value.value ? "true" : "false"}`;
  }
  if (value.kind === "nullkeyword") return "null";
  return null;
}

function phpCallKey(node: PhpAstNode): string | null {
  if (node.kind !== "call") return null;
  const callee = phpCalleeName(node.what);
  if (callee === null) return null;
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  const keys = args.flatMap((argument, index) => {
    if (isPhpAstNode(argument) && (argument.kind === "closure" || argument.kind === "arrowfunc")) {
      return [];
    }
    const literal = phpLiteralKey(argument);
    return literal === null ? [] : [`arg${index + 1}=${literal}`];
  });
  return keys.length === 0 ? callee : `${callee}[${keys.join(",")}]`;
}

function isPhpAnonymousFunction(node: PhpAstNode): boolean {
  return node.kind === "closure" || node.kind === "arrowfunc";
}

function isPhpNamedFunctionOwner(node: PhpAstNode): boolean {
  return node.kind === "function" || node.kind === "method";
}

function isPhpFunctionOwner(node: PhpAstNode): boolean {
  return isPhpNamedFunctionOwner(node) || isPhpAnonymousFunction(node);
}

function isPhpClassOwner(node: PhpAstNode): boolean {
  return ["class", "interface", "trait", "enum"].includes(node.kind);
}

function isPhpOwnerCandidate(node: PhpAstNode): boolean {
  return (
    node.kind === "namespace" ||
    isPhpClassOwner(node) ||
    isPhpFunctionOwner(node) ||
    node.kind === "assign" ||
    node.kind === "assignref" ||
    node.kind === "property" ||
    node.kind === "call"
  );
}

function phpAncestorChain(
  owner: PhpAstNode,
  parents: ReadonlyMap<PhpAstNode, PhpAstNode | null>
): readonly PhpAstNode[] {
  const reverse: PhpAstNode[] = [];
  let current: PhpAstNode | null | undefined = owner;
  while (current !== null && current !== undefined && current.kind !== "program") {
    reverse.push(current);
    current = parents.get(current);
  }
  return reverse.reverse();
}

function phpAnonymousSegment(
  node: PhpAstNode,
  parents: ReadonlyMap<PhpAstNode, PhpAstNode | null>
): string | null {
  const parent = parents.get(node);
  if (parent === undefined || parent === null) return null;
  if ((parent.kind === "assign" || parent.kind === "assignref") && parent.right === node) {
    const variable = phpVariableName(parent.left);
    return variable === null ? null : `callback:${variable}`;
  }
  if (parent.kind === "property" && parent.value === node) {
    const name = phpNodeName(parent);
    return name === null ? null : `callback:${name}`;
  }
  if (parent.kind === "entry" && parent.value === node) {
    const key = phpLiteralKey(parent.key);
    return key === null ? null : `callback:key:${key}`;
  }
  if (parent.kind === "call" && Array.isArray(parent.arguments)) {
    const index = parent.arguments.findIndex((argument) => argument === node);
    const callKey = phpCallKey(parent);
    return index < 0 || callKey === null ? null : `callback:${callKey}:arg${index + 1}`;
  }
  return null;
}

function buildPhpIdentity(
  owner: PhpAstNode,
  parents: ReadonlyMap<PhpAstNode, PhpAstNode | null>
): string | null {
  const chain = phpAncestorChain(owner, parents);
  const segments: string[] = [];
  for (const node of chain) {
    if (node.kind === "namespace") {
      const name = phpNodeName(node);
      if (name === null) return null;
      segments.push(`namespace:${name}`);
      continue;
    }
    if (isPhpClassOwner(node)) {
      const name = phpNodeName(node);
      if (name === null) return null;
      segments.push(`${node.kind}:${name}`);
      continue;
    }
    if (node.kind === "function") {
      const name = phpNodeName(node);
      if (name === null) return null;
      segments.push(`function:${name}`);
      continue;
    }
    if (node.kind === "method") {
      const name = phpNodeName(node);
      if (name === null) return null;
      segments.push(`method:${name}`);
      continue;
    }
    if (isPhpAnonymousFunction(node)) {
      const segment = phpAnonymousSegment(node, parents);
      if (segment === null) return null;
      segments.push(segment);
      continue;
    }
    if ((node.kind === "assign" || node.kind === "assignref") && node === owner) {
      const variable = phpVariableName(node.left);
      if (variable === null) return null;
      segments.push(`binding:${variable}`);
      continue;
    }
    if (node.kind === "property" && node === owner) {
      const name = phpNodeName(node);
      if (name === null) return null;
      segments.push(`property:${name}`);
      continue;
    }
    if (node.kind === "call" && node === owner) {
      const callKey = phpCallKey(node);
      if (callKey === null) return null;
      segments.push(`call:${callKey}`);
    }
  }
  return segments.length === 0 ? null : segments.join("/");
}

function phpPathAtPosition(root: PhpAstNode, position: number): readonly PhpAstNode[] {
  let result: readonly PhpAstNode[] = [];
  const visit = (node: PhpAstNode, ancestors: readonly PhpAstNode[]): boolean => {
    if (!(node.loc.start.offset <= position && position < node.loc.end.offset)) return false;
    const next = [...ancestors, node];
    result = next;
    let foundChild = false;
    for (const child of phpChildNodes(node)) {
      if (!foundChild && visit(child, next)) foundChild = true;
    }
    return true;
  };
  visit(root, []);
  return result;
}

function phpAnonymousFunctionsOnLine(
  root: PhpAstNode,
  range: SourceRange,
  containingOwner: PhpAstNode | undefined,
  parents: ReadonlyMap<PhpAstNode, PhpAstNode | null>
): readonly PhpAstNode[] {
  const matches: PhpAstNode[] = [];
  const visit = (node: PhpAstNode): void => {
    if (!nodeIntersectsRange(node.loc.start.offset, node.loc.end.offset, range)) return;
    if (
      isPhpAnonymousFunction(node) &&
      (containingOwner === undefined ||
        (containingOwner.loc.start.offset <= node.loc.start.offset &&
          node.loc.end.offset <= containingOwner.loc.end.offset)) &&
      buildPhpIdentity(node, parents) !== null
    ) {
      matches.push(node);
    }
    for (const child of phpChildNodes(node)) visit(child);
  };
  visit(root);
  return matches;
}

function resolvePhpOwner(
  parsed: ParsedPhp,
  pathNodes: readonly PhpAstNode[],
  lineRange: SourceRange
): OwnerResolution<PhpAstNode> | null {
  const containingFunction = [...pathNodes].reverse().find(isPhpFunctionOwner);
  const anonymousOnLine = phpAnonymousFunctionsOnLine(
    parsed.root,
    lineRange,
    containingFunction,
    parsed.parents
  );
  if (anonymousOnLine.length === 1) {
    const owner = anonymousOnLine[0];
    if (owner !== undefined) return { owner, ambiguousLine: false };
  }
  if (anonymousOnLine.length > 1) {
    const owner = anonymousOnLine[0];
    if (owner !== undefined) return { owner, ambiguousLine: true };
  }
  if (containingFunction !== undefined) return { owner: containingFunction, ambiguousLine: false };
  const owner = [...pathNodes].reverse().find(isPhpOwnerCandidate);
  return owner === undefined ? null : { owner, ambiguousLine: false };
}

function phpIdentityNeedsUniqueness(owner: PhpAstNode): boolean {
  return (
    isPhpAnonymousFunction(owner) ||
    owner.kind === "assign" ||
    owner.kind === "assignref" ||
    owner.kind === "property" ||
    owner.kind === "call"
  );
}

function phpIdentityIsAmbiguous(parsed: ParsedPhp, owner: PhpAstNode, symbol: string): boolean {
  if (!phpIdentityNeedsUniqueness(owner)) return false;
  let matches = 0;
  const visit = (node: PhpAstNode): void => {
    if (isPhpOwnerCandidate(node) && buildPhpIdentity(node, parsed.parents) === symbol)
      matches += 1;
    for (const child of phpChildNodes(node)) visit(child);
  };
  visit(parsed.root);
  return matches !== 1;
}

function sourceLineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 0x0d) {
      if (source.charCodeAt(index + 1) === 0x0a) index += 1;
      starts.push(index + 1);
    } else if (code === 0x0a) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function sourceLineRange(source: string, line: number): SourceRange | null {
  const starts = sourceLineStarts(source);
  const start = starts[line - 1];
  if (start === undefined) return null;
  return { start, end: starts[line] ?? source.length };
}

function firstSourceCodePosition(source: string, range: SourceRange): number {
  let position = range.start;
  while (position < range.end) {
    const code = source.charCodeAt(position);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d && code !== 0x0a) return position;
    position += 1;
  }
  return range.start;
}

function resolveSymbolFromParsedPhp(input: {
  readonly parsed: ParsedPhp;
  readonly source: string;
  readonly line: number;
}): ScaStructuralSymbolResolution {
  const lineRange = sourceLineRange(input.source, input.line);
  if (lineRange === null) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail: "The identity citation line is outside the parsed source.",
    };
  }
  const position = firstSourceCodePosition(input.source, lineRange);
  const pathNodes = phpPathAtPosition(input.parsed.root, position);
  let owner = resolvePhpOwner(input.parsed, pathNodes, lineRange);
  if (owner === null || (owner.owner.kind === "program" && pathNodes.length === 1)) {
    let fallback: PhpAstNode | null = null;
    const visit = (node: PhpAstNode): void => {
      if (node.loc.start.line === input.line && isPhpOwnerCandidate(node)) fallback = node;
      for (const child of phpChildNodes(node)) visit(child);
    };
    visit(input.parsed.root);
    if (fallback !== null) owner = { owner: fallback, ambiguousLine: false };
  }
  if (owner === null || owner.ambiguousLine) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail:
        owner?.ambiguousLine === true
          ? "The cited line contains multiple anonymous scopes without one unambiguous stable owner."
          : "The cited location has no stable named or structural scope; module fallback identities are prohibited.",
    };
  }
  const symbol = buildPhpIdentity(owner.owner, input.parsed.parents);
  if (symbol === null || phpIdentityIsAmbiguous(input.parsed, owner.owner, symbol)) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail:
        symbol === null
          ? "The cited location has no stable named or structural scope; module fallback identities are prohibited."
          : "The cited anonymous or structural scope does not have a unique stable source-level owner.",
    };
  }
  return {
    status: "resolved",
    language: "php",
    parser_id: PHP_PARSER_ID,
    symbol,
  };
}

function tsNodeContainedInRange(
  node: ts.Node,
  source: ts.SourceFile,
  start: number,
  end: number
): boolean {
  return node.getStart(source, false) >= start && node.getEnd() <= end;
}

function isDataFlowNode(node: ts.Node): boolean {
  return (
    ts.isIdentifier(node) ||
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isReturnStatement(node)
  );
}

function isEffectNode(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isDeleteExpression(node) ||
    ts.isThrowStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isTaggedTemplateExpression(node)
  ) {
    return true;
  }
  if (!ts.isBinaryExpression(node)) return false;
  return (
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

const PHP_DATA_FLOW_KINDS = new Set([
  "variable",
  "parameter",
  "propertylookup",
  "nullsafepropertylookup",
  "staticlookup",
  "offsetlookup",
  "call",
  "new",
  "return",
]);

const PHP_EFFECT_KINDS = new Set([
  "call",
  "new",
  "assign",
  "assignref",
  "yield",
  "yieldfrom",
  "throw",
  "return",
  "echo",
  "print",
  "eval",
  "include",
  "exit",
  "unset",
]);

function resolveScriptWitness(input: {
  readonly parsed: ParsedScript;
  readonly start_line: number;
  readonly end_line: number;
}): ScaStructuralWitnessResolution {
  const symbol = resolveSymbolFromParsedScript({ parsed: input.parsed, line: input.start_line });
  if (symbol.status === "unsupported") return symbol;
  const starts = input.parsed.source.getLineStarts();
  const start = firstCodePosition(input.parsed.source, input.start_line);
  const end = starts[input.end_line] ?? input.parsed.source.getEnd();
  if (start < 0 || input.end_line < input.start_line || input.end_line > starts.length) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail: "The structural witness range is outside the parsed source.",
    };
  }
  const syntaxKinds = new Set<string>();
  let hasDataFlowNode = false;
  let hasEffectNode = false;
  const visit = (node: ts.Node): void => {
    if (
      !nodeIntersectsRange(node.getStart(input.parsed.source, false), node.getEnd(), { start, end })
    ) {
      return;
    }
    if (tsNodeContainedInRange(node, input.parsed.source, start, end)) {
      const kind = ts.SyntaxKind[node.kind];
      if (kind !== undefined) syntaxKinds.add(kind);
      if (isDataFlowNode(node)) hasDataFlowNode = true;
      if (isEffectNode(node)) hasEffectNode = true;
    }
    node.forEachChild(visit);
  };
  visit(input.parsed.source);
  return {
    status: "resolved",
    language: symbol.language,
    parser_id: symbol.parser_id,
    symbol: symbol.symbol,
    syntax_kinds: [...syntaxKinds].sort((left, right) => left.localeCompare(right)),
    has_data_flow_node: hasDataFlowNode,
    has_effect_node: hasEffectNode,
  };
}

function resolvePhpWitness(input: {
  readonly parsed: ParsedPhp;
  readonly source: string;
  readonly start_line: number;
  readonly end_line: number;
}): ScaStructuralWitnessResolution {
  const symbol = resolveSymbolFromParsedPhp({
    parsed: input.parsed,
    source: input.source,
    line: input.start_line,
  });
  if (symbol.status === "unsupported") return symbol;
  const startRange = sourceLineRange(input.source, input.start_line);
  const endRange = sourceLineRange(input.source, input.end_line);
  if (startRange === null || endRange === null || input.end_line < input.start_line) {
    return {
      status: "unsupported",
      reason_code: "unresolvable_symbol",
      detail: "The structural witness range is outside the parsed source.",
    };
  }
  const range = { start: firstSourceCodePosition(input.source, startRange), end: endRange.end };
  const syntaxKinds = new Set<string>();
  let hasDataFlowNode = false;
  let hasEffectNode = false;
  const visit = (node: PhpAstNode): void => {
    if (!nodeIntersectsRange(node.loc.start.offset, node.loc.end.offset, range)) return;
    if (node.loc.start.offset >= range.start && node.loc.end.offset <= range.end) {
      syntaxKinds.add(node.kind);
      if (PHP_DATA_FLOW_KINDS.has(node.kind)) hasDataFlowNode = true;
      if (PHP_EFFECT_KINDS.has(node.kind)) hasEffectNode = true;
    }
    for (const child of phpChildNodes(node)) visit(child);
  };
  visit(input.parsed.root);
  return {
    status: "resolved",
    language: "php",
    parser_id: PHP_PARSER_ID,
    symbol: symbol.symbol,
    syntax_kinds: [...syntaxKinds].sort((left, right) => left.localeCompare(right)),
    has_data_flow_node: hasDataFlowNode,
    has_effect_node: hasEffectNode,
  };
}

export function scaStructuralParserCapability(pathValue: string): ScaStructuralParserCapability {
  const extension = path.posix.extname(pathValue).toLowerCase();
  const support = SUPPORTED_SCRIPT_KINDS.get(extension);
  if (support !== undefined) {
    return {
      status: "available",
      language: support.language,
      parser_id: `typescript-${ts.version}`,
    };
  }
  if (PHP_EXTENSIONS.has(extension)) {
    return { status: "available", language: "php", parser_id: PHP_PARSER_ID };
  }
  return { status: "not_applicable" };
}

/** Resolve a citation to a parser-owned structural symbol; no regex or line-derived identity is used. */
export function resolveScaStructuralSymbol(input: {
  readonly path: string;
  readonly source: string;
  readonly line: number;
}): ScaStructuralSymbolResolution {
  const extension = path.posix.extname(input.path).toLowerCase();
  if (PHP_EXTENSIONS.has(extension)) {
    const parsed = parsePhp(input);
    if (parsed.status === "unsupported") return parsed;
    return resolveSymbolFromParsedPhp({
      parsed: parsed.value,
      source: input.source,
      line: input.line,
    });
  }
  const parsed = parseScript(input);
  if (parsed.status === "unsupported") return parsed;
  return resolveSymbolFromParsedScript({ parsed: parsed.value, line: input.line });
}

/** Resolve generic parser witnesses from syntax wholly contained in one quoted source range. */
export function resolveScaStructuralWitness(input: {
  readonly path: string;
  readonly source: string;
  readonly start_line: number;
  readonly end_line: number;
}): ScaStructuralWitnessResolution {
  const extension = path.posix.extname(input.path).toLowerCase();
  if (PHP_EXTENSIONS.has(extension)) {
    const parsed = parsePhp(input);
    if (parsed.status === "unsupported") return parsed;
    return resolvePhpWitness({
      parsed: parsed.value,
      source: input.source,
      start_line: input.start_line,
      end_line: input.end_line,
    });
  }
  const parsed = parseScript(input);
  if (parsed.status === "unsupported") return parsed;
  return resolveScriptWitness({
    parsed: parsed.value,
    start_line: input.start_line,
    end_line: input.end_line,
  });
}

/** Canonical repository-relative path normalization used only after admission validation. */
export function normalizeScaFindingPath(value: string): string {
  const normalized = value.normalize("NFC");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    throw new Error(`SCA finding path '${value}' is not canonical repository-relative input`);
  }
  return normalized;
}

/** Stable identity: normalized path + parser-resolved symbol + vulnerability class, and nothing else. */
export function createScaFindingFingerprint(input: {
  readonly path: string;
  readonly symbol: string;
  readonly vulnerability_class: string;
}): ScaFindingFingerprintV1 {
  const normalizedPath = normalizeScaFindingPath(input.path);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(input.vulnerability_class)) {
    throw new Error("SCA vulnerability class is not a canonical identifier");
  }
  if (input.symbol.length === 0 || input.symbol.length > 1_024) {
    throw new Error("SCA structural symbol is empty or oversized");
  }
  const identity = {
    path: normalizedPath,
    symbol: input.symbol,
    vulnerability_class: input.vulnerability_class,
  };
  return {
    schema_version: 1,
    ...identity,
    sha256: sha256(canonicalJson(identity)),
  };
}
