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
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "summary" }] })
      .mockRejectedValueOnce(cancellation);
    vi.doMock(COMPAT_SPEC, () => ({ complete }));

    const { _summaryInternals } = await import("../../summarizer.js");
    const model = { provider: "test", id: "model" };
    const context = { messages: [] };
    const options = { signal: new AbortController().signal };

    await expect(_summaryInternals.complete(model, context, options)).resolves.toEqual({
      content: [{ type: "text", text: "summary" }],
    });
    await expect(_summaryInternals.complete(model, context, options)).rejects.toBe(cancellation);
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

  it("rejects when the lazily imported compat module has no callable complete export", async () => {
    vi.doMock(COMPAT_SPEC, () => ({ complete: null }));

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(
      _summaryInternals.complete({ provider: "test", id: "model" }, { messages: [] }, {})
    ).rejects.toThrow();
  });

  it("rejects a malformed compat response at the unknown result boundary", async () => {
    vi.doMock(COMPAT_SPEC, () => ({
      complete: () => Promise.resolve({ content: [{ type: "text", text: 42 }] }),
    }));

    const { _summaryInternals } = await import("../../summarizer.js");

    await expect(
      _summaryInternals.complete({ provider: "test", id: "model" }, { messages: [] }, {})
    ).rejects.toThrow(/invalid result/);
  });
});
