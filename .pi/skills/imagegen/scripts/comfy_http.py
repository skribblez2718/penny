#!/usr/bin/env python3
"""comfy_http — the imagegen skill's shared, hardened ComfyUI HTTP client.

Stdlib-only (``urllib`` / ``json`` / ``uuid`` — no third-party HTTP dependency).
Every network primitive the imagegen playbook needs lives here behind three
non-negotiable security guards, each of which is unit-tested with a fuzz set:

  * **SSRF (host allow-list).** A ``ComfyClient`` is pinned at construction to an
    allow-list that defaults to exactly ``{"127.0.0.1:8188"}``. Every request
    re-validates the host against that set AND asserts the hostname is a loopback
    literal, and redirects are refused — so no constructed request can ever target
    a non-127.0.0.1 host (the SSRF invariant). Tests inject their own loopback
    ``127.0.0.1:<test-port>`` into the allow-list to exercise a real local server;
    production keeps the locked default.
  * **Path traversal (/view).** ``validate_view_component`` rejects ``..``
    segments, a leading ``/`` or ``\\``, a null byte, and Windows-drive absolutes
    on the ``filename`` / ``subfolder`` params before they are urlencoded, and the
    ``type`` param is restricted to a known enum. The ``prompt_id`` used to build a
    ``/history/{id}`` path is likewise restricted to a safe token.
  * **Injection.** The ``/prompt`` body is built as a Python ``dict`` and
    ``json.dumps``-ed exactly once — user prompt text is never concatenated into a
    JSON string.

Graph construction (``build_graph``) is a pure, deterministic function so the same
``preset + prompt + seed + settings`` always yields a byte-identical constructed
graph (the manifest reproducibility guarantee).
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: The ONLY host a production imagegen run may ever talk to. Locked default.
DEFAULT_COMFY_HOST = "127.0.0.1:8188"
DEFAULT_ALLOWED_HOSTS: frozenset[str] = frozenset({DEFAULT_COMFY_HOST})

#: Loopback host literals accepted by the defense-in-depth hostname check. Kept
#: strict (IPv4 loopback literal only) so a widened allow-list still cannot point
#: at a routable host by accident.
_LOOPBACK_HOSTS: frozenset[str] = frozenset({"127.0.0.1"})

#: /view ``type`` is a fixed ComfyUI enum — never free text.
_VIEW_TYPES: frozenset[str] = frozenset({"output", "input", "temp"})

#: A server-issued prompt_id is a UUID; validate before it lands in a URL path.
_PROMPT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

#: Composed prompts are capped so an oversized payload never reaches the graph.
MAX_PROMPT_CHARS = 4000

#: Candidate count is clamped to protect the single-GPU queue (resource limit).
MAX_CANDIDATES = 10

# Per-request timeouts (seconds) — no request is unbounded, so a dead ComfyUI
# fails fast instead of hanging (the "0 silent hangs" guarantee).
_TIMEOUT_STATS = 5
_TIMEOUT_QUEUE = 5
_TIMEOUT_OBJECT_INFO = 30
_TIMEOUT_SUBMIT = 30
_TIMEOUT_HISTORY = 10
_TIMEOUT_VIEW = 120


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ComfyError(Exception):
    """Base class for every comfy_http failure."""


class ComfyHostNotAllowed(ComfyError, ValueError):
    """A host outside the allow-list (or a non-loopback host) was requested."""


class ComfyPathError(ComfyError, ValueError):
    """A /view or /history path component failed traversal validation."""


class ComfyUnreachable(ComfyError):
    """ComfyUI could not be reached (connection refused / timeout / redirect)."""


class ComfySubmitError(ComfyError):
    """A /prompt submission was rejected (bad graph / missing model file)."""


# ---------------------------------------------------------------------------
# Preset field maps + graph construction (pure, deterministic)
# ---------------------------------------------------------------------------

PRESETS: tuple[str, ...] = (
    "blog-flux-steampunk",
    "learning-qwen",
    "hero-flux",
    "general-flux",
)

# Node-id/field addresses for the knobs the skill overrides, per preset. Keeping
# this here (not string-built in the playbook) is what makes graph construction a
# pure function of (preset, prompt, seed, settings).
PRESET_FIELDS: dict[str, dict[str, Any]] = {
    "blog-flux-steampunk": {
        "positive": ("3", "text"),
        "negative": ("4", "text"),
        "seed": ("7", "seed"),
        "steps": ("7", "steps"),
        "width": ("6", "width"),
        "height": ("6", "height"),
        "batch_size": ("6", "batch_size"),
        "filename_prefix": ("9", "filename_prefix"),
        "lora_node": "2",  # LoraLoader — removed + rewired to checkpoint on fallback
    },
    "learning-qwen": {
        "positive": ("4", "text"),
        "negative": ("5", "text"),
        "seed": ("7", "seed"),
        "steps": ("7", "steps"),
        "width": ("6", "width"),
        "height": ("6", "height"),
        "batch_size": ("6", "batch_size"),
        "filename_prefix": ("9", "filename_prefix"),
    },
    "hero-flux": {
        "positive": ("3", "text"),
        "negative": ("4", "text"),
        "seed": ("7", "seed"),
        "steps": ("7", "steps"),
        "width": ("6", "width"),
        "height": ("6", "height"),
        "batch_size": ("6", "batch_size"),
        "filename_prefix": ("9", "filename_prefix"),
    },
    "general-flux": {
        "positive": ("3", "text"),
        "negative": ("4", "text"),
        "seed": ("7", "seed"),
        "steps": ("7", "steps"),
        "width": ("6", "width"),
        "height": ("6", "height"),
        "batch_size": ("6", "batch_size"),
        "filename_prefix": ("9", "filename_prefix"),
    },
}

# Model files each preset REQUIRES to be present in ComfyUI. The steampunk LoRA is
# deliberately NOT required — it is the one optional dependency (fallback path).
PRESET_REQUIRED_MODELS: dict[str, tuple[str, ...]] = {
    "blog-flux-steampunk": ("flux1-dev-fp8.safetensors",),
    "learning-qwen": (
        "qwen_image_fp8_e4m3fn.safetensors",
        "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "qwen_image_vae.safetensors",
    ),
    "hero-flux": ("flux1-dev-fp8.safetensors",),
    "general-flux": ("flux1-dev-fp8.safetensors",),
}

# The optional LoRA per preset (missing -> WARN + fall back to base, never fail).
PRESET_OPTIONAL_MODELS: dict[str, tuple[str, ...]] = {
    "blog-flux-steampunk": ("steampunk_illustration.safetensors",),
    "learning-qwen": (),
    "hero-flux": (),
    "general-flux": (),
}


def presets_dir() -> Path:
    """Absolute path to the shipped ``resources/presets`` directory."""
    return Path(__file__).resolve().parent.parent / "resources" / "presets"


def load_preset(preset: str, base_dir: str | Path | None = None) -> dict:
    """Load a preset's ``*.api.json`` graph as a dict. ``preset`` is validated
    against the known set so it can never be used to traverse the filesystem."""
    if preset not in PRESET_FIELDS:
        raise ComfyError(f"unknown preset '{preset}' (known: {', '.join(PRESETS)})")
    directory = Path(base_dir) if base_dir is not None else presets_dir()
    path = directory / f"{preset}.api.json"
    with open(path, encoding="utf-8") as handle:
        graph = json.load(handle)
    if not isinstance(graph, dict):
        raise ComfyError(f"preset '{preset}' is not a valid graph object")
    return graph


def clamp_candidate_count(count: Any, default: int = 3) -> tuple[int, str | None]:
    """Clamp a requested candidate count into ``[1, MAX_CANDIDATES]``.

    Returns ``(clamped, warning_or_None)``. A request above the max is clamped
    (not rejected) with a warning; a non-positive / non-int request falls back to
    ``default``.
    """
    try:
        value = int(count)
    except (TypeError, ValueError):
        return default, None
    if value < 1:
        return default, None
    if value > MAX_CANDIDATES:
        return MAX_CANDIDATES, (
            f"requested {value} candidates; clamped to the max of {MAX_CANDIDATES}"
        )
    return value, None


def cap_prompt(text: Any) -> tuple[str, str | None]:
    """Enforce the ``MAX_PROMPT_CHARS`` cap. Returns ``(text, warning_or_None)``;
    an over-length prompt is truncated (never passed through to the graph)."""
    value = "" if text is None else str(text)
    if len(value) > MAX_PROMPT_CHARS:
        return value[:MAX_PROMPT_CHARS], (
            f"composed prompt exceeded {MAX_PROMPT_CHARS} chars; truncated"
        )
    return value, None


def _apply_field_overrides(graph: dict, fields: dict, overrides: dict) -> None:
    """Set each ``{knob: value}`` override onto its mapped node input, skipping
    knobs the preset doesn't expose or whose node is absent."""
    for knob, value in overrides.items():
        addr = fields.get(knob)
        if not addr:
            continue
        node_id, field = addr
        if node_id in graph:
            graph[node_id]["inputs"][field] = value


