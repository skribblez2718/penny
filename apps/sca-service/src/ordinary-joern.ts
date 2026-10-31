/** Native Joern 4 query material; no discovery, installation, execution, or project paths. */
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ScaGraphData, ScaHostRequest } from "../../orchestration/dist/sca/ordinary-host.js";

export interface OrdinaryJoernManifest {
  schema_version: 1;
  language: ScaGraphData["language"];
  source_snapshot_sha256: string;
  source_corpus_sha256: string;
  files: { path: string; content_sha256: string }[];
}
export function ordinaryJoernBinding(input: {
  manifest: OrdinaryJoernManifest;
  graph: ScaGraphData;
  config: NonNullable<ScaHostRequest["tools"]["graph"]>;
  queryId: string;
}) {
  const query = input.config.queries.find((entry) => entry.id === input.queryId);
  if (query === undefined) throw new Error("Missing caller-selected Joern query");
  const frontend =
    input.graph.language === "php" ? input.config.php_frontend : input.config.js_frontend;
  if (frontend === undefined) throw new Error("Missing caller-selected graph frontend");
  return {
    manifest: input.manifest,
    manifest_sha256: sha256(canonicalJson(input.manifest)),
    graph_sha256: input.graph.graph_sha256,
    frontend,
    joern: input.config.joern,
    query,
  };
}

export interface OrdinaryJoernQueryOptions {
  kind: "call" | "control" | "dataflow";
  /** Joern regular expressions, encoded as literal data, never Scala code. */
  sink: string;
  sourceMethod: string;
  offset?: number;
  limit?: number;
}
/**
 * Caller writes/pins this script and selects it through ordinary tools.graph. Requires
 * --enable-file-content frontends and the runtime's cpgFile.manifest.json sidecar.
 * Writes cpgFile.result.json: a private launcher must emit those exact bytes on stdout
 * and route native Joern diagnostics to stderr. No log scraping or synthetic rows.
 * Pagination is deliberately incomplete for a nonzero offset or an extra result.
 */
export function ordinaryJoernQueryScript(options: OrdinaryJoernQueryOptions): string {
  if (!["call", "control", "dataflow"].includes(options.kind))
    throw new Error("Invalid Joern traversal kind");
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 128;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
    throw new Error("Invalid Joern offset");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
    throw new Error("Invalid Joern row limit");
  for (const value of [options.sink, options.sourceMethod])
    if (
      value.length === 0 ||
      value.length > 1024 ||
      [...value].some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error("Invalid Joern traversal expression");
  // Base64 avoids Scala's pre-lexing Unicode escapes and string interpolation entirely.
  const literal = (value: string) =>
    `new String(java.util.Base64.getDecoder.decode("${Buffer.from(value).toString("base64")}"), UTF_8)`;
  const sink = literal(options.sink);
  const source = literal(options.sourceMethod);
  const traversal =
    options.kind === "call"
      ? `cpg.call.name(${sink}).iterator.flatMap { call =>
          call.callee.map { target =>
            (call, s"CALL \${call.method.name} -> \${target.fullName}: \${call.code}")
          }
        }`
      : options.kind === "control"
        ? `cpg.call.name(${sink}).iterator.flatMap { call =>
          call.controlledBy.map { condition =>
            (call, s"CONTROL \${condition.code} -> \${call.code}")
          }
        }`
        : `cpg.call.name(${sink}).argument.filter(_.argumentIndex > 0).reachableByFlows(cpg.method.name(${source}).parameter.filter(_.index > 0)).iterator.flatMap { flow =>
          flow.elements.lastOption.toIterator.flatMap { endpoint =>
            endpoint.start.astParent.isCall.map { call =>
              (call, "DATAFLOW " + flow.elements.map(n => s"\${n.label}:\${n.code}").mkString(" -> "))
            }
          }
        }`;
  return `import io.shiftleft.semanticcpg.language.*
import io.joern.dataflowengineoss.language.*
import java.nio.file.{Files, Paths}
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
@main def exec(cpgFile: String): Unit = { try {
  val manifest = ujson.read(Files.readString(Paths.get(cpgFile + ".manifest.json")))
  importCpg(cpgFile)
  def hash(text: String): String = MessageDigest.getInstance("SHA-256").digest(text.getBytes(UTF_8)).map(b => f"\${b & 0xff}%02x").mkString
  val expected = manifest("files").arr.toSeq
  val files = expected.map { file =>
    val name = file("path").str
    val represented = cpg.file.nameExact(name).l
    val supported = represented.size == 1 && hash(represented.head.content) == file("content_sha256").str && cpg.unknown.filter(_.method.filename == name).isEmpty
    ujson.Obj("path" -> name, "content_sha256" -> file("content_sha256").str,
      "status" -> (if (supported) "supported" else "unsupported"),
      "detail" -> (if (supported) "Exact FILE content SHA-256 matched; no UNKNOWN nodes. Semantic completeness is not proven." else "FILE absent, ambiguous, content mismatch, or UNKNOWN nodes; not semantic coverage."))
  }
  val names = expected.map(_("path").str).toSet
  val candidates = ${traversal}
    .filter { case (call, _) => names.contains(call.method.filename) && call.lineNumber.isDefined }
    .map { case (call, title) =>
      ujson.Obj("title" -> title, "path" -> call.method.filename,
        "start_line" -> call.lineNumber.get, "end_line" -> call.lineNumber.get)
    }
  val page = candidates.drop(${offset}).take(${limit + 1}).toList
  val truncated = page.size > ${limit}
  files.foreach { file => file("detail") = file("detail").str + s" offset=${offset}; limit=${limit}; truncated=$truncated" }
  val complete = ${offset} == 0 && !truncated && files.forall(_("status").str == "supported")
  val result = ujson.Obj("schema_version" -> 1, "complete" -> complete,
    "files" -> ujson.Arr.from(files), "rows" -> ujson.Arr.from(page.take(${limit})))
  Files.writeString(Paths.get(cpgFile + ".result.json"), ujson.write(result))
} catch { case failure: Throwable => failure.printStackTrace(System.err); throw failure } }

`;
}
