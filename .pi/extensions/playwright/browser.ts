/**
 * Playwright Extension — BrowserManager
 *
 * A stable singleton facade dispatches every operation to an immutable
 * owner/invocation policy scope. Restricted scopes use separate browser
 * processes and contexts so launch-scoped settings cannot cross policy
 * boundaries.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type PageScreenshotOptions,
  type Request,
  type Route,
} from "playwright";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "../../lib/logger/logger.js";
import { loadConfig } from "./config.js";
import {
  authorizeNetworkUrl,
  describeBrowserDestination,
  MAX_BROWSER_URL_CHARS,
  effectiveBrowserPolicyBinding,
  networkPolicySignature,
  parseConfiguredNetworkPolicy,
  type EffectiveBrowserPolicyBinding,
  type NetworkPolicy,
} from "./network-policy.js";
import type { PlaywrightConfig, ProxyConfig, BrowserState, SnapshotNode } from "./types.js";

const logger = createLogger("playwright:browser");

export const BROWSER_POLICY_SETUP_TIMEOUT_MS = 5_000;
export const BROWSER_CLEANUP_TIMEOUT_MS = 5_000;
export const BROWSER_FORCE_KILL_TIMEOUT_MS = 5_000;
export const BROWSER_DISCONNECT_OBSERVATION_TIMEOUT_MS = 1_000;
export const MAX_RESTRICTED_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_POLICY_SCOPES = 32;
export const MAX_BROWSER_POLICY_BINDINGS = 128;

const RESTRICTED_RUNTIME_GUARD_SCRIPT = `(() => {
  for (const name of [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "WebTransport",
    "Worker",
    "SharedWorker",
  ]) {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
})();`;

interface CdpWebSocketHandle {
  unref(): void;
}

interface PlaywrightConnectionAdapter {
  toImpl(value: unknown): unknown;
}

interface CleanupSignal {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface OwnedBrowserProcess {
  readonly process: ChildProcess;
  readonly exitSignal: CleanupSignal;
  exitObserved: boolean;
}

class ScopeMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release = (): void => {};
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    })();
  }
}

type BrowserScopeLifecycle = "active" | "closing" | "termination-unconfirmed" | "retired";

interface BrowserScopeState {
  readonly key: string;
  readonly scopeTag: string;
  readonly binding: EffectiveBrowserPolicyBinding;
  readonly userDataDir: string;
  browser: Browser | null;
  browserProcess: ChildProcess | null;
  context: BrowserContext | null;
  pages: Page[];
  activePageIdx: number;
  readonly pagePolicySetups: Map<Page, Promise<void>>;
  readonly cdpSessions: Map<Page, CDPSession>;
  readonly policyReadyBeforeNavigation: Set<Page>;
  readonly ownedProcesses: Map<ChildProcess, OwnedBrowserProcess>;
  readonly operationMutex: ScopeMutex;
  browserDisconnectObserved: boolean;
  browserDisconnectSignal: CleanupSignal;
  lifecycle: BrowserScopeLifecycle;
  launchPromise: Promise<void> | null;
  cleanupPromise: Promise<void> | null;
  launchError: string | null;
}

interface BrowserPolicyBindingRecord {
  readonly signature: string;
  readonly invocationPolicyPresent: boolean;
}

export type RestrictedBrowserOperation =
  | "page-request-routing"
  | "proxy-mutation"
  | "proxy-reachability-check"
  | "unsafe-code"
  | "raw-browser-access";

export interface BrowserPolicyStatus {
  readonly mode: NetworkPolicy["mode"];
  readonly canonicalPatterns: readonly string[];
  readonly scopeTag: string;
  readonly invocationPolicyPresent: boolean;
  readonly processCeilingMode: NetworkPolicy["mode"];
}

export interface BrowserScopeHandle {
  readonly ownerScopeId: string;
  readonly invocationId: string;
  readonly invocationPolicyPresent: boolean;
  readonly policySignature: string;
}

export interface BrowserManagerTestingHooks {
  readonly beforeRestrictedPolicySetup?: () => void;
  readonly beforeGracefulCleanup?: () => Promise<void>;
  readonly onBrowserProcessOwned?: (browserProcess: ChildProcess) => void;
}

export class BrowserPolicyViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserPolicyViolationError";
    this.code = code;
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCdpWebSocketHandle(value: unknown): value is CdpWebSocketHandle {
  return isUnknownRecord(value) && typeof value.unref === "function";
}

function isPlaywrightConnectionAdapter(value: unknown): value is PlaywrightConnectionAdapter {
  return isUnknownRecord(value) && typeof value.toImpl === "function";
}

function isChildProcess(value: unknown): value is ChildProcess {
  return (
    isUnknownRecord(value) &&
    typeof value.kill === "function" &&
    typeof value.once === "function" &&
    typeof value.unref === "function" &&
    "exitCode" in value &&
    "signalCode" in value
  );
}

/**
 * Validated compatibility boundary for Playwright's locally launched Chromium
 * process. Returning null makes launch fail closed before a context is created.
 */
export function ownedPlaywrightBrowserProcess(browser: unknown): ChildProcess | null {
  try {
    if (!isUnknownRecord(browser)) return null;
    const connection = browser._connection;
    if (!isPlaywrightConnectionAdapter(connection)) return null;
    const implementation = connection.toImpl(browser);
    if (!isUnknownRecord(implementation)) return null;
    const options = implementation.options;
    if (!isUnknownRecord(options)) return null;
    const browserProcess = options.browserProcess;
    if (!isUnknownRecord(browserProcess)) return null;
    return isChildProcess(browserProcess.process) ? browserProcess.process : null;
  } catch {
    return null;
  }
}

function cleanupSignal(): CleanupSignal {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolver = resolvePromise;
  });
  return {
    promise,
    resolve() {
      resolver?.();
    },
  };
}

