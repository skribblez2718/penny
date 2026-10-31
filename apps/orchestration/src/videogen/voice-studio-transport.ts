import { parseVoiceWireJson } from "./voice-json.js";
import http from "node:http";
import https from "node:https";
import { isIP, connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { ComfySocketMeter } from "../comfy/client.js";
import { createHash } from "node:crypto";
import { TLSSocket } from "node:tls";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { canonicalJson } from "../canonical-json.js";
import {
  VoiceStudioTransportV1Schema,
  VoiceStudioLimitsV1Schema,
  type VoiceStudioTransportV1,
  type VoiceStudioLimitsV1,
} from "./voice-studio-contracts.js";

export class VoiceStudioTransportError extends Error {
  constructor(
    readonly code: "transport" | "status" | "limit" | "protocol",
    readonly status: number | null = null
  ) {
    super(`Voice Studio ${code} failure`);
    this.name = "VoiceStudioTransportError";
  }
}
/** Literal addresses avoid DNS rebinding. TLS additionally verifies the configured DNS service
 * identity, CA and exact certificate bytes. Independent network/access isolation is host evidence. */
export function validateVoiceStudioTransport(value: unknown): VoiceStudioTransportV1 {
  const t = validateSkillSchema(VoiceStudioTransportV1Schema, value, "VoiceStudioTransportV1");
  const u = new URL(t.origin);
  const host = u.hostname.replace(/^\[|\]$/gu, "");
  if (
    !isIP(host) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.origin !== t.origin
  )
    throw new Error("Voice Studio requires canonical literal origin without credentials/path");
  if (t.mode === "isolated_loopback") {
    if (u.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host))
      throw new Error("isolated literal loopback required");
  } else if (
    u.protocol !== "https:" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(t.servername) ||
    isIP(t.servername)
  ) {
    throw new Error("trusted TLS identity required");
  }
  return structuredClone(t);
}
export class VoiceStudioTransport {
  readonly config: VoiceStudioTransportV1;
  readonly limits: VoiceStudioLimitsV1;
  constructor(
    config: unknown,
    limits: unknown,
    readonly onBytes?: (bytes: number) => void,
    readonly wireMeter?: ComfySocketMeter
  ) {
    this.config = validateVoiceStudioTransport(config);
    this.limits = structuredClone(
      validateSkillSchema(VoiceStudioLimitsV1Schema, limits, "VoiceStudioLimitsV1")
    );
  }
  async json(
    method: "GET" | "POST",
    route: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<unknown> {
    const bytes = await this.request(
      method,
      route,
      signal,
      this.limits.max_json_bytes,
      "application/json",
      body
    );
    try {
      return parseVoiceWireJson(bytes);
    } catch {
      throw new VoiceStudioTransportError("protocol");
    }
  }
  wav(route: string, signal: AbortSignal, sample = false): Promise<Buffer> {
    return this.request(
      "GET",
      route,
      signal,
      sample ? this.limits.max_sample_bytes : this.limits.max_wav_bytes,
      "audio/wav"
    );
  }
  private async request(
    method: "GET" | "POST",
    route: string,
    signal: AbortSignal,
    cap: number,
    media: string,
    body?: unknown
  ): Promise<Buffer> {
    // Only these concrete source-inspected routes exist. No caller URL, SSE path, or file locator.
    if (
      route !== "/openapi.json" &&
      !/^\/api\/(?:system\/(?:health|gpu)|voices(?:\/[a-f0-9]{12}(?:\/sample)?)?|narrations(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})?|tts\/(?:generate|jobs\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|result\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.wav|cancel\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}))$/u.test(
        route
      )
    )
      throw new VoiceStudioTransportError("protocol");
    if (
      (route.startsWith("/api/system/") || route === "/openapi.json") &&
      (method !== "GET" || media !== "application/json" || body !== undefined)
    )
      throw new VoiceStudioTransportError("protocol");
    const encoded = body === undefined ? undefined : Buffer.from(canonicalJson(body));
    if (encoded !== undefined && encoded.length > this.limits.max_request_bytes)
      throw new VoiceStudioTransportError("limit");
    if (signal.aborted) return Promise.reject(new VoiceStudioTransportError("transport"));
    const t = this.config;
    let socketDone: Promise<void> = Promise.resolve();
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        let finished = false;
        let meteredSocket: Socket | undefined;
        let rawTlsSocket: Socket | undefined;
        const tlsAgent =
          t.mode === "trusted_tls" ? new https.Agent({ keepAlive: false }) : undefined;
        if (tlsAgent)
          tlsAgent.createConnection = () => {
            const origin = new URL(t.origin);
            rawTlsSocket = connectTcp({
              host: origin.hostname.replace(/^\[|\]$/gu, ""),
              port: Number(origin.port || 443),
            });
            if (t.mode !== "trusted_tls") throw new Error("TLS binding missing");
            return connectTls({
              socket: rawTlsSocket,
              ca: t.ca_pem,
              servername: t.servername,
              rejectUnauthorized: true,
              minVersion: "TLSv1.3",
            });
          };
        let metered = false;
        const meter = (): void => {
          if (!metered && meteredSocket) {
            metered = true;
            this.onBytes?.(meteredSocket.bytesRead + meteredSocket.bytesWritten);
          }
        };
        let response: http.IncomingMessage | undefined;
        const fail = (
          code: "transport" | "status" | "limit" | "protocol",
          status: number | null = null
        ): void => {
          if (finished) return;
          finished = true;
          clearTimeout(connect);
          clearTimeout(silence);
          signal.removeEventListener("abort", aborted);
          try {
            // Socket closure below owns all counting, including failed connections.
          } catch {
            /* Transport fails closed; missing export blocks settlement. */
          }
          response?.destroy();
          req.destroy();
          reject(new VoiceStudioTransportError(code, status));
        };
        const aborted = (): void => fail("transport");
        const options: https.RequestOptions = {
          method,
          agent: tlsAgent ?? false,
          headers: {
            accept: media,
            "accept-encoding": "identity",
            ...(encoded === undefined
              ? {}
              : { "content-type": "application/json", "content-length": encoded.length }),
          },
          ...(t.mode === "trusted_tls"
            ? {
                ca: t.ca_pem,
                servername: t.servername,
                rejectUnauthorized: true,
                minVersion: "TLSv1.3",
              }
            : {}),
        };
        const handle = (r: http.IncomingMessage): void => {
          response = r;
          clearTimeout(connect);
          if (r.statusCode === undefined || r.statusCode < 200 || r.statusCode >= 300)
            return fail("status", r.statusCode ?? null);
          if (
            (r.headers["content-encoding"] ?? "identity") !== "identity" ||
            r.headers["content-type"]?.split(";")[0]?.trim() !== media
          )
            return fail("protocol");
          const length = r.headers["content-length"];
          if (length !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > cap))
            return fail("limit");
          const chunks: Buffer[] = [];
          let size = 0;
          r.on("data", (data: Buffer) => {
            size += data.length;
            if (size > cap) return fail("limit");
            chunks.push(data);
            reset();
          });
          r.on("error", () => fail("transport"));
          r.on("aborted", () => fail("transport"));
          r.on("end", () => {
            if (finished) return;
            if (!r.complete || (length !== undefined && Number(length) !== size))
              return fail("protocol");
            finished = true;
            clearTimeout(connect);
            clearTimeout(silence);
            signal.removeEventListener("abort", aborted);
            try {
              req.destroy();
              resolve(Buffer.concat(chunks, size));
            } catch (error) {
              reject(error);
            }
          });
        };
        const url = new URL(route, t.origin);
        const req =
          t.mode === "trusted_tls"
            ? https.request(url, options, handle)
            : http.request(url, options, handle);
        const connect = setTimeout(() => fail("transport"), this.limits.connect_ms);
        let silence = setTimeout(() => fail("transport"), this.limits.silence_ms);
        const reset = (): void => {
          clearTimeout(silence);
          silence = setTimeout(() => fail("transport"), this.limits.silence_ms);
        };
        req.on("socket", (connected) => {
          meteredSocket = rawTlsSocket ?? connected;
          let finish: ReturnType<ComfySocketMeter["beginSocket"]> | undefined;
          try {
            finish = this.wireMeter?.beginSocket();
          } catch {
            fail("protocol");
            return;
          }
          socketDone = new Promise<void>((done, failClose) => {
            connected.once("close", () => {
              try {
                meter();
                if (meteredSocket) finish?.(meteredSocket.bytesWritten, meteredSocket.bytesRead);
                tlsAgent?.destroy();
                done();
              } catch (error) {
                failClose(error);
              }
            });
          });
          const socket = connected;
          if (t.mode === "trusted_tls") {
            if (!(socket instanceof TLSSocket)) return fail("protocol");
            socket.once("secureConnect", () => {
              const cert = socket.getPeerCertificate();
              if (
                !socket.authorized ||
                !cert.raw ||
                createHash("sha256").update(cert.raw).digest("hex") !== t.peer_cert_sha256
              )
                fail("protocol");
            });
          }
          socket.once(t.mode === "trusted_tls" ? "secureConnect" : "connect", () => {
            clearTimeout(connect);
            reset();
          });
        });
        req.on("error", () => fail("transport"));
        signal.addEventListener("abort", aborted, { once: true });
        req.end(encoded);
      });
    } finally {
      await socketDone;
    }
  }
}
