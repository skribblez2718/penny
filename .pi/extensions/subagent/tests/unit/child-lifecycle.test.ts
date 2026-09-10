import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChildLifecycleScope,
  createChildLifecycleSupervisor,
  SUBAGENT_FORCE_EXIT_GRACE_MS,
  SUBAGENT_OUTPUT_DRAIN_GRACE_MS,
  SUBAGENT_TERMINATION_GRACE_MS,
} from "../../child-lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("subagent child lifecycle", () => {
  it("requests graceful termination and never force-kills a child that exits in time", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sent: NodeJS.Signals[] = [];
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      sendSignal(signal) {
        sent.push(signal);
        return true;
      },
      closeStreams: vi.fn(),
    });
    supervisor.start();

    controller.abort();
    expect(sent).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(SUBAGENT_TERMINATION_GRACE_MS - 1);
    supervisor.exited(0, null);
    supervisor.closed(0, null);
    await vi.advanceTimersByTimeAsync(1);

    await expect(supervisor.settled).resolves.toMatchObject({
      state: "closed",
      terminationRequested: true,
      forceRequested: false,
      exitObserved: true,
      closeObserved: true,
    });
    expect(sent).toEqual(["SIGTERM"]);
  });

  it("forces an ignored SIGTERM after exactly the five-second grace", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sent: NodeJS.Signals[] = [];
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      sendSignal(signal) {
        sent.push(signal);
        return true;
      },
      closeStreams: vi.fn(),
    });
    supervisor.start();
    controller.abort();

    await vi.advanceTimersByTimeAsync(SUBAGENT_TERMINATION_GRACE_MS - 1);
    expect(sent).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);

    supervisor.exited(null, "SIGKILL");
    supervisor.closed(null, "SIGKILL");
    await expect(supervisor.settled).resolves.toMatchObject({
      state: "closed",
      forceRequested: true,
      exitSignal: "SIGKILL",
    });
  });

  it("uses explicit force-only semantics where graceful signals are unsupported", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sendSignal = vi.fn(() => true);
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      terminationStrategy: "force-only",
      sendSignal,
      closeStreams: vi.fn(),
    });
    supervisor.start();
    controller.abort();

    expect(sendSignal).toHaveBeenCalledOnce();
    expect(sendSignal).toHaveBeenCalledWith("SIGKILL");
    supervisor.exited(null, "SIGKILL");
    supervisor.closed(null, "SIGKILL");
    await expect(supervisor.settled).resolves.toMatchObject({
      state: "closed",
      terminationRequested: true,
      forceRequested: true,
    });
  });

  it("handles an already-aborted signal and repeated abort without duplicate signals", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const sendSignal = vi.fn(() => true);
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      sendSignal,
      closeStreams: vi.fn(),
    });

    supervisor.start();
    supervisor.start();
    controller.abort();
    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(sendSignal).toHaveBeenCalledWith("SIGTERM");

    supervisor.exited(0, null);
    supervisor.closed(0, null);
    await supervisor.settled;
    await vi.advanceTimersByTimeAsync(SUBAGENT_TERMINATION_GRACE_MS);
    expect(sendSignal).toHaveBeenCalledTimes(1);
  });

  it("does not force-kill when exit wins the grace-boundary race", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sendSignal = vi.fn(() => true);
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      sendSignal,
      closeStreams: vi.fn(),
    });
    supervisor.start();
    controller.abort();

    await vi.advanceTimersByTimeAsync(SUBAGENT_TERMINATION_GRACE_MS - 1);
    supervisor.exited(0, null);
    supervisor.closed(0, null);
    await vi.advanceTimersByTimeAsync(1);
    await supervisor.settled;

    expect(sendSignal).toHaveBeenCalledTimes(1);
    expect(sendSignal).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not reclassify an exited child when cancellation arrives during output drain", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sendSignal = vi.fn(() => true);
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      sendSignal,
      closeStreams: vi.fn(),
    });
    supervisor.start();
    supervisor.exited(0, null);
    controller.abort();
    supervisor.closed(0, null);

    await expect(supervisor.settled).resolves.toMatchObject({
      state: "closed",
      terminationRequested: false,
      forceRequested: false,
    });
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it("bounds inherited-open-stream drainage after actual process exit", async () => {
    vi.useFakeTimers();
    const closeStreams = vi.fn();
    const supervisor = createChildLifecycleSupervisor({
      sendSignal: vi.fn(() => true),
      closeStreams,
    });
    supervisor.start();
    supervisor.exited(0, null);

    await vi.advanceTimersByTimeAsync(SUBAGENT_OUTPUT_DRAIN_GRACE_MS);
    await expect(supervisor.settled).resolves.toMatchObject({
      state: "drain_timeout",
      exitObserved: true,
      closeObserved: false,
    });
    expect(closeStreams).toHaveBeenCalledTimes(1);
  });

  it("keeps a drain timeout truthful when destroying streams immediately emits close", async () => {
    vi.useFakeTimers();
    let emitClose = (): void => {};
    const supervisor = createChildLifecycleSupervisor({
      sendSignal: vi.fn(() => true),
      closeStreams() {
        emitClose();
      },
    });
    emitClose = () => supervisor.closed(0, null);
    supervisor.start();
    supervisor.exited(0, null);

    await vi.advanceTimersByTimeAsync(SUBAGENT_OUTPUT_DRAIN_GRACE_MS);
    await expect(supervisor.settled).resolves.toMatchObject({
      state: "drain_timeout",
      exitObserved: true,
      closeObserved: true,
    });
  });

  it("bounds a spawn error when no close event follows", async () => {
    vi.useFakeTimers();
    const closeStreams = vi.fn();
    const supervisor = createChildLifecycleSupervisor({
      sendSignal: vi.fn(() => true),
      closeStreams,
    });
    supervisor.start();
    supervisor.spawnFailed(new Error("ENOENT"));

    await vi.advanceTimersByTimeAsync(SUBAGENT_OUTPUT_DRAIN_GRACE_MS);
    await expect(supervisor.settled).resolves.toMatchObject({
      state: "spawn_error",
      exitObserved: false,
      closeObserved: false,
      errorMessage: "ENOENT",
    });
    expect(closeStreams).toHaveBeenCalledTimes(1);
  });

  it("settles honestly when graceful and forced signal delivery both fail", async () => {
    vi.useFakeTimers();
    const closeStreams = vi.fn();
    const supervisor = createChildLifecycleSupervisor({
      signal: AbortSignal.abort(),
      sendSignal(signal) {
        throw new Error(`${signal} unavailable`);
      },
      closeStreams,
    });
    supervisor.start();

    await vi.advanceTimersByTimeAsync(SUBAGENT_TERMINATION_GRACE_MS + SUBAGENT_FORCE_EXIT_GRACE_MS);
    const result = await supervisor.settled;
    expect(result).toMatchObject({
      state: "termination_failed",
      terminationRequested: true,
      forceRequested: true,
      exitObserved: false,
    });
    expect(result.errorMessage).toContain("SIGKILL failed");
    expect(closeStreams).toHaveBeenCalledTimes(1);
  });

  it("cleans the abort listener and settles only once across late races", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sendSignal = vi.fn(() => true);
    const supervisor = createChildLifecycleSupervisor({
      signal: controller.signal,
      sendSignal,
      closeStreams: vi.fn(),
    });
    supervisor.start();
    supervisor.exited(0, null);
    supervisor.closed(0, null);
    const first = await supervisor.settled;

    controller.abort();
    supervisor.spawnFailed(new Error("late error"));
    supervisor.exited(9, null);
    supervisor.closed(9, null);
    await vi.runAllTimersAsync();

    expect(await supervisor.settled).toBe(first);
    expect(first.state).toBe("closed");
    expect(sendSignal).not.toHaveBeenCalled();
  });

  function fakeChild() {
    const processDouble = new EventEmitter();
    const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const kill = vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => {
        processDouble.emit("exit", null, signal);
        processDouble.emit("close", null, signal);
      });
      return true;
    });
    return Object.assign(processDouble, { stdout, stderr, kill });
  }

  it("uses the bounded fallback finalizer when child-finalizer setup fails", async () => {
    const child = fakeChild();
    const scope = createChildLifecycleScope({
      maxActiveChildren: 1,
      createFinalizer() {
        throw new Error("synthetic finalizer setup failure");
      },
    });

    const begun = scope.beginChild(child);
    expect(begun).toMatchObject({ accepted: false, reason: "setup_failed" });
    const terminal = await begun.finalizer.settled;
    expect(terminal).toMatchObject({
      state: "setup_failed",
      terminationRequested: true,
      forceRequested: true,
    });
    expect(terminal.errorMessage).toContain("synthetic finalizer setup failure");
    await Promise.all([scope.finalize(), scope.finalize()]);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(scope.activeCount).toBe(0);
  });

  it("finalizes a limit-rejected child exactly once without disturbing the admitted child", async () => {
    const scope = createChildLifecycleScope({ maxActiveChildren: 1 });
    const admittedChild = fakeChild();
    const rejectedChild = fakeChild();
    const admitted = scope.beginChild(admittedChild);
    const rejected = scope.beginChild(rejectedChild);

    expect(admitted.accepted).toBe(true);
    expect(rejected).toMatchObject({ accepted: false, reason: "limit_rejected" });
    await expect(rejected.finalizer.settled).resolves.toMatchObject({
      state: "admission_rejected",
    });
    expect(rejectedChild.kill).toHaveBeenCalledTimes(1);
    expect(admittedChild.kill).not.toHaveBeenCalled();
    expect(scope.activeCount).toBe(1);

    await Promise.all([
      scope.finalize(),
      scope.finalize(),
      admitted.finalizer.finalize("scope_shutdown"),
    ]);
    expect(admittedChild.kill).toHaveBeenCalledTimes(1);
    expect(admittedChild.stdout.destroy).not.toHaveBeenCalled();
    expect(rejectedChild.stdout.destroy).not.toHaveBeenCalled();
    expect(scope.activeCount).toBe(0);
  });

  it("rejects a child begun during shutdown through its own bounded finalizer", async () => {
    const scope = createChildLifecycleScope({ maxActiveChildren: 2 });
    const activeChild = fakeChild();
    const racingChild = fakeChild();
    const active = scope.beginChild(activeChild);
    expect(active.accepted).toBe(true);

    const shutdown = scope.finalize();
    const racing = scope.beginChild(racingChild);
    expect(racing).toMatchObject({ accepted: false, reason: "scope_finalizing" });
    await Promise.all([shutdown, racing.finalizer.settled]);

    expect(activeChild.kill).toHaveBeenCalledTimes(1);
    expect(racingChild.kill).toHaveBeenCalledTimes(1);
    expect(scope.activeCount).toBe(0);
  });

  it("stays permanently closed after finalization resolves and cleans every later child", async () => {
    const scope = createChildLifecycleScope({ maxActiveChildren: 2 });

    const firstFinalization = scope.finalize();
    await firstFinalization;
    expect(scope.finalize()).toBe(firstFinalization);

    const lateChild = fakeChild();
    const late = scope.beginChild(lateChild);
    expect(late).toMatchObject({ accepted: false, reason: "scope_finalizing" });
    await expect(late.finalizer.settled).resolves.toMatchObject({
      state: "admission_rejected",
      terminationRequested: true,
    });

    expect(lateChild.kill).toHaveBeenCalledTimes(1);
    expect(scope.activeCount).toBe(0);
  });

  it("keeps a late setup failure classified as closed-scope rejection and cleans it", async () => {
    const scope = createChildLifecycleScope({
      maxActiveChildren: 1,
      createFinalizer() {
        throw new Error("late synthetic setup failure");
      },
    });
    await scope.finalize();
    const lateChild = fakeChild();

    const late = scope.beginChild(lateChild);
    expect(late).toMatchObject({ accepted: false, reason: "scope_finalizing" });
    const terminal = await late.finalizer.settled;

    expect(terminal).toMatchObject({
      state: "admission_rejected",
      terminationRequested: true,
      forceRequested: true,
    });
    expect(terminal.errorMessage).toContain("late synthetic setup failure");
    expect(lateChild.kill).toHaveBeenCalledTimes(1);
    expect(scope.activeCount).toBe(0);
  });

  it("rejects concurrent late admissions without orphaning any child", async () => {
    const scope = createChildLifecycleScope({ maxActiveChildren: 2 });
    await scope.finalize();
    const lateChildren = Array.from({ length: 8 }, () => fakeChild());

    const admissions = await Promise.all(
      lateChildren.map((child) => Promise.resolve().then(() => scope.beginChild(child)))
    );
    for (const admission of admissions) {
      expect(admission).toMatchObject({ accepted: false, reason: "scope_finalizing" });
    }
    await Promise.all(admissions.map((admission) => admission.finalizer.settled));

    for (const child of lateChildren) expect(child.kill).toHaveBeenCalledTimes(1);
    expect(scope.activeCount).toBe(0);
  });

  it("keeps shutdown/finalize and late-event races idempotent", async () => {
    const scope = createChildLifecycleScope({ maxActiveChildren: 2 });
    const child = fakeChild();
    const begun = scope.beginChild(child);
    expect(begun.accepted).toBe(true);

    const shutdowns = [scope.finalize(), scope.finalize()];
    child.emit("error", new Error("late ignored error"));
    child.emit("exit", 9, null);
    child.emit("close", 9, null);
    await Promise.all(shutdowns);
    const terminal = await begun.finalizer.settled;

    expect(terminal.terminationRequested).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(scope.activeCount).toBe(0);
  });
});
