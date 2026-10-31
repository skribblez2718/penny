import { describe, expect, it } from "vitest";

import { fetchTextWithInactivity } from "../../inactivity-fetch.js";

describe("observability inactivity-aware fetch", () => {
  it("renews liveness on response headers and non-empty body chunks", async () => {
    const chunks = ["progress ", "continues ", "past total time"];
    const fetchWithProgress = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              chunks.forEach((chunk, index) => {
                setTimeout(
                  () => {
                    controller.enqueue(new TextEncoder().encode(chunk));
                    if (index === chunks.length - 1) controller.close();
                  },
                  20 * (index + 1)
                );
              });
            },
          }),
          { status: 200 }
        )
      )) as typeof fetch;

    await expect(
      fetchTextWithInactivity("http://localhost", {}, 30, fetchWithProgress)
    ).resolves.toMatchObject({
      text: chunks.join(""),
    });
  });

  it("aborts a transport that produces no trusted activity", async () => {
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })) as typeof fetch;

    await expect(fetchTextWithInactivity("http://localhost", {}, 20, hangingFetch)).rejects.toThrow(
      "fetch became inactive"
    );
  });
});
