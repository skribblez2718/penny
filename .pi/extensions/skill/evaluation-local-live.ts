import path from "node:path";
import { performance } from "node:perf_hooks";

import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  ArtifactRefSchema,
  ArtifactStore,
  PiAgentClient,
  canonicalJson,
  resolvePennyRuntimeState,
  sha256,
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "@penny/orchestration/source";

import {
  validatePairedEvaluationPlan,
  type PairedEvaluationPlanV1,
} from "./evaluation-contracts.js";
import { executeArtifactRead, loadArtifactRuntimeConfig } from "../artifacts/artifact-runtime.js";
import {
  InvalidEvaluationFault,
  type EvaluationModelClientFactoryV1,
  type EvaluationPreflightInputV1,
  type EvaluationRuntimeBindingV1,
  type EvaluationRuntimeMeasurementV1,
  type MeasuredEvaluationModelClientV1,
} from "./evaluation-runner.js";
import {
  PreauthorizedIndependentSemanticReviewExecutorV1,
  type EvaluationOperatorApprovalVerifierV1,
  type PiSemanticReviewModelResolverV1,
  type PiSemanticReviewTestTransportV1,
} from "./evaluation-semantic-review.js";

const LOCAL_LIVE_ENV = "PENNY_EVALUATION_LOCAL_LIVE";
const LOCAL_LIVE_PROVIDER = "ollama";
const LOCAL_PREFLIGHT_TIMEOUT_MS = 15_000;
const MAX_OLLAMA_TAGS_RESPONSE_BYTES = 1_048_576;
const MAX_OLLAMA_TAG_COUNT = 4_096;
const MAX_OLLAMA_TAG_FIELD_LENGTH = 512;

const ArtifactReadPreflightPayloadV1Schema = Type.Object(
  {
    schema_version: Type.Literal(2),
    ok: Type.Literal(true),
    type: Type.Literal("artifact_read"),
    artifact_ref: ArtifactRefSchema,
    phase: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1 }),
    producer: Type.String({ minLength: 1 }),
    media_type: Type.String({ minLength: 1 }),
    total_bytes: Type.Integer({ minimum: 0 }),
    requested_range: Type.Object(
      { start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false }
    ),
    returned_range: Type.Object(
      { start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false }
    ),
    returned_bytes: Type.Integer({ minimum: 0 }),
    content_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    content: Type.String(),
    truncated: Type.Literal(false),
    next_range: Type.Null(),
  },
  { additionalProperties: false }
);

export interface LocalLiveEvaluationStateBindingV1 {
  readonly state_root: string;
  readonly project_id: string;
  readonly artifact_root: string;
}

export interface LocalLiveModelDescriptorV1 {
  readonly provider: string;
  readonly model: string;
  readonly base_url: string;
  readonly rates: EvaluationRuntimeBindingV1["rates"];
}

export interface LocalLiveModelPreflightV1 {
  readonly provider: string;
  readonly model: string;
  readonly model_id: string;
  readonly base_url: string;
  readonly runtime: string;
  readonly thinking_level: EvaluationRuntimeBindingV1["thinking_level"];
  readonly rates: EvaluationRuntimeBindingV1["rates"];
  readonly locality: "loopback";
  readonly provider_available: true;
}

export interface ResolvedLocalLiveModelV1 {
  readonly preflight: LocalLiveModelPreflightV1;
  readonly model: Model<Api>;
}

export interface LocalLiveModelCatalogV1 {
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
}

