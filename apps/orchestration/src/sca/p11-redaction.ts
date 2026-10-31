/**
 * Host-owned redaction, secret, and personal-data control for the inactive SCA P11 reporting
 * candidate (`SCA-P11` R16, report standard §6/§9/§10.4). It is deterministic, performs no network or
 * provider call, and is applied *before* any cognitive payload is disclosed and across every
 * produced representation (Markdown, JSON, SARIF).
 *
 * There is exactly **one** detection engine here: `scanScaP11Sensitive`, `redactScaP11Sensitive`,
 * `scaP11HasSensitiveContent`, and `redactScaP11JsonValue` all resolve the same `findSensitiveSpans`
 * result. The disclosure admission, the deterministic validation checks, the gate predicate, and the
 * renderer all consume this module, so a signature can never be recognized in one surface but not
 * another.
 *
 * Redaction wins: a detected secret or personal-data span is replaced with a typed marker rather
 * than being reproduced. The scanner is deliberately conservative and broad — it never invents a
 * finding and it never silently drops text it did not classify — so it recognizes case-insensitive
 * secret *key names* with underscore/dash/dot/space variants (e.g. `SECRET_KEY`,
 * `aws_secret_access_key`, `api-key`, `client.secret`, `secret key`, `clientSecret`), quoted and
 * unquoted assignments, and conservative high-entropy assigned values, in addition to literal token
 * shapes (bearer tokens, private-key blocks, and cloud/provider key prefixes).
 */
export interface ScaP11SensitiveScanV1 {
  readonly secrets: boolean;
  readonly personal_data: boolean;
  readonly secret_matches: number;
  readonly personal_data_matches: number;
}

export const SCA_P11_REDACTION_MARKER = "[REDACTED-BY-P11-HOST]" as const;

type SensitiveKind = "secret" | "personal_data";

interface SensitiveSpan {
  readonly kind: SensitiveKind;
  readonly start: number;
  readonly end: number;
}

interface SensitivePattern {
  readonly kind: SensitiveKind;
  readonly pattern: RegExp;
}

/**
 * Literal token shapes with a recognizable provider signature. Each is anchored to a token shape so
 * the scanner does not flag ordinary prose. Patterns are global and stateless between calls.
 */
const LITERAL_PATTERNS: readonly SensitivePattern[] = Object.freeze([
  {
    kind: "secret",
    pattern:
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
  },
  { kind: "secret", pattern: /\bsk-(?:live|test)-[A-Za-z0-9_-]{8,}/giu },
  { kind: "secret", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/gu },
  { kind: "secret", pattern: /\bghp_[A-Za-z0-9]{20,}\b/gu },
  { kind: "secret", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { kind: "secret", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/gu },
  { kind: "secret", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu },
  { kind: "secret", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { kind: "secret", pattern: /\bASIA[0-9A-Z]{16}\b/gu },
  { kind: "secret", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { kind: "secret", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/gu },
  { kind: "secret", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/gu },
  { kind: "secret", pattern: /\bdop_v1_[a-f0-9]{40,}\b/gu },
  { kind: "secret", pattern: /\bAccountKey\s*=\s*[A-Za-z0-9+/=]{20,}/giu },
  { kind: "secret", pattern: /\b(?:sig|SharedAccessSignature)\s*=\s*[A-Za-z0-9%+/=]{20,}/giu },
  { kind: "secret", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/giu },
  { kind: "secret", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  { kind: "personal_data", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu },
  {
    kind: "personal_data",
    pattern: /\b(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/gu,
  },
  { kind: "personal_data", pattern: /\b\d{3}-\d{2}-\d{4}\b/gu },
  { kind: "personal_data", pattern: /\b(?:\d[ -]?){13,19}\b/gu },
]);

/**
 * Assignment shape: optional quote, a key name (underscore/dash/dot/space variants and camelCase),
 * an assignment operator, then a quoted or unquoted value. Bounded quantifiers keep the scan
 * linear on adversarial input.
 */
const ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_.\- ]{0,63})\2[ \t]*[:=][ \t]*(?:"([^"\n]{1,8192})"|'([^'\n]{1,8192})'|([^\s"',;#]{1,8192}))/gu;

/**
 * A whole-word secret indicator. The key name is normalized first (camelCase split, then every
 * non-alphanumeric run collapsed to `_`) so `SECRET_KEY`, `secret-key`, `secret.key`, `secret key`,
 * `secretKey`, and `awsSecretAccessKey` all yield the same words. Compounds are listed explicitly so
 * concatenated lowercase forms (`clientsecret`, `authtoken`) are recognized too.
 */
const STRONG_SECRET_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "credential",
  "credentials",
  "bearer",
  "authorization",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "signingkey",
  "accountkey",
  "clientsecret",
  "clientkey",
  "appsecret",
  "authkey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "sessionkey",
  "sessiontoken",
  "encryptionkey",
  "sharedsecret",
  "connectionstring",
  "connstr",
]);

/**
 * A qualified `…key…`/`…token…` is only a secret when it also carries a credential-bearing
 * qualifier; a bare `token` is treated as a credential, while a domain label such as
 * `severity_token` is not.
 */
const QUALIFIED_SECRET_WORDS: ReadonlySet<string> = new Set(["key", "token"]);

