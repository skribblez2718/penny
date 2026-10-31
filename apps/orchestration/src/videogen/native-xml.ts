import { TextDecoder } from "node:util";

/** Deliberately restricted XML 1.0 grammar, NOT a general XML implementation. No DTD,
 * PI (except the initial UTF-8 declaration), comments, CDATA, namespaces or custom entities.
 * This pre-parser runs before any native interpreter. Limits apply before allocation/walking. */
export interface NativeXmlLimits {
  readonly max_bytes: number;
  readonly max_nodes: number;
  readonly max_depth: number;
  readonly max_text: number;
}
export interface NativeElement {
  name: string;
  attrs: Record<string, string>;
  children: NativeElement[];
  text: string;
}
export function nativeRefuse(message: string): never {
  throw new Error(`native boundary: ${message}`);
}
export function nativeRequired<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) nativeRefuse(`missing ${label}`);
  return value;
}
function xmlChars(text: string): string {
  for (const c of text) {
    const n = c.codePointAt(0) ?? 0;
    if (
      !(
        n === 9 ||
        n === 10 ||
        n === 13 ||
        (n >= 32 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff)
      )
    )
      nativeRefuse("invalid XML character");
  }
  return text;
}
function decode(text: string): string {
  if (/&(?!amp;|lt;|gt;|apos;|quot;|#[0-9]+;|#x[0-9a-fA-F]+;)/u.test(text))
    nativeRefuse("custom/malformed XML entity");
  return xmlChars(
    text.replace(/&(amp|lt|gt|apos|quot|#[0-9]+|#x[0-9a-fA-F]+);/gu, (_m, entity: string) => {
      const builtins: Readonly<Record<string, string>> = {
        amp: "&",
        lt: "<",
        gt: ">",
        apos: "'",
        quot: '"',
      };
      if (!entity.startsWith("#")) return nativeRequired(builtins[entity], "entity");
      const n = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (!Number.isSafeInteger(n) || n > 0x10ffff) nativeRefuse("invalid XML scalar");
      return String.fromCodePoint(n);
    })
  );
}
export function parseNativeXml(bytes: Uint8Array, limits: NativeXmlLimits): NativeElement {
  for (const n of Object.values(limits))
    if (!Number.isSafeInteger(n) || n < 1) nativeRefuse("finite XML limits required");
  if (bytes.byteLength < 1 || bytes.byteLength > limits.max_bytes) nativeRefuse("XML byte limit");
  let source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  xmlChars(source);
  source = source.replace(
    /^<\?xml version=(?:"1\.0"|'1\.0') encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8')\?>\s*/u,
    ""
  );
  if (
    source.includes("<!") ||
    source.includes("<?") ||
    source.includes("]]>") ||
    source.includes("\r")
  )
    nativeRefuse("unsupported XML declaration/markup/newline");
  let pos = 0,
    count = 0;
  const stack: NativeElement[] = [];
  let root: NativeElement | undefined;
  const name = /^[A-Za-z_][A-Za-z0-9_.-]*/u;
  while (pos < source.length) {
    if (source[pos] !== "<") {
      const end = source.indexOf("<", pos);
      const raw = source.slice(pos, end < 0 ? source.length : end);
      const current = stack.at(-1);
      if (current === undefined) {
        if (raw.trim() !== "") nativeRefuse("text outside XML root");
      } else {
        current.text += decode(raw);
        if (current.text.length > limits.max_text) nativeRefuse("XML text limit");
      }
      pos += raw.length;
      continue;
    }
    pos++;
    const closing = source[pos] === "/";
    if (closing) pos++;
    const tag = nativeRequired(name.exec(source.slice(pos))?.[0], "XML name");
    pos += tag.length;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (true) {
      const before = pos;
      while (/\s/u.test(source[pos] ?? "")) pos++;
      if (source.startsWith("/>", pos)) {
        selfClose = true;
        pos += 2;
        break;
      }
      if (source[pos] === ">") {
        pos++;
        break;
      }
      if (closing || pos === before) nativeRefuse("invalid XML tag spacing");
      const key = nativeRequired(name.exec(source.slice(pos))?.[0], "attribute name");
      pos += key.length;
      while (/\s/u.test(source[pos] ?? "")) pos++;
      if (source[pos++] !== "=") nativeRefuse("invalid XML attribute");
      while (/\s/u.test(source[pos] ?? "")) pos++;
      const quote = source[pos++];
      if (quote !== '"' && quote !== "'") nativeRefuse("unquoted XML attribute");
      const end = source.indexOf(quote, pos);
      if (end < pos || end - pos > limits.max_text) nativeRefuse("attribute text limit");
      const raw = source.slice(pos, end);
      if (raw.includes("<") || /[\n\t]/u.test(raw) || key in attrs)
        nativeRefuse("ambiguous XML attribute");
      attrs[key] = decode(raw);
      if (Object.keys(attrs).length > 32) nativeRefuse("attribute count limit");
      pos = end + 1;
    }
    if (closing) {
      if (selfClose || stack.pop()?.name !== tag) nativeRefuse("unbalanced XML");
    } else {
      if (++count > limits.max_nodes || stack.length >= limits.max_depth)
        nativeRefuse("XML complexity limit");
      const node: NativeElement = { name: tag, attrs, children: [], text: "" };
      const parent = stack.at(-1);
      if (parent !== undefined) parent.children.push(node);
      else if (root !== undefined) nativeRefuse("multiple XML roots");
      else root = node;
      if (!selfClose) stack.push(node);
    }
  }
  if (stack.length !== 0) nativeRefuse("truncated XML");
  return nativeRequired(root, "XML root");
}
function escape(text: string): string {
  xmlChars(text);
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
export function serializeNativeXml(root: NativeElement): Buffer {
  function emit(n: NativeElement): string {
    const attrs = Object.entries(n.attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ` ${k}="${escape(v)}"`)
      .join("");
    return `<${n.name}${attrs}>${escape(n.text)}${n.children.map(emit).join("")}</${n.name}>`;
  }
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n${emit(root)}\n`);
}
export function nativeProperty(n: NativeElement, key: string): string | undefined {
  return n.children.find((c) => c.name === "property" && c.attrs.name === key)?.text;
}
export function setNativeProperty(n: NativeElement, key: string, value: string): void {
  const p = n.children.find((c) => c.name === "property" && c.attrs.name === key);
  if (p === undefined)
    n.children.unshift({ name: "property", attrs: { name: key }, children: [], text: value });
  else p.text = value;
}
export function nativeWalk(root: NativeElement): NativeElement[] {
  return [root, ...root.children.flatMap(nativeWalk)];
}
