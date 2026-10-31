import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { createServer as createTlsServer } from "node:https";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { VoiceStudioTransport } from "../dist/videogen/voice-studio-transport.js";
import { parseVoiceWireJson } from "../dist/videogen/voice-json.js";
import { measureVoiceLoudness } from "../dist/videogen/voice-audio-meter.js";
const limits = {
  max_text_bytes: 1000,
  max_chunks: 2,
  max_json_bytes: 1024,
  max_wav_bytes: 1024,
  max_sample_bytes: 1024,
  max_request_bytes: 128,
  connect_ms: 100,
  silence_ms: 40,
  poll_ms: 1,
  cancel_observations: 1,
};
async function endpoint(handle: (r: ServerResponse) => void) {
  const server = createServer((_, r) => handle(r));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
describe("Voice Studio confined provider wire protocol", () => {
  it.each([
    "redirect",
    "oversize-length",
    "oversize-chunked",
    "compressed",
    "wrong-mime",
    "invalid-utf8",
    "duplicate-key",
    "truncated",
    "silence",
  ])("rejects %s without redirects or leaked response text", async (mode) => {
    let calls = 0;
    await using e = await endpoint((r) => {
      calls++;
      if (mode === "redirect") {
        r.writeHead(302, { location: "http://example.invalid/private" });
        r.end();
        return;
      }
      const headers: Record<string, string> = {
        "content-type": mode === "wrong-mime" ? "text/html" : "application/json",
      };
      if (mode === "compressed") headers["content-encoding"] = "gzip";
      if (mode === "oversize-length") headers["content-length"] = "2048";
      if (mode === "truncated") headers["content-length"] = "100";
      r.writeHead(200, headers);
      if (mode === "silence") {
        r.flushHeaders();
        return;
      }
      if (mode === "duplicate-key") r.end('{"id":1,"id":2}');
      else if (mode === "invalid-utf8") r.end(Buffer.from([0xc0, 0xaf]));
      else if (mode.startsWith("oversize")) r.end("x".repeat(2048));
      else if (mode === "truncated") {
        r.write("{}");
        r.destroy();
      } else r.end("PRIVATE RESPONSE NOT FOR ERRORS");
    });
    const t = new VoiceStudioTransport({ mode: "isolated_loopback", origin: e.origin }, limits);
    await expect(t.json("GET", "/api/voices", new AbortController().signal)).rejects.toThrow(
      /^Voice Studio (transport|protocol|limit|status) failure$/u
    );
    expect(calls).toBe(1);
  });
  it("rejects excessive nesting, duplicate escaped keys, nonfinite and invalid JSON", () => {
    for (const text of [
      '{"id":1,"\\u0069d":2}',
      "[".repeat(34) + "0" + "]".repeat(34),
      "1e999",
      '{"x":1,}',
      "{}{}",
      '"unterminated',
    ])
      expect(() => parseVoiceWireJson(Buffer.from(text))).toThrow();
    expect(
      parseVoiceWireJson(
        Buffer.from(JSON.stringify({ message: 'a"b', a: [true, false, null, 1.5, -2] }))
      )
    ).toEqual({ message: 'a"b', a: [true, false, null, 1.5, -2] });
  });
  it("aborts before sending a request or oversized body, and refuses TLS downgrade", async () => {
    let calls = 0;
    await using e = await endpoint((r) => {
      calls++;
      r.end("[]");
    });
    const t = new VoiceStudioTransport({ origin: e.origin, mode: "isolated_loopback" }, limits),
      abort = new AbortController();
    abort.abort();
    await expect(t.json("GET", "/api/voices", abort.signal)).rejects.toThrow();
    await expect(
      t.json("POST", "/api/narrations", new AbortController().signal, {
        source_text: "x".repeat(500),
      })
    ).rejects.toThrow();
    const tls = new VoiceStudioTransport(
      {
        origin: e.origin.replace("http:", "https:"),
        mode: "trusted_tls",
        ca_pem: "invalid test CA",
        servername: "fixture.invalid",
        peer_cert_sha256: "1".repeat(64),
      },
      limits
    );
    await expect(tls.json("GET", "/api/voices", new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it.each([1, 2] as const)(
    "independently referenced %i-channel LUFS/peak, never speech claims",
    (channels) => {
      // A separate FFmpeg ebur128 measurement of this one-second 1kHz, -6.0206dBFS PCM16
      // fixture reported -9.0 LUFS mono and -6.0 LUFS stereo (0.1-LU output precision).
      const pcm = Buffer.alloc(48000 * 2 * channels);
      for (let i = 0; i < 48000; i++)
        for (let ch = 0; ch < channels; ch++)
          pcm.writeInt16LE(
            Math.round(16384 * Math.sin((2 * Math.PI * 1000 * i) / 48000)),
            (i * channels + ch) * 2
          );
      const m = measureVoiceLoudness(pcm, channels, 48000);
      expect(Math.abs(m.loudness_lufs - (channels === 1 ? -9 : -6))).toBeLessThan(0.1);
      expect(m.peak_dbfs).toBeCloseTo(-6.020599913, 6);
      expect(() => measureVoiceLoudness(pcm.subarray(0, 100), channels, 48000)).toThrow();
      expect(() =>
        measureVoiceLoudness(Buffer.alloc(48000 * 2 * channels), channels, 48000)
      ).toThrow();
      expect(() => measureVoiceLoudness(pcm, channels, 7999)).toThrow();
    }
  );
  it.skipIf(spawnSync("openssl", ["version"], { stdio: "ignore", timeout: 2000 }).status !== 0)(
    "accepts only the exact CA/hostname/certificate-pinned local TLS service",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "voice-tls-test-"));
      using _scratch = {
        [Symbol.dispose]() {
          rmSync(root, { recursive: true, force: true });
        },
      };
      const keyPath = path.join(root, "key.pem"),
        certPath = path.join(root, "cert.pem");
      // Ephemeral test-only certificate/key; never tracked, transmitted, or used as deployment proof.
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=fixture.invalid",
          "-addext",
          "subjectAltName=DNS:fixture.invalid",
          "-keyout",
          keyPath,
          "-out",
          certPath,
        ],
        { stdio: "ignore", timeout: 10000 }
      );
      const cert = readFileSync(certPath),
        key = readFileSync(keyPath);
      let calls = 0;
      const server = createTlsServer({ cert, key }, (_, r) => {
        calls++;
        r.writeHead(200, { "content-type": "application/json" });
        r.end("[]");
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const a = server.address();
        if (!a || typeof a === "string") throw new Error("TLS fixture address");
        const config = {
          origin: `https://127.0.0.1:${a.port}`,
          mode: "trusted_tls",
          servername: "fixture.invalid",
          ca_pem: cert.toString(),
          peer_cert_sha256: createHash("sha256")
            .update(new X509Certificate(cert).raw)
            .digest("hex"),
        };
        const stable = { ...limits, connect_ms: 1000, silence_ms: 1000 };
        expect(
          await new VoiceStudioTransport(config, stable).json(
            "GET",
            "/api/voices",
            new AbortController().signal
          )
        ).toEqual([]);
        await expect(
          new VoiceStudioTransport({ ...config, peer_cert_sha256: "0".repeat(64) }, stable).json(
            "GET",
            "/api/voices",
            new AbortController().signal
          )
        ).rejects.toThrow();
        await expect(
          new VoiceStudioTransport({ ...config, servername: "wrong.invalid" }, stable).json(
            "GET",
            "/api/voices",
            new AbortController().signal
          )
        ).rejects.toThrow();
        // Pin and hostname rejection both occur before sending an HTTP request.
        expect(calls).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
