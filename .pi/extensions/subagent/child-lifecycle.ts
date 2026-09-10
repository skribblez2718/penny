export const SUBAGENT_TERMINATION_GRACE_MS = 5_000;
export const SUBAGENT_FORCE_EXIT_GRACE_MS = 1_000;
export const SUBAGENT_OUTPUT_DRAIN_GRACE_MS = 1_000;

export type ChildTerminationStrategy = "graceful-then-force" | "force-only";

/**
 * Windows implements SIGTERM as unconditional termination rather than a
 * catchable POSIX signal. Use an explicit force-only path there instead of
 * pretending the grace window has equivalent semantics.
 */
export const SUBAGENT_CHILD_TERMINATION_STRATEGY: ChildTerminationStrategy =
  process.platform === "win32" ? "force-only" : "graceful-then-force";

export type ChildLifecycleTerminalState =
  | "closed"
  | "spawn_error"
  | "setup_failed"
  | "admission_rejected"
  | "drain_timeout"
  | "termination_failed"
  | "close_without_exit";

export interface ChildLifecycleResult {
  readonly state: ChildLifecycleTerminalState;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly terminationRequested: boolean;
  readonly forceRequested: boolean;
  readonly errorMessage?: string;
}

export interface ChildLifecycleTimeouts {
  readonly terminationGraceMs?: number;
  readonly forceExitGraceMs?: number;
  readonly outputDrainGraceMs?: number;
}

interface ChildLifecycleSupervisorOptions extends ChildLifecycleTimeouts {
  readonly signal?: AbortSignal;
  readonly terminationStrategy?: ChildTerminationStrategy;
  readonly sendSignal: (signal: NodeJS.Signals) => boolean;
  readonly closeStreams: () => void;
}

export interface ChildLifecycleSupervisor {
  readonly settled: Promise<ChildLifecycleResult>;
  start(): void;
  exited(code: number | null, signal: NodeJS.Signals | null): void;
  closed(code: number | null, signal: NodeJS.Signals | null): void;
  spawnFailed(error: Error): void;
}

export interface AgentChildOutputStream {
  on(event: "data", listener: (data: Buffer) => void): this;
  removeListener(event: "data", listener: (data: Buffer) => void): this;
  destroy(): this;
}

export interface AgentChildProcess {
  readonly stdout: AgentChildOutputStream;
  readonly stderr: AgentChildOutputStream;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  prependOnceListener(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  removeListener(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type ChildFinalizeReason = "scope_shutdown" | "admission_rejected" | "setup_failed";

export interface ChildProcessFinalizer {
  readonly settled: Promise<ChildLifecycleResult>;
  finalize(reason: ChildFinalizeReason): Promise<ChildLifecycleResult>;
}

export type ChildBeginFailureReason = "scope_finalizing" | "limit_rejected" | "setup_failed";

export type ChildBeginResult =
  | { readonly accepted: true; readonly finalizer: ChildProcessFinalizer }
  | {
      readonly accepted: false;
      readonly reason: ChildBeginFailureReason;
      readonly finalizer: ChildProcessFinalizer;
    };

export interface ChildLifecycleScope {
  readonly activeCount: number;
  beginChild(
    child: AgentChildProcess,
    signal?: AbortSignal,
    timeouts?: ChildLifecycleTimeouts
  ): ChildBeginResult;
  finalize(): Promise<void>;
}

export interface ChildLifecycleScopeOptions {
  readonly maxActiveChildren?: number;
  readonly createFinalizer?: (
    child: AgentChildProcess,
    signal: AbortSignal | undefined,
    timeouts: ChildLifecycleTimeouts
  ) => ChildProcessFinalizer;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the child-process lifecycle state machine independently from event
 * wiring so timer and race behavior can be tested deterministically.
 */
export function createChildLifecycleSupervisor(
  options: ChildLifecycleSupervisorOptions
): ChildLifecycleSupervisor {
  const terminationGraceMs = options.terminationGraceMs ?? SUBAGENT_TERMINATION_GRACE_MS;
  const forceExitGraceMs = options.forceExitGraceMs ?? SUBAGENT_FORCE_EXIT_GRACE_MS;
  const outputDrainGraceMs = options.outputDrainGraceMs ?? SUBAGENT_OUTPUT_DRAIN_GRACE_MS;
  const terminationStrategy = options.terminationStrategy ?? "graceful-then-force";

  let started = false;
  let didSettle = false;
  let exitObserved = false;
  let closeObserved = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let terminationRequested = false;
  let forceRequested = false;
  let spawnError: string | undefined;
  let drainTimedOut = false;
  const signalErrors: string[] = [];
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveSettled: (result: ChildLifecycleResult) => void = () => {};

  const settled = new Promise<ChildLifecycleResult>((resolve) => {
    resolveSettled = resolve;
  });

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer !== undefined) clearTimeout(timer);
  };

  const cleanup = (): void => {
    clearTimer(terminationTimer);
    clearTimer(forceExitTimer);
    clearTimer(drainTimer);
    terminationTimer = undefined;
    forceExitTimer = undefined;
    drainTimer = undefined;
    options.signal?.removeEventListener("abort", abort);
  };

  const settle = (state: ChildLifecycleTerminalState, message?: string): void => {
    if (didSettle) return;
    didSettle = true;
    cleanup();
    resolveSettled({
      state,
      exitCode,
      exitSignal,
      exitObserved,
      closeObserved,
      terminationRequested,
      forceRequested,
      ...(message === undefined ? {} : { errorMessage: message }),
    });
  };

  const closeStreams = (): void => {
    try {
      options.closeStreams();
    } catch (error) {
      signalErrors.push(`stream cleanup failed: ${errorText(error)}`);
    }
  };

  const startDrainTimer = (): void => {
    if (didSettle || closeObserved || drainTimer !== undefined) return;
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      drainTimedOut = true;
      closeStreams();
      if (didSettle) return;
      if (spawnError !== undefined) {
        settle("spawn_error", [spawnError, ...signalErrors].join("; "));
        return;
      }
      settle(
        "drain_timeout",
        [
          "Child exited but output streams did not close within the drain grace period",
          ...signalErrors,
        ].join("; ")
      );
    }, outputDrainGraceMs);
  };

