/** Caller-only admission. Templates are sealed with the real generic-entrypoint run/corpus identity. */
import path from "node:path";
import { Type } from "typebox";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, type ArtifactRef } from "../contracts.js";
import type { ScaRequestV1 } from "../skill-contracts/sca-request.js";
import { persistScaArtifact } from "./ordinary-artifacts.js";
import { captureScaStaticSourceFile } from "./ordinary-source.js";
import {
  OrdinaryApplicationTestPlanSchema,
  OrdinaryApplicationTestPolicySchema,
  OrdinaryApplicationContainerPlanSchema,
  OrdinaryApplicationContainerPolicySchema,
  ScaApplicationBindingsSchema,
} from "./ordinary-advanced-contracts.js";

export function materializeScaAdvanced(input: {
  store: ArtifactHostStore;
  runId: string;
  request: ScaRequestV1;
  corpus: ArtifactRef;
  requestRef: ArtifactRef;
  projectId?: string;
}): ArtifactRef[] {
  const { store, runId, request, corpus, requestRef } = input;
  const refs: ArtifactRef[] = [];
  const save = (
    phase: string,
    kind: string,
    schemaId: string,
    value: unknown,
    upstream: readonly ArtifactRef[],
    schemaVersion = 1
  ) => {
    const ref = persistScaArtifact({
      store,
      runId,
      phase,
      kind,
      schemaId,
      schemaVersion,
      content: canonicalJson(value),
      upstream,
    });
    refs.push(ref);
    return ref;
  };
  const capture = (id: string, name: string, file: { path: string; sha256: string }) => {
    const bytes = captureScaStaticSourceFile({
      sourceRoot: path.dirname(file.path),
      relativePath: path.basename(file.path),
      maximumBytes: 2 * 1024 * 1024,
    });
    if (sha256(bytes) !== file.sha256) throw new Error("Advanced caller input digest drift");
    const ref = persistScaArtifact({
      store,
      runId,
      phase: `intake-${id}`,
      kind: `sca-test-${name}`,
      schemaId: "penny.sca-test-bytes.v1",
      content: bytes,
      mediaType: "application/octet-stream",
      upstream: [requestRef],
    });
    refs.push(ref);
    return ref;
  };
  const bindings = [];
  for (const entry of request.advanced?.application_tests ?? []) {
    const container = entry.isolation === "container";
    const version = container ? 2 : 1;
    const planSchemaId = `penny.sca-ordinary-application-plan.v${version}`;
    const policySchemaId = `penny.sca-ordinary-application-policy.v${version}`;
    if (entry.source_snapshot_sha256 !== request.source_snapshot_sha256)
      throw new Error("Application source snapshot authority mismatch");
    const harness = capture(entry.id, "harness", entry.harness);
    const inputs = entry.test_inputs.map((item, index) => ({
      path: item.name,
      ref: capture(entry.id, `input-${index}`, item.file),
    }));
    const stdin = entry.stdin === null ? null : capture(entry.id, "stdin", entry.stdin);
    const plan = validateContract(
      container ? OrdinaryApplicationContainerPlanSchema : OrdinaryApplicationTestPlanSchema,
      {
        schema_id: planSchemaId,
        schema_version: version,
        source_snapshot_sha256: entry.source_snapshot_sha256,
        source_corpus_ref: corpus,
        interpreter: entry.interpreter,
        source_files: entry.source_files,
        harness_ref: harness,
        test_inputs: inputs,
        stdin_ref: stdin,
        expected_exit_code: entry.expected_exit_code,
        resources: entry.resources,
      },
      "Application plan"
    );
    const operationSeconds =
      "operation_timeout_seconds" in entry.resources
        ? entry.resources.operation_timeout_seconds
        : entry.resources.vm_timeout_seconds;
    if (entry.resources.test_timeout_ms >= operationSeconds * 1000)
      throw new Error("Application test timeout must be below operation timeout");
    for (const key of Object.keys(entry.resources)) {
      const requested: unknown = Reflect.get(entry.resources, key),
        maximum: unknown = Reflect.get(entry.maxima, key);
      if (typeof requested !== "number" || typeof maximum !== "number" || requested > maximum)
        throw new Error("Application plan exceeds caller policy");
    }
    const planRef = save(
      `intake-${entry.id}`,
      "sca-execution-plan",
      planSchemaId,
      plan,
      [
        requestRef,
        corpus,
        harness,
        ...inputs.map((x) => x.ref),
        ...(stdin === null ? [] : [stdin]),
      ],
      version
    );
    // Project ID is derived by the concrete artifact owner, never the model or template.
    const projectId = input.projectId;
    if (projectId === undefined)
      throw new Error("Application requires project-bound artifact custody");
    const policy = validateContract(
      container ? OrdinaryApplicationContainerPolicySchema : OrdinaryApplicationTestPolicySchema,
      {
        schema_id: policySchemaId,
        schema_version: version,
        project_id: projectId,
        run_id: runId,
        isolation: container ? "container" : "vm",
        network: "none",
        credentials: "none",
        profile: container ? entry.profile : "qemu-kvm-nicless-v1",
        allowed_plan_sha256: [planRef.content_digest],
        maxima: entry.maxima,
      },
      "Application policy"
    );
    const policyRef = save(
      `intake-${entry.id}`,
      "sca-execution-policy",
      policySchemaId,
      policy,
      [requestRef, planRef],
      version
    );
    bindings.push({
      id: entry.id,
      plan_ref: planRef,
      policy_ref: policyRef,
      closure: [corpus, harness, ...inputs.map((x) => x.ref), ...(stdin === null ? [] : [stdin])],
    });
  }
  for (const entry of request.advanced?.learning ?? []) {
    if (entry.source_snapshot_sha256 !== request.source_snapshot_sha256)
      throw new Error("Learning source snapshot authority mismatch");
  }
  save(
    "intake",
    "sca-application-bindings",
    "penny.sca-application-bindings.v1",
    validateContract(ScaApplicationBindingsSchema, bindings, "Application bindings"),
    [requestRef, ...refs]
  );
  // Independent fixture truth and host paths deliberately stay out of cognitive inputs.
  const catalog = {
    schema_version: 1,
    application_tests: (request.advanced?.application_tests ?? []).map((x) => ({
      id: x.id,
      source_snapshot_sha256: x.source_snapshot_sha256,
      source_files: x.source_files,
    })),
    learning: (request.advanced?.learning ?? []).map((x) => ({
      id: x.id,
      language: x.language,
      rule_id: x.rule_id,
    })),
  };
  save(
    "intake",
    "sca-advanced-catalog",
    "penny.sca-advanced-catalog.v1",
    validateContract(
      Type.Object(
        {
          schema_version: Type.Literal(1),
          application_tests: Type.Array(
            Type.Object(
              {
                id: Type.String(),
                source_snapshot_sha256: Type.String(),
                source_files: OrdinaryApplicationTestPlanSchema.properties.source_files,
              },
              { additionalProperties: false }
            )
          ),
          learning: Type.Array(
            Type.Object(
              { id: Type.String(), language: Type.String(), rule_id: Type.String() },
              { additionalProperties: false }
            )
          ),
        },
        { additionalProperties: false }
      ),
      catalog,
      "Advanced catalog"
    ),
    [requestRef]
  );
  return refs;
}