def _disable_lora(graph: dict, fields: dict) -> None:
    """Remove the LoRA node and rewire its consumers to the LoRA's upstream
    model/clip sources, so a preset degrades cleanly to its base model when the
    LoRA file is absent.

    Zeroing strength is NOT sufficient: ComfyUI validates ``lora_name`` against
    the installed-LoRA list at submit time and rejects an absent name with a 400
    regardless of strength. The node must be removed from the submitted graph.
    """
    lora_node = fields.get("lora_node")
    if not lora_node or lora_node not in graph:
        return
    inputs = graph[lora_node].get("inputs", {})
    # LoraLoader output slots: 0=MODEL, 1=CLIP. Reconnect consumers straight to
    # the LoRA's own upstream sources (typically the checkpoint loader).
    upstream = {0: inputs.get("model"), 1: inputs.get("clip")}
    for other_id, other in graph.items():
        if other_id == lora_node:
            continue
        for field, value in other.get("inputs", {}).items():
            if (
                isinstance(value, list)
                and len(value) == 2
                and str(value[0]) == str(lora_node)
                and upstream.get(value[1]) is not None
            ):
                other["inputs"][field] = upstream[value[1]]
    del graph[lora_node]


def build_graph(
    preset: str,
    *,
    positive: str,
    negative: str | None = None,
    seed: int,
    width: int | None = None,
    height: int | None = None,
    steps: int | None = None,
    lora_fallback: bool = False,
    filename_prefix: str | None = None,
    base_dir: str | Path | None = None,
) -> dict:
    """Construct a submit-ready ComfyUI graph from a preset + overrides.

    Pure and deterministic: identical inputs always yield a byte-identical graph
    (see ``graph_hash``). ``batch_size`` is pinned to 1 — the skill submits one
    candidate at a time and NEVER batches multiple candidates into a single graph
    (the "no concurrent candidates" invariant). A missing steampunk LoRA is
    handled by ``lora_fallback=True``, which REMOVES the LoRA node and rewires its
    consumers to the checkpoint so the graph degrades to base FLUX instead of
    referencing an absent file (which ComfyUI would reject at submit time).
    """
    fields = PRESET_FIELDS[preset]  # KeyError-safe: load_preset validated membership
    graph = copy.deepcopy(load_preset(preset, base_dir))

    # Batch stays 1 — one candidate per graph, always.
    overrides: dict[str, Any] = {
        "positive": cap_prompt(positive)[0],
        "seed": int(seed),
        "batch_size": 1,
    }
    if negative is not None:
        overrides["negative"] = cap_prompt(negative)[0]
    if filename_prefix is not None:
        overrides["filename_prefix"] = str(filename_prefix)
    for knob, raw in (("width", width), ("height", height), ("steps", steps)):
        if raw is not None:
            overrides[knob] = int(raw)

    _apply_field_overrides(graph, fields, overrides)
    if lora_fallback:
        _disable_lora(graph, fields)
    return graph


