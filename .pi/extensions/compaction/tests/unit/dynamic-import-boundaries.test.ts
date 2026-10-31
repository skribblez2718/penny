import { beforeEach, describe, expect, it, vi } from "vitest";

const CODING_AGENT_SPEC = "@earendil-works/pi-coding-agent";
const COMPAT_SPEC = "@earendil-works/pi-ai/compat";

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock(CODING_AGENT_SPEC);
  vi.doUnmock(COMPAT_SPEC);
});

describe("summarizer dynamic import boundaries", () => {
  it("converts then serializes messages through the lazily imported coding-agent module", async () => {
    const converted = { messages: "converted" };
    const convertToLlm = vi.fn(() => converted);
    const serializeConversation = vi.fn(() => "serialized conversation");
    vi.doMock(CODING_AGENT_SPEC, () => ({ convertToLlm, serializeConversation }));

    const { _summaryInternals } = await import("../../summarizer.js");
    const messages = [{ role: "user", content: "hello" }];

    await expect(_summaryInternals.serialize(messages)).resolves.toBe("serialized conversation");
    expect(convertToLlm).toHaveBeenCalledWith(messages);
    expect(serializeConversation).toHaveBeenCalledWith(converted);
  });

  it("rejects when the coding-agent dynamic import fails", async () => {
    const importFailure = new Error("coding-agent unavailable");
    vi.doMock(CODING_AGENT_SPEC, () => {
      throw importFailure;
    });

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(_summaryInternals.serialize([])).rejects.toThrow();
  });

  it("rejects when the lazily imported coding-agent module has a malformed export", async () => {
    vi.doMock(CODING_AGENT_SPEC, () => ({
      convertToLlm: () => [],
      serializeConversation: "not callable",
    }));

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(_summaryInternals.serialize([])).rejects.toThrow();
  });

  it("rejects a non-string serializer result at the unknown module boundary", async () => {
    vi.doMock(CODING_AGENT_SPEC, () => ({
      convertToLlm: () => [],
      serializeConversation: () => 42,
    }));

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(_summaryInternals.serialize([])).rejects.toThrow(/non-string/);
  });

  it("returns the compat completion and propagates cancellation without wrapping it", async () => {
    const cancellation = new DOMException("cancelled", "AbortError");
    const result = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "summary" }] })
      .mockRejectedValueOnce(cancellation);
    const stream = vi.fn(() => ({ async *[Symbol.asyncIterator]() {}, result }));
    vi.doMock(COMPAT_SPEC, () => ({ stream }));

    const { _summaryInternals } = await import("../../summarizer.js");
    const model = { provider: "test", id: "model" };
    const context = { messages: [] };
    const options = { signal: new AbortController().signal };

    await expect(_summaryInternals.complete(model, context, options)).resolves.toEqual({
      content: [{ type: "text", text: "summary" }],
    });
    await expect(_summaryInternals.complete(model, context, options)).rejects.toBe(cancellation);
    expect(stream).toHaveBeenCalledWith(model, context, options);
  });

  it("reports only actual nonempty stream deltas without leaking any payload", async () => {
    vi.doMock(COMPAT_SPEC, () => ({
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "start" };
          yield { type: "text_delta", delta: "" };
          yield { type: "text_delta", delta: "private summary" };
          yield { type: "thinking_delta", delta: "é" };
          yield { type: "toolcall_delta", delta: "not summary progress" };
        },
        result: async () => ({ content: [{ type: "text", text: "summary" }] }),
      }),
    }));
    const { _summaryInternals } = await import("../../summarizer.js");
    const progress = vi.fn();
    await expect(
      _summaryInternals.complete({ provider: "test", id: "model" }, { messages: [] }, {}, progress)
    ).resolves.toEqual({ content: [{ type: "text", text: "summary" }] });
    expect(progress.mock.calls).toEqual([
      [{ activity_class: "assistant_text_delta", observed_units: 15 }],
      [{ activity_class: "assistant_thinking_delta", observed_units: 2 }],
    ]);
  });

  it("rejects when the compat dynamic import fails", async () => {
    const importFailure = new Error("compat unavailable");
    vi.doMock(COMPAT_SPEC, () => {
      throw importFailure;
    });

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(
      _summaryInternals.complete({ provider: "test", id: "model" }, { messages: [] }, {})
    ).rejects.toThrow();
  });

  it("rejects when the lazily imported compat module has no callable stream export", async () => {
    vi.doMock(COMPAT_SPEC, () => ({ stream: null }));

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(
      _summaryInternals.complete({ provider: "test", id: "model" }, { messages: [] }, {})
    ).rejects.toThrow();
  });

  it("rejects a malformed compat response at the unknown result boundary", async () => {
    vi.doMock(COMPAT_SPEC, () => ({
      stream: () => ({
        async *[Symbol.asyncIterator]() {},
        result: async () => ({ content: [{ type: "text", text: 42 }] }),
      }),
    }));

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(
      _summaryInternals.complete({ provider: "test", id: "model" }, { messages: [] }, {})
    ).rejects.toThrow(/invalid result/);
  });
});
