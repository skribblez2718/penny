import { readFileSync, readdirSync } from "node:fs";

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  InputArtifactsSchema,
  OutputArtifactMetadataSchema,
  validateContract,
} from "../dist/contracts.js";

// Only publication metadata is independent. The complete structural contract must be
// exactly the runtime schema's JSON projection, not a hand-maintained third shape.
const documents = [
  {
    name: "artifact-ref",
    title: "Immutable artifact communication ref v2",
    schema: ArtifactRefSchema,
  },
  {
    name: "input-artifacts",
    title: "Exact cross-run input artifacts v2",
    schema: InputArtifactsSchema,
  },
  {
    name: "output-artifact",
    title: "Output artifact lineage metadata v2",
    schema: OutputArtifactMetadataSchema,
  },
];

const ref = {
  schema_version: 2,
  artifact_id: `art_${"a".repeat(64)}`,
  run_id: "schema-test",
  phase: "testing",
  branch_id: null,
  kind: "agent-output",
  operation_id: "operation-test",
  version: 1,
  producer: "test",
  media_type: "application/json",
  content_schema: { schema_id: "penny.schema-test.v1", schema_version: 1 },
  byte_length: 0,
  content_digest: "b".repeat(64),
  store_ref: `artifact://sha256/${"b".repeat(64)}`,
};

const output = {
  schema_version: 2,
  run_id: ref.run_id,
  phase: ref.phase,
  branch_id: null,
  kind: ref.kind,
  operation_id: ref.operation_id,
  version: 1,
  producer: ref.producer,
  media_type: ref.media_type,
  content_schema: ref.content_schema,
  parent_ref: null,
  domain_revision_parent_ref: ref,
  upstream_refs: [ref],
};

function publishedSchema(name: string): TSchema {
  const value: unknown = JSON.parse(
    readFileSync(new URL(`../schemas/artifacts/v2/${name}.schema.json`, import.meta.url), "utf8")
  );
  // Validate the generic document container before using it as a schema. Exact
  // equality below is the authority for its full shape; this is not a copied contract.
  return validateContract(Type.Record(Type.String(), Type.Unknown()), value, "schema document");
}

function both(schema: TSchema, document: TSchema, value: unknown, accepted: boolean): void {
  expect(Value.Check(schema, value)).toBe(accepted);
  expect(Value.Check(document, value)).toBe(accepted);
}

describe("artifact schema documents cannot drift from runtime contracts", () => {
  it("requires a runtime source for every retained artifact schema document", () => {
    const retained = readdirSync(new URL("../schemas/artifacts/v2/", import.meta.url))
      .filter((name) => name.endsWith(".schema.json"))
      .sort();
    expect(retained).toEqual(documents.map(({ name }) => `${name}.schema.json`).sort());
  });

  it.each(documents)("publishes the exact $name runtime schema", ({ name, title, schema }) => {
    const expected: unknown = JSON.parse(
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `urn:penny:orchestration:artifacts:${name}:2`,
        title,
        ...schema,
      })
    );
    expect(publishedSchema(name)).toEqual(expected);
  });

  it("accepts content_schema at top level and every nested artifact reference", () => {
    both(ArtifactRefSchema, publishedSchema("artifact-ref"), ref, true);
    both(
      InputArtifactsSchema,
      publishedSchema("input-artifacts"),
      { schema_version: 2, artifacts: [{ slot: "input-test", ref }] },
      true
    );
    both(OutputArtifactMetadataSchema, publishedSchema("output-artifact"), output, true);
    both(
      OutputArtifactMetadataSchema,
      publishedSchema("output-artifact"),
      { ...output, domain_revision_parent_ref: null },
      true
    );
    const { content_schema: _contentSchema, ...untypedRef } = ref;
    const {
      domain_revision_parent_ref: _parent,
      content_schema: _outputSchema,
      ...untypedOutput
    } = output;
    both(ArtifactRefSchema, publishedSchema("artifact-ref"), untypedRef, true);
    both(OutputArtifactMetadataSchema, publishedSchema("output-artifact"), untypedOutput, true);
  });

  it.each([
    { ...ref, content_schema: { ...ref.content_schema, extra: true } },
    { ...ref, content_schema: { schema_id: "not-an-id", schema_version: 1 } },
    { ...ref, content_schema: { ...ref.content_schema, schema_version: 0 } },
    { ...ref, run_id: "x".repeat(257) },
    { ...ref, extra: true },
  ])("rejects malformed or additional metadata identically (%#)", (value) => {
    both(ArtifactRefSchema, publishedSchema("artifact-ref"), value, false);
    both(
      InputArtifactsSchema,
      publishedSchema("input-artifacts"),
      { schema_version: 2, artifacts: [{ slot: "input-test", ref: value }] },
      false
    );
    both(
      OutputArtifactMetadataSchema,
      publishedSchema("output-artifact"),
      { ...output, domain_revision_parent_ref: value },
      false
    );
  });

  it("keeps output-only and handoff unknown fields closed", () => {
    both(
      OutputArtifactMetadataSchema,
      publishedSchema("output-artifact"),
      { ...output, extra: true },
      false
    );
    both(
      InputArtifactsSchema,
      publishedSchema("input-artifacts"),
      { schema_version: 2, artifacts: [], extra: true },
      false
    );
    both(
      InputArtifactsSchema,
      publishedSchema("input-artifacts"),
      { schema_version: 2, artifacts: [{ slot: "input-test", ref, extra: true }] },
      false
    );
  });
});
