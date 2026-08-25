import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalJson, sha256 } from "./checkpointer.js";
import {
  ExecutionReceiptSchema,
  type ExecutionReceipt,
  type InputArtifacts,
  type OutputArtifactMetadata,
  type RunIdentity,
  type TrustProfile,
  validateContract,
} from "./contracts.js";

export type UnsignedExecutionReceipt = Omit<ExecutionReceipt, "signature">;

export interface TrustedInvocation {
  readonly identity: RunIdentity;
  readonly state_id: string;
  readonly branch_id: string | null;
  readonly agent: string;
  readonly attempt: number;
  readonly trust_profile: TrustProfile;
  readonly model_override: string | null;
  readonly task_sha256: string;
  readonly input_artifacts: InputArtifacts;
  readonly output_artifact: OutputArtifactMetadata;
}

export function trustedInvocationDigest(invocation: TrustedInvocation): string {
  return sha256(canonicalJson(invocation));
}

function keyFromEnvironment(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64url");
  if (decoded.length !== 32) {
    throw new Error("PENNY_RECEIPT_HMAC_KEY must be 32 bytes encoded as hex or base64url");
  }
  return decoded;
}

function existingOwnerKeyFile(keyPath: string): Buffer {
  const stats = lstatSync(keyPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw new Error("receipt HMAC key must be an owner-only regular single-link file");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("receipt HMAC key has the wrong owner");
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) {
    throw new Error("receipt HMAC key file must contain exactly 32 bytes");
  }
  return key;
}

function errorHasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function ownerKeyFile(keyPath: string): Buffer {
  mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!errorHasCode(error, "EEXIST")) {
      throw error;
    }
  }
  const stats = lstatSync(keyPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o077) !== 0
  ) {
    throw new Error("receipt HMAC key must be an owner-only regular single-link file");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("receipt HMAC key has the wrong owner");
  }
  chmodSync(keyPath, 0o600);
  return existingOwnerKeyFile(keyPath);
}

export class ReceiptAuthority {
  private constructor(private readonly key: Buffer) {}

  static load(keyPath: string, env: NodeJS.ProcessEnv = process.env): ReceiptAuthority {
    const configured = env.PENNY_RECEIPT_HMAC_KEY;
    return new ReceiptAuthority(
      configured ? keyFromEnvironment(configured) : ownerKeyFile(keyPath)
    );
  }

  /** Migration/read-only verification: never creates, replaces, or chmods key material. */
  static loadExisting(keyPath: string): ReceiptAuthority {
    return new ReceiptAuthority(existingOwnerKeyFile(keyPath));
  }

  sign(unsigned: UnsignedExecutionReceipt): ExecutionReceipt {
    const signature = this.signature(unsigned);
    return validateContract(
      ExecutionReceiptSchema,
      { ...unsigned, signature },
      "signed execution receipt"
    );
  }

  verify(receiptValue: unknown): ExecutionReceipt {
    const receipt = validateContract(ExecutionReceiptSchema, receiptValue, "execution receipt");
    const { signature, ...unsigned } = receipt;
    const expected = this.signature(unsigned);
    const suppliedBytes = Buffer.from(signature, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw new Error(`execution receipt '${receipt.receipt_id}' has an invalid signature`);
    }
    return receipt;
  }

  private signature(unsigned: UnsignedExecutionReceipt): string {
    const digest = createHmac("sha256", this.key)
      .update(canonicalJson(unsigned), "utf8")
      .digest("hex");
    return `hmac-sha256:${digest}`;
  }
}
