import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  PromotionApprovalReceiptSchema,
  validateKbContract,
  type PromotionApprovalReceipt,
  type Sha256Hex,
} from "./contracts.js";

const RAW_KEY_BYTES = 32;
const SIGNATURE_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const FORBIDDEN_MEMBER_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export class PromotionApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionApprovalError";
  }
}

/** Strict JSON parser: rejects duplicate members, trailing bytes, and unsafe member names. */
class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.space();
    const value = this.value();
    this.space();
    if (this.offset !== this.source.length) {
      throw new PromotionApprovalError("strict JSON contains trailing bytes");
    }
    return value;
  }

  private value(): unknown {
    const char = this.source[this.offset];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (char === "t") return this.literal("true", true);
    if (char === "f") return this.literal("false", false);
    if (char === "n") return this.literal("null", null);
    return this.number();
  }

  private object(): Record<string, unknown> {
    this.expect("{");
    const result = Object.create(null) as Record<string, unknown>;
    const names = new Set<string>();
    this.space();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.offset] !== '"') {
        throw new PromotionApprovalError("strict JSON object member name must be a string");
      }
      const name = this.string();
      if (names.has(name)) {
        throw new PromotionApprovalError(`strict JSON contains duplicate member '${name}'`);
      }
      if (FORBIDDEN_MEMBER_NAMES.has(name)) {
        throw new PromotionApprovalError(`strict JSON member '${name}' is forbidden`);
      }
      names.add(name);
      this.space();
      this.expect(":");
      this.space();
      result[name] = this.value();
      this.space();
      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") {
        throw new PromotionApprovalError("strict JSON object is missing a comma");
      }
      this.offset += 1;
    }
  }

  private array(): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.space();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }
    while (true) {
      this.space();
      result.push(this.value());
      this.space();
      const separator = this.source[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return result;
      }
      if (separator !== ",") {
        throw new PromotionApprovalError("strict JSON array is missing a comma");
      }
      this.offset += 1;
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (char === '"') {
        this.offset += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.offset)) as unknown;
        } catch {
          throw new PromotionApprovalError("strict JSON contains an invalid string");
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) {
          throw new PromotionApprovalError("strict JSON contains a non-I-JSON string");
        }
        return value;
      }
      if (char === "\\") {
        this.offset += 1;
        const escape = this.source[this.offset];
        if (escape === "u") {
          const hex = this.source.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
            throw new PromotionApprovalError("strict JSON contains an invalid Unicode escape");
          }
          this.offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new PromotionApprovalError("strict JSON contains an invalid escape");
        }
        this.offset += 1;
        continue;
      }
      if (char === undefined || char.charCodeAt(0) < 0x20) {
        throw new PromotionApprovalError("strict JSON contains an unescaped control character");
      }
      this.offset += 1;
    }
    throw new PromotionApprovalError("strict JSON string is unterminated");
  }

  private number(): number {
    const remaining = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (match === null) throw new PromotionApprovalError("strict JSON contains an invalid value");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new PromotionApprovalError("strict JSON number is outside the I-JSON range");
    }
    return value;
  }

  private literal<T>(token: string, value: T): T {
    if (this.source.slice(this.offset, this.offset + token.length) !== token) {
      throw new PromotionApprovalError("strict JSON contains an invalid literal");
    }
    this.offset += token.length;
    return value;
  }

  private expect(token: string): void {
    if (this.source[this.offset] !== token) {
      throw new PromotionApprovalError(`strict JSON expected '${token}'`);
    }
    this.offset += 1;
  }

  private space(): void {
    while (/\s/.test(this.source[this.offset] ?? "") && this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") {
        throw new PromotionApprovalError("strict JSON contains non-JSON whitespace");
      }
      this.offset += 1;
    }
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function strictParseJson(raw: string | Uint8Array): unknown {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new PromotionApprovalError("approval JSON is not strict UTF-8");
    }
  }
  return new StrictJsonParser(text).parse();
}

