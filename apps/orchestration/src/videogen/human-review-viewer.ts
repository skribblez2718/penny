import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ArtifactRef } from "../contracts.js";
import { exactRef, readExact } from "./bounds.js";
import {
  candidateDigest,
  currentHumanReviewCandidate,
  type HumanReviewCandidateV1,
  type HumanReviewService,
} from "./human-review.js";
import { PinnedReviewFile, reviewByteRange } from "./human-review-file.js";
import { humanReviewPage, REVIEW_CSS, REVIEW_JS } from "./human-review-page.js";

export interface HumanReviewViewerOptions {
  readonly service: HumanReviewService;
  readonly run_id: string;
  readonly master_file: {
    readonly path: string;
    readonly sha256: string;
    readonly max_bytes: number;
  };
  readonly playback_device_profile_ref: ArtifactRef;
  readonly expiry_ms: number;
  readonly max_requests: number;
  readonly max_served_bytes: number;
}
/** Read-only loopback delivery, not a trusted user transport. No POST, approval nonce, cookie,
 * principal, capability, path route, remote asset, server write or arbitrary URL is exposed. */
export async function openHumanReviewViewer(input: HumanReviewViewerOptions): Promise<{
  readonly url: string;
  readonly candidate: HumanReviewCandidateV1;
  readonly expires_at_utc: string;
  readonly closed: Promise<void>;
  close(): void;
}> {
  const candidate = currentHumanReviewCandidate(input.service, input.run_id);
  const device = exactRef(input.playback_device_profile_ref);
  readExact(input.service.artifacts, input.service.config.projectId, device, 1024 * 1024);
  if (
    input.master_file.sha256 !== candidate.master_ref.content_digest ||
    !Number.isSafeInteger(input.expiry_ms) ||
    input.expiry_ms < candidate.duration_ms + 60000 ||
    input.expiry_ms > 24 * 60 * 60 * 1000 ||
    !Number.isSafeInteger(input.max_requests) ||
    input.max_requests < 1 ||
    input.max_requests > 4096 ||
    !Number.isSafeInteger(input.max_served_bytes) ||
    input.max_served_bytes < candidate.master_ref.byte_length ||
    input.max_served_bytes > 16 * 1024 * 1024 * 1024
  )
    throw new Error("review viewer pins or finite limits invalid");
  const pinned = new PinnedReviewFile(input.master_file);
  if (pinned.size !== candidate.master_ref.byte_length) {
    pinned[Symbol.dispose]();
    throw new Error("master length mismatch");
  }
  const base = `/review/${randomBytes(32).toString("hex")}/`;
  const page = humanReviewPage(candidate, device);
  const started = performance.now();
  let host = "",
    origin = "",
    requests = 0,
    served = 0,
    closing = false;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    (req, res) => {
      const send = (status: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
        res.statusCode = status;
        res.setHeader("Content-Type", type);
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(req.method === "HEAD" ? undefined : body);
      };
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"
      );
      res.setHeader("Connection", "close");
      if (closing || performance.now() - started >= input.expiry_ms) {
        res.once("finish", close);
        send(410, "Review expired");
        return;
      }
      if (++requests > input.max_requests) {
        res.once("finish", close);
        send(429, "Review request limit");
        return;
      }
      if (
        req.socket.remoteAddress !== "127.0.0.1" ||
        req.headers.host !== host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] !== undefined &&
          !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))
      ) {
        send(403, "Review origin refused");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        send(405, "Read-only viewer; use trusted questionnaire");
        return;
      }
      if (
        req.headers["transfer-encoding"] ||
        (req.headers["content-length"] && req.headers["content-length"] !== "0")
      ) {
        send(400, "No request body accepted");
        return;
      }
      // Compare the raw target, not a URL-normalized path: encoded traversal, queries and absolute
      // request-targets never become file selectors or bypass the exact route allowlist.
      const routes = new Map([
        [base, [page, "text/html; charset=utf-8"]],
        [`${base}style.css`, [REVIEW_CSS, "text/css; charset=utf-8"]],
        [`${base}viewer.js`, [REVIEW_JS, "text/javascript; charset=utf-8"]],
      ]);
      const asset = routes.get(req.url ?? "");
      if (!asset && req.url !== `${base}master.mp4`) {
        send(404, "Not found");
        return;
      }
      try {
        if (
          candidateDigest(currentHumanReviewCandidate(input.service, input.run_id)) !==
          candidateDigest(candidate)
        )
          throw new Error("candidate changed");
        pinned.verify();
        if (asset) {
          const [text, type] = asset;
          if (text === undefined || type === undefined) throw new Error("missing compiled asset");
          const size = Buffer.byteLength(text);
          if (served + size > input.max_served_bytes) {
            res.once("finish", close);
            send(429, "Review byte limit");
            return;
          }
          served += size;
          send(200, text, type);
          return;
        }
        let range;
        try {
          range = reviewByteRange(req.headers.range, pinned.size);
        } catch {
          res.setHeader("Content-Range", `bytes */${pinned.size}`);
          send(416, "Range not satisfiable");
          return;
        }
        const size = range.end - range.start + 1;
        if (served + size > input.max_served_bytes) {
          res.once("finish", close);
          send(429, "Review byte limit");
          return;
        }
        served += size;
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("ETag", `"${candidate.master_ref.content_digest}"`);
        if (range.partial)
          res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${pinned.size}`);
        send(range.partial ? 206 : 200, pinned.slice(range.start, range.end + 1), "video/mp4");
        // HEAD advertises the same representation length but sends no bytes.
      } catch {
        send(409, "Review candidate unavailable or changed");
      }
    }
  );
  server.maxConnections = 4;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(10000, (socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("checkContinue", (_req, res) => {
    res.writeHead(405, { Connection: "close" });
    res.end();
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve) =>
    server.once("close", () => {
      clearTimeout(timer);
      pinned[Symbol.dispose]();
      resolve();
    })
  );
  const close = () => {
    if (!closing) {
      closing = true;
      server.close();
      server.closeAllConnections();
    }
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("loopback listener missing");
    host = `127.0.0.1:${address.port}`;
    origin = `http://${host}`;
    timer = setTimeout(close, input.expiry_ms);
    timer.unref();
    return {
      url: origin + base,
      candidate: structuredClone(candidate),
      expires_at_utc: new Date(Date.now() + input.expiry_ms).toISOString(),
      closed,
      close,
    };
  } catch (error) {
    close();
    pinned[Symbol.dispose]();
    throw error;
  }
}
