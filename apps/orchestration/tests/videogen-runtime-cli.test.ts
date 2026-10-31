import path from "node:path";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runVideogenRuntimeCli,
  VoicePreparationCliRequestSchema,
} from "../dist/videogen-runtime-cli.js";
import { VoicePreparationBindingsSchema } from "../dist/videogen/voice-preparation.js";
import { canonicalJson } from "../dist/canonical-json.js";
import { OrchestrationService } from "../dist/service.js";
import { VoicePrivateBindingSchema } from "../dist/videogen/voice-private-client.js";
import { parseVoiceWireJson } from "../dist/videogen/voice-json.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";
import {
  ManifestVideogenFixture,
  minimalVideogenManifest,
} from "./helpers/videogen-manifest-fixture.js";

async function* input(...chunks: unknown[]): AsyncGenerator<unknown> {
  yield* chunks;
}
function fixture(f: ManifestVideogenFixture) {
  const manifest = path.join(f.root, "runtime.json");
  writeFileSync(manifest, canonicalJson(minimalVideogenManifest(f)), { mode: 0o600 });
  return { PENNY_STATE_ROOT: f.stateRoot, PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE: manifest };
}
describe("fixed videogen operator entrypoint (isolated manifest; no live model)", () => {
  it("prints the actual closed private binding schema without needing state or stdin", async () => {
    let text = "";
    await runVideogenRuntimeCli(["--voice-binding-schema"], {}, input(), (s) => {
      text += s;
    });
    expect(parseVoiceWireJson(Buffer.from(text))).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...VoicePrivateBindingSchema,
    });
    expect(VoicePrivateBindingSchema).toHaveProperty("additionalProperties", false);
  });
  it("exports the exact closed normal-API contracts without state or service work", async () => {
    let text = "";
    await runVideogenRuntimeCli(["--api-schemas"], {}, input(), (s) => {
      text += s;
    });
    const schemas = parseVoiceWireJson(Buffer.from(text));
    expect(schemas).toMatchObject({
      manifest: { type: "object", additionalProperties: false },
      profile: { type: "object", additionalProperties: false },
      meter: { type: "object", additionalProperties: false },
      binding_request: { type: "object", additionalProperties: false },
      policy_version_request: { type: "object", additionalProperties: false },
    });
  });
  it("prints the exact closed preparation contracts and rejects invented approvals before any state/service work", async () => {
    let output = "";
    await runVideogenRuntimeCli(["--prep-schema"], {}, input(), (s) => {
      output += s;
    });
    expect(parseVoiceWireJson(Buffer.from(output))).toEqual({
      request: VoicePreparationCliRequestSchema,
      bindings: VoicePreparationBindingsSchema,
    });
    using f = new ManifestVideogenFixture();
    const file = path.join(f.root, "prep.json");
    writeFileSync(file, canonicalJson({ approved: true, bindings_file: "not-a-capability" }), {
      mode: 0o600,
    });
    await expect(
      runVideogenRuntimeCli(["prep", "--requestfile", file], {}, input())
    ).rejects.toThrow("voice preparation CLI request");
    await expect(
      runVideogenRuntimeCli(["prep", `--requestfile=${file}`], {}, input())
    ).rejects.toThrow("voice preparation CLI request");
  });
  it("refuses missing private selection and unknown/arbitrary launch options", async () => {
    for (const args of [
      ["--execute", "--project-root=not-used"],
      ["--restart"],
      ["--module=operator.js"],
      ["--check"],
    ])
      await expect(runVideogenRuntimeCli(args, {}, input())).rejects.toThrow("explicit mode");
  });
  it("constructs DEFAULT service, reports no live readiness, and recovers the exact existing G1 without a second approval", async () => {
    using f = new ManifestVideogenFixture();
    const x = setup(f),
      env = fixture(f),
      request = videogenStageRequest();
    const identity = {
      schema_version: 2 as const,
      run_id: f.run_id,
      session_id: f.run_id,
      playbook: "videogen",
      engine_owner: "typescript" as const,
    };
    let gate;
    {
      using service = new OrchestrationService({
        projectRoot: f.root,
        env,
        playbookName: "videogen",
        modelClient: x.client,
      });
      gate = await service.execute({
        schema_version: 2,
        action: "start",
        identity,
        goal: request.brief,
        constraints: request,
        project_root: f.root,
        trust_profile: "hardened-untrusted",
      });
    }
    expect(gate.action).toBe("await_user");
    let check = "",
      recovered = "";
    await runVideogenRuntimeCli(["--check", `--project-root=${f.root}`], env, input(), (s) => {
      check += s;
    });
    expect(parseVoiceWireJson(Buffer.from(check))).toEqual({
      configuration: "valid",
      live_readiness: "not_assessed",
    });
    await runVideogenRuntimeCli(
      ["--execute", `--project-root=${f.root}`],
      env,
      input(Buffer.from(canonicalJson({ schema_version: 2, action: "recover", identity }))),
      (s) => {
        recovered += s;
      }
    );
    expect(parseVoiceWireJson(Buffer.from(recovered))).toEqual(gate);
  }, 30000);
  it("rejects non-byte, oversized and duplicate-key input before engine mutation", async () => {
    using f = new ManifestVideogenFixture();
    const env = fixture(f),
      args = ["--execute", `--project-root=${f.root}`];
    for (const value of [
      "not bytes",
      Buffer.alloc(4 * 1024 * 1024 + 1),
      Buffer.from('{"schema_version":2,"schema_version":1}'),
    ])
      await expect(runVideogenRuntimeCli(args, env, input(value))).rejects.toThrow();
  }, 30000);
});
