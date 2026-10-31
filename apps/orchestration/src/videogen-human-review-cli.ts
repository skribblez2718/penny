#!/usr/bin/env node
/** Separate read-only entrypoint; never edits the runtime CLI or accepts approval submissions. */
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { OrchestrationService } from "./service.js";
import { ArtifactRefSchema, validateContract } from "./contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "./skill-contracts/common.js";
import { HUMAN_REVIEW_LIMITS } from "./videogen/human-review.js";
import { parseVoiceWireJson } from "./videogen/voice-json.js";
import { openHumanReviewViewer } from "./videogen/human-review-viewer.js";
const closed = { additionalProperties: false } as const;
export const HumanReviewViewerRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-human-review-viewer-request.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    master_file: Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        sha256: Sha256Schema,
        max_bytes: Type.Integer({ minimum: 1, maximum: 512 * 1024 * 1024 }),
      },
      closed
    ),
    playback_device_profile_ref: ArtifactRefSchema,
    expiry_ms: Type.Integer({ minimum: 1, maximum: 86400000 }),
    max_requests: Type.Integer({ minimum: 1, maximum: 4096 }),
    max_served_bytes: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 * 1024 }),
  },
  closed
);
export async function runVideogenHumanReviewCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  input: AsyncIterable<unknown> = stdin,
  write: (text: string) => void = (text) => {
    stdout.write(text);
  }
): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    write(
      "Usage: videogen-human-review-cli --serve --project-root=PATH < private-viewer-request.json\nRequires PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE and an existing final-playback/G5 wait. Read-only, finite loopback viewer. No approve/submit mode. Ctrl-C closes.\n--request-schema prints the closed input schema.\n"
    );
    return;
  }
  if (args.length === 1 && args[0] === "--request-schema") {
    write(JSON.stringify(HumanReviewViewerRequestSchema) + "\n");
    return;
  }
  if (
    args.length !== 2 ||
    args[0] !== "--serve" ||
    !args[1]?.startsWith("--project-root=") ||
    !env.PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE
  )
    throw new Error("explicit serve, project root and private manifest required");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw new Error("byte input required");
    length += chunk.byteLength;
    if (length > 32768) throw new Error("viewer request byte limit");
    chunks.push(Buffer.from(chunk));
  }
  const request = validateContract(
    HumanReviewViewerRequestSchema,
    parseVoiceWireJson(Buffer.concat(chunks), HUMAN_REVIEW_LIMITS),
    "viewer request"
  );
  using service = new OrchestrationService({
    projectRoot: args[1].slice("--project-root=".length),
    playbookName: "videogen",
    env,
  });
  const viewer = await openHumanReviewViewer({ ...request, service });
  const close = () => viewer.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    write(
      JSON.stringify({
        url: viewer.url,
        expires_at_utc: viewer.expires_at_utc,
        review_authority: "none",
        submission: "trusted_parent_questionnaire_only",
      }) + "\n"
    );
    await viewer.closed;
  } finally {
    viewer.close();
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runVideogenHumanReviewCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('{"error":"videogen_human_review_refused"}\n');
    process.exitCode = 1;
  });