/** RFC 8785/JCS for the closed I-JSON values admitted by this module. */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new PromotionApprovalError("JCS string is not I-JSON");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PromotionApprovalError("JCS number must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcsCanonicalize).join(",")}]`;
  if (typeof value !== "object") {
    throw new PromotionApprovalError("JCS value contains an unsupported member");
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((name) => {
      if (FORBIDDEN_MEMBER_NAMES.has(name) || record[name] === undefined) {
        throw new PromotionApprovalError(`JCS member '${name}' is invalid`);
      }
      return `${JSON.stringify(name)}:${jcsCanonicalize(record[name])}`;
    });
  return `{${members.join(",")}}`;
}

export function promotionSha256(value: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(value).digest("hex") as Sha256Hex;
}

export function receiptSignedJcs(receipt: PromotionApprovalReceipt): string {
  const { signature: _signature, ...unsigned } = receipt;
  return jcsCanonicalize(unsigned);
}

export function receiptJcs(receipt: PromotionApprovalReceipt): string {
  return jcsCanonicalize(receipt);
}

export function signPromotionReceipt(
  unsigned: Omit<PromotionApprovalReceipt, "signature">,
  key: Buffer
): PromotionApprovalReceipt {
  if (key.length !== RAW_KEY_BYTES) {
    throw new PromotionApprovalError("promotion approval key must be exactly 32 raw bytes");
  }
  const signedJcs = jcsCanonicalize(unsigned);
  const signature = createHmac("sha256", key).update(signedJcs, "utf8").digest("base64url");
  if (signature.length !== 43 || signature.includes("=")) {
    throw new PromotionApprovalError("promotion signature encoding is not 43-char base64url");
  }
  return validateKbContract(
    PromotionApprovalReceiptSchema,
    { ...unsigned, signature },
    "promotion approval receipt"
  );
}

export function parsePromotionReceipt(raw: string | Uint8Array): PromotionApprovalReceipt {
  return validateKbContract(
    PromotionApprovalReceiptSchema,
    strictParseJson(raw),
    "promotion approval receipt"
  );
}

export function verifyPromotionReceiptSignature(
  receipt: PromotionApprovalReceipt,
  key: Buffer
): void {
  if (key.length !== RAW_KEY_BYTES) {
    throw new PromotionApprovalError("promotion approval key must be exactly 32 raw bytes");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(receipt.signature) || receipt.signature.includes("=")) {
    throw new PromotionApprovalError("promotion approval signature is not unpadded base64url");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(receipt.signature, "base64url");
  } catch {
    throw new PromotionApprovalError("promotion approval signature is not base64url");
  }
  if (decoded.length !== SIGNATURE_BYTES || decoded.toString("base64url") !== receipt.signature) {
    throw new PromotionApprovalError("promotion approval signature encoding is non-canonical");
  }
  const expected = createHmac("sha256", key).update(receiptSignedJcs(receipt), "utf8").digest();
  if (!timingSafeEqual(decoded, expected)) {
    throw new PromotionApprovalError("promotion approval HMAC-SHA-256 signature mismatch");
  }
}

export function generatePromotionKeyId(): string {
  return `key_${randomBytes(18).toString("base64url")}`;
}

export function generateRawPromotionKey(): Buffer {
  return randomBytes(RAW_KEY_BYTES);
}

function validateKeyId(keyId: string): void {
  if (!KEY_ID_PATTERN.test(keyId) || path.basename(keyId) !== keyId) {
    throw new PromotionApprovalError("promotion key_id is invalid");
  }
}

export function promotionKeyPath(approvalRoot: string, keyId: string): string {
  validateKeyId(keyId);
  const root = path.resolve(approvalRoot);
  const keyPath = path.resolve(root, `${keyId}.key`);
  if (path.dirname(keyPath) !== root) {
    throw new PromotionApprovalError("promotion key path escapes the approval root");
  }
  return keyPath;
}

export function pinnedDirectoryChildPath(descriptor: number, child: string): string {
  if (process.platform !== "linux") {
    throw new PromotionApprovalError(
      "promotion custody requires Linux /proc/self/fd directory-descriptor paths"
    );
  }
  if (child.length === 0 || child === "." || child === ".." || child.includes("/")) {
    throw new PromotionApprovalError("promotion custody child name is invalid");
  }
  return `/proc/self/fd/${descriptor}/${child}`;
}

/**
 * Open every absolute directory component independently with O_NOFOLLOW.
 *
 * Node does not expose openat2(RESOLVE_NO_SYMLINKS), so Linux /proc/self/fd is
 * used to make each next lookup relative to the already pinned parent. Live
 * promotion custody fails closed when that mechanism is unavailable.
 */
export function openPinnedDirectoryNoFollow(directory: string): number {
  const absolute = path.resolve(directory);
  if (absolute !== directory || process.platform !== "linux") {
    throw new PromotionApprovalError(
      "promotion custody requires an absolute normalized Linux directory path"
    );
  }
  const parsed = path.parse(absolute);
  let descriptor = openSync(
    parsed.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      const next = openSync(
        pinnedDirectoryChildPath(descriptor, segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      closeSync(descriptor);
      descriptor = next;
    }
    if (!fstatSync(descriptor).isDirectory()) {
      throw new PromotionApprovalError("promotion custody path is not a directory");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    if (error instanceof PromotionApprovalError) throw error;
    throw new PromotionApprovalError(
      `promotion custody rejected a symlinked or invalid directory component: ${String(error)}`
    );
  }
}

function assertOwnerOnlyDirectory(descriptor: number): void {
  const stat = fstatSync(descriptor);
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700) {
    throw new PromotionApprovalError(
      "promotion key root must be a non-symlink owner-only directory with mode 0700"
    );
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new PromotionApprovalError("promotion key root is not owned by the current user");
  }
}

function openOwnerOnlyKeyAt(rootDescriptor: number, keyId: string): number {
  const keyPath = pinnedDirectoryChildPath(rootDescriptor, `${keyId}.key`);
  const before = lstatSync(keyPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new PromotionApprovalError(
      "promotion key must be a regular, non-symlink, single-link file"
    );
  }
  if ((before.mode & 0o7777) !== 0o600) {
    throw new PromotionApprovalError("promotion key file mode must be exactly 0600");
  }
  if (typeof process.geteuid === "function" && before.uid !== process.geteuid()) {
    throw new PromotionApprovalError("promotion key is not owned by the current user");
  }
  const descriptor = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    (opened.mode & 0o7777) !== 0o600 ||
    opened.uid !== before.uid
  ) {
    closeSync(descriptor);
    throw new PromotionApprovalError("promotion key changed while it was opened");
  }
  return descriptor;
}

export function createRawPromotionKeyFile(
  approvalRoot: string,
  keyId: string,
  key = generateRawPromotionKey()
): void {
  if (key.length !== RAW_KEY_BYTES) {
    throw new PromotionApprovalError("promotion approval key must be exactly 32 raw bytes");
  }
  validateKeyId(keyId);
  const rootDescriptor = openPinnedDirectoryNoFollow(path.resolve(approvalRoot));
  try {
    assertOwnerOnlyDirectory(rootDescriptor);
    const keyPath = pinnedDirectoryChildPath(rootDescriptor, `${keyId}.key`);
    const descriptor = openSync(
      keyPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      let offset = 0;
      while (offset < key.length) {
        const written = writeSync(descriptor, key, offset, key.length - offset, offset);
        if (written <= 0) throw new PromotionApprovalError("short promotion key write");
        offset += written;
      }
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const verified = openOwnerOnlyKeyAt(rootDescriptor, keyId);
    closeSync(verified);
    fsyncSync(rootDescriptor);
  } finally {
    closeSync(rootDescriptor);
  }
}

export function readRawPromotionKeyFile(approvalRoot: string, keyId: string): Buffer {
  validateKeyId(keyId);
  const rootDescriptor = openPinnedDirectoryNoFollow(path.resolve(approvalRoot));
  try {
    assertOwnerOnlyDirectory(rootDescriptor);
    const descriptor = openOwnerOnlyKeyAt(rootDescriptor, keyId);
    try {
      const stat = fstatSync(descriptor);
      if (stat.size !== RAW_KEY_BYTES) {
        throw new PromotionApprovalError("promotion key must contain exactly 32 raw bytes");
      }
      const key = readFileSync(descriptor);
      if (key.length !== RAW_KEY_BYTES) {
        throw new PromotionApprovalError("promotion key must contain exactly 32 raw bytes");
      }
      return key;
    } finally {
      closeSync(descriptor);
    }
  } finally {
    closeSync(rootDescriptor);
  }
}