export interface LocalLiveModelPreflightDependenciesV1 {
  readonly createCatalog: (signal: AbortSignal) => Promise<LocalLiveModelCatalogV1>;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

interface OllamaTagV1 {
  readonly name: string;
  readonly model: string;
  readonly remote_model?: string;
  readonly remote_host?: string;
}

function normalizedAbsoluteStateRoot(raw: string | undefined): string {
  const value = raw?.trim();
  if (value === undefined || value.length === 0 || !path.isAbsolute(value)) {
    throw new InvalidEvaluationFault(
      "artifact_read_preflight",
      "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE",
      null
    );
  }
  return path.resolve(value);
}

export function bindLocalLiveEvaluationState(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly processEnv?: NodeJS.ProcessEnv;
}): LocalLiveEvaluationStateBindingV1 {
  try {
    normalizedAbsoluteStateRoot(input.env.PENNY_STATE_ROOT);
    const host = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
    const hostRoot = path.resolve(host.state.root);
    const processEnv = input.processEnv ?? process.env;
    const selectedProcessRoot = processEnv.PENNY_STATE_ROOT?.trim();
    if (selectedProcessRoot === undefined || selectedProcessRoot.length === 0) {
      processEnv.PENNY_STATE_ROOT = hostRoot;
    } else if (normalizedAbsoluteStateRoot(selectedProcessRoot) !== hostRoot) {
      throw new InvalidEvaluationFault(
        "artifact_read_preflight",
        "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE",
        null
      );
    }
    const toolState = resolvePennyRuntimeState(input.projectRoot, { env: processEnv });
    const toolConfig = loadArtifactRuntimeConfig(input.projectRoot, processEnv);
    if (
      path.resolve(toolState.state.root) !== hostRoot ||
      toolState.projectId !== host.projectId ||
      toolConfig.projectId !== host.projectId ||
      path.normalize(toolState.paths.artifacts.root) !==
        path.normalize(host.paths.artifacts.root) ||
      path.normalize(toolConfig.artifactRoot) !== path.normalize(host.paths.artifacts.root)
    ) {
      throw new InvalidEvaluationFault(
        "artifact_read_preflight",
        "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE",
        null
      );
    }
    return {
      state_root: hostRoot,
      project_id: host.projectId,
      artifact_root: host.paths.artifacts.root,
    };
  } catch (error) {
    if (error instanceof InvalidEvaluationFault) throw error;
    throw new InvalidEvaluationFault(
      "artifact_read_preflight",
      "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE",
      null,
      error
    );
  }
}

export async function preflightLocalLiveArtifactRead(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly frozen: EvaluationPreflightInputV1["frozen"];
}): Promise<void> {
  try {
    const processEnv = input.processEnv ?? process.env;
    const binding = bindLocalLiveEvaluationState({
      projectRoot: input.projectRoot,
      env: input.env,
      processEnv,
    });
    const identitySha256 = sha256(
      canonicalJson({
        plan_id: input.frozen.plan_id,
        schedule_sha256: input.frozen.schedule_sha256,
      })
    );
    const sentinelBytes = canonicalJson({
      schema_version: 1,
      plan_id: input.frozen.plan_id,
      schedule_sha256: input.frozen.schedule_sha256,
    });
    using artifacts = ArtifactStore.openExisting(binding.artifact_root, {
      projectId: binding.project_id,
    });
    const sentinelRef = artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: `evaluation-preflight-${identitySha256.slice(0, 32)}`,
        phase: "evaluation",
        branch_id: null,
        kind: "evaluation-preflight",
        operation_id: `artifact-read-preflight:${identitySha256}`,
        version: 1,
        producer: "host:evaluation-runner",
        media_type: "application/json",
        content_schema: {
          schema_id: "penny.evaluation-artifact-read-preflight.v1",
          schema_version: 1,
        },
        parent_ref: null,
        upstream_refs: [],
      },
      content: sentinelBytes,
    });
    const hostRef = artifacts.refById(sentinelRef.artifact_id);
    if (
      hostRef === undefined ||
      canonicalJson(hostRef) !== canonicalJson(sentinelRef) ||
      artifacts.readById(sentinelRef.artifact_id).toString("utf8") !== sentinelBytes
    ) {
      throw new Error("host sentinel re-read diverged");
    }
    const toolConfig = loadArtifactRuntimeConfig(input.projectRoot, processEnv);
    const execution = await executeArtifactRead(toolConfig, {
      artifact: sentinelRef.artifact_id,
    });
    if (execution.code !== "OK" || execution.result.content.length !== 1) {
      throw new Error("model-visible artifact_read did not return one successful payload");
    }
    const text = execution.result.content[0]?.text;
    if (text === undefined) throw new Error("model-visible artifact_read payload is absent");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("model-visible artifact_read payload is not JSON");
    }
    const payload = validateContract(
      ArtifactReadPreflightPayloadV1Schema,
      parsed,
      "local-live artifact_read preflight payload"
    );
    const byteLength = Buffer.byteLength(sentinelBytes);
    if (
      canonicalJson(payload.artifact_ref) !== canonicalJson(sentinelRef) ||
      payload.content !== sentinelBytes ||
      payload.content_digest !== sentinelRef.content_digest ||
      payload.total_bytes !== byteLength ||
      payload.returned_bytes !== byteLength ||
      payload.requested_range.start !== 0 ||
      payload.requested_range.end !== byteLength ||
      payload.returned_range.start !== 0 ||
      payload.returned_range.end !== byteLength ||
      payload.truncated !== false ||
      payload.next_range !== null
    ) {
      throw new Error("model-visible artifact_read sentinel verification diverged");
    }
  } catch (error) {
    if (
      error instanceof InvalidEvaluationFault &&
      error.code === "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE"
    ) {
      throw error;
    }
    throw new InvalidEvaluationFault(
      "artifact_read_preflight",
      "LOCAL_LIVE_ARTIFACT_READ_PREFLIGHT_FAILED",
      null,
      error
    );
  }
}

