import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai/compat";
import {
  ArtifactStore,
  createPrivateSessionResourceLoader,
  encodeCanonicalPng,
  initializePennyState,
} from "@penny/orchestration";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { executeArtifactRead, loadArtifactRuntimeConfig } from "../../artifact-runtime.js";
import { outputMetadata } from "../fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function imageFauxProvider() {
  return fauxProvider({
    api: "penny-o1-image-worker",
    provider: "penny-o1-fixture",
    models: [{ id: "vision-fixture", input: ["text", "image"] }],
  });
}

function latestToolResult(messages: readonly Message[]): Extract<Message, { role: "toolResult" }> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const result = messages[index];
    if (result?.role === "toolResult") return result;
  }
  throw new Error("faux image-capable worker did not receive a tool result");
}

describe("artifact_read image-capable Pi worker transport", () => {
  it("preserves exact artifact identity metadata while Pi carries image content to the provider", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "penny-artifact-image-worker-"));
    roots.push(sandbox);
    const projectRoot = path.join(sandbox, "project");
    const stateRoot = path.join(sandbox, "state");
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    const state = initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: stateRoot } });
    const bytes = Buffer.from(
      encodeCanonicalPng({
        width: 1,
        height: 1,
        rgba: Uint8Array.from([120, 90, 60, 255]),
      })
    );
    let ref: ReturnType<ArtifactStore["persist"]>;
    {
      using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
        projectId: state.projectId,
      });
      ref = store.persist({
        metadata: outputMetadata({ media_type: "image/png", operation_id: "image-worker" }),
        content: bytes,
      });
    }
    const config = loadArtifactRuntimeConfig(projectRoot, { PENNY_STATE_ROOT: stateRoot });
    const artifactRead = defineTool({
      name: "artifact_read",
      label: "Artifact Read",
      description: "Read one exact fixture artifact.",
      parameters: Type.Object(
        { artifact: Type.String({ pattern: "^art_[a-f0-9]{64}$" }) },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const execution = await executeArtifactRead(config, params);
        return { ...execution.result, details: {} };
      },
    });

    const faux = imageFauxProvider();
    let providerToolResult: Extract<Message, { role: "toolResult" }> | undefined;
    let sessionRoles = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("artifact_read", { artifact: ref.artifact_id }, { id: "image-read-call" }),
        { stopReason: "toolUse" }
      ),
      (context) => {
        providerToolResult = latestToolResult(context.messages);
        return fauxAssistantMessage("image received");
      },
    ]);
    const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = required(
      modelRuntime.getModel("penny-o1-fixture", "vision-fixture"),
      "registered faux model is unavailable"
    );
    const sessionManager = SessionManager.inMemory(projectRoot);
    const isolated = await createPrivateSessionResourceLoader({
      projectRoot,
      systemPrompt: "Call artifact_read once and inspect the returned image.",
    });
    const created = await createAgentSession({
      cwd: projectRoot,
      model,
      modelRuntime,
      sessionManager,
      resourceLoader: isolated.resourceLoader,
      settingsManager: isolated.settingsManager,
      noTools: "all",
      tools: ["artifact_read"],
      customTools: [artifactRead],
    });
    try {
      await created.session.prompt("Read the supplied exact artifact ID.");
      sessionRoles = created.session.messages.map((message) => message.role).join(",");
    } finally {
      created.session.dispose();
      modelRuntime.unregisterProvider("penny-o1-fixture");
    }

    const delivered = required(
      providerToolResult,
      `provider tool result was not captured; calls=${faux.state.callCount}; pending=${faux.getPendingResponseCount()}; roles=${sessionRoles}`
    );
    const metadataContent = delivered.content.find((content) => content.type === "text");
    const imageContent = delivered.content.find((content) => content.type === "image");
    if (metadataContent?.type !== "text" || imageContent?.type !== "image") {
      throw new Error("provider did not receive metadata plus image content");
    }
    expect(JSON.parse(metadataContent.text)).toMatchObject({
      type: "artifact_image",
      artifact_ref: { artifact_id: ref.artifact_id },
      content_digest: ref.content_digest,
      media_type: "image/png",
      image: { width: 1, height: 1 },
    });
    expect(metadataContent.text).not.toContain(bytes.toString("base64"));
    expect(metadataContent.text).not.toContain(sandbox);
    expect(imageContent.mimeType).toBe("image/png");
    expect(Buffer.from(imageContent.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  });
});