async function signalWithin(signal: CleanupSignal, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([signal.promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function childProcessExited(browserProcess: ChildProcess): boolean {
  return browserProcess.exitCode !== null || browserProcess.signalCode !== null;
}

function scopeTag(ownerScopeId: string, invocationId: string): string {
  return createHash("sha256")
    .update(ownerScopeId)
    .update("\0")
    .update(invocationId)
    .digest("hex")
    .slice(0, 16);
}

function bindingKey(binding: EffectiveBrowserPolicyBinding): string {
  return `${binding.ownerScopeId}\0${binding.invocationId}`;
}

async function withPolicySetupTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new BrowserPolicyViolationError(
          "BROWSER_POLICY_SETUP_TIMEOUT",
          `Browser policy setup exceeded ${BROWSER_POLICY_SETUP_TIMEOUT_MS}ms`
        )
      );
    }, BROWSER_POLICY_SETUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeNavigationUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length < 1) {
    throw new BrowserPolicyViolationError(
      "BROWSER_NAVIGATION_URL_INVALID",
      "Navigation URL must not be empty"
    );
  }
  if (trimmed.length > MAX_BROWSER_URL_CHARS) {
    throw new BrowserPolicyViolationError(
      "BROWSER_NETWORK_URL_TOO_LONG",
      `Navigation URL exceeds the ${MAX_BROWSER_URL_CHARS}-character limit`
    );
  }
  const hasHttpScheme = /^https?:\/\//i.test(trimmed);
  if (!hasHttpScheme && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    throw new BrowserPolicyViolationError(
      "BROWSER_NAVIGATION_SCHEME_DENIED",
      "Navigation accepts only HTTP and HTTPS URLs"
    );
  }
  const normalized = hasHttpScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new BrowserPolicyViolationError(
      "BROWSER_NAVIGATION_URL_INVALID",
      "Navigation URL is invalid"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserPolicyViolationError(
      "BROWSER_NAVIGATION_SCHEME_DENIED",
      "Navigation accepts only HTTP and HTTPS URLs"
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new BrowserPolicyViolationError(
      "BROWSER_NAVIGATION_CREDENTIALS_DENIED",
      "Credentials are not allowed in navigation URLs"
    );
  }
  return parsed.href;
}

/**
 * Best-effort adapter for Playwright's private Chromium transport chain.
 * Missing or changed private members are ignored.
 */
export function unrefPlaywrightCdpConnection(browser: unknown): boolean {
  try {
    if (!isUnknownRecord(browser)) return false;
    const connection = browser._connection;
    if (!isUnknownRecord(connection)) return false;
    const transport = connection._transport;
    if (!isUnknownRecord(transport)) return false;
    const webSocket = transport._ws;
    if (!isCdpWebSocketHandle(webSocket)) return false;
    webSocket.unref();
    return true;
  } catch {
    return false;
  }
}

export class BrowserManager {
  private static instance: BrowserManager | null = null;
  private static proxyOverride: ProxyConfig | null | undefined = undefined;

  private readonly config: PlaywrightConfig;
  private readonly processCeiling: NetworkPolicy;
  private readonly states = new Map<string, BrowserScopeState>();
  private readonly policyBindings = new Map<string, BrowserPolicyBindingRecord>();
  private defaultOwnerScopeId = "process-default";

  private constructor(
    config: PlaywrightConfig,
    private readonly testingHooks: BrowserManagerTestingHooks = {}
  ) {
    this.config = config;
    this.processCeiling = parseConfiguredNetworkPolicy(
      config.networkAllowlist,
      "immutable process browser policy"
    );
  }

  static setProxyOverride(proxy: ProxyConfig | null): void {
    BrowserManager.proxyOverride = proxy;
  }

  static getEffectiveProxy(config: PlaywrightConfig): ProxyConfig | undefined {
    if (BrowserManager.proxyOverride !== undefined) {
      return BrowserManager.proxyOverride ?? undefined;
    }
    return config.proxy;
  }

