/** Pure HTTP editing helpers for caido_edit */

export interface ParsedRawHttp {
  requestLine: string;
  headers: string[];
  body: string;
  lineEnd: string;
}

export function parseRawHttp(raw: string): ParsedRawHttp {
  if (!raw) return { requestLine: "", headers: [], body: "", lineEnd: "\r\n" };

  const lineEnd = raw.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
  const separator = lineEnd + lineEnd;
  const splitIdx = raw.indexOf(separator);

  let headerBlock: string;
  let body: string;

  if (splitIdx >= 0) {
    headerBlock = raw.substring(0, splitIdx);
    body = raw.substring(splitIdx + separator.length);
  } else {
    headerBlock = raw;
    body = "";
  }

  const lines = headerBlock.split(lineEnd);
  const requestLine = lines[0] || "";
  const headers = lines.slice(1).filter((l) => l.trim() !== "");

  return { requestLine, headers, body, lineEnd };
}

export function modifyRequestLine(requestLine: string, method?: string, path?: string): string {
  if (!method && !path) return requestLine;

  const firstSpace = requestLine.indexOf(" ");
  const lastSpace = requestLine.lastIndexOf(" ");
  if (firstSpace <= 0 || lastSpace <= firstSpace) return requestLine;

  const currentMethod = requestLine.substring(0, firstSpace);
  const currentPath = requestLine.substring(firstSpace + 1, lastSpace);
  const version = requestLine.substring(lastSpace);

  const newMethod = method || currentMethod;
  const newPath = path || currentPath;

  return `${newMethod} ${newPath}${version}`;
}

export function modifyHeaders(
  headers: string[],
  removeNames: string[],
  setHeaders: string[]
): string[] {
  const lowerRemoves = removeNames.map((n) => n.toLowerCase());
  let result = headers.filter((h) => {
    const name = h.split(":")[0]?.trim().toLowerCase() || "";
    return !lowerRemoves.includes(name);
  });

  for (const header of setHeaders) {
    const colonIdx = header.indexOf(":");
    if (colonIdx > 0) {
      const name = header.substring(0, colonIdx).trim().toLowerCase();
      result = result.filter((h) => {
        const hName = h.split(":")[0]?.trim().toLowerCase() || "";
        return hName !== name;
      });
      result.push(header.trim());
    }
  }

  return result;
}

export function applyReplacements(raw: string, replacements: string[]): string {
  let result = raw;
  for (const rep of replacements) {
    const sepIdx = rep.indexOf(":::");
    if (sepIdx > 0) {
      const from = rep.substring(0, sepIdx);
      const to = rep.substring(sepIdx + 3);
      result = result.replaceAll(from, to);
    }
  }
  return result;
}

export function buildModifiedRaw(
  requestLine: string,
  headers: string[],
  body: string,
  lineEnd: string
): string {
  const clBytes = new TextEncoder().encode(body).length;
  const filtered = headers.filter((h) => !h.toLowerCase().startsWith("content-length:"));
  filtered.push(`Content-Length: ${clBytes}`);
  const headerBlock = [requestLine, ...filtered].join(lineEnd);
  return headerBlock + lineEnd + lineEnd + body;
}