  const requestSignal = (signal: NodeJS.Signals): void => {
    try {
      if (!options.sendSignal(signal)) signalErrors.push(`${signal} was not delivered`);
    } catch (error) {
      signalErrors.push(`${signal} failed: ${errorText(error)}`);
    }
  };

  const force = (): void => {
    if (didSettle || exitObserved || forceRequested) return;
    forceRequested = true;
    requestSignal("SIGKILL");
    forceExitTimer = setTimeout(() => {
      forceExitTimer = undefined;
      if (didSettle || exitObserved) return;
      closeStreams();
      settle(
        "termination_failed",
        ["Child did not exit after forced termination", ...signalErrors].join("; ")
      );
    }, forceExitGraceMs);
  };

  function abort(): void {
    if (didSettle || exitObserved || terminationRequested) return;
    terminationRequested = true;
    if (terminationStrategy === "force-only") {
      force();
      return;
    }
    requestSignal("SIGTERM");
    terminationTimer = setTimeout(() => {
      terminationTimer = undefined;
      force();
    }, terminationGraceMs);
  }

  const supervisor: ChildLifecycleSupervisor = {
    settled,
    start() {
      if (started || didSettle) return;
      started = true;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted === true) abort();
    },
    exited(code, signal) {
      if (didSettle || exitObserved) return;
      exitObserved = true;
      exitCode = code;
      exitSignal = signal;
      clearTimer(terminationTimer);
      clearTimer(forceExitTimer);
      terminationTimer = undefined;
      forceExitTimer = undefined;
      if (closeObserved) {
        settle(spawnError === undefined ? "closed" : "spawn_error", spawnError);
        return;
      }
      startDrainTimer();
    },
    closed(code, signal) {
      if (didSettle || closeObserved) return;
      closeObserved = true;
      if (exitCode === null && code !== null) exitCode = code;
      if (exitSignal === null && signal !== null) exitSignal = signal;
      if (spawnError !== undefined) {
        settle("spawn_error", [spawnError, ...signalErrors].join("; "));
        return;
      }
      if (drainTimedOut) {
        settle(
          "drain_timeout",
          [
            "Child exited but output streams did not close within the drain grace period",
            ...signalErrors,
          ].join("; ")
        );
        return;
      }
      if (!exitObserved) {
        settle(
          "close_without_exit",
          ["Child output closed before an exit event was observed", ...signalErrors].join("; ")
        );
        return;
      }
      settle("closed", signalErrors.length === 0 ? undefined : signalErrors.join("; "));
    },
    spawnFailed(error) {
      if (didSettle || spawnError !== undefined) return;
      spawnError = error.message;
      clearTimer(terminationTimer);
      clearTimer(forceExitTimer);
      terminationTimer = undefined;
      forceExitTimer = undefined;
      startDrainTimer();
    },
  };

  return supervisor;
}

function lifecycleStateForFinalizeReason(
  reason: ChildFinalizeReason
): "setup_failed" | "admission_rejected" | undefined {
  if (reason === "setup_failed") return "setup_failed";
  if (reason === "admission_rejected") return "admission_rejected";
  return undefined;
}

