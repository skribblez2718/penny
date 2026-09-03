/**
 * Read-only structural and rendered conformance checker for skill flow diagrams.
 *
 * It treats each flow document as untrusted local input: static parsing is bounded,
 * browser requests are blocked, only verified skill paths are opened, and screenshots
 * are retained only for failed checks below /tmp/penny-flow-html-validation.
 */

import { chromium } from "playwright";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");
const SKILLS_ROOT = resolve(REPO_ROOT, ".pi/skills");
const FAILURE_ROOT = "/tmp/penny-flow-html-validation";
const MAX_FLOW_BYTES = 512 * 1024;
const TEMPLATE_VERSION = "1";
const EDGE_KINDS = new Set(["fwd", "gate", "loop", "exit", "abort", "esc"]);
const NON_COGNITIVE_CLASSES = new Set(["start", "host", "gate", "done", "error", "esc"]);
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1080 },
] as const;

type EdgeKind = "fwd" | "gate" | "loop" | "exit" | "abort" | "esc";

export interface DiagramNode {
  title: string;
  desc: string;
  cls: string;
  lane: "left" | "center" | "right";
  y: number;
  who?: string;
  badge?: string;
  host_only?: boolean;
  decisions?: string[];
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
}

export interface ParsedFlow {
  nodes: Readonly<Record<string, DiagramNode>>;
  edges: readonly DiagramEdge[];
}

interface Failure {
  code: string;
  message: string;
}

