import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_OWNER_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * Copy truncated bash output into the trusted parent event before the agent can
 * issue another command that changes or deletes Pi's temporary output file.
 */
export function captureToolResultForExecutionOwner(
  message: Record<string, unknown>
): Record<string, unknown> {
  if (message.role !== "toolResult" || message.toolName !== "bash") return message;
  const details =
    message.details && typeof message.details === "object"
      ? { ...(message.details as Record<string, unknown>) }
      : {};
  delete details.executionOwnerCapture;
  const truncation = details.truncation as Record<string, unknown> | undefined;
  if (truncation?.truncated !== true) return { ...message, details };

  const withCapture = (capture: Record<string, unknown>): Record<string, unknown> => {
    const capturedDetails = { ...details };
    // Raw full output is execution-owner evidence, not agent/UI data. Keeping it
    // non-enumerable prevents progress/result serialization from exposing it.
    Object.defineProperty(capturedDetails, "executionOwnerCapture", {
      value: capture,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return { ...message, details: capturedDetails };
  };
  const unavailable = (reason: string): Record<string, unknown> =>
    withCapture({ schema_version: 1, complete: false, reason });
  const fullOutputPath = details.fullOutputPath;
  if (typeof fullOutputPath !== "string" || !path.isAbsolute(fullOutputPath)) {
    return unavailable("missing-absolute-output-path");
  }
  try {
    if (fs.lstatSync(fullOutputPath).isSymbolicLink()) return unavailable("symlink-output-path");
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const canonicalOutputPath = fs.realpathSync(fullOutputPath);
    const relative = path.relative(temporaryRoot, canonicalOutputPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return unavailable("output-path-outside-temporary-root");
    }
    const metadata = fs.statSync(canonicalOutputPath);
    if (!metadata.isFile() || metadata.size > MAX_OWNER_CAPTURE_BYTES) {
      return unavailable("output-file-invalid-or-too-large");
    }
    const output = fs.readFileSync(canonicalOutputPath, "utf8");
    if (!output) return unavailable("output-file-empty");
    return withCapture({
      schema_version: 1,
      complete: true,
      output,
      output_digest: createHash("sha256").update(output, "utf8").digest("hex"),
      captured_at: new Date().toISOString(),
    });
  } catch {
    return unavailable("output-capture-failed");
  }
}