  static getBrowser(config?: PlaywrightConfig): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager(config ?? loadConfig());
    } else if (config !== undefined) {
      const nextPolicy = parseConfiguredNetworkPolicy(
        config.networkAllowlist,
        "browser manager process policy"
      );
      if (
        networkPolicySignature(BrowserManager.instance.processCeiling) !==
        networkPolicySignature(nextPolicy)
      ) {
        throw new BrowserPolicyViolationError(
          "BROWSER_PROCESS_POLICY_IMMUTABLE",
          "The process browser network policy cannot change after initialization"
        );
      }
    }
    return BrowserManager.instance;
  }

  static reset(): void {
    const instance = BrowserManager.instance;
    if (instance === null) {
      BrowserManager.proxyOverride = undefined;
      return;
    }
    if (instance.states.size === 0) {
      instance.policyBindings.clear();
      BrowserManager.instance = null;
      BrowserManager.proxyOverride = undefined;
      return;
    }
    void instance
      .cleanup()
      .then(() => {
        if (BrowserManager.instance === instance) BrowserManager.instance = null;
        BrowserManager.proxyOverride = undefined;
      })
      .catch((error: unknown) => {
        logger.error("Browser manager reset could not confirm process termination", {
          errorCode:
            error instanceof BrowserPolicyViolationError
              ? error.code
              : "BROWSER_CLEANUP_TERMINATION_UNCONFIRMED",
        });
      });
  }

  static async resetForTesting(): Promise<void> {
    const instance = BrowserManager.instance;
    if (instance !== null) {
      await instance.cleanup();
      if (BrowserManager.instance === instance) BrowserManager.instance = null;
    }
    BrowserManager.proxyOverride = undefined;
  }

  static createForTesting(
    config: PlaywrightConfig,
    hooks: BrowserManagerTestingHooks = {}
  ): BrowserManager {
    return new BrowserManager(config, hooks);
  }

  setDefaultOwnerScope(ownerScopeId: string): void {
    this.defaultOwnerScopeId = ownerScopeId.trim().length > 0 ? ownerScopeId : "process-default";
  }

  assertProcessCeilingUnchanged(networkAllowlist: readonly string[]): void {
    const next = parseConfiguredNetworkPolicy(networkAllowlist, "refreshed process browser policy");
    if (networkPolicySignature(next) !== networkPolicySignature(this.processCeiling)) {
      throw new BrowserPolicyViolationError(
        "BROWSER_PROCESS_POLICY_IMMUTABLE",
        "The process browser network policy cannot change after initialization"
      );
    }
  }

  private currentBinding(): EffectiveBrowserPolicyBinding {
    const binding = effectiveBrowserPolicyBinding(this.processCeiling, this.defaultOwnerScopeId);
    const key = bindingKey(binding);
    const signature = networkPolicySignature(binding.policy);
    const existing = this.policyBindings.get(key);
    if (existing !== undefined && existing.signature !== signature) {
      throw new BrowserPolicyViolationError(
        "BROWSER_POLICY_SCOPE_REBIND_DENIED",
        "A browser owner/invocation scope cannot be rebound to a different network policy"
      );
    }
    if (existing === undefined) {
      if (this.policyBindings.size >= MAX_BROWSER_POLICY_BINDINGS) {
        throw new BrowserPolicyViolationError(
          "BROWSER_POLICY_BINDING_LIMIT",
          `Browser policy binding limit (${MAX_BROWSER_POLICY_BINDINGS}) reached`
        );
      }
      this.policyBindings.set(
        key,
        Object.freeze({
          signature,
          invocationPolicyPresent: binding.invocationPolicyPresent,
        })
      );
    }
    return binding;
  }

  private currentState(): BrowserScopeState {
    const binding = this.currentBinding();
    const key = bindingKey(binding);
    const existing = this.states.get(key);
    if (existing !== undefined) {
      if (existing.lifecycle !== "active") {
        throw new BrowserPolicyViolationError(
          "BROWSER_POLICY_SCOPE_RETIRING",
          "Browser policy scope is closing or has unconfirmed termination"
        );
      }
      return existing;
    }
    if (this.states.size >= MAX_BROWSER_POLICY_SCOPES) {
      throw new BrowserPolicyViolationError(
        "BROWSER_POLICY_SCOPE_LIMIT",
        `Browser policy scope limit (${MAX_BROWSER_POLICY_SCOPES}) reached; release completed scopes`
      );
    }
    const state: BrowserScopeState = {
      key,
      scopeTag: scopeTag(binding.ownerScopeId, binding.invocationId),
      binding,
      userDataDir: resolve(`/tmp/playwright-profile-${randomUUID().slice(0, 8)}`),
      browser: null,
      browserProcess: null,
      context: null,
      pages: [],
      activePageIdx: -1,
      pagePolicySetups: new Map(),
      cdpSessions: new Map(),
      policyReadyBeforeNavigation: new Set(),
      ownedProcesses: new Map(),
      operationMutex: new ScopeMutex(),
      browserDisconnectObserved: false,
      browserDisconnectSignal: cleanupSignal(),
      lifecycle: "active",
      launchPromise: null,
      cleanupPromise: null,
      launchError: null,
    };
    this.states.set(key, state);
    return state;
  }

  captureCurrentScope(): BrowserScopeHandle {
    const binding = this.currentBinding();
    return Object.freeze({
      ownerScopeId: binding.ownerScopeId,
      invocationId: binding.invocationId,
      invocationPolicyPresent: binding.invocationPolicyPresent,
      policySignature: networkPolicySignature(binding.policy),
    });
  }

  getPolicyStatus(): BrowserPolicyStatus {
    const binding = this.currentBinding();
    return Object.freeze({
      mode: binding.policy.mode,
      canonicalPatterns:
        binding.policy.mode === "allow"
          ? Object.freeze(binding.policy.patterns.map((pattern) => pattern.canonical))
          : Object.freeze([]),
      scopeTag: scopeTag(binding.ownerScopeId, binding.invocationId),
      invocationPolicyPresent: binding.invocationPolicyPresent,
      processCeilingMode: this.processCeiling.mode,
    });
  }

  restrictedOperationDenial(
    operation: RestrictedBrowserOperation
  ): BrowserPolicyViolationError | null {
    const status = this.getPolicyStatus();
    if (status.mode === "unrestricted") return null;
    return new BrowserPolicyViolationError(
      "BROWSER_RESTRICTED_OPERATION_DENIED",
      `Restricted browser policy refuses ${operation} (scope ${status.scopeTag})`
    );
  }

  assertOperationAllowed(operation: RestrictedBrowserOperation): void {
    const denial = this.restrictedOperationDenial(operation);
    if (denial !== null) throw denial;
  }

  safeErrorMessage(error: unknown): string {
    const status = this.getPolicyStatus();
    if (status.mode !== "unrestricted") {
      return `BROWSER_RESTRICTED_ACTION_FAILED: Browser action failed under restricted policy (scope ${status.scopeTag})`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private addPage(state: BrowserScopeState, page: Page): number {
    const existing = state.pages.indexOf(page);
    if (existing >= 0) return existing;
    state.pages.push(page);
    page.on("dialog", async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });
    page.on("close", () => {
      const session = state.cdpSessions.get(page);
      if (session !== undefined) void session.detach().catch(() => {});
      state.cdpSessions.delete(page);
      state.pagePolicySetups.delete(page);
      state.policyReadyBeforeNavigation.delete(page);
    });
    return state.pages.length - 1;
  }

  private admitContextPage(state: BrowserScopeState, page: Page, restricted: boolean): void {
    void state.operationMutex
      .runExclusive(async () => {
        this.assertScopeActive(state);
        this.addPage(state, page);
        if (restricted) await this.ensurePagePolicy(state, page);
      })
      .catch(async (error: unknown) => {
        if (restricted) {
          logger.warn("Restricted popup/page policy attachment failed closed", {
            event: "browser_network_mediation_failed",
            reasonCode:
              error instanceof BrowserPolicyViolationError
                ? error.code
                : "BROWSER_CDP_POLICY_SETUP_FAILED",
            scopeTag: state.scopeTag,
          });
        }
        await page.close().catch(() => {});
      });
  }

  private async mediateUnprotectedPageRequest(
    route: Route,
    request: Request,
    state: BrowserScopeState
  ): Promise<void> {
    const configuredTimeout = Number.isFinite(this.config.timeout)
      ? this.config.timeout
      : MAX_RESTRICTED_REQUEST_TIMEOUT_MS;
    try {
      // A popup can issue its first request before a CDP session is attached.
      // Fetch exactly one hop and synthesize that response; a redirect target
      // is authorized before the browser can issue the next hop.
      const response = await route.fetch({
        maxRedirects: 0,
        maxRetries: 0,
        timeout: Math.min(Math.max(configuredTimeout, 1), MAX_RESTRICTED_REQUEST_TIMEOUT_MS),
      });
      const redirectLocation = response.headers().location;
      if (redirectLocation !== undefined && [301, 302, 303, 307, 308].includes(response.status())) {
        let redirectUrl: string;
        try {
          redirectUrl = new URL(redirectLocation, request.url()).href;
        } catch {
          logger.warn("Malformed browser redirect denied", {
            event: "browser_network_denied",
            reasonCode: "BROWSER_NETWORK_INVALID_REDIRECT",
            destination: "invalid-destination",
            resourceType: request.resourceType(),
            scopeTag: state.scopeTag,
          });
          await route.abort("blockedbyclient");
          return;
        }
        const redirectDecision = authorizeNetworkUrl(state.binding.policy, redirectUrl);
        if (!redirectDecision.allowed) {
          logger.warn("Browser redirect denied", {
            event: "browser_network_denied",
            reasonCode: redirectDecision.reasonCode,
            destination: redirectDecision.destination,
            resourceType: request.resourceType(),
            scopeTag: state.scopeTag,
          });
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.fulfill({ response });
    } catch {
      logger.warn("Browser popup request mediation failed closed", {
        event: "browser_network_mediation_failed",
        reasonCode: "BROWSER_NETWORK_MEDIATION_FAILED",
        destination: describeBrowserDestination(request.url()),
        resourceType: request.resourceType(),
        scopeTag: state.scopeTag,
      });
      await route.abort("failed").catch(() => {});
    }
  }

  private async installRestrictedPolicy(
    context: BrowserContext,
    state: BrowserScopeState
  ): Promise<void> {
    const policy = state.binding.policy;
    if (policy.mode === "unrestricted") return;
    try {
      this.testingHooks.beforeRestrictedPolicySetup?.();
    } catch {
      throw new BrowserPolicyViolationError(
        "BROWSER_POLICY_SETUP_FAILED",
        "Restricted browser policy setup failed closed"
      );
    }

    await withPolicySetupTimeout(
      (async () => {
        await context.route(
          () => true,
          async (route) => {
            const request = route.request();
            const decision = authorizeNetworkUrl(policy, request.url());
            if (decision.allowed) {
              let pageWasProtectedBeforeNavigation = true;
              if (request.isNavigationRequest()) {
                try {
                  pageWasProtectedBeforeNavigation = state.policyReadyBeforeNavigation.has(
                    request.frame().page()
                  );
                } catch {
                  pageWasProtectedBeforeNavigation = false;
                }
              }
              if (!pageWasProtectedBeforeNavigation) {
                await this.mediateUnprotectedPageRequest(route, request, state);
                return;
              }
              await route.continue();
              return;
            }
            logger.warn("Browser network request denied", {
              event: "browser_network_denied",
              reasonCode: decision.reasonCode,
              destination: decision.destination,
              resourceType: request.resourceType(),
              scopeTag: state.scopeTag,
            });
            await route.abort("blockedbyclient");
          }
        );

        await context.routeWebSocket(
          () => true,
          (webSocket) => {
            const decision = authorizeNetworkUrl(policy, webSocket.url());
            if (decision.allowed) {
              webSocket.connectToServer();
              return;
            }
            logger.warn("Browser WebSocket denied", {
              event: "browser_network_denied",
              reasonCode: decision.reasonCode,
              destination: decision.destination,
              resourceType: "websocket",
              scopeTag: state.scopeTag,
            });
            void webSocket.close({
              code: 1008,
              reason: "Browser network policy denied destination",
            });
          }
        );

        await context.addInitScript(RESTRICTED_RUNTIME_GUARD_SCRIPT);
      })()
    );
  }

  private async handleCdpRequestPaused(
    session: CDPSession,
    state: BrowserScopeState,
    event: unknown
  ): Promise<void> {
    if (!isUnknownRecord(event) || typeof event.requestId !== "string") {
      logger.warn("Malformed CDP request event failed closed", {
        event: "browser_network_mediation_failed",
        reasonCode: "BROWSER_CDP_REQUEST_INVALID",
        scopeTag: state.scopeTag,
      });
      return;
    }
    const requestId = event.requestId;
    const request = event.request;
    if (!isUnknownRecord(request) || typeof request.url !== "string") {
      await session
        .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
        .catch(() => {});
      logger.warn("Malformed CDP request failed closed", {
        event: "browser_network_mediation_failed",
        reasonCode: "BROWSER_CDP_REQUEST_INVALID",
        scopeTag: state.scopeTag,
      });
      return;
    }

    const decision = authorizeNetworkUrl(state.binding.policy, request.url);
    if (decision.allowed) {
      await session.send("Fetch.continueRequest", { requestId }).catch(() => {});
      return;
    }
    logger.warn("Browser request or redirect denied by CDP guard", {
      event: "browser_network_denied",
      reasonCode: decision.reasonCode,
      destination: decision.destination,
      resourceType: typeof event.resourceType === "string" ? event.resourceType : "unknown",
      scopeTag: state.scopeTag,
    });
    await session
      .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      .catch(() => {});
  }

  private async ensurePagePolicy(state: BrowserScopeState, page: Page): Promise<void> {
    if (state.binding.policy.mode === "unrestricted") return;
    const existing = state.pagePolicySetups.get(page);
    if (existing !== undefined) return existing;
    if (state.context === null) {
      throw new BrowserPolicyViolationError(
        "BROWSER_POLICY_CONTEXT_MISSING",
        "Restricted page policy cannot attach without a browser context"
      );
    }

    const setup = withPolicySetupTimeout(
      (async () => {
        const session = await state.context?.newCDPSession(page);
        if (session === undefined) {
          throw new BrowserPolicyViolationError(
            "BROWSER_CDP_POLICY_SETUP_FAILED",
            "Restricted page CDP policy failed closed"
          );
        }
        session.on("Fetch.requestPaused", (event: unknown) => {
          void this.handleCdpRequestPaused(session, state, event);
        });
        await session.send("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        });
        state.cdpSessions.set(page, session);
      })()
    );
    state.pagePolicySetups.set(page, setup);
    try {
      await setup;
    } catch (error) {
      state.pagePolicySetups.delete(page);
      throw error;
    }
  }

  private authorizeNavigation(state: BrowserScopeState, rawUrl: string): string {
    const normalized = normalizeNavigationUrl(rawUrl);
    const decision = authorizeNetworkUrl(state.binding.policy, normalized);
    if (!decision.allowed) {
      logger.warn("Browser navigation denied before request", {
        event: "browser_network_denied",
        reasonCode: decision.reasonCode,
        destination: decision.destination,
        resourceType: "document",
        scopeTag: state.scopeTag,
      });
      throw new BrowserPolicyViolationError(
        decision.reasonCode,
        `Browser network policy denied navigation to ${decision.destination}`
      );
    }
    return normalized;
  }

  private assertScopeActive(state: BrowserScopeState): void {
    if (state.lifecycle !== "active" || this.states.get(state.key) !== state) {
      throw new BrowserPolicyViolationError(
        "BROWSER_POLICY_SCOPE_RETIRING",
        "Browser policy scope is closing or has unconfirmed termination"
      );
    }
  }

  private hasBrowserResources(state: BrowserScopeState): boolean {
    return (
      state.browser !== null ||
      state.browserProcess !== null ||
      state.context !== null ||
      state.pages.length > 0 ||
      state.ownedProcesses.size > 0
    );
  }

  private async launchBrowserState(state: BrowserScopeState): Promise<void> {
    const restricted = state.binding.policy.mode !== "unrestricted";
    const effectiveProxy = BrowserManager.getEffectiveProxy(this.config);
    if (restricted && effectiveProxy !== undefined) {
      throw new BrowserPolicyViolationError(
        "BROWSER_RESTRICTED_PROXY_UNSUPPORTED",
        "Restricted browser scopes refuse launch through a configured proxy"
      );
    }

    logger.info("Launching Chromium browser", {
      headless: this.config.headless,
      scopeTag: state.scopeTag,
      policyMode: state.binding.policy.mode,
    });
    state.launchError = null;
    state.browserDisconnectObserved = false;
    state.browserDisconnectSignal = cleanupSignal();

    try {
      if (!existsSync(state.userDataDir)) {
        mkdirSync(state.userDataDir, { recursive: true });
      }

      const launchOpts: Record<string, unknown> = { headless: this.config.headless };
      if (this.config.browserPath) launchOpts.executablePath = this.config.browserPath;
      if (effectiveProxy !== undefined) {
        const proxyOpts: Record<string, unknown> = { server: effectiveProxy.server };
        if (effectiveProxy.username) proxyOpts.username = effectiveProxy.username;
        if (effectiveProxy.password) proxyOpts.password = effectiveProxy.password;
        if (effectiveProxy.bypass) proxyOpts.bypass = effectiveProxy.bypass;
        launchOpts.proxy = proxyOpts;
        logger.info("Browser will route traffic through configured proxy", {
          hasAuth: !!effectiveProxy.username,
          hasBypass: !!effectiveProxy.bypass,
          scopeTag: state.scopeTag,
        });
      }

      const browser = await chromium.launch(launchOpts);
      state.browser = browser;
      browser.once("disconnected", () => {
        state.browserDisconnectObserved = true;
        state.browserDisconnectSignal.resolve();
      });
      const browserProcess = ownedPlaywrightBrowserProcess(browser);
      if (browserProcess === null) {
        throw new BrowserPolicyViolationError(
          "BROWSER_PROCESS_OWNERSHIP_UNAVAILABLE",
          "Browser launch did not expose an owned Chromium process handle"
        );
      }
      state.browserProcess = browserProcess;
      const ownership: OwnedBrowserProcess = {
        process: browserProcess,
        exitSignal: cleanupSignal(),
        exitObserved: childProcessExited(browserProcess),
      };
      state.ownedProcesses.set(browserProcess, ownership);
      if (ownership.exitObserved) {
        ownership.exitSignal.resolve();
      } else {
        browserProcess.once("exit", () => {
          ownership.exitObserved = true;
          ownership.exitSignal.resolve();
        });
      }
      this.testingHooks.onBrowserProcessOwned?.(browserProcess);
      browserProcess.unref();
      this.assertScopeActive(state);

      const contextOpts: Record<string, unknown> = {};
      if (this.config.ignoreHTTPSErrors) contextOpts.ignoreHTTPSErrors = true;
      if (restricted) {
        contextOpts.serviceWorkers = "block";
        contextOpts.acceptDownloads = false;
      }
      state.context = await browser.newContext(contextOpts);
      this.assertScopeActive(state);
      await this.installRestrictedPolicy(state.context, state);
      this.assertScopeActive(state);
      state.context.on("page", (page) => {
        this.admitContextPage(state, page, restricted);
      });

      const page = await state.context.newPage();
      this.assertScopeActive(state);
      const initialPageIdx = this.addPage(state, page);
      state.activePageIdx = initialPageIdx;

      if (restricted) {
        await this.ensurePagePolicy(state, page);
        this.assertScopeActive(state);
        state.policyReadyBeforeNavigation.add(page);
        const guardStatus: unknown = await page.evaluate(`({
          rtc: typeof globalThis.RTCPeerConnection,
          webkitRtc: typeof globalThis.webkitRTCPeerConnection,
          webTransport: typeof globalThis.WebTransport,
          worker: typeof globalThis.Worker,
          sharedWorker: typeof globalThis.SharedWorker
        })`);
        this.assertScopeActive(state);
        if (
          !isUnknownRecord(guardStatus) ||
          guardStatus.rtc !== "undefined" ||
          guardStatus.webkitRtc !== "undefined" ||
          guardStatus.webTransport !== "undefined" ||
          guardStatus.worker !== "undefined" ||
          guardStatus.sharedWorker !== "undefined"
        ) {
          throw new BrowserPolicyViolationError(
            "BROWSER_RESTRICTED_RUNTIME_GUARD_FAILED",
            "Restricted browser runtime guards failed closed"
          );
        }
      }

      logger.info("Browser launched successfully", {
        pageCount: state.pages.length,
        scopeTag: state.scopeTag,
        policyMode: state.binding.policy.mode,
      });
      this.unrefConnections(browser);
    } catch (error) {
      state.launchError =
        error instanceof BrowserPolicyViolationError
          ? `${error.code}: ${error.message}`
          : "Browser launch or policy setup failed";
      logger.error("Failed to launch browser scope", {
        errorCode:
          error instanceof BrowserPolicyViolationError ? error.code : "BROWSER_LAUNCH_FAILED",
        scopeTag: state.scopeTag,
      });
      try {
        await this.performCleanupResources(state);
      } catch (cleanupError) {
        state.lifecycle = "termination-unconfirmed";
        throw cleanupError;
      }
      throw error;
    }
  }

  private ensureBrowserForState(state: BrowserScopeState): Promise<void> {
    const inFlight = state.launchPromise;
    if (inFlight !== null) return inFlight;

    const launch = state.operationMutex.runExclusive(async () => {
      this.assertScopeActive(state);
      if (state.browser?.isConnected()) return;
      if (this.hasBrowserResources(state)) {
        try {
          await this.performCleanupResources(state);
        } catch (error) {
          state.lifecycle = "termination-unconfirmed";
          throw error;
        }
        this.assertScopeActive(state);
      }
      await this.launchBrowserState(state);
    });
    state.launchPromise = launch;
    void launch.then(
      () => {
        if (state.launchPromise === launch) state.launchPromise = null;
      },
      () => {
        if (state.launchPromise === launch) state.launchPromise = null;
      }
    );
    return launch;
  }

  async ensureBrowser(): Promise<void> {
    await this.ensureBrowserForState(this.currentState());
  }

  private unrefConnections(browser: Browser): void {
    if (unrefPlaywrightCdpConnection(browser)) logger.debug("CDP WebSocket unref'd");
  }

  isConnected(): boolean {
    const state = this.currentState();
    return state.browser?.isConnected() ?? false;
  }

  isAnyScopeConnected(): boolean {
    return [...this.states.values()].some((state) => state.browser?.isConnected() ?? false);
  }

  hasOwnedLiveBrowserProcess(): boolean {
    return [...this.states.values()].some((state) =>
      [...state.ownedProcesses.values()].some(
        (ownership) => !ownership.exitObserved && !childProcessExited(ownership.process)
      )
    );
  }

  getRawBrowser(): Browser | null {
    this.assertOperationAllowed("raw-browser-access");
    return this.currentState().browser;
  }

  getLaunchError(): string | null {
    return this.currentState().launchError;
  }

  private async withReadyState<T>(
    state: BrowserScopeState,
    operation: () => Promise<T> | T
  ): Promise<T> {
    await this.ensureBrowserForState(state);
    return state.operationMutex.runExclusive(async () => {
      this.assertScopeActive(state);
      if (!state.browser?.isConnected() || state.context === null) {
        throw new BrowserPolicyViolationError(
          "BROWSER_SCOPE_NOT_READY",
          "Browser scope is not connected and ready"
        );
      }
      return operation();
    });
  }

  private activePage(state: BrowserScopeState): Page {
    if (state.activePageIdx < 0 || state.activePageIdx >= state.pages.length) {
      throw new Error("No active page. Use playwright_new_page to create one.");
    }
    return state.pages[state.activePageIdx];
  }

  async getPage(): Promise<Page> {
    const state = this.currentState();
    return this.withReadyState(state, () => this.activePage(state));
  }

  async newPage(url?: string): Promise<{ pageId: string; url: string }> {
    const state = this.currentState();
    const normalizedUrl = url === undefined ? undefined : this.authorizeNavigation(state, url);
    return this.withReadyState(state, async () => {
      const context = state.context;
      if (context === null) throw new Error("Browser context not initialized");

      const page = await context.newPage();
      const idx = this.addPage(state, page);
      state.activePageIdx = idx;
      await this.ensurePagePolicy(state, page);
      if (state.binding.policy.mode !== "unrestricted") {
        state.policyReadyBeforeNavigation.add(page);
      }
      if (normalizedUrl !== undefined) {
        try {
          await page.goto(normalizedUrl, { waitUntil: "domcontentloaded" });
        } catch (error) {
          if (state.binding.policy.mode !== "unrestricted") {
            throw new BrowserPolicyViolationError(
              "BROWSER_RESTRICTED_NAVIGATION_FAILED",
              `Restricted navigation failed for ${describeBrowserDestination(normalizedUrl)}`
            );
          }
          throw error;
        }
      }
      return { pageId: String(idx), url: page.url() };
    });
  }

  async closePage(pageId: string): Promise<{ closed: boolean; remainingPages: number }> {
    const state = this.currentState();
    return state.operationMutex.runExclusive(async () => {
      this.assertScopeActive(state);
      const idx = parseInt(pageId, 10);
      if (isNaN(idx) || idx < 0 || idx >= state.pages.length) {
        throw new Error(`Page "${pageId}" not found. Available pages: 0-${state.pages.length - 1}`);
      }
      if (state.pages.length <= 1) {
        throw new Error("Cannot close the last page. Use playwright_close to close the browser.");
      }
      await state.pages[idx].close();
      state.pages.splice(idx, 1);
      if (state.activePageIdx >= state.pages.length) state.activePageIdx = state.pages.length - 1;
      return { closed: true, remainingPages: state.pages.length };
    });
  }

  switchTab(pageId: string): { pageId: string; url: string; title: string } {
    const state = this.currentState();
    const idx = parseInt(pageId, 10);
    if (isNaN(idx) || idx < 0 || idx >= state.pages.length) {
      throw new Error(`Page "${pageId}" not found. Available pages: 0-${state.pages.length - 1}`);
    }
    state.activePageIdx = idx;
    return { pageId: String(idx), url: state.pages[idx].url(), title: "" };
  }

  async listTabs(): Promise<BrowserState> {
    const state = this.currentState();
    return state.operationMutex.runExclusive(async () => {
      this.assertScopeActive(state);
      const tabs = await Promise.all(
        state.pages.map(async (page, idx) => ({
          pageId: String(idx),
          url: page.url(),
          title: await page.title().catch(() => ""),
          isActive: idx === state.activePageIdx,
        }))
      );
      return {
        connected: state.browser?.isConnected() ?? false,
        tabs,
        activePageId: String(state.activePageIdx),
      };
    });
  }

  async navigate(
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded",
    timeout?: number
  ): Promise<{ url: string; title: string; status: number; loadTimeMs: number }> {
    const state = this.currentState();
    const normalizedUrl = this.authorizeNavigation(state, url);
    return this.withReadyState(state, async () => {
      const page = this.activePage(state);
      const startTime = Date.now();
      try {
        const response = await page.goto(normalizedUrl, {
          waitUntil,
          timeout: timeout ?? this.config.timeout,
        });
        return {
          url: page.url(),
          title: await page.title().catch(() => ""),
          status: response?.status() ?? 0,
          loadTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        logger.error("Navigation failed", {
          destination: describeBrowserDestination(normalizedUrl),
          errorCode:
            state.binding.policy.mode === "unrestricted"
              ? "BROWSER_NAVIGATION_FAILED"
              : "BROWSER_RESTRICTED_NAVIGATION_FAILED",
          scopeTag: state.scopeTag,
        });
        if (state.binding.policy.mode !== "unrestricted") {
          throw new BrowserPolicyViolationError(
            "BROWSER_RESTRICTED_NAVIGATION_FAILED",
            `Restricted navigation failed for ${describeBrowserDestination(normalizedUrl)}`
          );
        }
        throw error;
      }
    });
  }

  async snapshot(): Promise<{ tree: SnapshotNode | null; error?: string }> {
    const state = this.currentState();
    return this.withReadyState(state, async () => {
      const page = this.activePage(state);
      try {
        const tree = await page.evaluate(() => {
          const MAX_DEPTH = 8;
          const MAX_CHILDREN = 30;

          function getRole(el: Element): string {
            const ariaRole = el.getAttribute("role");
            if (ariaRole) return ariaRole;
            const tag = el.tagName.toLowerCase();
            const roleMap: Record<string, string> = {
              a: "link",
              button: "button",
              input: "textbox",
              select: "combobox",
              textarea: "textbox",
              img: "image",
              nav: "navigation",
              main: "main",
              header: "banner",
              footer: "contentinfo",
              form: "form",
              table: "table",
              ul: "list",
              ol: "list",
              li: "listitem",
              h1: "heading",
              h2: "heading",
              h3: "heading",
              h4: "heading",
              h5: "heading",
              h6: "heading",
              p: "paragraph",
              article: "article",
              section: "region",
              aside: "complementary",
              label: "label",
              span: "text",
              div: "group",
            };
            return roleMap[tag] || tag;
          }

          function getName(el: Element): string {
            const ariaLabel = el.getAttribute("aria-label");
            if (ariaLabel) return ariaLabel;
            const labelledBy = el.getAttribute("aria-labelledby");
            if (labelledBy) {
              const labelEl = document.getElementById(labelledBy);
              if (labelEl) return labelEl.textContent?.trim() || "";
            }
            if (el instanceof HTMLInputElement && el.type !== "submit") {
              return el.placeholder || el.value || "";
            }
            if (el instanceof HTMLImageElement) return el.alt || "";
            let text = "";
            for (const child of el.childNodes) {
              if (child.nodeType === 3) text += child.textContent || "";
            }
            return text.trim().slice(0, 100);
          }

          function getState(el: Element): Record<string, unknown> | undefined {
            const state: Record<string, unknown> = {};
            if (el instanceof HTMLInputElement) {
              if (el.disabled) state.disabled = true;
              if (el.type === "checkbox" || el.type === "radio") state.checked = el.checked;
              if (el.readOnly) state.readonly = true;
              if (el.required) state.required = true;
            }
            if (el instanceof HTMLButtonElement && el.disabled) state.disabled = true;
            if (el instanceof HTMLSelectElement && el.disabled) state.disabled = true;
            if (el instanceof HTMLTextAreaElement) {
              if (el.disabled) state.disabled = true;
              if (el.readOnly) state.readonly = true;
            }
            return Object.keys(state).length ? state : undefined;
          }

          function shouldOmit(el: Element): boolean {
            return ["script", "style", "meta", "link", "noscript", "br", "hr"].includes(
              el.tagName.toLowerCase()
            );
          }

          function buildTree(el: Element, depth: number): SnapshotNode | null {
            if (depth > MAX_DEPTH || shouldOmit(el)) return null;
            const node: SnapshotNode = { role: getRole(el), name: getName(el) };
            const state = getState(el);
            if (state) Object.assign(node, state);
            const children: SnapshotNode[] = [];
            let count = 0;
            for (const child of el.children) {
              if (count >= MAX_CHILDREN) break;
              const built = buildTree(child, depth + 1);
              if (built) {
                children.push(built);
                count++;
              }
            }
            if (children.length) node.children = children;
            return node;
          }

          return buildTree(document.body, 0);
        });
        return { tree };
      } catch (error) {
        return { tree: null, error: error instanceof Error ? error.message : "Snapshot failed" };
      }
    });
  }

  async screenshot(options: {
    selector?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
    quality?: number;
    path?: string;
  }): Promise<{
    filePath: string;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
    fileSizeBytes: number;
  }> {
    const state = this.currentState();
    return this.withReadyState(state, async () => {
      const page = this.activePage(state);
      const outputDir = options.path ? dirname(options.path) : this.config.outputDir;
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
      const filename =
        options.path ?? `${outputDir}/screenshot-${Date.now()}.${options.type ?? "png"}`;
      const screenshotOpts: PageScreenshotOptions = {
        path: filename,
        type: options.type ?? "png",
        fullPage: options.fullPage ?? false,
      };
      if (options.quality !== undefined && options.type === "jpeg") {
        screenshotOpts.quality = options.quality;
      }
      if (options.selector) {
        const element = await page.$(options.selector);
        if (!element) throw new Error(`Element not found: ${options.selector}`);
        await element.screenshot(screenshotOpts);
      } else {
        await page.screenshot(screenshotOpts);
      }
      const stats = statSync(filename);
      const viewport = page.viewportSize();
      return {
        filePath: filename,
        mimeType: options.type === "jpeg" ? "image/jpeg" : "image/png",
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
        fileSizeBytes: stats.size,
      };
    });
  }

  async resize(width: number, height: number): Promise<void> {
    const state = this.currentState();
    await this.withReadyState(state, async () => {
      await this.activePage(state).setViewportSize({ width, height });
    });
  }

  async close(): Promise<void> {
    const state = this.currentState();
    const shouldCleanup = await state.operationMutex.runExclusive(async () => {
      this.assertScopeActive(state);
      if (state.pages.length > 0) {
        await state.pages[state.activePageIdx]?.close().catch(() => {});
        state.pages.splice(state.activePageIdx, 1);
      }
      if (state.pages.length === 0) {
        state.lifecycle = "closing";
        return true;
      }
      state.activePageIdx = 0;
      return false;
    });
    if (shouldCleanup) await this.cleanupState(state);
  }

  async cleanupCurrentScope(): Promise<void> {
    const state = this.states.get(bindingKey(this.currentBinding()));
    if (state !== undefined) await this.cleanupState(state);
  }

  async cleanupCapturedScope(handle: BrowserScopeHandle): Promise<void> {
    const key = `${handle.ownerScopeId}\0${handle.invocationId}`;
    const bound = this.policyBindings.get(key);
    if (bound !== undefined && bound.signature !== handle.policySignature) {
      throw new BrowserPolicyViolationError(
        "BROWSER_POLICY_SCOPE_REBIND_DENIED",
        "Captured browser scope no longer matches its immutable policy"
      );
    }
    const state = this.states.get(key);
    if (state !== undefined) await this.cleanupState(state);
    // Only session_shutdown's captured host lease reaches this method. A tool-level
    // close retires the browser but intentionally keeps the immutable binding live.
    this.policyBindings.delete(key);
  }

  async cleanupOrdinaryScopes(): Promise<void> {
    const ordinaryStates = [...this.states.values()].filter(
      (state) => !state.binding.invocationPolicyPresent
    );
    await Promise.all(
      ordinaryStates.map(async (state) => {
        await this.cleanupState(state);
        this.policyBindings.delete(state.key);
      })
    );
    for (const [key, binding] of this.policyBindings) {
      if (!binding.invocationPolicyPresent) this.policyBindings.delete(key);
    }
  }

  private stateTerminationConfirmed(state: BrowserScopeState): boolean {
    const everyProcessExited = [...state.ownedProcesses.values()].every(
      (ownership) => ownership.exitObserved || childProcessExited(ownership.process)
    );
    const browserDisconnected =
      state.browser === null || state.browserDisconnectObserved || !state.browser.isConnected();
    return everyProcessExited && browserDisconnected;
  }

  private async observeTermination(
    state: BrowserScopeState,
    processTimeoutMs: number
  ): Promise<boolean> {
    if (this.stateTerminationConfirmed(state)) return true;
    const liveProcesses = [...state.ownedProcesses.values()].filter(
      (ownership) => !ownership.exitObserved && !childProcessExited(ownership.process)
    );
    await Promise.all(
      liveProcesses.map(async (ownership) => signalWithin(ownership.exitSignal, processTimeoutMs))
    );
    if (state.browser !== null && !state.browserDisconnectObserved && state.browser.isConnected()) {
      await signalWithin(state.browserDisconnectSignal, BROWSER_DISCONNECT_OBSERVATION_TIMEOUT_MS);
    }
    return this.stateTerminationConfirmed(state);
  }

  private signalEveryLiveProcess(state: BrowserScopeState): void {
    for (const ownership of state.ownedProcesses.values()) {
      if (ownership.exitObserved || childProcessExited(ownership.process)) continue;
      try {
        ownership.process.kill("SIGKILL");
      } catch {
        // The observation below is authoritative; a thrown signal attempt is not.
      }
    }
  }

  private async forceTerminate(state: BrowserScopeState): Promise<boolean> {
    this.signalEveryLiveProcess(state);
    if (await this.observeTermination(state, BROWSER_FORCE_KILL_TIMEOUT_MS)) return true;
    this.signalEveryLiveProcess(state);
    return this.observeTermination(state, BROWSER_DISCONNECT_OBSERVATION_TIMEOUT_MS);
  }

  private async performCleanupResources(state: BrowserScopeState): Promise<void> {
    if (!this.hasBrowserResources(state)) {
      if (existsSync(state.userDataDir)) {
        try {
          rmSync(state.userDataDir, { recursive: true, force: true });
        } catch {
          // Best-effort removal; the directory belongs only to this browser scope.
        }
      }
      return;
    }

    const pages = [...state.pages];
    const context = state.context;
    const browser = state.browser;
    const gracefulCleanup = (async () => {
      await this.testingHooks.beforeGracefulCleanup?.();
      for (const page of pages) await page.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const gracefulResult = await Promise.race([
      gracefulCleanup.then(
        () => "complete" as const,
        () => "failed" as const
      ),
      new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), BROWSER_CLEANUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    let terminationConfirmed =
      gracefulResult === "complete" &&
      (await this.observeTermination(state, BROWSER_DISCONNECT_OBSERVATION_TIMEOUT_MS));
    if (!terminationConfirmed) {
      logger.warn("Browser cleanup force-kill activated", {
        event: "browser_force_kill_activated",
        reason: gracefulResult,
        scopeTag: state.scopeTag,
        timeoutMs: BROWSER_CLEANUP_TIMEOUT_MS,
      });
      terminationConfirmed = await this.forceTerminate(state);
    }

    if (!terminationConfirmed) {
      logger.error("Browser cleanup could not confirm process termination", {
        event: "browser_termination_unconfirmed",
        scopeTag: state.scopeTag,
      });
      throw new BrowserPolicyViolationError(
        "BROWSER_CLEANUP_TERMINATION_UNCONFIRMED",
        "Browser cleanup did not observe browser disconnect and every owned process exit"
      );
    }

    state.pages = [];
    state.activePageIdx = -1;
    state.pagePolicySetups.clear();
    state.cdpSessions.clear();
    state.policyReadyBeforeNavigation.clear();
    state.context = null;
    state.browser = null;
    state.browserProcess = null;
    state.ownedProcesses.clear();
    state.browserDisconnectObserved = false;
    state.browserDisconnectSignal = cleanupSignal();
    if (existsSync(state.userDataDir)) {
      try {
        rmSync(state.userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort removal; the directory belongs only to this browser scope.
      }
    }
  }

  private cleanupState(state: BrowserScopeState): Promise<void> {
    if (state.cleanupPromise !== null) return state.cleanupPromise;
    state.lifecycle = "closing";
    const cleanup = (async () => {
      const launch = state.launchPromise;
      if (launch !== null) {
        await launch.catch(() => {});
      }
      await state.operationMutex.runExclusive(async () => {
        await this.performCleanupResources(state);
        state.lifecycle = "retired";
        if (this.states.get(state.key) === state) this.states.delete(state.key);
      });
      logger.info("Browser scope cleanup complete", {
        event: "browser_scope_cleanup_complete",
        scopeTag: state.scopeTag,
      });
    })()
      .catch((error: unknown) => {
        state.lifecycle = "termination-unconfirmed";
        throw error;
      })
      .finally(() => {
        state.cleanupPromise = null;
      });
    state.cleanupPromise = cleanup;
    return cleanup;
  }

  async cleanup(): Promise<void> {
    const states = [...this.states.values()];
    logger.info("Browser cleanup initiated", { scopes: states.length });
    const results = await Promise.allSettled(states.map(async (state) => this.cleanupState(state)));
    if (results.some((result) => result.status === "rejected") || this.states.size > 0) {
      throw new BrowserPolicyViolationError(
        "BROWSER_CLEANUP_TERMINATION_UNCONFIRMED",
        "Browser cleanup retained one or more scopes with unconfirmed termination"
      );
    }
    this.policyBindings.clear();
    logger.info("Browser cleanup complete", { event: "browser_manager_cleanup_complete" });
  }
}
