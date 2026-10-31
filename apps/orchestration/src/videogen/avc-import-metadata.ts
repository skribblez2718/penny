import { type FoundationLimitsV1 } from "./bounds.js";
import { parseRuntimeWireJson } from "./runtime-json.js";

export interface ImportBox {
  readonly type: string;
  readonly payload: number;
  readonly end: number;
}
function refuse(): never {
  throw new Error("media refused: unsupported AVC import metadata");
}
const JSON_LIMITS: FoundationLimitsV1 = {
  schema_id: "penny.videogen-foundation-limits.v1",
  schema_version: 1,
  max_json_bytes: 65536,
  max_text_bytes: 65536,
  max_collection_items: 2048,
  max_depth: 16,
  max_nodes: 8192,
  max_integer: Number.MAX_SAFE_INTEGER,
};
/** Read-only import grammar. Metadata is inspected then discarded, never made executable or
 * treated as a request/profile/rights authority. Canonical admission does not use this grammar. */
export function inspectAvcImportMetadata(bytes: Buffer, box: ImportBox): number {
  let count = 0;
  const boxes = (start: number, end: number): ImportBox[] => {
    const result: ImportBox[] = [];
    for (let at = start; at < end; ) {
      if (++count > 64 || at + 8 > end) refuse();
      const n = bytes.readUInt32BE(at);
      if (n < 8 || at + n > end) refuse();
      result.push({ type: bytes.toString("latin1", at + 4, at + 8), payload: at + 8, end: at + n });
      at += n;
    }
    return result;
  };
  const exact = (items: ImportBox[], names: readonly string[]): void => {
    if (items.length !== names.length || items.some((b, i) => b.type !== names[i])) refuse();
  };
  const zero = (at: number, end: number): void => {
    if (bytes.subarray(at, end).some((b) => b !== 0)) refuse();
  };
  if (box.end - box.payload > JSON_LIMITS.max_json_bytes) refuse();
  const udta = boxes(box.payload, box.end);
  exact(udta, ["meta"]);
  const meta = udta[0] ?? refuse();
  if (meta.end - meta.payload < 4) refuse();
  zero(meta.payload, meta.payload + 4);
  const children = boxes(meta.payload + 4, meta.end);
  // FFmpeg's default encoder tag and Comfy's use_metadata_tags form are both parsed exactly.
  if (children.length === 2) {
    exact(children, ["hdlr", "ilst"]);
    const handler = children[0] ?? refuse();
    const expected = Buffer.from("00000000000000006d6469726170706c000000000000000000", "hex");
    if (!bytes.subarray(handler.payload, handler.end).equals(expected)) refuse();
    const entries = boxes((children[1] ?? refuse()).payload, (children[1] ?? refuse()).end);
    if (entries.length === 0) return count;
    exact(entries, ["©too"]);
    const entry = entries[0] ?? refuse();
    const data = boxes(entry.payload, entry.end);
    exact(data, ["data"]);
    inspectText(data[0] ?? refuse(), false);
    return count;
  }
  exact(children, ["hdlr", "keys", "ilst"]);
  const handler = children[0] ?? refuse();
  if (
    !bytes
      .subarray(handler.payload, handler.end)
      .equals(Buffer.from("00000000000000006d64746100000000000000000000000000", "hex"))
  )
    refuse();
  const keys = children[1] ?? refuse();
  if (keys.end - keys.payload < 8) refuse();
  zero(keys.payload, keys.payload + 4);
  const n = bytes.readUInt32BE(keys.payload + 4);
  if (n < 1 || n > 2) refuse();
  const names: string[] = [];
  let at = keys.payload + 8;
  for (let i = 0; i < n; i++) {
    if (at + 8 > keys.end) refuse();
    const size = bytes.readUInt32BE(at);
    if (size < 9 || at + size > keys.end || bytes.toString("ascii", at + 4, at + 8) !== "mdta")
      refuse();
    names.push(bytes.toString("ascii", at + 8, at + size));
    at += size;
  }
  if (
    at !== keys.end ||
    new Set(names).size !== n ||
    names.some((name) => !["prompt", "encoder"].includes(name))
  )
    refuse();
  const list = children[2] ?? refuse();
  const entries = boxes(list.payload, list.end);
  if (entries.length !== n) refuse();
  for (const [i, entry] of entries.entries()) {
    if (bytes.readUInt32BE(entry.payload - 4) !== i + 1) refuse();
    const data = boxes(entry.payload, entry.end);
    exact(data, ["data"]);
    inspectText(data[0] ?? refuse(), names[i] === "prompt");
  }
  return count;
  function inspectText(data: ImportBox, prompt: boolean): void {
    if (data.end - data.payload < 9 || bytes.readUInt32BE(data.payload) !== 1) refuse();
    zero(data.payload + 4, data.payload + 8);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(data.payload + 8, data.end)
    );
    if (prompt) {
      let value: unknown;
      try {
        value = parseRuntimeWireJson(Buffer.from(text, "utf8"), JSON_LIMITS);
      } catch {
        // Native JSON syntax errors can quote producer prompt content. Never expose that data.
        refuse();
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) refuse();
    } else if (!/^Lavf[0-9]+\.[0-9]+\.[0-9]+$/u.test(text)) refuse();
  }
}
/** Only x264's bounded informational user-data SEI is imported; all other SEI payloads refuse. */
export function inspectAvcImportSei(nal: Buffer): void {
  // Bound the encoded representation BEFORE allocating the de-escaped buffer. A 4096-byte
  // payload plus framing cannot require more than this with emulation-prevention bytes.
  if (nal.length > 8192) refuse();
  const rbsp: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
      if ((nal[i + 1] ?? 255) > 3) refuse();
      continue;
    }
    rbsp.push(nal[i] ?? refuse());
  }
  const b = Buffer.from(rbsp);
  let at = 0;
  const number = (): number => {
    let n = 0;
    while (at < b.length && b[at] === 255) {
      n += 255;
      at++;
    }
    if (at >= b.length) refuse();
    return n + (b[at++] ?? refuse());
  };
  const type = number(),
    size = number();
  if (
    type !== 5 ||
    size < 17 ||
    size > 4096 ||
    at + size + 1 !== b.length ||
    b[b.length - 1] !== 128
  )
    refuse();
  if (!b.subarray(at, at + 16).equals(Buffer.from("dc45e9bde6d948b7962cd820d923eeef", "hex")))
    refuse();
  const text = b.subarray(at + 16, at + size);
  if (text[text.length - 1] !== 0 || !/^x264 - core [\x20-\x7e]+\0$/u.test(text.toString("latin1")))
    refuse();
}