export function assertLocalLiveOptIn(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly cliOptIn: boolean;
}): void {
  if (input.cliOptIn !== true || input.env[LOCAL_LIVE_ENV] !== "1") {
    throw new Error(
      `local-live evaluation requires both --execute-local-live and ${LOCAL_LIVE_ENV}=1`
    );
  }
}

function assertZeroRateCard(rates: EvaluationRuntimeBindingV1["rates"]): void {
  if (Object.values(rates).some((rate) => rate !== 0)) {
    throw new Error("local-live evaluation requires an exact USD 0.00 model rate card");
  }
}

function loopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("local-live model base URL is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  ) {
    throw new Error("local-live model base URL must be credential-free HTTP loopback");
  }
  return url;
}

function rateCard(model: Model<Api>): EvaluationRuntimeBindingV1["rates"] {
  return {
    input_usd_per_million_tokens: model.cost.input,
    output_usd_per_million_tokens: model.cost.output,
    cache_read_usd_per_million_tokens: model.cost.cacheRead,
    cache_write_usd_per_million_tokens: model.cost.cacheWrite,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedTagField(value: Record<string, unknown>, field: "name" | "model"): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_OLLAMA_TAG_FIELD_LENGTH
  ) {
    throw new Error(`Ollama tags response has an invalid '${field}' field`);
  }
  return candidate;
}

function optionalBoundedTagField(
  value: Record<string, unknown>,
  field: "remote_model" | "remote_host"
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_OLLAMA_TAG_FIELD_LENGTH
  ) {
    throw new Error(`Ollama tags response has an invalid '${field}' field`);
  }
  return candidate;
}

