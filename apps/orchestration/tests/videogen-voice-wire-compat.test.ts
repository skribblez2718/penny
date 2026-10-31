import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { validateSkillSchema } from "../dist/skill-contracts/common.js";
import {
  VoiceStudioHealthV1Schema,
  VoiceStudioVoiceV1Schema,
  VoiceStudioNarrationV1Schema,
  VoiceStudioJobV1Schema,
} from "../dist/videogen/voice-studio-contracts.js";
import { VoiceStudioTransport } from "../dist/videogen/voice-studio-transport.js";
import {
  inspectVoiceStudioSavedVoice,
  createVoiceStudioProfileFromSavedVoice,
} from "../dist/videogen/voice-studio-discovery.js";
import { VoiceFixture } from "./helpers/videogen-voice-fixture.js";
import { required, pcmAsset } from "./helpers/videogen-media-fixtures.js";
import {
  SOURCE_SHAPED_VOICE as voice,
  SOURCE_SHAPED_HEALTH as health,
  SOURCE_SHAPED_NARRATION as narration,
  SOURCE_SHAPED_JOB as job,
} from "./helpers/voice-studio-wire-fixtures.js";

const limits = {
  max_text_bytes: 10000,
  max_chunks: 100,
  max_json_bytes: 65536,
  max_wav_bytes: 1048576,
  max_sample_bytes: 1048576,
  max_request_bytes: 65536,
  connect_ms: 2000,
  silence_ms: 2000,
  poll_ms: 10,
  cancel_observations: 2,
};
async function endpoint(handle: (route: string, res: ServerResponse) => void) {
  const calls: string[] = [],
    server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      handle(req.url ?? "", res);
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("fixture address");
  return {
    calls,
    config: { origin: `http://127.0.0.1:${a.port}`, mode: "isolated_loopback" as const },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
describe("Voice Studio actual 2.x wire compatibility", () => {
  it("runs the four production GETs, preserves fractional epochs and bootstraps only observable identity", async () => {
    const wav = pcmAsset();
    await using f = await endpoint((route, res) => {
      if (route.endsWith("/sample")) {
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(wav);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          route === "/api/system/health" ? health : route === "/api/voices" ? [voice] : voice
        )
      );
    });
    const observed = await inspectVoiceStudioSavedVoice(
      f.config,
      limits,
      voice.id,
      new AbortController().signal
    );
    expect(observed).toEqual({
      health,
      voice,
      voice_sha256: sha256(canonicalJson(voice)),
      sample_sha256: sha256(wav),
      sample_bytes: wav.length,
    });
    expect(observed.voice.created_at).toBe(1780000000.123456);
    expect(f.calls).toEqual([
      "GET /api/system/health",
      "GET /api/voices",
      `GET /api/voices/${voice.id}`,
      `GET /api/voices/${voice.id}/sample`,
    ]);
    await using refs = new VoiceFixture();
    const ref = refs.raw("synthetic build or policy, not live evidence");
    const profile = createVoiceStudioProfileFromSavedVoice(
      {
        profile_id: "test",
        backend_binding_id: "test",
        process_worker_id: "test",
        gpu_resource_ids: ["test-gpu"],
        service_build_ref: ref,
        model_sha256: sha256("test model"),
        media_policy_ref: ref,
        limits,
      },
      observed
    );
    expect(profile.voice_sha256).toBe(observed.voice_sha256);
    expect(profile.sample_sha256).toBe(observed.sample_sha256);
    expect(profile.engine).toBe(health.engine);
    expect(profile).not.toHaveProperty("readiness");
    expect(() =>
      createVoiceStudioProfileFromSavedVoice(
        { ...profile },
        { ...observed, voice_sha256: sha256("changed") }
      )
    ).toThrow("drift");
  });
  it("validates source-shaped create/readback narration and aggregate job responses without coercion", async () => {
    await using f = await endpoint((route, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route.startsWith("/api/tts/") ? job : narration));
    });
    const client = new VoiceStudioTransport(f.config, limits),
      signal = new AbortController().signal;
    expect(
      validateSkillSchema(
        VoiceStudioNarrationV1Schema,
        await client.json("POST", "/api/narrations", signal, {
          source_text: narration.source_text,
          voice_profile_id: voice.id,
        }),
        "created narration"
      )
    ).toEqual(narration);
    expect(
      validateSkillSchema(
        VoiceStudioNarrationV1Schema,
        await client.json("GET", `/api/narrations/${narration.id}`, signal),
        "readback"
      )
    ).toEqual(narration);
    expect(
      validateSkillSchema(
        VoiceStudioJobV1Schema,
        await client.json("GET", `/api/tts/jobs/${job.job_id}`, signal),
        "job"
      )
    ).toEqual(job);
    expect(
      validateSkillSchema(
        VoiceStudioNarrationV1Schema,
        { ...narration, source_text: "", chunk_count: 0, char_count: 0 },
        "empty draft"
      ).created_at
    ).toBe(narration.created_at);
  });
  it.each(["1780000000.1", "2026-01-01T00:00:00Z", null, -1, Infinity, NaN, 253402300800])(
    "rejects non-wire timestamp %s on both record types",
    (created_at) => {
      for (const [schema, record] of [
        [VoiceStudioVoiceV1Schema, voice],
        [VoiceStudioNarrationV1Schema, narration],
      ] as const)
        expect(() =>
          validateSkillSchema(schema, { ...record, created_at }, "wire record")
        ).toThrow();
    }
  );
  it("keeps closed field contracts and refuses non-object voice metadata", () => {
    expect(validateSkillSchema(VoiceStudioHealthV1Schema, health, "health")).toEqual(health);
    for (const bad of [
      { ...voice, storage_path: "untrusted" },
      { ...voice, meta: [] },
      { ...voice, meta: null },
    ])
      expect(() => validateSkillSchema(VoiceStudioVoiceV1Schema, bad, "voice")).toThrow();
    expect(() =>
      validateSkillSchema(
        VoiceStudioNarrationV1Schema,
        { ...narration, char_count: -1 },
        "narration"
      )
    ).toThrow();
  });
  it("refuses system mutations and duplicate/mismatched voice discovery before sample GET", async () => {
    await using f = await endpoint((route, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route === "/api/system/health" ? health : [voice, voice]));
    });
    await expect(
      inspectVoiceStudioSavedVoice(f.config, limits, voice.id, new AbortController().signal)
    ).rejects.toThrow("duplicate");
    await expect(
      new VoiceStudioTransport(f.config, limits).json(
        "POST",
        "/api/system/health",
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
  });
  it("runs the entire existing effect/observation owner against numeric service records", async () => {
    await using f = new VoiceFixture();
    await f.start();
    expect(typeof f.voice.created_at).toBe("number");
    expect(typeof f.narration.created_at).toBe("number");
    await (await f.owner()).dispatch(f.engine, required(f.directive));
    expect(f.record().disposition?.outcome).toBe("completed");
  });
});
