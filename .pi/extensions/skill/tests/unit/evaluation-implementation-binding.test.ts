import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import {
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  type EvaluationImplementationBindingV1,
} from "../../evaluation-contracts.js";
import {
  DETERMINISTIC_GRADING_DEFINITION,
  DIRECT_DEMETRI_BASELINE_REGISTRATION,
  SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
  SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
  createEvaluationImplementationBinding,
  evaluationImplementationBindingSha256,
  freezePairedEvaluation,
  syntheticEvaluationImplementationBinding,
  syntheticEvaluationRuntimeFunctions,
} from "../../evaluation-runner.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
const temporaryRoots: string[] = [];

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, "evals", "fixtures", name), "utf8"));
}

function population() {
  return validateEvaluationPopulation(fixture("synthetic-known-delta.population.v1.json"));
}

function plan() {
  return validatePairedEvaluationPlan(fixture("synthetic-known-delta.plan.v1.json"));
}

function implementation() {
  const populationValue = population();
  const planValue = plan();
  const runtimeFunctions = syntheticEvaluationRuntimeFunctions();
  const implementationBinding = syntheticEvaluationImplementationBinding({
    projectRoot: PROJECT_ROOT,
    population: populationValue,
    plan: planValue,
    runtimeFunctions,
  });
  return { populationValue, planValue, runtimeFunctions, implementationBinding };
}

function copyBindingTree(binding: EvaluationImplementationBindingV1): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-evaluation-implementation-"));
  temporaryRoots.push(root);
  for (const relativePath of new Set(binding.files.map((file) => file.path))) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(PROJECT_ROOT, relativePath), destination);
  }
  return root;
}

