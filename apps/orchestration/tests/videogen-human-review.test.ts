import { request } from "node:http";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { inspectReportedPlaybackCoverage } from "../dist/videogen/human-review-coverage.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { humanReviewFixture } from "./helpers/videogen-human-review-fixture.js";
import {
  currentHumanReviewCandidate,
  candidateDigest,
  parseHumanReviewAnswers,
  humanReviewPositive,
} from "../dist/videogen/human-review.js";
import { openHumanReviewViewer } from "../dist/videogen/human-review-viewer.js";
import { PinnedReviewFile, reviewByteRange } from "../dist/videogen/human-review-file.js";
import { humanReviewPage, REVIEW_JS } from "../dist/videogen/human-review-page.js";
import { runVideogenHumanReviewCli } from "../dist/videogen-human-review-cli.js";
import { executionState, saveExecution } from "../dist/videogen/execution-state.js";
function get(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  target?: string
): Promise<{ status: number; bytes: Buffer; headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: "127.0.0.1",
        port: u.port,
        path: target ?? u.pathname,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            bytes: Buffer.concat(chunks),
            headers: res.headers,
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}
async function viewer(f: FoundationFixture, limits = {}) {
  const x = humanReviewFixture(f);
  const v = await openHumanReviewViewer({
    service: x.service,
    run_id: f.run_id,
    master_file: { path: x.file, sha256: x.master.content_digest, max_bytes: 1000000 },
    playback_device_profile_ref: x.device,
    expiry_ms: 120000,
    max_requests: 128,
    max_served_bytes: 1000000,
    ...limits,
  });
  return { x, v };
}
describe("read-only human review delivery (synthetic bytes, no browser approval)", () => {
  it("serves exact pinned bytes, single/suffix/open ranges, HEAD and safe headers", async () => {
    using f = new FoundationFixture();
    const { x, v } = await viewer(f);
    try {
      const full = await get(v.url + "master.mp4");
      expect(full.status).toBe(200);
      expect(full.bytes).toEqual(f.store.read(x.master));
      expect(full.headers["content-type"]).toBe("video/mp4");
      expect(full.headers["cache-control"]).toBe("no-store");
      expect(full.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(full.headers["access-control-allow-origin"]).toBeUndefined();
      for (const [range, start, end] of [
        ["bytes=1-3", 1, 4],
        ["bytes=-3", full.bytes.length - 3, full.bytes.length],
        ["bytes=3-", 3, full.bytes.length],
      ] as const) {
        const r = await get(v.url + "master.mp4", "GET", { Range: range });
        expect(r.status).toBe(206);
        expect(r.bytes).toEqual(full.bytes.subarray(start, end));
      }
      const head = await get(v.url + "master.mp4", "HEAD");
      expect(head.bytes.length).toBe(0);
      expect(Number(head.headers["content-length"])).toBe(full.bytes.length);
      for (const range of [
        "bytes=99999-",
        "bytes=0-1,3-4",
        "bytes=-0",
        "bytes=3-1",
        "bytes=9007199254740999-",
      ])
        expect((await get(v.url + "master.mp4", "GET", { Range: range })).status).toBe(416);
      expect(f.checkpointer.loadRunById(f.run_id)?.selectedArtifacts).not.toContainEqual(
        expect.objectContaining({ kind: "videogen-playback-review" })
      );
    } finally {
      v.close();
      await v.closed;
    }
  });
  it("denies foreign origins, DNS-rebinding Host, traversal, arbitrary assets and ALL POSTs, regardless of content type or claimed approval", async () => {
    using f = new FoundationFixture();
    const { v } = await viewer(f);
    try {
      for (const headers of [
        { Origin: "https://evil.invalid" },
        { Host: "evil.invalid" },
        { "Sec-Fetch-Site": "cross-site" },
      ])
        expect((await get(v.url, "GET", headers)).status).toBe(403);
      for (const target of [
        "/",
        "/etc/passwd",
        new URL(v.url).pathname + "../master.mp4",
        new URL(v.url).pathname + "%2e%2e/master.mp4",
        new URL(v.url).pathname + "master.mp4?path=/etc/passwd",
        "http://evil.invalid/",
      ])
        expect((await get(v.url, "GET", {}, target)).status).toBe(404);
      for (const type of ["application/json", "text/plain", "application/x-www-form-urlencoded"])
        expect(
          (
            await get(v.url + "approve", "POST", {
              "Content-Type": type,
              Origin: new URL(v.url).origin,
            })
          ).status
        ).toBe(405);
      expect((await get(v.url, "POST", { Origin: "https://evil.invalid" })).status).toBe(403);
      expect((await get(v.url, "POST", { "Content-Length": "99999999" })).status).toBe(405);
      expect((await get(v.url, "GET", { "Content-Length": "1" })).status).toBe(400);
    } finally {
      v.close();
      await v.closed;
    }
  });
  it("refuses hash drift and inode replacement rather than re-opening a pathname", async () => {
    using f = new FoundationFixture();
    const { x, v } = await viewer(f);
    try {
      writeFileSync(x.file, Buffer.alloc(x.master.byte_length, 65));
      expect((await get(v.url + "master.mp4")).status).toBe(409);
    } finally {
      v.close();
      await v.closed;
    }
    writeFileSync(x.file, f.store.read(x.master));
    using pinned = new PinnedReviewFile({
      path: x.file,
      sha256: x.master.content_digest,
      max_bytes: 1000000,
    });
    renameSync(x.file, x.file + ".old");
    writeFileSync(x.file, "replacement", { mode: 0o600 });
    // Rename changes the retained inode's ctime. The new path is never read.
    expect(() => pinned.verify()).toThrow(/drift/);
    symlinkSync(x.file, x.file + ".link");
    expect(
      () =>
        new PinnedReviewFile({
          path: x.file + ".link",
          sha256: x.master.content_digest,
          max_bytes: 1000000,
        })
    ).toThrow();
    expect(
      () =>
        new PinnedReviewFile({ path: x.file, sha256: x.master.content_digest, max_bytes: 1000000 })
    ).toThrow(/hash/);
  });
  it("invalidates an already-open viewer on same-byte/new-revision selection changes", async () => {
    using f = new FoundationFixture();
    const { v, x } = await viewer(f);
    try {
      const c = f.checkpointer.loadRunById(f.run_id);
      if (!c) throw new Error("fixture run absent");
      const s = executionState(c);
      const master = s.slots.find((x) => x.slot === "master");
      if (!master) throw new Error("master absent");
      master.ref = { ...x.master, version: x.master.version + 1 };
      saveExecution(c, s);
      f.checkpointer.saveRun(c, "fixture_revision", {});
      expect((await get(v.url)).status).toBe(409);
    } finally {
      v.close();
      await v.closed;
    }
  });
  it("enforces request and aggregate byte bounds and closes/revokes all routes", async () => {
    using f = new FoundationFixture();
    const { v } = await viewer(f, { max_requests: 1 });
    expect((await get(v.url)).status).toBe(200);
    expect((await get(v.url)).status).toBe(429);
    v.close();
    await v.closed;
    await expect(get(v.url)).rejects.toThrow();
  });
  it("expires all routes and enforces aggregate bytes independently of request count", async () => {
    using f = new FoundationFixture();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    const { v } = await viewer(f);
    try {
      clock.mockReturnValue(122000);
      expect((await get(v.url)).status).toBe(410);
    } finally {
      clock.mockRestore();
      v.close();
      await v.closed;
    }
    using g = new FoundationFixture();
    const x = humanReviewFixture(g);
    const w = await openHumanReviewViewer({
      service: x.service,
      run_id: g.run_id,
      master_file: { path: x.file, sha256: x.master.content_digest, max_bytes: 1000000 },
      playback_device_profile_ref: x.device,
      expiry_ms: 120000,
      max_requests: 100,
      max_served_bytes: x.master.byte_length,
    });
    try {
      expect((await get(w.url + "master.mp4")).status).toBe(200);
      expect((await get(w.url + "master.mp4")).status).toBe(429);
    } finally {
      w.close();
      await w.closed;
    }
  });
  it("checks playback range consistency, union coverage, seeks and exclusions without granting human proof", () => {
    const sample = (media_ms: number, clock_ms: number, eligible = true, seeking = false) => ({
      media_ms,
      clock_ms,
      eligible,
      seeking,
    });
    const full = inspectReportedPlaybackCoverage(
      [sample(0, 0), sample(500, 500), sample(1000, 1000)],
      1000
    );
    expect(full.covered_ms).toBe(1000);
    expect(full.assurance).toContain("not_human_watch_proof");
    expect(full).not.toHaveProperty("approved");
    const seek = inspectReportedPlaybackCoverage(
      [
        sample(0, 0),
        sample(100, 100),
        sample(800, 200, true, true),
        sample(900, 300),
        sample(1000, 400),
      ],
      1000
    );
    expect(seek.covered_ms).toBe(200);
    expect(seek.excluded_intervals).toBe(2);
    expect(
      inspectReportedPlaybackCoverage(
        [sample(0, 0), sample(500, 500, false), sample(1000, 1000)],
        1000
      ).covered_ms
    ).toBe(0);
    expect(inspectReportedPlaybackCoverage([sample(0, 0), sample(1000, 50)], 1000).covered_ms).toBe(
      0
    );
    expect(() => inspectReportedPlaybackCoverage([sample(1001, 0)], 1000)).toThrow();
    expect(() =>
      inspectReportedPlaybackCoverage(
        [{ media_ms: 0, clock_ms: 0, eligible: true, seeking: false, approved: true }],
        1000
      )
    ).toThrow();
  });
  it("renders escaped labels/captions, labeled keyboard-native controls, no autoplay/assets or approval endpoint; browser JS parses", () => {
    using f = new FoundationFixture();
    const x = humanReviewFixture(f);
    const candidate = currentHumanReviewCandidate(x.service, f.run_id);
    const html = humanReviewPage(
      {
        ...candidate,
        package_id: "</dd><script>alert(1)</script>",
        captions: [{ start_ms: 0, end_ms: 1, text: '<img src="https://evil.invalid/">' }],
      },
      x.device
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<img src="https:');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('class="skip"');
    expect(html).toContain("controls playsinline");
    expect(html).not.toMatch(/autoplay|<iframe|<link[^>]*https:|fetch\(/u);
    expect(html).toContain('for="complete_viewing"');
    expect(html).toContain('role="status"');
    expect(() => new Script(REVIEW_JS)).not.toThrow();
    const answers = {
      schema_id: "penny.videogen-human-review-answers.v1",
      schema_version: 1,
      candidate_digest: candidateDigest(candidate),
      reviewer_id: "fixture",
      reviewer_role: "fixture",
      complete_viewing: false,
      heard_audio: false,
      image: "pass",
      audio: "pass",
      captions: "pass",
      overall: "pass",
      motion: "pass",
      speech: "pass",
      sync: "pass",
      identity: "pass",
      issues: "synthetic; no user responded",
      playback_device_profile_ref: x.device,
    };
    expect(humanReviewPositive(parseHumanReviewAnswers(answers))).toBe(false);
    expect(() => parseHumanReviewAnswers({ ...answers, approved: true })).toThrow();
    expect(() => parseHumanReviewAnswers({ ...answers, issues: "" })).toThrow();
    expect(() => parseHumanReviewAnswers({ ...answers, captions: undefined })).toThrow();
    expect(() => reviewByteRange("bytes=", 100)).toThrow();
  });
  it("offers a separate read-only CLI and refuses execute/approve modes", async () => {
    let output = "";
    await runVideogenHumanReviewCli(["--help"], {}, undefined, (text) => {
      output += text;
    });
    expect(output).toContain("Read-only");
    await expect(runVideogenHumanReviewCli(["--approve"], {})).rejects.toThrow();
  });
});
