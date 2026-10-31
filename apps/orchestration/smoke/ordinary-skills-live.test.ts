/** Opt-in native Pi user command -> real parent tool loop -> compiled production skills.
 * No provider calls occur without the explicit live gate and all preflight checks. */
import "../dist/index.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  DefaultPackageManager,
  getAgentDir,
  initTheme,
  ModelRuntime,
  parseFrontmatter,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../.pi/lib/tests/test-narrowers.js";
import { OrchestrationService } from "../dist/service.js";
import { assertCurrentShippingBuild } from "../dist/build-provenance.js";
import { initializePennyState } from "../dist/state/setup.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../dist/contracts.js";
import { ssotModel, ssotProvider, parseSsotTools } from "../dist/model-client.js";
import {
  enrollWorkerGuard,
  observeWorkerGuardDenials,
  WORKER_GUARD_ENV,
  WorkerGuardConfigSchema,
} from "../tests/ordinary-skills-live-guard.js";
import { PLAYBOOK_REGISTRY } from "../dist/playbooks/registry.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  COHORTS,
  COHORT_ENV,
  SOURCE_FREEZE_ENV,
  LIVE_GATE,
  EXPECTED_GENERATION_ENV,
  requireExpectedGeneration,
  assertExpectedGeneration,
  requireNativeSingle,
  nativeParentRequest,
  exactParentInvocation,
  inspectParentSession,
  ORDINARY_SKILLS,
  atomicBytes,
  atomicJson,
  terminalOutputEvidence,
  contextualHandoffMatches,
  CURRENT_RESEARCH_FETCH_POLICY,
  LIVE_PROJECT_GUIDANCE,
  filesUnder,
  buildCohort,
  parseCohortSelection,
  publicResultMatches,
  requiredLivePhase,
  exactHandoffMatches,
  reviewedAssuranceMatches,
  inspectSession,
  safeError,
  sourceHash,
  type Check,
  type Identity,
  type ParentDispatch,
  type ParentOutcome,
  type RoleIdentity,
  type SessionEvidence,
} from "./ordinary-skills-live-contract.js";

const REPOSITORY = path.resolve(import.meta.dirname, "../../..");

