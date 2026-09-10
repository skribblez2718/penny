import { describe, expect, it } from "vitest";
import { ownedPlaywrightBrowserProcess, unrefPlaywrightCdpConnection } from "../../browser.js";

describe("Playwright CDP transport boundary", () => {
  it("unrefs the private WebSocket with its receiver and accepts host extras", () => {
    const webSocket = {
      calls: 0,
      extra: "preserved",
      unref() {
        this.calls += 1;
      },
    };
    const browserHost = {
      _connection: {
        _transport: {
          _ws: webSocket,
          transportExtra: true,
        },
        connectionExtra: true,
      },
      browserExtra: true,
    };

    expect(unrefPlaywrightCdpConnection(browserHost)).toBe(true);
    expect(webSocket.calls).toBe(1);
  });

  it("ignores missing and wrong-type private transport members", () => {
    for (const value of [
      null,
      {},
      { _connection: null },
      { _connection: { _transport: [] } },
      { _connection: { _transport: { _ws: { unref: "not-a-function" } } } },
    ]) {
      expect(unrefPlaywrightCdpConnection(value)).toBe(false);
    }
  });

  it("extracts only a structurally validated owned Chromium process", () => {
    const browserProcess = {
      exitCode: null,
      signalCode: null,
      kill() {
        return true;
      },
      once() {
        return this;
      },
      unref() {},
    };
    const browserHost = {
      _connection: {
        toImpl() {
          return { options: { browserProcess: { process: browserProcess } } };
        },
      },
    };

    expect(ownedPlaywrightBrowserProcess(browserHost)).toBe(browserProcess);
    expect(ownedPlaywrightBrowserProcess({ _connection: { toImpl: "not-a-function" } })).toBeNull();
    expect(
      ownedPlaywrightBrowserProcess({
        _connection: { toImpl: () => ({ options: { browserProcess: { process: {} } } }) },
      })
    ).toBeNull();
  });

  it("keeps private-member access and unref failures best-effort", () => {
    const browserHost = {
      _connection: {
        _transport: {
          _ws: {
            unref() {
              throw new Error("socket already closed");
            },
          },
        },
      },
    };
    const throwingHost = {
      get _connection(): never {
        throw new Error("private transport changed");
      },
    };

    expect(() => unrefPlaywrightCdpConnection(browserHost)).not.toThrow();
    expect(unrefPlaywrightCdpConnection(browserHost)).toBe(false);
    expect(unrefPlaywrightCdpConnection(throwingHost)).toBe(false);
  });
});