const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "api",
  "access",
  "private",
  "secret",
  "signing",
  "account",
  "encryption",
  "client",
  "app",
  "auth",
  "bearer",
  "oauth",
  "csrf",
  "xsrf",
  "session",
  "refresh",
  "service",
  "security",
  "root",
  "master",
]);

const HIGH_ENTROPY_MIN_LENGTH = 32;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 4;

function normalizeKeyWords(raw: string): readonly string[] {
  const camelSpaced = raw.replace(/([a-z0-9])([A-Z])/gu, "$1_$2");
  return camelSpaced
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .split("_")
    .filter((word) => word.length > 0);
}

/** True when a key name denotes a secret (any surface: env var, YAML, JSON, shell, prose). */
export function isScaP11SensitiveKeyName(raw: string): boolean {
  const words = normalizeKeyWords(raw);
  if (words.length === 0) return false;
  const set = new Set(words);
  for (const word of set) if (STRONG_SECRET_WORDS.has(word)) return true;
  // A bare `token` is a credential; a qualified one needs a credential-bearing qualifier so that
  // domain labels such as `severity_token` are not swept up.
  if (set.has("token") && words.length === 1) return true;
  for (const qualified of QUALIFIED_SECRET_WORDS) {
    if (!set.has(qualified)) continue;
    for (const qualifier of set) if (KEY_QUALIFIERS.has(qualifier)) return true;
  }
  return false;
}

function shannonBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * Conservative high-entropy classifier for an assigned value. It requires a long base64-ish token
 * (no dots — dots are common in identifiers, and standard base64 never contains them) with a digit
 * and either an explicit base64 symbol (`+ / =`) or both cases, plus a high per-character entropy.
 * Ordinary digests, artifact ids, schema ids, rule ids, and version strings are not swept up.
 */
export function isScaP11HighEntropyAssignedValue(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(value)) return false;
  if (!/[0-9]/u.test(value)) return false;
  const hasUpper = /[A-Z]/u.test(value);
  const hasLower = /[a-z]/u.test(value);
  const hasBase64Symbol = /[+/=]/u.test(value);
  if (!(hasBase64Symbol || (hasUpper && hasLower))) return false;
  return shannonBitsPerChar(value) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

function collectPatternSpans(text: string, spans: SensitiveSpan[]): void {
  for (const { kind, pattern } of LITERAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      } else {
        spans.push({ kind, start: match.index, end: match.index + match[0].length });
      }
      match = pattern.exec(text);
    }
    pattern.lastIndex = 0;
  }
}

function collectAssignmentSpans(text: string, spans: SensitiveSpan[]): void {
  ASSIGNMENT_PATTERN.lastIndex = 0;
  let match = ASSIGNMENT_PATTERN.exec(text);
  while (match !== null) {
    const key = match[3] ?? "";
    const value = match[4] ?? match[5] ?? match[6] ?? "";
    if (isScaP11SensitiveKeyName(key) || isScaP11HighEntropyAssignedValue(value)) {
      const start = match.index + (match[1]?.length ?? 0);
      spans.push({ kind: "secret", start, end: match.index + match[0].length });
    }
    if (match[0].length === 0) ASSIGNMENT_PATTERN.lastIndex += 1;
    match = ASSIGNMENT_PATTERN.exec(text);
  }
  ASSIGNMENT_PATTERN.lastIndex = 0;
}

/** Merge overlapping or adjacent spans so each character is replaced exactly once. */
function mergeSpans(spans: readonly SensitiveSpan[]): SensitiveSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((left, right) =>
    left.start === right.start ? left.end - right.end : left.start - right.start
  );
  const merged: SensitiveSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { ...last, end: span.end };
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function findSensitiveSpans(text: string): readonly SensitiveSpan[] {
  const spans: SensitiveSpan[] = [];
  collectPatternSpans(text, spans);
  collectAssignmentSpans(text, spans);
  return mergeSpans(spans);
}

/** Scan one exact string for secret and personal-data spans without mutating it. */
export function scanScaP11Sensitive(text: string): ScaP11SensitiveScanV1 {
  let secrets = false;
  let personalData = false;
  let secretMatches = 0;
  let personalDataMatches = 0;
  for (const span of findSensitiveSpans(text)) {
    if (span.kind === "secret") {
      secrets = true;
      secretMatches += 1;
    } else {
      personalData = true;
      personalDataMatches += 1;
    }
  }
  return {
    secrets,
    personal_data: personalData,
    secret_matches: secretMatches,
    personal_data_matches: personalDataMatches,
  };
}

/** Redact every detected secret and personal-data span, replacing each with a typed marker. */
export function redactScaP11Sensitive(text: string): string {
  const spans = findSensitiveSpans(text);
  if (spans.length === 0) return text;
  let redacted = "";
  let cursor = 0;
  for (const span of spans) {
    redacted += text.slice(cursor, span.start) + SCA_P11_REDACTION_MARKER;
    cursor = span.end;
  }
  return redacted + text.slice(cursor);
}

export function scaP11HasSensitiveContent(text: string): boolean {
  const scan = scanScaP11Sensitive(text);
  return scan.secrets || scan.personal_data;
}

/** Deep-redact every string leaf of a JSON-compatible value. Arrays and objects keep their shape. */
export function redactScaP11JsonValue(value: unknown): unknown {
  if (typeof value === "string") return redactScaP11Sensitive(value);
  if (Array.isArray(value)) return value.map((entry) => redactScaP11JsonValue(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactScaP11JsonValue(entry)])
    );
  }
  return value;
}