function parseOllamaTags(value: unknown): readonly OllamaTagV1[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new Error("Ollama tags response must contain a models array");
  }
  if (value.models.length > MAX_OLLAMA_TAG_COUNT) {
    throw new Error("Ollama tags response contains too many models");
  }
  return value.models.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Ollama tags response contains a malformed model");
    const remoteModel = optionalBoundedTagField(candidate, "remote_model");
    const remoteHost = optionalBoundedTagField(candidate, "remote_host");
    return {
      name: boundedTagField(candidate, "name"),
      model: boundedTagField(candidate, "model"),
      ...(remoteModel === undefined ? {} : { remote_model: remoteModel }),
      ...(remoteHost === undefined ? {} : { remote_host: remoteHost }),
    };
  });
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      throw new Error("Ollama tags response has an invalid content length");
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_OLLAMA_TAGS_RESPONSE_BYTES) {
      throw new Error("Ollama tags response exceeds the byte limit");
    }
  }
  if (response.body === null) throw new Error("Ollama tags response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteCount += result.value.byteLength;
    if (byteCount > MAX_OLLAMA_TAGS_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Ollama tags response exceeds the byte limit");
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

function assertExactLocalOllamaTag(tags: readonly OllamaTagV1[], expectedModel: string): void {
  const matches = tags.filter(
    (candidate) => candidate.name === expectedModel || candidate.model === expectedModel
  );
  if (matches.length === 0) {
    throw new Error("frozen local-live model is not installed in the loopback Ollama runtime");
  }
  if (matches.length !== 1) {
    throw new Error("frozen local-live model has ambiguous Ollama tag identities");
  }
  const match = matches[0];
  if (match === undefined || match.name !== expectedModel || match.model !== expectedModel) {
    throw new Error("Ollama tag identity does not exactly match the frozen local-live model");
  }
  if (
    expectedModel.endsWith(":cloud") ||
    match.remote_model !== undefined ||
    match.remote_host !== undefined
  ) {
    throw new Error("frozen local-live model resolves to a remote Ollama tag");
  }
}

async function queryExactLocalOllamaTag(input: {
  readonly baseUrl: URL;
  readonly expectedModel: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
}): Promise<void> {
  const tagsUrl = new URL("/api/tags", input.baseUrl.origin);
  let response: Response;
  try {
    response = await input.fetch(tagsUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: input.signal,
    });
  } catch (cause) {
    throw new Error(
      input.signal.aborted
        ? "loopback Ollama tags preflight timed out"
        : "loopback Ollama tags preflight request failed",
      { cause }
    );
  }
  if (!response.ok) {
    throw new Error(`loopback Ollama tags preflight returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) {
    throw new Error("loopback Ollama tags preflight did not return JSON");
  }
  let text: string;
  try {
    text = await readBoundedResponseText(response);
  } catch (cause) {
    throw new Error(
      input.signal.aborted
        ? "loopback Ollama tags preflight timed out"
        : "loopback Ollama tags preflight response failed",
      { cause }
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("loopback Ollama tags preflight returned malformed JSON", { cause });
  }
  assertExactLocalOllamaTag(parseOllamaTags(value), input.expectedModel);
}

function defaultPreflightDependencies(): LocalLiveModelPreflightDependenciesV1 {
  return {
    createCatalog: (signal) =>
      ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        allowModelNetwork: false,
        refreshOnCreate: false,
        signal,
      }),
    fetch: globalThis.fetch,
    timeoutMs: LOCAL_PREFLIGHT_TIMEOUT_MS,
  };
}

export function assertLocalLiveModelBinding(input: {
  readonly plan: PairedEvaluationPlanV1;
  readonly actualRuntime: string;
  readonly descriptor: LocalLiveModelDescriptorV1;
}): LocalLiveModelPreflightV1 {
  const plan = validatePairedEvaluationPlan(input.plan);
  const expected = plan.runtime_binding;
  if (input.actualRuntime !== expected.runtime) {
    throw new Error("local-live Node/Penny runtime does not match the frozen plan");
  }
  if (
    input.descriptor.provider !== expected.provider ||
    input.descriptor.model !== expected.model
  ) {
    throw new Error("local-live resolved model identity does not match the frozen plan");
  }
  const url = loopbackUrl(input.descriptor.base_url);
  assertZeroRateCard(expected.rates);
  if (canonicalJson(input.descriptor.rates) !== canonicalJson(expected.rates)) {
    throw new Error("local-live resolved model rates do not match the frozen plan");
  }
  return {
    provider: expected.provider,
    model: expected.model,
    model_id: `${expected.provider}/${expected.model}`,
    base_url: url.toString(),
    runtime: expected.runtime,
    thinking_level: expected.thinking_level,
    rates: expected.rates,
    locality: "loopback",
    provider_available: true,
  };
}

export async function preflightLocalLiveModel(
  input: {
    readonly plan: unknown;
    readonly actualRuntime: string;
    readonly expectedProvider: string;
    /** Optional live-calibration authorization gate; runs before catalog/model/provider access. */
    readonly semanticAuthorizationPreflight?: () => Promise<{
      readonly manifest: {
        readonly execution_binding: {
          readonly provider: string;
          readonly model: string;
          readonly runtime: string;
          readonly thinking_level: string;
        };
      };
    }>;
  },
  dependencies: LocalLiveModelPreflightDependenciesV1 = defaultPreflightDependencies()
): Promise<ResolvedLocalLiveModelV1> {
  const semanticAuthorization = await input.semanticAuthorizationPreflight?.();
  const plan = validatePairedEvaluationPlan(input.plan);
  if (
    semanticAuthorization !== undefined &&
    canonicalJson(semanticAuthorization.manifest.execution_binding) !==
      canonicalJson({
        provider: plan.runtime_binding.provider,
        model: plan.runtime_binding.model,
        runtime: plan.runtime_binding.runtime,
        thinking_level: plan.runtime_binding.thinking_level,
      })
  ) {
    throw new Error("local-live model binding differs from semantic authorization");
  }
  if (
    input.expectedProvider !== LOCAL_LIVE_PROVIDER ||
    plan.runtime_binding.provider !== input.expectedProvider
  ) {
    throw new Error("local-live provider differs from the caller-authorized Ollama provider");
  }
  if (plan.runtime_binding.model.endsWith(":cloud")) {
    throw new Error("local-live evaluation refuses remote Ollama model tags");
  }
  assertZeroRateCard(plan.runtime_binding.rates);
  if (
    !Number.isSafeInteger(dependencies.timeoutMs) ||
    dependencies.timeoutMs < 1 ||
    dependencies.timeoutMs > LOCAL_PREFLIGHT_TIMEOUT_MS
  ) {
    throw new Error("local-live preflight timeout is outside the allowed bound");
  }
  const signal = AbortSignal.timeout(dependencies.timeoutMs);
  const catalog = await dependencies.createCatalog(signal);
  const model = catalog.getModel(plan.runtime_binding.provider, plan.runtime_binding.model);
  if (model === undefined) {
    throw new Error("frozen local-live model is absent from the current Pi model catalog");
  }
  const preflight = assertLocalLiveModelBinding({
    plan,
    actualRuntime: input.actualRuntime,
    descriptor: {
      provider: model.provider,
      model: model.id,
      base_url: model.baseUrl,
      rates: rateCard(model),
    },
  });
  await queryExactLocalOllamaTag({
    baseUrl: loopbackUrl(model.baseUrl),
    expectedModel: model.id,
    fetch: dependencies.fetch,
    signal,
  });
  return { preflight, model };
}

export class PinnedLocalLiveMeasuredModelClient implements MeasuredEvaluationModelClientV1 {
  private elapsedMs = 0;
  private invocations = 0;

  constructor(
    readonly runtime_binding: EvaluationRuntimeBindingV1,
    private readonly client: ModelClient
  ) {
    assertZeroRateCard(runtime_binding.rates);
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const started = performance.now();
    this.invocations += 1;
    try {
      return await this.client.runAgent({
        ...invocation,
        modelOverride: `${this.runtime_binding.provider}/${this.runtime_binding.model}`,
        thinkingLevel: this.runtime_binding.thinking_level,
        admitResolvedModel: (resolved) => {
          if (
            resolved.provider !== this.runtime_binding.provider ||
            resolved.model !== this.runtime_binding.model
          ) {
            throw new Error("local-live invocation resolved outside the frozen model binding");
          }
          invocation.admitResolvedModel?.(resolved);
        },
      });
    } finally {
      this.elapsedMs += performance.now() - started;
    }
  }

  measurement(_runId: string): EvaluationRuntimeMeasurementV1 {
    return {
      cost_microusd: 0,
      latency_ms: this.invocations === 0 ? 0 : Math.max(1, Math.ceil(this.elapsedMs)),
      loopback_provider_calls: this.invocations,
    };
  }
}

export function createLocalLiveSemanticReviewExecutorV1(
  input: {
    readonly projectRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cliOptIn: boolean;
    readonly manifest: unknown;
    readonly expectedManifest: unknown;
    readonly approval: unknown;
    readonly ownerVerifier: EvaluationOperatorApprovalVerifierV1;
    readonly packageJournalPresent: boolean;
    readonly now?: () => Date;
  },
  dependencies: {
    readonly resolveModel: PiSemanticReviewModelResolverV1;
    readonly testOnlyTransport?: PiSemanticReviewTestTransportV1;
  }
): PreauthorizedIndependentSemanticReviewExecutorV1 {
  return new PreauthorizedIndependentSemanticReviewExecutorV1({
    projectRoot: input.projectRoot,
    env: input.env,
    cliOptIn: input.cliOptIn,
    manifest: input.manifest,
    expectedManifest: input.expectedManifest,
    approval: input.approval,
    ownerVerifier: input.ownerVerifier,
    packageJournalPresent: input.packageJournalPresent,
    ...(input.now === undefined ? {} : { now: input.now }),
    resolveModel: dependencies.resolveModel,
    ...(dependencies.testOnlyTransport === undefined
      ? {}
      : { testOnlyTransport: dependencies.testOnlyTransport }),
  });
}

export function localLiveModelClientFactory(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly resolved: ResolvedLocalLiveModelV1;
}): EvaluationModelClientFactoryV1 {
  const processEnv = process.env;
  const initialBinding = bindLocalLiveEvaluationState({
    projectRoot: input.projectRoot,
    env: input.env,
    processEnv,
  });
  let artifactReadPreflightSucceeded = false;
  const createClient = ({ plan }: Parameters<EvaluationModelClientFactoryV1>[0]) => {
    if (!artifactReadPreflightSucceeded) {
      throw new InvalidEvaluationFault(
        "artifact_read_preflight",
        "LOCAL_LIVE_ARTIFACT_READ_PREFLIGHT_FAILED",
        null
      );
    }
    const currentBinding = bindLocalLiveEvaluationState({
      projectRoot: input.projectRoot,
      env: input.env,
      processEnv,
    });
    if (canonicalJson(currentBinding) !== canonicalJson(initialBinding)) {
      throw new InvalidEvaluationFault(
        "artifact_read_preflight",
        "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE",
        null
      );
    }
    const state = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
    const runtimeBinding = validatePairedEvaluationPlan(plan).runtime_binding;
    const projected = {
      provider: input.resolved.preflight.provider,
      model: input.resolved.preflight.model,
      runtime: input.resolved.preflight.runtime,
      thinking_level: input.resolved.preflight.thinking_level,
      rates: input.resolved.preflight.rates,
    };
    if (canonicalJson(runtimeBinding) !== canonicalJson(projected)) {
      throw new Error("local-live client factory received a drifted runtime binding");
    }
    const modelId = `${runtimeBinding.provider}/${runtimeBinding.model}`;
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: state.projectId,
        root: state.paths.subagentSessions,
      },
      resolveModel: (requested) => {
        if (requested !== modelId) {
          throw new Error("local-live client refused a non-frozen model override");
        }
        return input.resolved.model;
      },
    });
    return new PinnedLocalLiveMeasuredModelClient(runtimeBinding, client);
  };
  return Object.assign(createClient, {
    preflight: async ({ frozen }: EvaluationPreflightInputV1) => {
      artifactReadPreflightSucceeded = false;
      await preflightLocalLiveArtifactRead({
        projectRoot: input.projectRoot,
        env: input.env,
        processEnv,
        frozen,
      });
      const currentBinding = bindLocalLiveEvaluationState({
        projectRoot: input.projectRoot,
        env: input.env,
        processEnv,
      });
      if (canonicalJson(currentBinding) !== canonicalJson(initialBinding)) {
        throw new InvalidEvaluationFault(
          "artifact_read_preflight",
          "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE",
          null
        );
      }
      artifactReadPreflightSucceeded = true;
    },
  });
}