function finalizeReasonMessage(reason: ChildFinalizeReason): string | undefined {
  if (reason === "setup_failed") return "Child finalizer setup failed";
  if (reason === "admission_rejected") return "Child lifecycle admission was rejected";
  return undefined;
}

/**
 * Construct and fully wire the ordinary child finalizer before it can enter a
 * shared scope. Partial listener setup is rolled back if construction fails.
 */
function createChildProcessFinalizer(
  child: AgentChildProcess,
  signal: AbortSignal | undefined,
  timeouts: ChildLifecycleTimeouts
): ChildProcessFinalizer {
  const finalizerController = new AbortController();
  const supervisor = createChildLifecycleSupervisor({
    ...timeouts,
    signal: finalizerController.signal,
    terminationStrategy: SUBAGENT_CHILD_TERMINATION_STRATEGY,
    sendSignal: (requestedSignal) => child.kill(requestedSignal),
    closeStreams: () => {
      const errors: string[] = [];
      try {
        child.stdout.destroy();
      } catch (error) {
        errors.push(`stdout cleanup failed: ${errorText(error)}`);
      }
      try {
        child.stderr.destroy();
      } catch (error) {
        errors.push(`stderr cleanup failed: ${errorText(error)}`);
      }
      if (errors.length > 0) throw new Error(errors.join("; "));
    },
  });
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
    supervisor.exited(code, exitSignal);
  };
  const onClose = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
    supervisor.closed(code, exitSignal);
  };
  const onError = (error: Error): void => {
    supervisor.spawnFailed(error);
  };
  const onAbort = (): void => {
    finalizerController.abort();
  };
  let exitListenerAdded = false;
  let closeListenerAdded = false;
  let errorListenerAdded = false;
  let abortListenerAdded = false;
  let listenersRemoved = false;
  let finalizeReason: ChildFinalizeReason | undefined;
  const listenerCleanupErrors: string[] = [];

  const removeListenerSafely = (remove: () => void): void => {
    try {
      remove();
    } catch (error) {
      listenerCleanupErrors.push(`listener cleanup failed: ${errorText(error)}`);
    }
  };

  const removeListeners = (): void => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    if (exitListenerAdded) removeListenerSafely(() => child.removeListener("exit", onExit));
    if (closeListenerAdded) removeListenerSafely(() => child.removeListener("close", onClose));
    if (errorListenerAdded) removeListenerSafely(() => child.removeListener("error", onError));
    if (abortListenerAdded) {
      removeListenerSafely(() => signal?.removeEventListener("abort", onAbort));
    }
  };

  try {
    child.once("exit", onExit);
    exitListenerAdded = true;
    child.once("close", onClose);
    closeListenerAdded = true;
    child.once("error", onError);
    errorListenerAdded = true;
    signal?.addEventListener("abort", onAbort, { once: true });
    abortListenerAdded = signal !== undefined;
    supervisor.start();
    if (signal?.aborted === true) onAbort();
  } catch (error) {
    removeListeners();
    throw error;
  }

  const settled = supervisor.settled.then((result) => {
    removeListeners();
    const state =
      finalizeReason === undefined ? undefined : lifecycleStateForFinalizeReason(finalizeReason);
    const reasonMessage =
      finalizeReason === undefined ? undefined : finalizeReasonMessage(finalizeReason);
    const messages = [reasonMessage, result.errorMessage, ...listenerCleanupErrors].filter(
      (message): message is string => message !== undefined
    );
    return {
      ...result,
      ...(state === undefined ? {} : { state }),
      ...(messages.length === 0 ? {} : { errorMessage: messages.join("; ") }),
    };
  });

  return {
    settled,
    finalize(reason) {
      if (finalizeReason === undefined) finalizeReason = reason;
      finalizerController.abort();
      return settled;
    },
  };
}

/**
 * Last-resort bounded cleanup for finalizer-construction failures. Every method
 * catches host/process exceptions, and repeated finalize calls share one
 * promise, so this fallback cannot replace the primary setup/admission error.
 */