def graph_hash(graph: dict) -> str:
    """Stable SHA-256 of a constructed graph (canonical JSON). Two graphs with the
    same content hash identically regardless of key insertion order — the
    reproducibility oracle used by the provenance manifest."""
    canonical = json.dumps(graph, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def typed_value(raw: str) -> Any:
    """Auto-type a CLI override value: int, then float, else the raw string."""
    for cast in (int, float):
        try:
            return cast(raw)
        except (ValueError, TypeError):
            continue
    return raw


def parse_set_override(item: str) -> tuple[str, str, Any]:
    """Parse one ``NODE_ID.field=value`` override into ``(node_id, field,
    typed_value)``. Raises ``ComfyError`` on a malformed spec so a bad ``--set``
    fails loudly instead of silently no-op'ing."""
    key, sep, val = item.partition("=")
    if not sep:
        raise ComfyError(f"--set '{item}' must be NODE.field=value")
    node_id, dot, field = key.partition(".")
    if not dot or not node_id or not field:
        raise ComfyError(f"--set key '{key}' must be NODE.field")
    return node_id, field, typed_value(val)


def apply_set_overrides(graph: dict, overrides: Iterable[str]) -> dict:
    """Apply validated ``NODE.field=value`` overrides to a graph in place.

    Each override is parsed + type-checked and the target node MUST already exist
    in the graph (an unknown node id is rejected, never created) — so a typo can
    never inject a new node. Values land as dict entries under ``inputs``; nothing
    is string-concatenated into the payload.
    """
    for item in overrides:
        node_id, field, value = parse_set_override(item)
        if node_id not in graph:
            raise ComfyError(f"--set node '{node_id}' not in graph")
        graph[node_id].setdefault("inputs", {})[field] = value
    return graph


# ---------------------------------------------------------------------------
# Security validators
# ---------------------------------------------------------------------------


def validate_host(host: str, allowed: Iterable[str] | None = None) -> str:
    """Validate ``host`` against the allow-list AND assert it is a loopback
    literal. Raises ``ComfyHostNotAllowed`` on any deviation. This is the single
    SSRF choke point — both the constructor and every request go through it."""
    allowed_set = frozenset(allowed) if allowed is not None else DEFAULT_ALLOWED_HOSTS
    if not isinstance(host, str) or host not in allowed_set:
        raise ComfyHostNotAllowed(
            f"host '{host}' is not in the allow-list {sorted(allowed_set)} — "
            "imagegen only ever talks to a pinned loopback ComfyUI"
        )
    hostname = host.rsplit(":", 1)[0]
    if hostname not in _LOOPBACK_HOSTS:
        raise ComfyHostNotAllowed(
            f"host '{host}' resolves to non-loopback '{hostname}' — refused (SSRF guard)"
        )
    return host


def validate_view_component(value: Any, *, field: str) -> str:
    """Reject any /view path component that could escape the ComfyUI output root.

    Blocks: null bytes, a leading ``/`` or ``\\`` (absolute), Windows drive
    absolutes (``C:\\``), and any ``..`` path segment. An empty ``subfolder`` is
    valid; an empty ``filename`` is not.
    """
    if not isinstance(value, str):
        raise ComfyPathError(f"/view {field} must be a string, got {type(value).__name__}")
    if "\x00" in value:
        raise ComfyPathError(f"/view {field} contains a null byte")
    if value.startswith("/") or value.startswith("\\"):
        raise ComfyPathError(f"/view {field} must be relative, got absolute '{value}'")
    if re.match(r"^[A-Za-z]:", value):
        raise ComfyPathError(f"/view {field} looks like a Windows-absolute path '{value}'")
    segments = re.split(r"[\\/]+", value)
    if any(segment == ".." for segment in segments):
        raise ComfyPathError(f"/view {field} contains a '..' traversal segment: '{value}'")
    return value


def validate_prompt_id(prompt_id: Any) -> str:
    """A prompt_id lands in a ``/history/{id}`` URL path — restrict it to a safe
    token so it can never inject additional path segments or a query."""
    if not isinstance(prompt_id, str) or not _PROMPT_ID_RE.match(prompt_id):
        raise ComfyPathError(f"unsafe prompt_id: {prompt_id!r}")
    return prompt_id


# ---------------------------------------------------------------------------
# Model inventory (readiness helper)
# ---------------------------------------------------------------------------

_MODEL_ENUM_FIELDS: tuple[tuple[str, str], ...] = (
    ("CheckpointLoaderSimple", "ckpt_name"),
    ("LoraLoader", "lora_name"),
    ("LoraLoaderModelOnly", "lora_name"),
    ("UNETLoader", "unet_name"),
    ("CLIPLoader", "clip_name"),
    ("VAELoader", "vae_name"),
)


def extract_model_filenames(object_info: dict) -> set[str]:
    """Flatten every model filename ComfyUI advertises in ``/object_info`` loader
    enums into one set — used to check a preset's required/optional model files
    are actually installed."""
    found: set[str] = set()
    if not isinstance(object_info, dict):
        return found
    for node_type, field in _MODEL_ENUM_FIELDS:
        node = object_info.get(node_type)
        if not isinstance(node, dict):
            continue
        required = (node.get("input") or {}).get("required") or {}
        spec = required.get(field)
        # ComfyUI encodes an enum as [[opt, opt, ...], {...}] or [[...]].
        if isinstance(spec, list) and spec and isinstance(spec[0], list):
            found.update(str(opt) for opt in spec[0])
    return found


# ---------------------------------------------------------------------------
# The hardened HTTP client
# ---------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse all redirects — a redirect to another host would defeat the SSRF
    allow-list, so we treat any 3xx as an error."""

    def redirect_request(
        self, req: Any, fp: Any, code: Any, msg: Any, headers: Any, newurl: Any
    ) -> Any:
        raise ComfyUnreachable(f"refused redirect to '{newurl}' (SSRF guard)")


class ComfyClient:
    """A ComfyUI HTTP client pinned to a loopback host allow-list.

    All eight endpoints the skill uses (``/system_stats``, ``/queue``,
    ``/object_info``, ``/prompt``, ``/history/{id}``, ``/view``) route through
    ``_get`` / ``_post`` / ``_get_bytes``, which re-validate the host on every call
    and refuse redirects. Nothing here retains image bytes beyond the caller's
    request (``download_image`` streams straight to a file path).
    """

    def __init__(
        self, host: str = DEFAULT_COMFY_HOST, *, allowed_hosts: Iterable[str] | None = None
    ) -> None:
        self.allowed_hosts = (
            frozenset(allowed_hosts) if allowed_hosts is not None else DEFAULT_ALLOWED_HOSTS
        )
        self.host = validate_host(host, self.allowed_hosts)
        self._opener = urllib.request.build_opener(_NoRedirect)

    # -- URL construction (host re-validated every time) -------------------
    def _url(self, path: str) -> str:
        validate_host(self.host, self.allowed_hosts)
        if not path.startswith("/"):
            path = "/" + path
        return f"http://{self.host}{path}"

    def _get(self, path: str, *, timeout: int) -> Any:
        req = urllib.request.Request(self._url(path), method="GET")
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise ComfyUnreachable(f"GET {path} failed: {exc}") from exc

    def _get_dict(self, path: str, *, timeout: int) -> dict:
        """A GET that must decode to a JSON object (defensive at the I/O boundary)."""
        data = self._get(path, timeout=timeout)
        if not isinstance(data, dict):
            raise ComfyError(f"GET {path} returned a non-object ({type(data).__name__})")
        return data

    def _get_bytes(self, path: str, *, timeout: int) -> bytes:
        req = urllib.request.Request(self._url(path), method="GET")
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                data: bytes = resp.read()
                return data
        except urllib.error.URLError as exc:
            raise ComfyUnreachable(f"GET {path} failed: {exc}") from exc

    def _post(self, path: str, payload: dict, *, timeout: int) -> Any:
        # Build a dict then json.dumps ONCE — user prompt text is a value in the
        # dict, never concatenated into the JSON string (injection guard).
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self._url(path),
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:500]
            except Exception:  # noqa: BLE001 - best-effort error detail
                detail = ""
            raise ComfySubmitError(f"POST {path} rejected ({exc.code}): {detail}") from exc
        except urllib.error.URLError as exc:
            raise ComfyUnreachable(f"POST {path} failed: {exc}") from exc

    # -- endpoints ---------------------------------------------------------
    def system_stats(self) -> dict:
        """GET /system_stats — the reachability + version probe (fail-fast)."""
        return self._get_dict("/system_stats", timeout=_TIMEOUT_STATS)

    def queue(self) -> dict:
        """GET /queue — current queue state (used for queue-safety waits)."""
        return self._get_dict("/queue", timeout=_TIMEOUT_QUEUE)

    def object_info(self) -> dict:
        """GET /object_info — node schemas incl. installed-model enums."""
        return self._get_dict("/object_info", timeout=_TIMEOUT_OBJECT_INFO)

    def submit(self, graph: dict, client_id: str | None = None) -> str:
        """POST /prompt — submit ONE graph, return its prompt_id. Raises
        ``ComfySubmitError`` on a 4xx (bad graph / missing model file)."""
        cid = client_id or str(uuid.uuid4())
        result = self._post("/prompt", {"prompt": graph, "client_id": cid}, timeout=_TIMEOUT_SUBMIT)
        prompt_id = (result or {}).get("prompt_id")
        if not prompt_id:
            raise ComfySubmitError("submit succeeded but returned no prompt_id")
        return validate_prompt_id(prompt_id)

    def history(self, prompt_id: str) -> dict:
        """GET /history/{prompt_id} — poll for completion + outputs."""
        safe = validate_prompt_id(prompt_id)
        return self._get_dict(f"/history/{safe}", timeout=_TIMEOUT_HISTORY)

    def view_bytes(self, *, filename: str, subfolder: str = "", type: str = "output") -> bytes:
        """GET /view?... — fetch a rendered PNG's bytes. Every component is
        traversal-validated and the query is urlencoded from a dict."""
        safe_filename = validate_view_component(filename, field="filename")
        if not safe_filename:
            raise ComfyPathError("/view filename must not be empty")
        safe_subfolder = validate_view_component(subfolder, field="subfolder")
        if type not in _VIEW_TYPES:
            raise ComfyPathError(f"/view type must be one of {sorted(_VIEW_TYPES)}, got '{type}'")
        query = urllib.parse.urlencode(
            {"filename": safe_filename, "subfolder": safe_subfolder, "type": type}
        )
        return self._get_bytes(f"/view?{query}", timeout=_TIMEOUT_VIEW)

    def download_image(self, *, filename: str, subfolder: str, type: str, dest: str | Path) -> str:
        """Fetch a rendered PNG and write it to ``dest`` (a file path). Returns the
        destination path. Only bytes-on-disk + a path leave this method — no image
        bytes are ever retained or logged."""
        data = self.view_bytes(filename=filename, subfolder=subfolder, type=type)
        dest_path = Path(dest)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_path, "wb") as handle:
            handle.write(data)
        return str(dest_path)