function sourceInputs(binding: EvaluationImplementationBindingV1) {
  return binding.files.map((file) => ({
    role: file.role,
    owner: file.owner,
    path: file.path,
  }));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("EvaluationImplementationBindingV1 reproducibility boundary", () => {
  it("rejects a same-contract candidate with a deliberately substituted construct", () => {
    const base = implementation();
    const substituted = {
      ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
      construct: DIRECT_DEMETRI_BASELINE_REGISTRATION.construct,
    };

    expect(() =>
      freezePairedEvaluation({
        population: base.populationValue,
        plan: base.planValue,
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: new Map([[substituted.name, substituted]]),
        implementationBinding: base.implementationBinding,
        runtimeFunctions: base.runtimeFunctions,
      })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);
  });

  it("rejects guidance prompt byte drift before trial 1", () => {
    const base = implementation();
    const root = copyBindingTree(base.implementationBinding);
    const prompt = base.implementationBinding.files.find(
      (file) =>
        file.role === "registration_guidance" &&
        file.owner === SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.name
    );
    if (prompt === undefined) throw new Error("candidate prompt binding is absent");
    writeFileSync(
      path.join(root, prompt.path),
      `${readFileSync(path.join(root, prompt.path), "utf8")}drift\n`
    );

    expect(() =>
      freezePairedEvaluation({
        population: base.populationValue,
        plan: base.planValue,
        projectRoot: root,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        implementationBinding: base.implementationBinding,
        runtimeFunctions: base.runtimeFunctions,
      })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);
  });

  it("rejects material evaluator source byte drift before trial 1", () => {
    const base = implementation();
    const root = copyBindingTree(base.implementationBinding);
    const source = base.implementationBinding.files.find(
      (file) => file.role === "evaluator_source" && file.owner === "evaluation-runtime"
    );
    if (source === undefined) throw new Error("evaluator source binding is absent");
    writeFileSync(
      path.join(root, source.path),
      `${readFileSync(path.join(root, source.path), "utf8")}\n`
    );

    expect(() =>
      freezePairedEvaluation({
        population: base.populationValue,
        plan: base.planValue,
        projectRoot: root,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        implementationBinding: base.implementationBinding,
        runtimeFunctions: base.runtimeFunctions,
      })
    ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);
  });

  it("rejects symlinked implementation files and lexical path escape", () => {
    const base = implementation();
    const root = copyBindingTree(base.implementationBinding);
    const source = base.implementationBinding.files.find(
      (file) => file.role === "worker_source" && file.owner === "evaluation-runtime"
    );
    if (source === undefined) throw new Error("worker source binding is absent");
    const destination = path.join(root, source.path);
    const outside = path.join(root, "outside-worker.ts");
    copyFileSync(destination, outside);
    unlinkSync(destination);
    symlinkSync(outside, destination);

    expect(() =>
      createEvaluationImplementationBinding({
        projectRoot: root,
        population: base.populationValue,
        plan: base.planValue,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
        files: sourceInputs(base.implementationBinding),
        runtimeFunctions: base.runtimeFunctions,
      })
    ).toThrow(/symbolic link/u);

    expect(() =>
      createEvaluationImplementationBinding({
        projectRoot: PROJECT_ROOT,
        population: base.populationValue,
        plan: base.planValue,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
        files: sourceInputs(base.implementationBinding).map((file) =>
          file.role === "worker_source" ? { ...file, path: "../outside-worker.ts" } : file
        ),
        runtimeFunctions: base.runtimeFunctions,
      })
    ).toThrow(/canonical project-relative/u);
  });

  it("rejects an omitted material role", () => {
    const base = implementation();
    expect(() =>
      createEvaluationImplementationBinding({
        projectRoot: PROJECT_ROOT,
        population: base.populationValue,
        plan: base.planValue,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        gradingDefinition: DETERMINISTIC_GRADING_DEFINITION,
        files: sourceInputs(base.implementationBinding).filter(
          (file) => file.role !== "artifact_preflight_source"
        ),
        runtimeFunctions: base.runtimeFunctions,
      })
    ).toThrow(/omits artifact_preflight_source/u);
  });

  it("rejects start-admission function behavior and worker-schema descriptor drift", () => {
    const base = implementation();
    const admission = SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.start_admission;
    if (admission === undefined) throw new Error("candidate start admission is absent");
    const functionDrift = {
      ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
      start_admission: {
        ...admission,
        prepare: (
          request: Parameters<typeof admission.prepare>[0],
          host: Parameters<typeof admission.prepare>[1]
        ) => {
          const prepared = admission.prepare(request, host);
          return { ...prepared, goal: `${prepared.goal} changed` };
        },
      },
    };
    const worker = SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") {
      throw new Error("candidate catalog worker is absent");
    }
    const phase = worker.phases.get("evaluating");
    if (phase === undefined) throw new Error("candidate catalog phase is absent");
    const schemaDrift = {
      ...SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION,
      worker: {
        ...worker,
        phases: new Map([
          [
            "evaluating",
            {
              ...phase,
              schema: Type.Object(
                { complete: Type.Literal(true), descriptor_drift: Type.Optional(Type.Boolean()) },
                { additionalProperties: false }
              ),
            },
          ],
        ]),
      },
    };

    for (const registration of [functionDrift, schemaDrift]) {
      expect(() =>
        freezePairedEvaluation({
          population: base.populationValue,
          plan: base.planValue,
          projectRoot: PROJECT_ROOT,
          baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
          candidateRegistry: new Map([[registration.name, registration]]),
          implementationBinding: base.implementationBinding,
          runtimeFunctions: base.runtimeFunctions,
        })
      ).toThrow(/EVALUATION_REGISTRATION_INCOMPATIBLE/u);
    }
  });

  it("reproduces the unchanged known-delta implementation digest", () => {
    const base = implementation();
    expect(evaluationImplementationBindingSha256(base.implementationBinding)).toBe(
      base.planValue.implementation_binding_sha256
    );
    expect(
      freezePairedEvaluation({
        population: base.populationValue,
        plan: base.planValue,
        projectRoot: PROJECT_ROOT,
        baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
        candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
        implementationBinding: base.implementationBinding,
        runtimeFunctions: base.runtimeFunctions,
      }).implementation_binding_sha256
    ).toBe(base.planValue.implementation_binding_sha256);
  });
});