interface Rect {
  label: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface BrowserSnapshot {
  nodes: Rect[];
  labels: Rect[];
  paths: Rect[];
  graph: Rect;
  pathCount: number;
  markerCount: number;
  edgeListCount: number;
  h1Count: number;
  viewportScrollWidth: number;
  viewportClientWidth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalStringField(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringField(value, label);
}

function finiteNumberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function stringArrayField(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }

  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${label} must be an array of strings`);
    }
    strings.push(item);
  }
  return strings;
}

/** Checks duplicate JSON object keys before JSON.parse would erase that evidence. */
function assertNoDuplicateJsonKeys(input: string): void {
  function skipWhitespace(index: number): number {
    let cursor = index;
    while (/\s/u.test(input[cursor] ?? "")) cursor += 1;
    return cursor;
  }

  function parseString(index: number): { value: string; end: number } {
    if (input[index] !== '"') throw new Error(`expected JSON string at byte ${index}`);
    let cursor = index + 1;
    let escaped = false;
    while (cursor < input.length) {
      const character = input[cursor];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        const raw = input.slice(index, cursor + 1);
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "string") throw new Error(`invalid JSON string at byte ${index}`);
        return { value, end: cursor + 1 };
      }
      cursor += 1;
    }
    throw new Error(`unterminated JSON string at byte ${index}`);
  }

  function parseValue(index: number): number {
    const start = skipWhitespace(index);
    const character = input[start];
    if (character === '"') return parseString(start).end;
    if (character === "{") {
      const seen = new Set<string>();
      let cursor = skipWhitespace(start + 1);
      if (input[cursor] === "}") return cursor + 1;
      while (cursor < input.length) {
        const key = parseString(cursor);
        if (seen.has(key.value))
          throw new Error(`duplicate JSON key '${key.value}' at byte ${cursor}`);
        seen.add(key.value);
        cursor = skipWhitespace(key.end);
        if (input[cursor] !== ":") throw new Error(`expected ':' after JSON key '${key.value}'`);
        cursor = skipWhitespace(parseValue(cursor + 1));
        if (input[cursor] === "}") return cursor + 1;
        if (input[cursor] !== ",") throw new Error(`expected ',' after JSON key '${key.value}'`);
        cursor = skipWhitespace(cursor + 1);
      }
      throw new Error("unterminated JSON object");
    }
    if (character === "[") {
      let cursor = skipWhitespace(start + 1);
      if (input[cursor] === "]") return cursor + 1;
      while (cursor < input.length) {
        cursor = skipWhitespace(parseValue(cursor));
        if (input[cursor] === "]") return cursor + 1;
        if (input[cursor] !== ",") throw new Error("expected ',' in JSON array");
        cursor = skipWhitespace(cursor + 1);
      }
      throw new Error("unterminated JSON array");
    }
    const primitive = input
      .slice(start)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);
    if (primitive === null) throw new Error(`invalid JSON value at byte ${start}`);
    return start + primitive[0].length;
  }

  const end = skipWhitespace(parseValue(0));
  if (end !== input.length) throw new Error(`unexpected JSON bytes at ${end}`);
}

export function extractConstant(source: string, name: "N" | "E"): string {
  const marker = `const ${name} = `;
  const valueStart = source.indexOf(marker);
  if (valueStart < 0) throw new Error(`missing '${marker}'`);
  let index = valueStart + marker.length;
  const opening = source[index];
  if (opening !== "{" && opening !== "[") throw new Error(`const ${name} must start with JSON`);
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(valueStart + marker.length, index + 1);
    }
  }
  throw new Error(`const ${name} is unbalanced`);
}

function parseNode(value: unknown, id: string): DiagramNode {
  if (!isRecord(value)) throw new Error(`N.${id} must be an object`);
  const lane = stringField(value["lane"], `N.${id}.lane`);
  if (lane !== "left" && lane !== "center" && lane !== "right") {
    throw new Error(`N.${id}.lane must be left, center, or right`);
  }
  const hostOnly = value["host_only"];
  if (hostOnly !== undefined && typeof hostOnly !== "boolean") {
    throw new Error(`N.${id}.host_only must be boolean`);
  }
  const who = optionalStringField(value["who"], `N.${id}.who`);
  const badge = optionalStringField(value["badge"], `N.${id}.badge`);
  const decisions = stringArrayField(value["decisions"], `N.${id}.decisions`);
  return {
    title: stringField(value["title"], `N.${id}.title`),
    desc: stringField(value["desc"], `N.${id}.desc`),
    cls: stringField(value["cls"], `N.${id}.cls`),
    lane,
    y: finiteNumberField(value["y"], `N.${id}.y`),
    ...(who === undefined ? {} : { who }),
    ...(badge === undefined ? {} : { badge }),
    ...(hostOnly === true ? { host_only: true } : {}),
    ...(decisions === undefined ? {} : { decisions }),
  };
}

function isEdgeKind(value: string): value is EdgeKind {
  return EDGE_KINDS.has(value);
}

function parseEdge(value: unknown, index: number): DiagramEdge {
  if (!isRecord(value)) throw new Error(`E[${index}] must be an object`);
  const kind = stringField(value["kind"], `E[${index}].kind`);
  if (!isEdgeKind(kind)) throw new Error(`E[${index}].kind '${kind}' is not allowed`);
  return {
    from: stringField(value["from"], `E[${index}].from`),
    to: stringField(value["to"], `E[${index}].to`),
    kind,
    label: stringField(value["label"], `E[${index}].label`),
  };
}

export function parseFlow(source: string): ParsedFlow {
  const rawNodes = extractConstant(source, "N");
  const rawEdges = extractConstant(source, "E");
  assertNoDuplicateJsonKeys(rawNodes);
  assertNoDuplicateJsonKeys(rawEdges);
  const nodeValue: unknown = JSON.parse(rawNodes);
  const edgeValue: unknown = JSON.parse(rawEdges);
  if (!isRecord(nodeValue)) throw new Error("N must be a JSON object");
  if (!Array.isArray(edgeValue)) throw new Error("E must be a JSON array");
  const nodes: Record<string, DiagramNode> = {};
  for (const [id, node] of Object.entries(nodeValue)) {
    nodes[id] = parseNode(node, id);
  }
  const edges = edgeValue.map((edge, index) => parseEdge(edge, index));
  return { nodes, edges };
}

function staticFailures(path: string, source: string, flow: ParsedFlow): Failure[] {
  const failures: Failure[] = [];
  const requireText = (pattern: RegExp, code: string, message: string): void => {
    if (!pattern.test(source)) failures.push({ code, message });
  };
  requireText(/^<!doctype html>/imu, "DOCTYPE", "missing HTML5 doctype");
  requireText(/<html\s+lang=["']en["']/iu, "LANG", "document language must be English");
  requireText(/<meta\s+charset=["']utf-8["']/iu, "CHARSET", "missing UTF-8 charset");
  requireText(/name=["']viewport["']/iu, "VIEWPORT", "missing viewport metadata");
  requireText(
    new RegExp(`name=["']penny-flow-template["']\\s+content=["']${TEMPLATE_VERSION}["']`, "iu"),
    "TEMPLATE_VERSION",
    "missing canonical template version marker"
  );
  if ((source.match(/<h1\b/giu) ?? []).length !== 1)
    failures.push({ code: "H1", message: "document needs exactly one h1" });
  for (const [selector, code] of [
    ["flow-viewport", "FLOW_VIEWPORT"],
    ['id="wrap"', "WRAP"],
    ['id="edges"', "SVG"],
    ['id="edge-list"', "EDGE_LIST"],
    ['class="callout"', "CALLOUT"],
    ['class="legend"', "LEGEND"],
    ["<footer", "FOOTER"],
  ] as const) {
    if (!source.includes(selector))
      failures.push({ code, message: `missing required ${selector} region` });
  }
  if (!source.includes('id="arrowhead"'))
    failures.push({ code: "ARROWHEAD", message: "missing SVG arrowhead marker" });
  if (/<script\b[^>]*\bsrc\s*=/iu.test(source) || /<link\b[^>]*\bhref\s*=/iu.test(source)) {
    failures.push({
      code: "EXTERNAL_ASSET",
      message: "external scripts and stylesheets are forbidden",
    });
  }
  if (/\b(?:fetch|XMLHttpRequest|WebSocket)\b|\bimport\s*(?:\(|["'])/u.test(source)) {
    failures.push({
      code: "NETWORK_API",
      message: "flow documents must not initiate network activity",
    });
  }
  if (/innerHTML\s*=/u.test(source))
    failures.push({
      code: "UNSAFE_DOM",
      message: "renderer must not interpolate through innerHTML",
    });
  if (
    source.includes("__FLOW_") ||
    source.includes("__N_JSON__") ||
    source.includes("__E_JSON__")
  ) {
    failures.push({ code: "PLACEHOLDER", message: "unresolved template placeholder" });
  }
  if (Object.keys(flow.nodes).length === 0)
    failures.push({ code: "N_EMPTY", message: "N must contain at least one node" });
  const edgeKeys = new Set<string>();
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (node.y < 0 || node.y > 10000)
      failures.push({ code: "NODE_BOUNDS", message: `N.${id}.y is outside 0..10000` });
    if (!NON_COGNITIVE_CLASSES.has(node.cls) && node.who === undefined) {
      failures.push({ code: "NODE_OWNER", message: `cognitive node '${id}' must name its owner` });
    }
    if ((node.cls === "gate" || node.cls === "host") && node.badge === undefined) {
      failures.push({ code: "NODE_BADGE", message: `control node '${id}' must have a text badge` });
    }
    if ((node.cls === "done" || node.cls === "error") && node.badge !== "TERM") {
      failures.push({
        code: "TERMINAL_BADGE",
        message: `terminal '${id}' must use the TERM badge`,
      });
    }
  }
  for (const edge of flow.edges) {
    if (flow.nodes[edge.from] === undefined || flow.nodes[edge.to] === undefined) {
      failures.push({
        code: "EDGE_ENDPOINT",
        message: `${edge.from} → ${edge.to} has a missing endpoint`,
      });
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.label}`;
    if (edgeKeys.has(key))
      failures.push({
        code: "EDGE_DUPLICATE",
        message: `duplicate edge ${edge.from} → ${edge.to}`,
      });
    edgeKeys.add(key);
  }
  if (path.length === 0) failures.push({ code: "PATH", message: "unreachable flow path" });
  return failures;
}

export function validateStaticFlow(path: string): { flow?: ParsedFlow; failures: Failure[] } {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      return { failures: [{ code: "FILE", message: "flow must be a regular non-symlink file" }] };
    if (stat.size > MAX_FLOW_BYTES)
      return { failures: [{ code: "SIZE", message: `flow exceeds ${MAX_FLOW_BYTES} bytes` }] };
    const source = readFileSync(path, "utf8");
    const flow = parseFlow(source);
    return { flow, failures: staticFailures(path, source, flow) };
  } catch (error) {
    return {
      failures: [
        { code: "STATIC_PARSE", message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

function rectanglesIntersect(left: Rect, right: Rect): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

function rectFailure(kind: string, left: Rect, right: Rect): Failure {
  const x = Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const y = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return {
    code: kind,
    message: `"${left.label}" intersects "${right.label}" by ${Math.round(x)}×${Math.round(y)} px`,
  };
}

async function browserSnapshot(page: import("playwright").Page): Promise<BrowserSnapshot> {
  return page.evaluate(() => {
    const rectangle = (element: Element, label: string) => {
      const box = element.getBoundingClientRect();
      return { label, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    };
    const nodes = [...document.querySelectorAll(".node")].map((node) =>
      rectangle(node, node.getAttribute("data-node-id") ?? "node")
    );
    const labels = [...document.querySelectorAll(".lbl")].map((label) =>
      rectangle(label, label.textContent?.trim() ?? "label")
    );
    const graphElement = document.querySelector("#wrap");
    const graphArea = document.querySelector("#graph-area");
    const viewport = document.querySelector(".flow-viewport");
    if (graphElement === null || graphArea === null || viewport === null)
      throw new Error("graph regions missing after render");
    const graphRect = rectangle(graphElement, "graph canvas");
    const areaRect = graphArea.getBoundingClientRect();
    const paths = [...document.querySelectorAll<SVGPathElement>("path.edge")].map((path, index) => {
      const box = path.getBBox();
      return {
        label: `edge ${index + 1}`,
        left: areaRect.left + box.x,
        top: areaRect.top + box.y,
        right: areaRect.left + box.x + box.width,
        bottom: areaRect.top + box.y + box.height,
      };
    });
    return {
      nodes,
      labels,
      paths,
      graph: graphRect,
      pathCount: document.querySelectorAll("path.edge").length,
      markerCount: document.querySelectorAll("path.edge[marker-end='url(#arrowhead)']").length,
      edgeListCount: document.querySelectorAll("#edge-list > li").length,
      h1Count: document.querySelectorAll("h1").length,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
    };
  });
}

function renderedFailures(
  snapshot: BrowserSnapshot,
  flow: ParsedFlow,
  viewport: { width: number; height: number }
): Failure[] {
  const failures: Failure[] = [];
  if (snapshot.nodes.length !== Object.keys(flow.nodes).length)
    failures.push({
      code: "NODE_COUNT",
      message: `rendered ${snapshot.nodes.length} nodes for ${Object.keys(flow.nodes).length} N entries`,
    });
  if (snapshot.labels.length !== flow.edges.length)
    failures.push({
      code: "LABEL_COUNT",
      message: `rendered ${snapshot.labels.length} labels for ${flow.edges.length} E entries`,
    });
  if (snapshot.pathCount !== flow.edges.length || snapshot.markerCount !== flow.edges.length)
    failures.push({
      code: "EDGE_COUNT",
      message: `rendered ${snapshot.pathCount} arrow paths and ${snapshot.markerCount} arrowheads for ${flow.edges.length} E entries`,
    });
  if (snapshot.edgeListCount !== flow.edges.length)
    failures.push({
      code: "EDGE_LIST",
      message: `assistive edge list has ${snapshot.edgeListCount} items for ${flow.edges.length} edges`,
    });
  if (snapshot.h1Count !== 1)
    failures.push({ code: "H1_RENDERED", message: "rendered page does not have exactly one H1" });
  for (let index = 0; index < snapshot.nodes.length; index += 1) {
    const node = snapshot.nodes[index];
    if (node === undefined) continue;
    for (const other of snapshot.nodes.slice(index + 1))
      if (rectanglesIntersect(node, other)) failures.push(rectFailure("NODE_OVERLAP", node, other));
    if (
      node.left < snapshot.graph.left ||
      node.right > snapshot.graph.right ||
      node.top < snapshot.graph.top ||
      node.bottom > snapshot.graph.bottom
    )
      failures.push({
        code: "NODE_BOUNDS",
        message: `node '${node.label}' leaves the graph canvas`,
      });
  }
  for (let index = 0; index < snapshot.labels.length; index += 1) {
    const label = snapshot.labels[index];
    if (label === undefined) continue;
    for (const other of snapshot.labels.slice(index + 1))
      if (rectanglesIntersect(label, other))
        failures.push(rectFailure("LABEL_OVERLAP", label, other));
    for (const node of snapshot.nodes)
      if (rectanglesIntersect(label, node))
        failures.push(rectFailure("LABEL_NODE_OVERLAP", label, node));
    if (
      label.left < snapshot.graph.left ||
      label.right > snapshot.graph.right ||
      label.top < snapshot.graph.top ||
      label.bottom > snapshot.graph.bottom
    )
      failures.push({
        code: "LABEL_BOUNDS",
        message: `route label '${label.label}' leaves the graph canvas`,
      });
  }
  for (const path of snapshot.paths) {
    if (
      path.left < snapshot.graph.left ||
      path.right > snapshot.graph.right ||
      path.top < snapshot.graph.top ||
      path.bottom > snapshot.graph.bottom
    ) {
      failures.push({ code: "PATH_BOUNDS", message: `${path.label} leaves the graph canvas` });
    }
  }
  if (viewport.width >= 1600 && snapshot.viewportScrollWidth <= 1340)
    failures.push({
      code: "RESPONSIVE_WIDTH",
      message: "wide viewport did not expand the graph beyond its minimum width",
    });
  if (viewport.width < 1340 && snapshot.viewportScrollWidth <= snapshot.viewportClientWidth)
    failures.push({
      code: "NARROW_SCROLL",
      message: "narrow viewport must contain graph overflow in the named viewport",
    });
  return failures;
}

function discoverFlows(skillFilter?: string): string[] {
  if (skillFilter !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(skillFilter))
    throw new Error("--skill must be a canonical skill package name");
  const paths: string[] = [];
  for (const name of readdirSync(SKILLS_ROOT)) {
    if (skillFilter !== undefined && name !== skillFilter) continue;
    const skillRoot = resolve(SKILLS_ROOT, name);
    if (!lstatSync(skillRoot).isDirectory() || !existsSync(resolve(skillRoot, "SKILL.md")))
      continue;
    const flow = resolve(skillRoot, "resources/flow.html");
    if (existsSync(flow)) paths.push(flow);
  }
  if (skillFilter !== undefined && paths.length === 0)
    throw new Error(`skill '${skillFilter}' has no flow.html`);
  return paths.sort();
}

function outputFailure(skill: string, viewport: string, failure: Failure): void {
  process.stderr.write(`FAIL ${skill} [${viewport}] ${failure.code}: ${failure.message}\n`);
}

async function validateBrowserFlow(path: string, flow: ParsedFlow): Promise<number> {
  const skill = basename(dirname(dirname(path)));
  const browser = await chromium.launch({ headless: true });
  let count = 0;
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      const page = await context.newPage();
      const requests: string[] = [];
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith("file:")) await route.continue();
        else {
          requests.push(url);
          await route.abort("blockedbyclient");
        }
      });
      try {
        await page.goto(pathToFileURL(path).href, { waitUntil: "load", timeout: 15_000 });
        const failures = renderedFailures(await browserSnapshot(page), flow, viewport);
        for (const url of requests)
          failures.push({ code: "NETWORK", message: `attempted request: ${url}` });
        if (failures.length > 0) {
          mkdirSync(FAILURE_ROOT, { recursive: true });
          const screenshot = resolve(
            FAILURE_ROOT,
            `${skill}-${viewport.width}x${viewport.height}.png`
          );
          await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
          for (const failure of failures)
            outputFailure(skill, `${viewport.width}x${viewport.height}`, failure);
          process.stderr.write(
            `FAIL ${skill} [${viewport.width}x${viewport.height}] SCREENSHOT: ${screenshot}\n`
          );
          count += failures.length;
        }
      } catch (error) {
        outputFailure(skill, `${viewport.width}x${viewport.height}`, {
          code: "BROWSER",
          message: error instanceof Error ? error.message : String(error),
        });
        count += 1;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return count;
}

export async function runValidator(skillFilter?: string): Promise<number> {
  let failures = 0;
  let checked = 0;
  for (const path of discoverFlows(skillFilter)) {
    const skill = basename(dirname(dirname(path)));
    const staticResult = validateStaticFlow(path);
    if (staticResult.flow === undefined || staticResult.failures.length > 0) {
      for (const failure of staticResult.failures) outputFailure(skill, "static", failure);
      failures += staticResult.failures.length;
      continue;
    }
    checked += 1;
    failures += await validateBrowserFlow(path, staticResult.flow);
  }
  process.stdout.write(
    `Flow HTML validation: ${checked} static-ready skill(s), ${failures} failure(s).\n`
  );
  return failures;
}

function parseSkillArgument(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--skill") return argv[1];
  throw new Error(
    "usage: bun .pi/extensions/playwright/scripts/validate-flow-html.ts [--skill NAME]"
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  runValidator(parseSkillArgument(process.argv.slice(2)))
    .then((failures) => (process.exitCode = failures === 0 ? 0 : 1))
    .catch((error: unknown) => {
      process.stderr.write(
        `Flow HTML validator failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    });
}
