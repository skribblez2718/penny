import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalJson, sha256 } from "./checkpointer.js";
import { ArtifactRefSchema, type ArtifactRef, validateContract } from "./contracts.js";

export interface PersistArtifactInput {
  readonly runId: string;
  readonly phase: string;
  readonly branchId: string | null;
  readonly operationId: string;
  readonly producer: string;
  readonly consumerScope: readonly string[];
  readonly content: string | Uint8Array;
  readonly mediaType?: string;
}

function artifactIdFor(input: {
  runId: string;
  phase: string;
  branchId: string | null;
  operationId: string;
  version: number;
}): string {
  const identity = {
    branch_id: input.branchId,
    kind: "agent-output",
    operation_id: input.operationId,
    phase: input.phase,
    run_id: input.runId,
    version: input.version,
  };
  return `art_${sha256(canonicalJson(identity))}`;
}

function assertOwnerOnly(candidate: string, type: "file" | "directory"): void {
  const stats = lstatSync(candidate);
  if (stats.isSymbolicLink()) {
    throw new Error(`artifact ${type} must not be a symbolic link`);
  }
  if ((type === "file" && !stats.isFile()) || (type === "directory" && !stats.isDirectory())) {
    throw new Error(`artifact path '${candidate}' has the wrong type`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`artifact path '${candidate}' must be owner-only`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`artifact path '${candidate}' has the wrong owner`);
  }
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
    const objects = path.join(this.root, "objects");
    const shaRoot = path.join(objects, "sha256");
    for (const directory of [objects, shaRoot]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
  }

  persist(input: PersistArtifactInput): ArtifactRef {
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const shard = path.join(this.root, "objects", "sha256", digest.slice(0, 2));
    mkdirSync(shard, { recursive: true, mode: 0o700 });
    chmodSync(shard, 0o700);
    const destination = path.join(shard, digest.slice(2));
    if (existsSync(destination)) {
      assertOwnerOnly(destination, "file");
      const existing = readFileSync(destination);
      if (!existing.equals(bytes)) {
        throw new Error(`artifact digest collision for '${digest}'`);
      }
    } else {
      const temporary = path.join(shard, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
        renameSync(temporary, destination);
        chmodSync(destination, 0o600);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    const consumerScope = [...new Set(input.consumerScope)].sort();
    return validateContract(
      ArtifactRefSchema,
      {
        schema_version: 1,
        artifact_id: artifactIdFor({
          runId: input.runId,
          phase: input.phase,
          branchId: input.branchId,
          operationId: input.operationId,
          version: 1,
        }),
        run_id: input.runId,
        phase: input.phase,
        branch_id: input.branchId,
        kind: "agent-output",
        operation_id: input.operationId,
        version: 1,
        producer: input.producer,
        consumer_scope: consumerScope,
        media_type: input.mediaType ?? "text/plain; charset=utf-8",
        byte_length: bytes.length,
        content_digest: digest,
        store_ref: `artifact://sha256/${digest}`,
      },
      "persisted artifact ref"
    );
  }

  read(refValue: ArtifactRef, consumer: string): Buffer {
    const ref = validateContract(ArtifactRefSchema, refValue, "artifact ref");
    if (!ref.consumer_scope.includes(consumer)) {
      throw new Error(`artifact '${ref.artifact_id}' does not grant consumer '${consumer}'`);
    }
    if (ref.store_ref !== `artifact://sha256/${ref.content_digest}`) {
      throw new Error("artifact store_ref does not match its digest");
    }
    const objectPath = path.join(
      this.root,
      "objects",
      "sha256",
      ref.content_digest.slice(0, 2),
      ref.content_digest.slice(2)
    );
    assertOwnerOnly(this.root, "directory");
    assertOwnerOnly(objectPath, "file");
    const bytes = readFileSync(objectPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== ref.content_digest || bytes.length !== ref.byte_length) {
      throw new Error(`artifact '${ref.artifact_id}' failed exact-byte verification`);
    }
    return bytes;
  }
}
