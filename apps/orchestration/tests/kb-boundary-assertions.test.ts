import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const KB_COHORT = [
  "ingest",
  "promotion",
  "generations",
  "content-review",
  "run-artifacts",
  "operation-receipts",
  "session-tools",
  "profile-grants",
  "gate",
  "save-claim",
  "query-reader",
  "owner-sqlite",
  "capabilities",
  "approval-receipts",
  "workflows",
  "save-evidence-reader",
  "promotion-reader",
  "profile-registry",
  "ingest-plane",
  "promote",
  "parent-delivery",
  "kb-model-client",
  "gate-decisions",
  "filesystem",
  "core-read",
] as const;

const KB_SOURCE_DIRECTORY = fileURLToPath(new URL("../src/kb/", import.meta.url));
const COHORT_FILES = KB_COHORT.map((name) => `${KB_SOURCE_DIRECTORY}/${name}.ts`);

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${start.line + 1}:${start.character + 1}`;
}

function unsafeTypeFindings(): string[] {
  const program = ts.createProgram({
    rootNames: COHORT_FILES,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
  });
  const checker = program.getTypeChecker();
  const findings: string[] = [];

  for (const file of COHORT_FILES) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      findings.push(`${file}: source file is absent from the TypeScript program`);
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        findings.push(`${location(sourceFile, node)} explicit any`);
      }
      if (ts.isNonNullExpression(node)) {
        findings.push(`${location(sourceFile, node)} postfix non-null assertion`);
      }
      if (
        (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
        node.exclamationToken !== undefined
      ) {
        findings.push(`${location(sourceFile, node.exclamationToken)} definite assignment`);
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const source = checker.getTypeAtLocation(node.expression);
        const target = checker.getTypeFromTypeNode(node.type);
        if (
          (source.flags & ts.TypeFlags.Any) !== 0 ||
          (target.flags & ts.TypeFlags.Any) !== 0 ||
          !checker.isTypeAssignableTo(source, target)
        ) {
          findings.push(`${location(sourceFile, node)} unsafe type assertion`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const text = readFileSync(file, "utf8");
    if (/@ts-(?:nocheck|ignore|expect-error)\b/u.test(text)) {
      findings.push(`${file}: TypeScript suppression directive`);
    }
    if (/eslint-disable/u.test(text)) {
      findings.push(`${file}: ESLint suppression directive`);
    }
  }
  return findings;
}

describe("TS-240 orchestration KB assertion boundary cohort", () => {
  it("contains no unsafe assertions, any, non-null assertions, or suppressions", () => {
    expect(unsafeTypeFindings()).toEqual([]);
  });
});