function createFallbackChildFinalizer(
  child: AgentChildProcess,
  primaryError: string,
  timeouts: ChildLifecycleTimeouts
): ChildProcessFinalizer {
  const timeoutMs =
    (timeouts.forceExitGraceMs ?? SUBAGENT_FORCE_EXIT_GRACE_MS) +
    (timeouts.outputDrainGraceMs ?? SUBAGENT_OUTPUT_DRAIN_GRACE_MS);
  let started = false;
  let settledOnce = false;
  let exitObserved = false;
  let closeObserved = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let cleanupAttempted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestedState: "setup_failed" | "admission_rejected" = "setup_failed";
  const cleanupErrors: string[] = [];
  let resolveSettled: (result: ChildLifecycleResult) => void = () => {};

  const settled = new Promise<ChildLifecycleResult>((resolve) => {
    resolveSettled = resolve;
  });

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitObserved = true;
    exitCode = code;
    exitSignal = signal;
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    closeObserved = true;
    if (exitCode === null && code !== null) exitCode = code;
    if (exitSignal === null && signal !== null) exitSignal = signal;
    finish();
  };

  const removeListeners = (): void => {
    try {
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    } catch (error) {
      cleanupErrors.push(`listener cleanup failed: ${errorText(error)}`);
    }
  };

  function finish(): void {
    if (settledOnce) return;
    settledOnce = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    removeListeners();
    resolveSettled({
      state: requestedState,
      exitCode,
      exitSignal,
      exitObserved,
      closeObserved,
      terminationRequested: true,
      forceRequested: true,
      errorMessage: [primaryError, ...cleanupErrors].join("; "),
    });
  }

  const attemptCleanup = (): void => {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    try {
      child.once("exit", onExit);
      child.once("close", onClose);
    } catch (error) {
      cleanupErrors.push(`listener setup failed: ${errorText(error)}`);
    }
    timer = setTimeout(finish, timeoutMs);
    try {
      if (!child.kill("SIGKILL")) cleanupErrors.push("SIGKILL was not delivered");
    } catch (error) {
      cleanupErrors.push(`SIGKILL failed: ${errorText(error)}`);
    }
    try {
      child.stdout.destroy();
    } catch (error) {
      cleanupErrors.push(`stdout cleanup failed: ${errorText(error)}`);
    }
    try {
      child.stderr.destroy();
    } catch (error) {
      cleanupErrors.push(`stderr cleanup failed: ${errorText(error)}`);
    }
  };

  return {
    settled,
    finalize(reason) {
      if (!started) {
        started = true;
        requestedState = lifecycleStateForFinalizeReason(reason) ?? "setup_failed";
        attemptCleanup();
      }
      return settled;
    },
  };
}

/**
 * Own active child finalizers for one extension instance. Finalizer construction
 * precedes registration; rejected/setup-failed children immediately enter the
 * same bounded finalization path and are never left unowned.
 */
export function createChildLifecycleScope(
  options: ChildLifecycleScopeOptions = {}
): ChildLifecycleScope {
  const maxActiveChildren = options.maxActiveChildren ?? 25;
  if (!Number.isSafeInteger(maxActiveChildren) || maxActiveChildren < 1) {
    throw new Error("maxActiveChildren must be a positive safe integer");
  }
  const finalizerFactory = options.createFinalizer ?? createChildProcessFinalizer;
  const active = new Set<ChildProcessFinalizer>();
  // Monotonic: finalization closes admission before it snapshots active children and
  // this flag is deliberately never reset when the shared finalization promise settles.
  let closed = false;
  let finalizing: Promise<void> | undefined;

  const reject = (
    finalizer: ChildProcessFinalizer,
    reason: ChildBeginFailureReason,
    finalizeReason: ChildFinalizeReason
  ): ChildBeginResult => {
    void finalizer.finalize(finalizeReason);
    return { accepted: false, reason, finalizer };
  };

  const scope: ChildLifecycleScope = {
    get activeCount() {
      return active.size;
    },
    beginChild(child, signal, timeouts = {}) {
      let finalizer: ChildProcessFinalizer;
      try {
        finalizer = finalizerFactory(child, signal, timeouts);
      } catch (error) {
        finalizer = createFallbackChildFinalizer(
          child,
          `Child finalizer setup failed: ${errorText(error)}`,
          timeouts
        );
        return closed
          ? reject(finalizer, "scope_finalizing", "admission_rejected")
          : reject(finalizer, "setup_failed", "setup_failed");
      }

      if (closed) {
        return reject(finalizer, "scope_finalizing", "admission_rejected");
      }
      if (active.size >= maxActiveChildren) {
        return reject(finalizer, "limit_rejected", "admission_rejected");
      }

      active.add(finalizer);
      void finalizer.settled.then(() => {
        active.delete(finalizer);
      });
      return { accepted: true, finalizer };
    },
    finalize() {
      if (finalizing !== undefined) return finalizing;
      closed = true;
      finalizing = Promise.all(
        [...active].map((finalizer) => finalizer.finalize("scope_shutdown"))
      ).then(() => undefined);
      return finalizing;
    },
  };

  return scope;
}

/** Wire one real child through a bounded finalizer and wait for terminal state. */
export async function waitForChildLifecycle(
  child: AgentChildProcess,
  signal?: AbortSignal,
  timeouts: ChildLifecycleTimeouts = {}
): Promise<ChildLifecycleResult> {
  const scope = createChildLifecycleScope({ maxActiveChildren: 1 });
  const begun = scope.beginChild(child, signal, timeouts);
  return begun.finalizer.settled;
}
