import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactStore } from "../../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../../orchestration/dist/canonical-json.js";
import type { CurrentArtifactRef } from "../../../orchestration/dist/contracts.js";
import { buildHostStaticInventory } from "../../../orchestration/dist/sca/ordinary-source.js";
import {
  createOrdinaryApplicationTestRuntime,
  type OrdinaryApplicationContainerConfig,
  type OrdinaryApplicationContainerPlan,
  type OrdinaryApplicationContainerPolicy,
  type OrdinaryApplicationTestOwner,
  type OrdinaryApplicationTestRequest,
  type OrdinaryApplicationDockerRunner,
} from "../../src/ordinary-application-tests.js";

export interface ContainerFixtureOptions {
  readonly root: string;
  readonly config: OrdinaryApplicationContainerConfig;
  readonly interpreter?: OrdinaryApplicationContainerPlan["interpreter"];
  readonly harness?: string;
  readonly source?: string;
  readonly resources?: Partial<OrdinaryApplicationContainerPlan["resources"]>;
  readonly mutatePlan?: (plan: OrdinaryApplicationContainerPlan) => void;
  readonly mutatePolicy?: (policy: OrdinaryApplicationContainerPolicy) => unknown;
  readonly accepted?: (controller: AbortController) => void;
}
export function containerFixture(options: ContainerFixtureOptions) {
  const root = mkdtempSync(path.join(options.root, "case-"));
  const projectId = "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const store = ArtifactStore.provision(path.join(root, "artifacts"), { projectId });
  let sequence = 0;
  const closure = new Map<string, CurrentArtifactRef>();
  function persist(kind: string, content: string | Buffer, schema?: string, version = 1) {
    const ref = store.persist({
      metadata: {
        schema_version: 2,
        run_id: "container-test",
        phase: "disposable-test",
        branch_id: null,
        kind,
        operation_id: `operand-${sequence++}`,
        version: 1,
        producer: "host:disposable-fixture",
        media_type: schema === undefined ? "application/octet-stream" : "application/json",
        ...(schema === undefined
          ? {}
          : { content_schema: { schema_id: schema, schema_version: version } }),
        parent_ref: null,
        upstream_refs: [],
      },
      content,
    });
    closure.set(ref.artifact_id, ref);
    return ref;
  }
  const interpreter = options.interpreter ?? "node";
  const ext = interpreter === "php" ? "php" : interpreter === "node_typescript" ? "ts" : "mjs";
  const source =
    options.source ??
    (interpreter === "php"
      ? "<?php function render($s) { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }\n"
      : `export function render(s${interpreter === "node_typescript" ? ": string" : ""}) { return s.replaceAll('<', '&lt;'); }\n`);
  const sourceRoot = path.join(root, "source");
  mkdirSync(sourceRoot);
  writeFileSync(path.join(sourceRoot, `target.${ext}`), source);
  const capture = buildHostStaticInventory({
    schema_version: 1,
    purpose: "Disposable source-only container fixture",
    source_root: sourceRoot,
    scope: { include: [], exclude: [] },
    execution_mode: "static_only",
    model: "deepseek-flash",
  });
  const corpusRef = persist("source-corpus", capture.sourceCorpus);
  const harness =
    options.harness ??
    (interpreter === "php"
      ? "<?php require '../source/target.php'; echo render('<script>') === '<script>' ? 'vulnerable' : 'safe';"
      : `import {render} from '../source/target.${ext}'; process.stdout.write(render('<script>') === '<script>' ? 'vulnerable' : 'safe');`);
  const harnessRef = persist("test-harness", harness);
  const inputRef = persist("test-input", "exact-input");
  const stdinRef = persist("test-stdin", "exact-stdin");
  const resources = {
    operation_timeout_seconds: 30,
    test_timeout_ms: 3000,
    cpu_seconds: 5,
    memory_bytes: 536_870_912,
    processes: 32,
    file_bytes: 1_048_576,
    output_bytes: 4096,
    ...options.resources,
  };
  const plan: OrdinaryApplicationContainerPlan = {
    schema_id: "penny.sca-ordinary-application-plan.v2",
    schema_version: 2,
    source_snapshot_sha256: capture.sourceSnapshotSha256,
    source_corpus_ref: corpusRef,
    interpreter,
    source_files: [{ path: `target.${ext}`, content_sha256: sha256(source) }],
    harness_ref: harnessRef,
    test_inputs: [{ path: "value.txt", ref: inputRef }],
    stdin_ref: stdinRef,
    expected_exit_code: 0,
    resources,
  };
  options.mutatePlan?.(plan);
  const planRef = persist("sca-execution-plan", canonicalJson(plan), plan.schema_id, 2);
  const policy: OrdinaryApplicationContainerPolicy = {
    schema_id: "penny.sca-ordinary-application-policy.v2",
    schema_version: 2,
    project_id: projectId,
    run_id: "container-test",
    isolation: "container",
    network: "none",
    credentials: "none",
    profile: "docker-local-no-network-v1",
    allowed_plan_sha256: [planRef.content_digest],
    maxima: { ...resources },
  };
  const policyRef = persist(
    "sca-execution-policy",
    canonicalJson(options.mutatePolicy?.(policy) ?? policy),
    policy.schema_id,
    2
  );
  const request: OrdinaryApplicationTestRequest = {
    schema_id: "penny.sca-ordinary-application-request.v1",
    schema_version: 1,
    project_id: projectId,
    run_id: "container-test",
    action_id: path.basename(root),
    source_snapshot_sha256: capture.sourceSnapshotSha256,
    execution_plan_ref: planRef,
    policy_ref: policyRef,
  };
  const controller = new AbortController();
  const events: unknown[] = [];
  const owner: OrdinaryApplicationTestOwner = {
    projectId,
    runId: request.run_id,
    signal: controller.signal,
    readArtifact(ref) {
      const exact = closure.get(ref.artifact_id);
      if (exact === undefined || canonicalJson(exact) !== canonicalJson(ref))
        throw new Error("Unadmitted fixture operand");
      return { ref: exact, bytes: store.readById(ref.artifact_id) };
    },
    beforeSubmit(name) {
      events.push({ submission_guard: name });
    },
    accepted(name) {
      events.push({ accepted: name });
      options.accepted?.(controller);
    },
    activity() {
      events.push({ activity: true });
    },
  };
  const authority = { project_id: projectId, admitted_policy_refs: [policyRef] };
  const config = options.config;
  return {
    root,
    sourceRoot,
    source,
    harness,
    corpusRef,
    plan,
    policy,
    request,
    owner,
    authority,
    controller,
    events,
    persist,
    closure,
    close: () => store.close(),
    async run(runner?: OrdinaryApplicationDockerRunner) {
      const result = await createOrdinaryApplicationTestRuntime({
        authority,
        runtime: config,
        dockerRunner: runner,
      }).run(request, owner);
      writeFileSync(
        path.join(root, "receipt.json"),
        canonicalJson({
          source_sha256: sha256(source),
          harness_sha256: sha256(harness),
          corpusRef,
          plan,
          policy,
          request,
          events,
          result,
        }),
        { mode: 0o600 }
      );
      return result;
    },
  };
}
export function privateContainerFixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), "ordinary-container-native-"));
}
