#!/usr/bin/env python3
"""Execute one canonical, bounded SCA job inside the NIC-less guest."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Mapping

from output_protocol import OutputPayload, write_envelope

JOB_MOUNT = Path("/mnt/penny-job")
WORK_ROOT = Path("/var/tmp/penny-sca-job")
OUTPUT_LINK = Path("/dev/disk/by-id/virtio-penny-output")
JOB_LINK = Path("/dev/disk/by-label/PENNY_JOB")
JOERN_ROOT = Path("/opt/penny-sca/joern-cli")
MAX_JOB_BYTES = 1024 * 1024
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_RESULT_ITEMS = 10_000
SAFE_PATH = re.compile(r"^[A-Za-z0-9._/@+-]+(?:/[A-Za-z0-9._@+-]+)*$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
JOERN_VERSION = "4.0.627"
JOERN_CLI_PACKAGE = re.compile(r"^io\.joern\.joern-cli-([0-9]+(?:\.[0-9]+){1,5})\.jar$")


class JobError(ValueError):
    """A job failed the guest-side closed contract."""


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def record(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise JobError(f"invalid {label}")
    return value


def exact_keys(value: Mapping[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise JobError(f"invalid {label} fields")


def integer(value: object, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise JobError(f"invalid {label}")
    return value


def text(value: object, label: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode("utf-8")) > maximum
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise JobError(f"invalid {label}")
    return value


def relative_path(value: object, label: str) -> str:
    candidate = text(value, label, 4096)
    parsed = PurePosixPath(candidate)
    if (
        parsed.is_absolute()
        or not SAFE_PATH.fullmatch(candidate)
        or any(part in ("", ".", "..") for part in parsed.parts)
    ):
        raise JobError(f"invalid {label}")
    return candidate


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def resolve_block(link: Path, label: str) -> Path:
    try:
        resolved = link.resolve(strict=True)
        details = resolved.stat()
    except OSError as exc:
        raise JobError(f"missing {label}") from exc
    if (
        not stat.S_ISBLK(details.st_mode)
        or resolved.parent != Path("/dev")
        or not re.fullmatch(r"vd[a-z]+", resolved.name)
    ):
        raise JobError(f"invalid {label}")
    return resolved


def mount_job() -> None:
    JOB_MOUNT.mkdir(mode=0o700, parents=True, exist_ok=True)
    device = resolve_block(JOB_LINK, "job device")
    subprocess.run(
        ["/usr/bin/mount", "-o", "ro,nodev,nosuid,noexec", str(device), str(JOB_MOUNT)],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )


def read_canonical_job() -> tuple[Mapping[str, object], str]:
    path = JOB_MOUNT / "job.json"
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or not 1 <= details.st_size <= MAX_JOB_BYTES:
            raise JobError("invalid job file")
        content = os.read(descriptor, details.st_size + 1)
        if len(content) != details.st_size:
            raise JobError("job file changed")
    finally:
        os.close(descriptor)
    try:
        value: object = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JobError("invalid job JSON") from exc
    job = record(value, "job")
    if canonical_json(job) != content:
        raise JobError("job JSON is not canonical")
    exact_keys(
        job,
        {"limits", "operation", "payload", "schema_id", "schema_version"},
        "job",
    )
    if job["schema_id"] != "penny.sca-vm-job.v1" or job["schema_version"] != 1:
        raise JobError("unsupported job schema")
    if job["operation"] not in (
        "health",
        "source_query",
        "graph_build",
        "graph_query",
        "application_test",
    ):
        raise JobError("unsupported operation")
    record(job["payload"], "job payload")
    limits = record(job["limits"], "job limits")
    exact_keys(limits, {"max_output_bytes", "max_result_items"}, "job limits")
    integer(limits["max_output_bytes"], "maximum output bytes", 1, MAX_OUTPUT_BYTES)
    integer(limits["max_result_items"], "maximum result items", 1, MAX_RESULT_ITEMS)
    return job, sha256(content)


def admitted_file(value: object, maximum_bytes: int = MAX_FILE_BYTES) -> tuple[str, bytes]:
    declaration = record(value, "file declaration")
    exact_keys(
        declaration,
        {"asset_path", "byte_length", "content_sha256", "path"},
        "file declaration",
    )
    source_path = relative_path(declaration["path"], "source path")
    asset_path = relative_path(declaration["asset_path"], "asset path")
    expected_bytes = integer(declaration["byte_length"], "file byte length", 0, maximum_bytes)
    expected_sha = text(declaration["content_sha256"], "file SHA256", 64)
    if not SHA256.fullmatch(expected_sha):
        raise JobError("invalid file SHA256")
    full_path = JOB_MOUNT.joinpath(*asset_path.split("/"))
    descriptor = os.open(full_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size != expected_bytes
        ):
            raise JobError("file metadata mismatch")
        content = os.read(descriptor, expected_bytes + 1)
        after = os.fstat(descriptor)
        if (
            len(content) != expected_bytes
            or after.st_ino != before.st_ino
            or after.st_size != before.st_size
            or sha256(content) != expected_sha
        ):
            raise JobError("file content mismatch")
    finally:
        os.close(descriptor)
    return source_path, content


def source_files(payload: Mapping[str, object]) -> dict[str, bytes]:
    raw_files = payload.get("files")
    if not isinstance(raw_files, list) or not 1 <= len(raw_files) <= MAX_RESULT_ITEMS:
        raise JobError("invalid source files")
    result: dict[str, bytes] = {}
    total = 0
    for value in raw_files:
        source_path, content = admitted_file(value)
        if source_path in result:
            raise JobError("duplicate source path")
        total += len(content)
        if total > MAX_SOURCE_BYTES:
            raise JobError("source bytes exceed limit")
        result[source_path] = content
    return result


def selector(value: object) -> tuple[str, int | None, int | None, str | None]:
    item = record(value, "selector")
    exact_keys(item, {"end_line_exclusive", "path", "start_line", "symbol"}, "selector")
    source_path = relative_path(item["path"], "selector path")
    start_value = item["start_line"]
    end_value = item["end_line_exclusive"]
    symbol_value = item["symbol"]
    if (start_value is None) != (end_value is None):
        raise JobError("incomplete line range")
    start = None if start_value is None else integer(start_value, "start line", 1, 10_000_000)
    end = None if end_value is None else integer(end_value, "end line", 2, 10_000_001)
    if start is not None and end is not None and end <= start:
        raise JobError("invalid line range")
    symbol = None if symbol_value is None else text(symbol_value, "selector symbol", 256)
    return source_path, start, end, symbol


def query_parameters(value: object) -> None:
    if not isinstance(value, list) or len(value) > 1:
        raise JobError("invalid query parameters")
    if not value:
        return
    parameter = record(value[0], "query parameter")
    exact_keys(parameter, {"name", "value"}, "query parameter")
    setting = record(parameter["value"], "query parameter value")
    exact_keys(setting, {"kind", "value"}, "query parameter value")
    if (
        parameter["name"] != "case_sensitive"
        or setting["kind"] != "boolean"
        or setting["value"] is not True
    ):
        raise JobError("unsupported query parameter")


def execute_source_query(payload: Mapping[str, object], max_items: int) -> bytes:  # noqa: C901
    exact_keys(payload, {"files", "query"}, "source query payload")
    files = source_files(payload)
    query = record(payload["query"], "source query")
    exact_keys(query, {"parameters", "query_id", "selectors"}, "source query")
    query_id = text(query["query_id"], "query ID", 128)
    query_parameters(query["parameters"])
    raw_selectors = query["selectors"]
    if not isinstance(raw_selectors, list) or not 1 <= len(raw_selectors) <= 32:
        raise JobError("invalid selectors")
    items: list[dict[str, object]] = []
    for raw_selector in raw_selectors:
        source_path, start, end, symbol = selector(raw_selector)
        content = files.get(source_path)
        if content is None:
            raise JobError("selector path is not admitted")
        try:
            source_text = content.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise JobError("selected source is not UTF-8") from exc
        trailing_newline = source_text.endswith("\n")
        parts = source_text.split("\n")
        if trailing_newline:
            parts.pop()
        lines = [
            f"{line}\n" if index < len(parts) - 1 or trailing_newline else line
            for index, line in enumerate(parts)
        ]
        first = start or 1
        last = min((end or len(lines) + 1) - 1, len(lines))
        selected = "".join(lines[first - 1 : last])
        if symbol is not None:
            matching = [
                (index, line)
                for index, line in enumerate(lines, start=1)
                if symbol in line and first <= index <= last
            ]
            for line_number, line in matching:
                items.append(
                    {
                        "content_sha256": sha256(content),
                        "end_line_exclusive": line_number + 1,
                        "path": source_path,
                        "start_line": line_number,
                        "text": line,
                    }
                )
        elif selected:
            items.append(
                {
                    "content_sha256": sha256(content),
                    "end_line_exclusive": last + 1,
                    "path": source_path,
                    "start_line": first,
                    "text": selected,
                }
            )
        if len(items) > max_items:
            raise JobError("result item limit exceeded")
    return canonical_json(
        {
            "complete": True,
            "authority": "guest_claim",
            "items": items,
            "query_id": query_id,
            "schema_id": "penny.sca-source-query-result.v1",
            "schema_version": 1,
        }
    )


def joern_environment() -> dict[str, str]:
    jre = JOERN_ROOT.parent / "jre"
    return {
        "HOME": str(WORK_ROOT),
        "JAVA_HOME": str(jre),
        "LANG": "C.UTF-8",
        "PATH": f"{jre / 'bin'}:/usr/bin:/bin",
    }


def run_joern(argv: list[str], timeout: int) -> bytes:
    completed = subprocess.run(
        argv,
        cwd=WORK_ROOT,
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        env=joern_environment(),
    )
    if completed.returncode != 0 or len(completed.stdout) > 1024 * 1024:
        raise JobError("Joern execution failed")
    return completed.stdout


def joern_cli_package_listing(root: Path = JOERN_ROOT) -> tuple[str, str]:
    matches: list[str] = []
    for candidate in root.rglob("io.joern.joern-cli-*.jar"):
        details = candidate.lstat()
        if stat.S_ISREG(details.st_mode) and not candidate.is_symlink():
            matches.append(candidate.name)
    matches.sort()
    if len(matches) != 1 or len(matches[0].encode("utf-8")) > 4096:
        raise JobError("Joern package listing check failed")
    parsed = JOERN_CLI_PACKAGE.fullmatch(matches[0])
    if parsed is None or parsed.group(1) != JOERN_VERSION:
        raise JobError("Joern package listing check failed")
    return matches[0] + "\n", parsed.group(1)


def stage_sources(payload: Mapping[str, object]) -> tuple[Path, int]:
    files = source_files(payload)
    source_root = WORK_ROOT / "source"
    source_root.mkdir(mode=0o700, parents=True)
    for source_path, content in files.items():
        target = source_root.joinpath(*source_path.split("/"))
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(
            target,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        try:
            os.write(descriptor, content)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return source_root, len(files)


def execute_graph_build(
    payload: Mapping[str, object], max_output_bytes: int
) -> list[OutputPayload]:
    exact_keys(payload, {"files", "language", "max_num_def"}, "graph build payload")
    max_num_def = integer(payload["max_num_def"], "maximum definitions", 1, 1_000_000)
    language = text(payload["language"], "graph language", 32)
    allowed_extensions = {
        "jssrc": (".js", ".jsx", ".mjs", ".ts", ".tsx"),
        "php": (".php",),
    }
    if language not in allowed_extensions:
        raise JobError("unsupported graph language")
    source_root, file_count = stage_sources(payload)
    staged_files = [path for path in source_root.rglob("*") if path.is_file()]
    if not staged_files or any(
        path.suffix.lower() not in allowed_extensions[language] for path in staged_files
    ):
        raise JobError("source files do not match graph language")
    graph_path = WORK_ROOT / "graph.cpg.bin"
    run_joern(
        [
            str(JOERN_ROOT / "joern-parse"),
            str(source_root),
            "--output",
            str(graph_path),
            "--language",
            language,
            "--max-num-def",
            str(max_num_def),
        ],
        900,
    )
    descriptor = os.open(graph_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or not 1 <= details.st_size <= max_output_bytes:
            raise JobError("graph output exceeds limit")
        graph = os.read(descriptor, details.st_size + 1)
        if len(graph) != details.st_size:
            raise JobError("graph output changed")
    finally:
        os.close(descriptor)
    metadata = canonical_json(
        {
            "byte_length": len(graph),
            "content_sha256": sha256(graph),
            "file_count": file_count,
            "language": language,
            "schema_id": "penny.sca-graph-build-metadata.v1",
            "schema_version": 1,
        }
    )
    if len(graph) + len(metadata) > max_output_bytes:
        raise JobError("aggregate graph output exceeds limit")
    return [
        OutputPayload(
            name="graph.cpg.bin",
            media_type="application/vnd.penny.joern-cpg",
            schema_id="penny.sca-joern-cpg.v1",
            content=graph,
        ),
        OutputPayload(
            name="metadata.json",
            media_type="application/json",
            schema_id="penny.sca-graph-build-metadata.v1",
            content=metadata,
        ),
    ]


INVENTORY_SCRIPT = """import io.shiftleft.semanticcpg.language.*
import java.nio.file.{Files, Paths}
import java.nio.charset.StandardCharsets
import java.util.Base64
@main def exec(cpgFile: String, outFile: String, pathsBase64: String, maxRows: Int) = {
  importCpg(cpgFile)
  val decoder = Base64.getDecoder
  val encoder = Base64.getEncoder
  val paths = String(decoder.decode(pathsBase64), StandardCharsets.UTF_8).split("\\n").toSet
  def b(s: String): String = encoder.encodeToString(s.getBytes(StandardCharsets.UTF_8))
  def normalized(s: String): String = {
    val marker = "/source/"
    val index = s.lastIndexOf(marker)
    if (index >= 0) s.substring(index + marker.length) else s
  }
  val lines = scala.collection.mutable.ArrayBuffer.empty[String]
  cpg.graph.allNodes.foreach { n =>
    def prop(k: String): String = Option(n.propertiesMap.get(k)).map(_.toString).getOrElse("")
    val file = normalized(prop("FILENAME"))
    if (paths.contains(file)) {
      lines += (n.id.toString + "\\t" + b(n.label) + "\\t" + b(file) + "\\t" +
        b(prop("LINE_NUMBER")) + "\\t" + b(prop("NAME")) + "\\t" + b(prop("FULL_NAME")))
      if (lines.size > maxRows) throw new IllegalStateException("inventory row limit")
    }
  }
  Files.write(Paths.get(outFile), lines.mkString("\\n").getBytes(StandardCharsets.UTF_8))
}
"""


def decode_inventory_field(value: str) -> str:
    import base64

    if not re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value):
        raise JobError("invalid graph inventory")
    try:
        decoded = base64.b64decode(value, validate=True)
        result = decoded.decode("utf-8", errors="strict")
    except (ValueError, UnicodeDecodeError) as exc:
        raise JobError("invalid graph inventory") from exc
    if base64.b64encode(decoded).decode("ascii") != value:
        raise JobError("invalid graph inventory")
    return result


def graph_declaration(payload: Mapping[str, object]) -> bytes:
    graph = payload.get("graph")
    _, content = admitted_file(graph, MAX_OUTPUT_BYTES)
    if not content:
        raise JobError("empty graph")
    return content


def execute_graph_query(payload: Mapping[str, object], max_items: int) -> bytes:
    exact_keys(payload, {"graph", "query"}, "graph query payload")
    query = record(payload["query"], "graph query")
    exact_keys(query, {"parameters", "query_id", "selectors"}, "graph query")
    query_id = text(query["query_id"], "query ID", 128)
    query_parameters(query["parameters"])
    raw_selectors = query["selectors"]
    if not isinstance(raw_selectors, list) or not 1 <= len(raw_selectors) <= 32:
        raise JobError("invalid selectors")
    selectors = [selector(value) for value in raw_selectors]
    paths = sorted({item[0] for item in selectors})
    graph = graph_declaration(payload)
    WORK_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    graph_path = WORK_ROOT / "input.cpg.bin"
    graph_path.write_bytes(graph)
    graph_path.chmod(0o600)
    script_path = WORK_ROOT / "inventory.sc"
    script_path.write_text(INVENTORY_SCRIPT, encoding="utf-8")
    script_path.chmod(0o400)
    inventory_path = WORK_ROOT / "inventory.tsv"
    import base64

    encoded_paths = base64.b64encode("\n".join(paths).encode("utf-8")).decode("ascii")
    run_joern(
        [
            str(JOERN_ROOT / "joern"),
            "--script",
            str(script_path),
            "--param",
            f"cpgFile={graph_path}",
            "--param",
            f"outFile={inventory_path}",
            "--param",
            f"pathsBase64={encoded_paths}",
            "--param",
            f"maxRows={max_items}",
        ],
        600,
    )
    inventory = inventory_path.read_bytes()
    if len(inventory) > 16 * 1024 * 1024:
        raise JobError("graph inventory exceeds limit")
    items: list[dict[str, object]] = []
    for row in inventory.decode("utf-8", errors="strict").splitlines():
        fields = row.split("\t")
        if len(fields) != 6 or not fields[0].isdigit():
            raise JobError("invalid graph inventory")
        label, file_name, line_text, name, full_name = [
            decode_inventory_field(value) for value in fields[1:]
        ]
        line_number = int(line_text) if line_text.isdigit() else None
        matching = [item for item in selectors if item[0] == file_name]
        if not matching:
            continue
        include = any(
            (start is None or (line_number is not None and start <= line_number < (end or start)))
            and (symbol is None or symbol in name or symbol in full_name)
            for _, start, end, symbol in matching
        )
        if include:
            items.append(
                {
                    "file_name": file_name,
                    "full_name": full_name,
                    "label": label,
                    "line_number": line_number,
                    "name": name,
                    "node_id": fields[0],
                }
            )
        if len(items) > max_items:
            raise JobError("graph result item limit exceeded")
    return canonical_json(
        {
            "complete": True,
            "authority": "guest_claim",
            "items": items,
            "query_id": query_id,
            "schema_id": "penny.sca-graph-query-result.v1",
            "schema_version": 1,
        }
    )


def execute_application_test(payload: Mapping[str, object]) -> bytes:
    exact_keys(payload, {"files", "test"}, "application test payload")
    test = record(payload["test"], "application test")
    exact_keys(test, {"test_id"}, "application test")
    test_id = text(test["test_id"], "application test ID", 128)
    source_root, _ = stage_sources(payload)
    if test_id == "php.syntax.v1":
        files = sorted(path for path in source_root.rglob("*") if path.is_file())
        if not files or any(path.suffix.lower() != ".php" for path in files):
            raise JobError("invalid PHP syntax test inputs")
        items = []
        for path in files:
            completed = subprocess.run(
                ["/usr/bin/php", "-n", "-l", str(path)],
                cwd=WORK_ROOT,
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=30,
                env={"HOME": str(WORK_ROOT), "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"},
            )
            if completed.returncode != 0 or len(completed.stdout) > 64 * 1024:
                raise JobError("PHP syntax test failed")
            items.append({"path": str(path.relative_to(source_root)), "passed": True})
    elif test_id == "jssrc.parse.v1":
        files = sorted(path for path in source_root.rglob("*") if path.is_file())
        if not files or any(
            path.suffix.lower() not in (".js", ".jsx", ".mjs", ".ts", ".tsx") for path in files
        ):
            raise JobError("invalid JavaScript syntax test inputs")
        graph_path = WORK_ROOT / "test.cpg.bin"
        run_joern(
            [
                str(JOERN_ROOT / "joern-parse"),
                str(source_root),
                "--output",
                str(graph_path),
                "--language",
                "jssrc",
                "--max-num-def",
                "4000",
            ],
            600,
        )
        if not graph_path.is_file() or graph_path.stat().st_size == 0:
            raise JobError("JavaScript syntax test failed")
        items = [{"path": str(path.relative_to(source_root)), "passed": True} for path in files]
    else:
        raise JobError("application test is not enabled")
    return canonical_json(
        {
            "complete": True,
            "authority": "guest_claim",
            "items": items,
            "passed": True,
            "schema_id": "penny.sca-application-test-result.v1",
            "schema_version": 1,
            "test_id": test_id,
        }
    )


def execute_health(payload: Mapping[str, object]) -> bytes:
    exact_keys(payload, set(), "health payload")
    package_listing, _version = joern_cli_package_listing()
    help_output = run_joern([str(JOERN_ROOT / "joern"), "--help"], 120)
    if (
        not help_output.startswith(b"Usage: joern [options] [<cpg.bin>]\n")
        or b"Unknown option" in help_output
        or b"\0" in help_output
        or len(help_output) > 64 * 1024
    ):
        raise JobError("Joern launcher check failed")
    interfaces = sorted(entry.name for entry in Path("/sys/class/net").iterdir())
    cpu_flags = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="strict")
    return canonical_json(
        {
            "cpu_virtualization_flags_masked": " vmx " not in f" {cpu_flags} "
            and " svm " not in f" {cpu_flags} ",
            "joern_output": package_listing,
            "network_interfaces": interfaces,
            "schema_id": "penny.sca-vm-health.v1",
            "schema_version": 1,
        }
    )


def execute(job: Mapping[str, object]) -> list[OutputPayload]:
    limits = record(job["limits"], "job limits")
    max_output_bytes = integer(
        limits["max_output_bytes"], "maximum output bytes", 1, MAX_OUTPUT_BYTES
    )
    max_result_items = integer(
        limits["max_result_items"], "maximum result items", 1, MAX_RESULT_ITEMS
    )
    payload = record(job["payload"], "job payload")
    operation = job["operation"]
    if operation == "graph_build":
        return execute_graph_build(payload, max_output_bytes)
    if operation == "health":
        content = execute_health(payload)
        schema_id = "penny.sca-vm-health.v1"
    elif operation == "source_query":
        content = execute_source_query(payload, max_result_items)
        schema_id = "penny.sca-source-query-result.v1"
    elif operation == "graph_query":
        content = execute_graph_query(payload, max_result_items)
        schema_id = "penny.sca-graph-query-result.v1"
    elif operation == "application_test":
        content = execute_application_test(payload)
        schema_id = "penny.sca-application-test-result.v1"
    else:
        raise JobError("operation is not enabled in this guest build")
    if len(content) > max_output_bytes:
        raise JobError("output byte limit exceeded")
    return [
        OutputPayload(
            name="result.json",
            media_type="application/json",
            schema_id=schema_id,
            content=content,
        )
    ]


def cleanup() -> None:
    if JOB_MOUNT.is_mount():
        subprocess.run(
            ["/usr/bin/umount", str(JOB_MOUNT)],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    shutil.rmtree(WORK_ROOT, ignore_errors=True)


def main() -> int:
    output_device: Path | None = None
    job_digest = "0" * 64
    try:
        mount_job()
        job, job_digest = read_canonical_job()
        output_device = resolve_block(OUTPUT_LINK, "output device")
        payloads = execute(job)
        write_envelope(
            output_device,
            job_sha256=job_digest,
            status="succeeded",
            error_code=None,
            outputs=payloads,
        )
        print("PENNY_SCA_JOB_SUCCEEDED", flush=True)
        return 0
    except (JobError, OSError, subprocess.SubprocessError) as exc:
        if output_device is not None:
            try:
                write_envelope(
                    output_device,
                    job_sha256=job_digest,
                    status="failed",
                    error_code="guest_job_failed",
                    outputs=[],
                )
            except (OSError, ValueError):
                pass
        reason = str(exc) if isinstance(exc, JobError) else "guest runtime error"
        print(f"PENNY_SCA_JOB_FAILED:{reason}", file=sys.stderr, flush=True)
        return 1
    finally:
        cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