(process.env[LIVE_GATE] === "1" ? describe : describe.skip)(
  "ordinary skills REAL production cohort",
  () => {
    it("runs exactly one selected single scenario through a native command and real parent dispatch", async () => {
      const selection = parseCohortSelection(process.env[COHORT_ENV]);
      const expectedGeneration = requireExpectedGeneration(process.env[EXPECTED_GENERATION_ENV]);
      if (process.env[SOURCE_FREEZE_ENV] !== "1")
        throw new Error(
          `Parent source freeze required: ${SOURCE_FREEZE_ENV}=1 (after offline gates and verification of the frozen compiled generation; do not rebuild)`
        );
      const cohort = buildCohort(selection, (skill) => `${skill}-live-${randomUUID()}`);
      const step = requireNativeSingle(cohort);
      const root = mkdtempSync(path.join(tmpdir(), "penny-orchestration-live-"));
      console.log(`ORDINARY_SKILLS_LIVE_EVIDENCE=${root}`);
      const project = path.join(root, "project");
      mkdirSync(project, { mode: 0o700 });
      const runIds = cohort.steps.map((step) => step.session_id);
      const researchRuns = cohort.steps
        .filter((step) => step.skill_name === "research")
        .map((step) => step.session_id);
      const params = cohort.params;
      const terminalOutputs = new Map<string, ArtifactRef>();
      const errors: string[] = [];
      const checks: Check[] = [];
      const roles: RoleIdentity[] = [];
      const sessions: SessionEvidence[] = [];
      const runs: unknown[] = [];
      let result: unknown = null;
      const nativePrompts: string[] = [];
      const dispatches: ParentDispatch[] = [];
      const outcomes: ParentOutcome[] = [];
      const providerStreams = new Map<string, Identity & { events: number }>();
      let providerRequests = 0;
      let admittedCalls = 0;
      let blockedCalls = 0;
      let parent: AgentSession | undefined;
      let parentIdentity: Identity | undefined;
      let parentEvidence: ReturnType<typeof inspectParentSession> | undefined;
      let unsubscribe: (() => void) | undefined;
      let abortParent: (() => void) | undefined;
      let stopWorkerGuardObservation: (() => void) | undefined;
      const originalCwd = process.cwd();
      const request = nativeParentRequest(cohort);
      const literalPrompt = `/skill:${step.skill_name} ${request}`;
      let ownerState: ReturnType<typeof initializePennyState> | undefined;
      let sourceHashes: ReturnType<typeof sourceHash>[] = [];
      const prior = new Map(
        [
          "PROJECT_ROOT",
          "PENNY_STATE_ROOT",
          "PENNY_SKILLS_DIR",
          "PI_OBSERVABILITY_ENABLED",
          "PI_OBSERVABILITY_AUTO_START",
          "PI_OBSERVABILITY_REST_URL",
          "PI_OBSERVABILITY_API_KEY",
          "PENNY_OBSERVABILITY_API_KEY",
          "PENNY_ARTIFACT_ROOT",
          WORKER_GUARD_ENV,
        ].map((key) => [key, process.env[key]])
      );
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort(new Error("Operator cancelled ordinary live cohort"));
      const captureRunEvidence = (): void => {
        if (ownerState !== undefined) {
          // Read only this newly initialized partition; no execute/recover/provider call here.
          using service = new OrchestrationService({ projectRoot: project, env: process.env });
          const sessionFiles = filesUnder(ownerState.paths.subagentSessions).filter((file) =>
            file.endsWith(".jsonl")
          );
          for (const file of sessionFiles) {
            try {
              atomicBytes(
                path.join(
                  root,
                  "exact-worker-sessions",
                  path.relative(ownerState.paths.subagentSessions, file)
                ),
                readFileSync(file)
              );
              sessions.push(
                inspectSession(
                  file,
                  roles,
                  runIds,
                  researchRuns,
                  CURRENT_RESEARCH_FETCH_POLICY,
                  (ref) => service.artifacts.readById(ref.artifact_id)
                )
              );
            } catch (error) {
              errors.push(safeError(error));
            }
          }
          for (const [stepIndex, step] of cohort.steps.entries()) {
            try {
              const context = service.checkpointer.loadRunById(step.session_id);
              if (context === undefined) {
                checks.push({
                  name: `${step.skill_name} persisted run`,
                  passed: false,
                  detail: "No run created",
                });
                continue;
              }
              const terminal = context.terminalDirective;
              if (isRecord(result) && isRecord(result.details))
                checks.push({
                  name: "parent skill result identifies exact durable terminal output",
                  passed:
                    terminal?.action === "complete" &&
                    terminal.met === true &&
                    canonicalJson(result.details.output_artifact_ref) ===
                      canonicalJson(terminal.result.output_artifact_ref),
                  detail: step.session_id,
                });
              const events = service.checkpointer.events(step.session_id);
              const refs = new Map<string, ArtifactRef>(
                context.selectedArtifacts.map((ref) => [ref.artifact_id, ref])
              );
              for (const session of sessions.filter((item) => item.run_id === step.session_id)) {
                for (const id of session.input_ids) {
                  const ref = service.artifacts.refById(id);
                  if (ref === undefined) throw new Error(`Exact session input is absent: ${id}`);
                  refs.set(id, ref);
                }
              }
              const outputValue =
                terminal !== undefined && terminal !== null && "result" in terminal
                  ? terminal.result.output_artifact_ref
                  : undefined;
              if (outputValue !== undefined && outputValue !== null) {
                const outputRef = validateContract(
                  ArtifactRefSchema,
                  outputValue,
                  "terminal output"
                );
                refs.set(outputRef.artifact_id, outputRef);
                if (terminal?.action === "complete" && terminal.met === true)
                  terminalOutputs.set(step.session_id, outputRef);
              }
              const runEvidence = {
                skill: step.skill_name,
                run_id: step.session_id,
                status: context.status,
                terminal,
                snapshot: context.snapshot(),
                events,
                exact_refs: [...refs.values()],
              };
              runs.push(runEvidence);
              atomicJson(path.join(root, `${step.session_id}-run.json`), runEvidence);
              for (const ref of refs.values()) {
                const bytes = service.artifacts.readById(ref.artifact_id);
                if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
                  throw new Error(`Exact artifact mismatch: ${ref.artifact_id}`);
                atomicBytes(path.join(root, "exact-artifacts", `${ref.artifact_id}.bin`), bytes);
              }
              checks.push({
                name: `${step.skill_name} completed and admitted`,
                passed: terminal?.action === "complete" && terminal.met === true,
                detail: terminal?.action ?? context.status,
              });
              const runSessions = sessions.filter((item) => item.run_id === step.session_id);
              checks.push({
                name: `${step.skill_name} real sessions captured`,
                passed: runSessions.length > 0,
                detail: String(runSessions.length),
              });
              const registration = PLAYBOOK_REGISTRY.get(step.skill_name);
              if (registration?.worker.kind !== "catalog-agent")
                throw new Error("Missing catalog registration during evidence check");
              for (const [state] of registration.worker.phases) {
                if (!requiredLivePhase(step.skill_name, state)) continue;
                checks.push({
                  name: `${step.skill_name}/${state} live phase`,
                  passed: runSessions.some(
                    (item) =>
                      item.state === state && item.purpose === "phase" && item.responses.length > 0
                  ),
                  detail: state,
                });
              }
              for (const session of runSessions)
                checks.push({
                  name: `${step.skill_name}/${session.state} registered phase agent`,
                  passed: registration.worker.phases.get(session.state)?.agent === session.agent,
                  detail: session.agent,
                });
              const priorStep = cohort.mode === "chain" ? cohort.steps[stepIndex - 1] : undefined;
              const upstream =
                priorStep === undefined ? undefined : terminalOutputs.get(priorStep.session_id);
              if (priorStep !== undefined && step.previous_artifact_designation !== "context") {
                const firstState =
                  step.skill_name === "plan" ? "orienting_strategy" : "analyzing_decision";
                checks.push({
                  name: "exact cross-run core retained and assigned to first consumer workers",
                  passed:
                    upstream !== undefined &&
                    exactHandoffMatches(
                      upstream,
                      step.session_id,
                      context.selectedArtifacts,
                      runSessions.filter(
                        (session) => session.state === firstState && session.purpose === "phase"
                      ),
                      priorStep.skill_name === "define" ? "define" : "research"
                    ),
                  detail: upstream?.artifact_id ?? "No predecessor core",
                });
                if (step.skill_name === "plan") {
                  const assuranceRef = context.selectedArtifacts.find(
                    (ref) => ref.kind === "composition-assurance"
                  );
                  const assurance: unknown =
                    assuranceRef === undefined
                      ? null
                      : JSON.parse(
                          service.artifacts.readById(assuranceRef.artifact_id).toString("utf8")
                        );
                  checks.push({
                    name: "strict reviewed_definition consumer-bound assurance, no downgrade",
                    passed:
                      upstream !== undefined &&
                      assurance !== null &&
                      reviewedAssuranceMatches(assurance, upstream, step.session_id),
                    detail: assuranceRef?.artifact_id ?? "No assurance",
                  });
                }
              }
              const contextRefs =
                step.previous_artifact_designation === "context"
                  ? upstream === undefined
                    ? []
                    : [upstream]
                  : cohort.mode === "fan-in" && stepIndex === 2
                    ? cohort.steps.slice(0, 2).flatMap((source) => {
                        const ref = terminalOutputs.get(source.session_id);
                        return ref === undefined ? [] : [ref];
                      })
                    : [];
              if (
                step.previous_artifact_designation === "context" ||
                (cohort.mode === "fan-in" && stepIndex === 2)
              ) {
                checks.push({
                  name: "exact nonbinding context retained, labeled and fully read in every downstream phase",
                  passed:
                    contextRefs.length === (cohort.mode === "fan-in" ? 2 : 1) &&
                    contextualHandoffMatches(
                      {
                        schema_version: 2,
                        artifacts: contextRefs.map((ref, index) => ({
                          slot:
                            cohort.mode === "fan-in"
                              ? `context-input-${String(index + 1).padStart(4, "0")}`
                              : "previous-skill-terminal-output",
                          designation: "context",
                          ref,
                        })),
                      },
                      step.session_id,
                      context.admittedInputArtifacts,
                      context.selectedArtifacts,
                      runSessions
                    ),
                  detail: canonicalJson(contextRefs),
                });
              }
              if (
                terminal?.action === "complete" ||
                terminal?.action === "incomplete" ||
                terminal?.action === "error" ||
                terminal?.action === "cancelled"
              ) {
                const output = terminal.result.output_artifact_ref;
                if (output !== null && output !== undefined) {
                  const ref = validateContract(
                    ArtifactRefSchema,
                    output,
                    "live terminal output ref"
                  );
                  const bytes = service.artifacts.readById(ref.artifact_id);
                  const evidence = terminalOutputEvidence(
                    step.skill_name,
                    terminal,
                    bytes,
                    ref,
                    upstream,
                    { selection, step_index: stepIndex, context_refs: contextRefs }
                  );
                  atomicBytes(
                    path.join(
                      root,
                      `${step.session_id}-terminal-${evidence.classification === "canonical_product" ? "product.json" : `${evidence.classification}.bin`}`
                    ),
                    bytes
                  );
                  atomicJson(path.join(root, `${step.session_id}-terminal-output.json`), {
                    classification: evidence.classification,
                    ref,
                    action: terminal.action,
                    met: terminal.met,
                  });
                  checks.push(...evidence.checks);
                } else
                  checks.push({
                    name: `${step.skill_name} terminal semantic core`,
                    passed: false,
                    detail: "No output artifact ref",
                  });
              }
            } catch (error) {
              // Preserve other runs' terminals and artifacts even when one native product refuses.
              errors.push(`${step.session_id}: ${safeError(error)}`);
            }
          }
        }
      };
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const build = assertCurrentShippingBuild();
        assertExpectedGeneration(expectedGeneration, build);
        atomicJson(path.join(root, "compiled-generation.json"), build);
        const shippingEntry = readFileSync(
          path.join(REPOSITORY, ".pi/extensions/skill/index.ts"),
          "utf8"
        );
        if (shippingEntry.includes('"@penny/orchestration/source"'))
          throw new Error(
            "SHIPPING IMPORT ALIGNMENT not frozen: public skill ingress still imports /source"
          );
        for (const file of ["dist/index.js", "dist/artifact-worker.js"])
          if (!existsSync(path.join(REPOSITORY, "apps/orchestration", file)))
            throw new Error(`Parent matching compiled build prerequisite missing: ${file}`);
        // Explicit public-source allowlist. No settings, credentials, .env, sessions or private inputs.
        const publicSources = [".pi/agents", ".pi/skills", "docs/agents"].flatMap((relative) =>
          filesUnder(path.join(REPOSITORY, relative)).filter((file) => file.endsWith(".md"))
        );
        publicSources.push(path.join(REPOSITORY, ".pi/SYSTEM.md"));
        for (const file of publicSources)
          atomicBytes(path.join(project, path.relative(REPOSITORY, file)), readFileSync(file));
        atomicBytes(path.join(project, "AGENTS.md"), LIVE_PROJECT_GUIDANCE);
        // Real directory: never write the guard through a repository-directory symlink.
        const guardPath = enrollWorkerGuard(REPOSITORY, project);
        const runtimeSources = ["apps/orchestration/src", ".pi/lib", ".pi/extensions"].flatMap(
          (relative) =>
            filesUnder(path.join(REPOSITORY, relative)).filter(
              (file) =>
                file.endsWith(".ts") &&
                !file.includes(`${path.sep}tests${path.sep}`) &&
                !file.includes(`${path.sep}node_modules${path.sep}`)
            )
        );
        const harnessSources = [
          "smoke/ordinary-skills-live.test.ts",
          "smoke/ordinary-skills-live-contract.ts",
          "tests/ordinary-skills-live-guard.ts",
          "tests/ordinary-skills-live-guard.test.ts",
          "vitest.ordinary-skills-live.config.ts",
          "tsconfig.ordinary-skills-live.json",
          "tests/ordinary-skills-live-contract.test.ts",
        ].map((file) => path.join(REPOSITORY, "apps/orchestration", file));
        const compiledSources = filesUnder(path.join(REPOSITORY, "apps/orchestration/dist"));
        sourceHashes = [
          ...new Set([...publicSources, ...runtimeSources, ...harnessSources, ...compiledSources]),
        ]
          .sort()
          .map((file) => sourceHash(REPOSITORY, file));
        atomicJson(path.join(root, "source-hashes.before.json"), sourceHashes);
        for (const source of sourceHashes) {
          const bytes = readFileSync(path.join(REPOSITORY, source.path));
          if (bytes.length !== source.byte_length || sha256(bytes) !== source.sha256)
            throw new Error("Source changed during exact snapshot capture");
          // Hashes suffice for source-freeze evidence; do not export source/configuration bytes.
        }
        if (!existsSync(path.join(REPOSITORY, "apps/orchestration/dist/artifact-worker.js")))
          throw new Error(
            "Frozen compiled artifact-worker prerequisite missing; do not rebuild for this campaign"
          );
        process.env.PROJECT_ROOT = project;
        process.env.PENNY_STATE_ROOT = path.join(root, "state");
        process.env.PENNY_SKILLS_DIR = path.join(project, ".pi/skills");
        process.env.PI_OBSERVABILITY_ENABLED = "false";
        process.env.PI_OBSERVABILITY_AUTO_START = "false";
        // Do not send diagnostics to a real retained observability service.
        process.env.PI_OBSERVABILITY_REST_URL = "http://127.0.0.1:1";
        delete process.env.PI_OBSERVABILITY_API_KEY;
        delete process.env.PENNY_OBSERVABILITY_API_KEY;
        delete process.env.PENNY_ARTIFACT_ROOT;
        // Production extension factories that consult process.cwd() must see only the synthetic project.
        process.chdir(project);
        // Keep PI_CODING_AGENT_DIR and SDK auth/model lookup untouched. Never copy those files.
        ownerState = initializePennyState(project, { env: process.env });
        const selectedRegistration = PLAYBOOK_REGISTRY.get(step.skill_name);
        if (selectedRegistration?.worker.kind !== "catalog-agent")
          throw new Error("Missing selected catalog registration");
        const guardConfig = validateContract(
          WorkerGuardConfigSchema,
          {
            schema_version: 1,
            project,
            project_id: ownerState.projectId,
            session_root: ownerState.paths.subagentSessions,
            run_id: step.session_id,
            skill: step.skill_name,
            phases: [...selectedRegistration.worker.phases].map(([state, phase]) => ({
              state_id: state,
              agent: phase.agent,
              tools:
                phase.allowed_tools ??
                parseSsotTools(
                  readFileSync(path.join(project, ".pi/agents", `${phase.agent}.md`), "utf8"),
                  phase.agent
                ),
            })),
          },
          "owner live guard configuration"
        );
        const guardConfigFile = path.join(root, "worker-guard.json");
        atomicJson(guardConfigFile, guardConfig);
        process.env[WORKER_GUARD_ENV] = guardConfigFile;
        stopWorkerGuardObservation = observeWorkerGuardDenials(project, step.session_id, () => {
          errors.push(
            "Worker action guard denied an action/provenance; scenario failed without repair"
          );
          cancellation.abort(
            new Error("Worker guard denied action; no further dispatch authorized")
          );
        });
        // Same normal inventory used by production worker source-replacement resolution.
        // No factories, credentials or providers are executed by this discovery check.
        const inventory = await new DefaultPackageManager({
          cwd: project,
          agentDir: getAgentDir(),
          settingsManager: SettingsManager.create(project),
        }).resolve(async () => "error");
        if (
          !inventory.extensions.some(
            (resource) =>
              resource.enabled && realpathSync(resource.path) === realpathSync(guardPath)
          )
        )
          throw new Error(
            "Worker guard absent from normal extension discovery; no provider dispatch"
          );
        atomicJson(path.join(root, "invocation.json"), params);
        atomicBytes(path.join(root, "parent-prompt.txt"), literalPrompt);
        const runtime = await ModelRuntime.create();
        await runtime.refresh({ allowNetwork: false });
        const phaseBindings: unknown[] = [];
        const roleNames = new Set<string>();
        for (const name of ORDINARY_SKILLS) {
          const registration = PLAYBOOK_REGISTRY.get(name);
          if (registration?.worker.kind !== "catalog-agent")
            throw new Error(`Missing ordinary registration '${name}'`);
          for (const [state, phase] of registration.worker.phases) {
            phaseBindings.push({
              skill: name,
              state,
              agent: phase.agent,
              allowed_tools: phase.allowed_tools ?? null,
              enrolled: cohort.steps.some((step) => step.skill_name === name),
            });
            if (cohort.steps.some((step) => step.skill_name === name)) roleNames.add(phase.agent);
          }
        }
        atomicJson(path.join(root, "phase-bindings.json"), phaseBindings);
        for (const agent of roleNames) {
          const text = readFileSync(path.join(project, ".pi/agents", `${agent}.md`), "utf8");
          const alias = ssotModel(text);
          const provider = ssotProvider(text);
          if (alias === undefined || provider === undefined)
            throw new Error(`Catalog identity missing for '${agent}'`);
          const resolved = resolveCliModel({
            cliProvider: provider,
            cliModel: alias,
            modelRuntime: runtime,
          });
          if (
            resolved.model === undefined ||
            resolved.error !== undefined ||
            resolved.warning !== undefined ||
            resolved.model.provider !== provider ||
            (resolved.model.id !== alias && resolved.model.name !== alias)
          )
            throw new Error(`Catalog identity unavailable for '${agent}': ${provider}/${alias}`);
          roles.push({ agent, alias, provider: resolved.model.provider, model: resolved.model.id });
        }
        atomicJson(path.join(root, "expected-role-identities.json"), roles);
        // Read only normal SDK model/thinking selectors; never dump settings or credential material.
        // All parent settings writes and conversation bytes stay in this disposable root.
        const normalSettings = SettingsManager.create(REPOSITORY);
        const provider = normalSettings.getDefaultProvider();
        const alias = normalSettings.getDefaultModel();
        if (provider === undefined || alias === undefined)
          throw new Error(
            "Normal parent defaultProvider/defaultModel must be explicitly configured; no guessed fallback"
          );
        const resolved = resolveCliModel({
          cliProvider: provider,
          cliModel: alias,
          modelRuntime: runtime,
        });
        if (
          resolved.model === undefined ||
          resolved.error !== undefined ||
          resolved.warning !== undefined ||
          resolved.model.provider !== provider ||
          (resolved.model.id !== alias && resolved.model.name !== alias)
        )
          throw new Error(
            "Normal configured parent identity is unavailable or ambiguous; no fallback permitted"
          );
        parentIdentity = { provider: resolved.model.provider, model: resolved.model.id };
        atomicJson(path.join(root, "parent-model-selection.json"), {
          source:
            "ordinary SDK SettingsManager repository defaults; exact registered ID or catalog name only",
          alias,
          ...parentIdentity,
        });
        const thinking = normalSettings.getDefaultThinkingLevel();
        const settingsManager = SettingsManager.inMemory({
          cacheWarming: "off",
          ...(thinking === undefined ? {} : { defaultThinkingLevel: thinking }),
          modelThinkingLevels: normalSettings.getAllModelThinkingLevels(),
        });
        initTheme("dark", false);
        const loader = new DefaultResourceLoader({
          cwd: project,
          agentDir: path.join(root, "parent-agent"),
          settingsManager,
          // Focused SDK parent: load the original shipping extension through Pi's loader.
          // No ambient primary memory/diary extensions, replacement factories or skill overrides.
          noExtensions: true,
          additionalExtensionPaths: [path.join(REPOSITORY, ".pi/extensions/skill/index.ts")],
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [
            (pi) => {
              pi.on("before_agent_start", (event) => {
                if (event.messageType === "user") {
                  nativePrompts.push(event.prompt);
                  atomicBytes(
                    path.join(root, "native-expansions", `${nativePrompts.length}.txt`),
                    event.prompt
                  );
                  atomicBytes(
                    path.join(
                      root,
                      "parent-effective-system-prompts",
                      `${nativePrompts.length}.txt`
                    ),
                    event.systemPrompt
                  );
                }
              });
              pi.on("before_provider_request", () => {
                providerRequests += 1;
              });
              pi.on("provider_stream_event", (event) => {
                const key = `${event.provider}/${event.model}`;
                const previous = providerStreams.get(key);
                providerStreams.set(key, {
                  provider: event.provider,
                  model: event.model,
                  events: (previous?.events ?? 0) + 1,
                });
              });
              pi.on("tool_call", (event) => {
                if (
                  event.toolName === "skill" &&
                  event.parentToolCallId === undefined &&
                  admittedCalls === 0 &&
                  exactParentInvocation(event.input, cohort)
                ) {
                  admittedCalls += 1;
                  return;
                }
                blockedCalls += 1;
                errors.push(
                  "Parent attempted an altered, duplicate or out-of-scope invocation; blocked without repair"
                );
                cancellation.abort(
                  new Error("Parent invocation outside the one-scenario authorization")
                );
                return {
                  block: true,
                  reason: "Only the one exact selected invocation is authorized",
                };
              });
            },
          ],
        });
        await loader.reload();
        if (loader.getExtensions().errors.length !== 0)
          throw new Error("Parent extension resource loading failed; no provider dispatch");
        const manifest = path.join(project, ".pi/skills", step.skill_name, "SKILL.md");
        const discovered = loader
          .getSkills()
          .skills.filter((skill) => skill.name === step.skill_name);
        if (discovered.length !== 1 || discovered[0]?.filePath !== manifest)
          throw new Error("Selected original skill manifest not discovered exactly by SDK");
        const body = parseFrontmatter(readFileSync(manifest, "utf8")).body.trim();
        const expectedExpansion = `<skill name="${step.skill_name}" location="${manifest}">\nReferences are relative to ${path.dirname(manifest)}.\n\n${body}\n</skill>\n\n${request}`;
        atomicBytes(path.join(root, "expected-native-expansion.txt"), expectedExpansion);
        const manager = SessionManager.create(project, path.join(root, "parent-sessions"));
        const created = await createAgentSession({
          cwd: project,
          agentDir: path.join(root, "parent-agent"),
          modelRuntime: runtime,
          model: resolved.model,
          settingsManager,
          sessionManager: manager,
          resourceLoader: loader,
          tools: ["skill"],
        });
        parent = created.session;
        const session = parent;
        abortParent = () => {
          void session.abort().catch((error: unknown) => errors.push(safeError(error)));
        };
        cancellation.signal.addEventListener("abort", abortParent, { once: true });
        unsubscribe = session.subscribe((event) => {
          if (event.type === "tool_execution_start" && event.toolName === "skill")
            dispatches.push({ toolCallId: event.toolCallId, args: structuredClone(event.args) });
          if (event.type === "tool_execution_end" && event.toolName === "skill") {
            outcomes.push({
              toolCallId: event.toolCallId,
              isError: event.isError,
              result: structuredClone(event.result),
            });
            result = event.result;
            atomicJson(path.join(root, "skill-result.json"), event.result);
          }
          if (event.type === "tool_execution_update" && event.toolName === "skill") {
            const update: unknown = event.partialResult;
            if (isRecord(update) && isRecord(update.details))
              console.log(
                `ordinary-live progress ${canonicalJson({ stage: update.details.stage ?? null, state: update.details.state_id ?? null })}`
              );
          }
        });
        await session.bindExtensions({
          mode: "json",
          onError: (error) => errors.push(safeError(error)),
        });
        if (
          errors.length > 0 ||
          session.getActiveToolNames().join(",") !== "skill" ||
          session.model?.provider !== parentIdentity.provider ||
          session.model.id !== parentIdentity.model
        )
          throw new Error(
            "Parent normal extension binding/model/tool selection failed; no provider dispatch"
          );
        atomicBytes(path.join(root, "parent-system-prompt.before.txt"), session.systemPrompt);
        cancellation.signal.throwIfAborted();
        try {
          await session.prompt(literalPrompt);
        } catch (error) {
          errors.push(safeError(error));
        } finally {
          await session.waitForIdle();
          try {
            const observation = {
              literal_prompt: readFileSync(path.join(root, "parent-prompt.txt"), "utf8"),
              native_prompts: nativePrompts,
              provider_requests: providerRequests,
              provider_streams: [...providerStreams.values()],
              dispatches,
              outcomes,
              blocked_calls: blockedCalls,
            };
            atomicJson(path.join(root, "parent-observations.json"), observation);
            const file = manager.getSessionFile();
            if (file === undefined || !existsSync(file)) {
              errors.push("Actual parent session file absent; no entrypoint evidence");
            } else {
              atomicBytes(path.join(root, "exact-parent-session.jsonl"), readFileSync(file));
              parentEvidence = inspectParentSession(
                file,
                cohort,
                parentIdentity,
                expectedExpansion,
                observation
              );
              checks.push(...parentEvidence.checks);
            }
          } catch (error) {
            errors.push(safeError(error));
          }
        }
        checks.push({
          name: "public tool reports exactly the selected successful cohort",
          passed: publicResultMatches(result, cohort),
          detail:
            "Public result checked independently from persisted terminals and semantic oracles",
        });
      } catch (error) {
        errors.push(safeError(error));
      } finally {
        try {
          try {
            captureRunEvidence();
          } catch (error) {
            errors.push(safeError(error));
          }
          try {
            if (ownerState !== undefined) {
              for (const file of filesUnder(ownerState.paths.root)) {
                // Host receipt signing keys are secrets, even in a synthetic project.
                if (file === ownerState.paths.orchestration.receiptKey) continue;
                atomicBytes(
                  path.join(root, "exact-state", path.relative(ownerState.paths.root, file)),
                  readFileSync(file)
                );
              }
            }
          } catch (error) {
            errors.push(safeError(error));
          }
          checks.push(
            ...sessions.flatMap((session) =>
              session.checks.map((check) => ({
                ...check,
                name: `${session.run_id}/${session.state}: ${check.name}`,
              }))
            )
          );
          try {
            const after = sourceHashes.map((item) =>
              sourceHash(REPOSITORY, path.join(REPOSITORY, item.path))
            );
            atomicJson(path.join(root, "source-hashes.after.json"), after);
            checks.push({
              name: "source snapshot unchanged during cohort",
              passed:
                sourceHashes.length > 0 &&
                sourceHashes.every((item, index) => item.sha256 === after[index]?.sha256),
              detail: "Concurrent source changes invalidate binding claims; hashes preserved",
            });
            checks.push({
              name: "same frozen compiled generation after parent and workers",
              passed: (() => {
                assertExpectedGeneration(expectedGeneration, assertCurrentShippingBuild());
                return true;
              })(),
              detail: expectedGeneration,
            });
          } catch (error) {
            errors.push(safeError(error));
          }
          const guardEvents = (
            existsSync(path.join(root, "worker-guard-events"))
              ? filesUnder(path.join(root, "worker-guard-events"))
              : []
          )
            .map((file): unknown => JSON.parse(readFileSync(file, "utf8")))
            .filter(isRecord);
          checks.push({
            name: "worker guard bound every session and denied no actions (denials fail, never repair)",
            passed:
              sessions.length > 0 &&
              !guardEvents.some((event) => event.kind === "deny") &&
              sessions.every((session) => {
                const header: unknown = JSON.parse(
                  readFileSync(session.file, "utf8").split("\n")[0] ?? "null"
                );
                return (
                  isRecord(header) &&
                  guardEvents.some(
                    (event) => event.kind === "bound" && event.session_id === header.id
                  )
                );
              }),
            detail: `bound=${guardEvents.filter((event) => event.kind === "bound").length}; denied=${guardEvents.filter((event) => event.kind === "deny").length}`,
          });
          atomicJson(path.join(root, "report.json"), {
            schema_version: 1,
            research_fetch_policy: CURRENT_RESEARCH_FETCH_POLICY,
            cohort: selection,
            mode: cohort.mode,
            source_freeze:
              "Parent-attested opt-in plus before/after real shipping-build checks against the explicit caller expected generation; source/compiled hashes retained. Not a signed build attestation.",
            import_boundary:
              "Harness observers, registry, native validators and public extension use the same compiled generation. Runtime freshness guards verify source/helper/output correspondence; hashes are not signed attestation.",
            root,
            process_id: process.pid,
            entrypoint:
              "fresh Vitest process -> literal /skill:<name> -> SDK native expansion -> real parent model toolCall -> normal bound shipping skill tool -> compiled engine/workers",
            parent_scope:
              "Focused SDK parent with the unchanged shipping skill extension, normal bindExtensions(json), native skill discovery and one active skill tool; not full ambient primary extensions or TUI qualification",
            parent_identity: parentIdentity ?? null,
            project_trust:
              "Normal SDK in-memory settings trust only the caller-authorized synthetic public project; no real trust records or ExtensionContext overrides",
            parent_evidence: parentEvidence ?? null,
            provider_boundary:
              "No harness-installed service/model/SDK mocks, spies, replacement factories or worker model overrides",
            identity_evidence:
              "SDK model_change and completed assistant message provider/model, checked independently against normal ModelRuntime catalog alias resolution; not remote-server hardware attestation",
            credentials:
              "Normal SDK runtime lookup retained; auth/config/credential files never copied or changed by the harness. SDK credential refresh/cache writes remain ordinary live-provider authentication, not evidence of secrecy or sandboxing.",
            campaign_boundary:
              "Current user scope: ONE single scenario per each of seven ordinary skills. One selection per fresh process, no repeats. Cross-process enforcement belongs to the campaign operator ledger. Legacy parallel/chain/fan-in operands remain offline only; native live modes NOT IMPLEMENTED.",
            baseline_limit:
              "The saved pre-edit harness baseline is offline only. No live execution or generation-final claim follows from offline contracts; broad/conformance aggregates are not rerun by this harness correction.",
            containment:
              "Fixed trusted SDK consuming synthetic inputs; test-only normally discovered worker tool_call gate binds owner metadata/continuity to this project/run and unchanged catalog tools. Default-deny except assigned current-run artifact reads and exact RFC4180 fetch by Research Echo/researching or Vera/validating phase workers. Denials abort and fail the scenario without repair. This gates model tool actions, including delegated calls; it is NOT OS/process isolation or a constraint on trusted extension/SDK internals, provider transport/redirects or normal auth/cache behavior. SIGINT/SIGTERM and production renewable inactivity leases retained; no invented call/repair/elapsed caps",
            roles,
            sessions,
            runs,
            checks,
            errors,
            passed: errors.length === 0 && checks.length > 0 && checks.every((item) => item.passed),
            not_run: [
              ...COHORTS.filter((item) => item !== selection),
              "cancellation qualification (SIGINT/SIGTERM forwarding is only an operator stop hook, not tested live cancellation evidence)",
              "chain resume (no faithful live pause/failure-and-reopen experiment implemented here)",
              "restart (same-process observer reopen is not workflow restart qualification)",
              "clarification",
              "forced compaction qualification",
              "child workflows",
              "F09/F10 fixture integration is NOT live evidence",
              "broad aggregates",
            ],
          });
        } finally {
          if (abortParent !== undefined)
            cancellation.signal.removeEventListener("abort", abortParent);
          unsubscribe?.();
          stopWorkerGuardObservation?.();
          parent?.dispose();
          process.chdir(originalCwd);
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
          for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
      expect(errors, `Safe errors; evidence: ${root}`).toEqual([]);
      expect(
        checks.filter((item) => !item.passed),
        `Failed independent checks; evidence: ${root}`
      ).toEqual([]);
      expect(sessions.length).toBeGreaterThan(0);
    }, 0);
  }
);
