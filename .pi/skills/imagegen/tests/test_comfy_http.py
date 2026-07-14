"""Tests for comfy_http — the hardened ComfyUI HTTP client.

Three layers:

1. **Pure-unit** — SSRF host allow-list, /view path-traversal fuzz set, prompt_id
   validation, deterministic graph construction (byte-identical reproduction),
   candidate-count clamp, prompt cap, and validated ``--set`` override parsing.
   No network.

2. **Real-server integration (server-startup Category 1 + 4)** — a real
   ``http.server`` mimicking the ComfyUI endpoints boots in a background thread on
   a loopback high port; ``ComfyClient`` (its own allow-list widened to that test
   port) drives the full submit -> poll -> fetch happy path over real HTTP. This
   is the honest "real server, real HTTP" test for this skill: the *server* it
   integrates with is the ComfyUI HTTP API, so we stand up a lightweight real one
   (heavy dep = the GPU model, replaced by a 1x1 PNG) and exercise the actual
   urllib code path — catching URL construction, redirect refusal, JSON encoding,
   and traversal-guard bugs that a pure mock cannot.

   (Category 2 — entry-point-script-from-its-own-dir — is covered in
   test_comfy_generate.py; Category 3 — CORS — is N/A, the ComfyUI API is a
   same-origin loopback service with no browser preflight.)
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import comfy_http as ch
import pytest

# ---------------------------------------------------------------------------
# SSRF — host allow-list
# ---------------------------------------------------------------------------


def test_default_host_is_the_locked_loopback():
    client = ch.ComfyClient()
    assert client.host == "127.0.0.1:8188"


@pytest.mark.parametrize(
    "host",
    [
        "evil.com:8188",
        "169.254.169.254:8188",  # cloud metadata
        "127.0.0.1:9999",  # right host, wrong port — not the pinned service
        "localhost:8188",  # not a loopback *literal* in the allow-list
        "10.0.0.5:8188",
        "127.0.0.1:8188@evil.com",
        "0.0.0.0:8188",
        "[::1]:8188",
    ],
)
def test_non_allowlisted_host_is_refused(host):
    with pytest.raises(ch.ComfyHostNotAllowed):
        ch.ComfyClient(host)


def test_widened_allowlist_still_enforces_loopback_literal():
    # Even if an allow-list is widened, a non-loopback hostname is refused.
    with pytest.raises(ch.ComfyHostNotAllowed):
        ch.ComfyClient("attacker.internal:8188", allowed_hosts={"attacker.internal:8188"})


def test_validate_host_accepts_loopback_test_port():
    assert ch.validate_host("127.0.0.1:18999", {"127.0.0.1:18999"}) == "127.0.0.1:18999"


# ---------------------------------------------------------------------------
# Path traversal — /view fuzz set
# ---------------------------------------------------------------------------

_TRAVERSAL_PAYLOADS = [
    "../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/shadow",
    "\\etc\\shadow",
    "foo/../../bar",
    "a/b/../../../etc/passwd",
    "C:\\Windows\\win.ini",
    "sub/../..",
    "img\x00.png",
    "..",
]


@pytest.mark.parametrize("payload", _TRAVERSAL_PAYLOADS)
def test_view_filename_rejects_traversal(payload):
    with pytest.raises(ch.ComfyPathError):
        ch.validate_view_component(payload, field="filename")


@pytest.mark.parametrize("payload", _TRAVERSAL_PAYLOADS)
def test_view_subfolder_rejects_traversal(payload):
    with pytest.raises(ch.ComfyPathError):
        ch.validate_view_component(payload, field="subfolder")


def test_view_accepts_clean_names():
    assert ch.validate_view_component("blog_steampunk_00001_.png", field="filename")
    assert ch.validate_view_component("blog", field="subfolder")
    assert ch.validate_view_component("", field="subfolder") == ""  # empty subfolder ok


@pytest.mark.parametrize("bad", ["../id", "a/b", "id;rm", "id?x=1", "id\x00", "", "a" * 200])
def test_prompt_id_validation_rejects_unsafe(bad):
    with pytest.raises(ch.ComfyPathError):
        ch.validate_prompt_id(bad)


def test_prompt_id_validation_accepts_uuid():
    assert ch.validate_prompt_id("2f1c9d3e-1a2b-4c5d-8e9f-0a1b2c3d4e5f")


# ---------------------------------------------------------------------------
# Deterministic graph construction (reproducibility oracle)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("preset", list(ch.PRESETS))
def test_build_graph_is_byte_identical_for_same_inputs(preset):
    kwargs = dict(positive="a wise owl", negative="", seed=777, width=1024, height=1024)
    g1 = ch.build_graph(preset, **kwargs)
    g2 = ch.build_graph(preset, **kwargs)
    assert ch.graph_hash(g1) == ch.graph_hash(g2)
    assert json.dumps(g1, sort_keys=True) == json.dumps(g2, sort_keys=True)


def test_build_graph_changes_with_seed():
    base = dict(positive="x", seed=1)
    assert ch.graph_hash(ch.build_graph("hero-flux", **base)) != ch.graph_hash(
        ch.build_graph("hero-flux", **{**base, "seed": 2})
    )


def test_build_graph_sets_prompt_and_seed_on_correct_nodes():
    g = ch.build_graph("blog-flux-steampunk", positive="steampunk owl", seed=99)
    assert g["3"]["inputs"]["text"] == "steampunk owl"
    assert g["7"]["inputs"]["seed"] == 99
    assert g["6"]["inputs"]["batch_size"] == 1  # never batched


def test_build_graph_qwen_uses_node_4_for_prompt():
    g = ch.build_graph("learning-qwen", positive="a polarized beam", seed=1)
    assert g["4"]["inputs"]["text"] == "a polarized beam"


def test_build_graph_lora_fallback_removes_node_and_rewires():
    """On fallback the LoRA node must be REMOVED (not merely strength-zeroed) and
    its consumers rewired to the checkpoint — ComfyUI rejects an absent lora_name
    at submit time regardless of strength (regression: live 400)."""
    base = ch.build_graph("blog-flux-steampunk", positive="x", seed=1)
    lora_id = ch.PRESET_FIELDS["blog-flux-steampunk"]["lora_node"]  # "2"
    up_model = base[lora_id]["inputs"]["model"]  # e.g. ["1", 0]
    up_clip = base[lora_id]["inputs"]["clip"]    # e.g. ["1", 1]

    g = ch.build_graph("blog-flux-steampunk", positive="x", seed=1, lora_fallback=True)
    # Node gone entirely.
    assert lora_id not in g
    # No remaining node references the removed LoRA node or the absent lora_name.
    blob = json.dumps(g)
    assert f'"{lora_id}"' not in blob or lora_id not in g  # node id not present as a key
    assert "steampunk_illustration.safetensors" not in blob
    for node in g.values():
        for value in node.get("inputs", {}).values():
            assert not (isinstance(value, list) and str(value[0]) == str(lora_id))
    # Consumers rewired to the LoRA's upstream sources (the checkpoint).
    assert g["7"]["inputs"]["model"] == up_model   # KSampler model <- checkpoint
    assert g["3"]["inputs"]["clip"] == up_clip     # positive CLIPTextEncode
    assert g["4"]["inputs"]["clip"] == up_clip     # negative CLIPTextEncode


def test_build_graph_truncates_over_length_prompt():
    long_prompt = "z" * (ch.MAX_PROMPT_CHARS + 500)
    g = ch.build_graph("hero-flux", positive=long_prompt, seed=1)
    assert len(g["3"]["inputs"]["text"]) == ch.MAX_PROMPT_CHARS


def test_load_preset_rejects_unknown_preset():
    with pytest.raises(ch.ComfyError):
        ch.load_preset("../../../etc/passwd")


# ---------------------------------------------------------------------------
# Candidate clamp + prompt cap
# ---------------------------------------------------------------------------


def test_clamp_candidate_count_defaults_to_three():
    assert ch.clamp_candidate_count(None) == (3, None)
    assert ch.clamp_candidate_count(0) == (3, None)


def test_clamp_candidate_count_clamps_over_ten():
    clamped, warning = ch.clamp_candidate_count(25)
    assert clamped == 10 and warning and "clamped" in warning


def test_clamp_candidate_count_passes_valid():
    assert ch.clamp_candidate_count(5) == (5, None)


def test_cap_prompt_truncates_and_warns():
    text, warning = ch.cap_prompt("a" * (ch.MAX_PROMPT_CHARS + 1))
    assert len(text) == ch.MAX_PROMPT_CHARS and warning


# ---------------------------------------------------------------------------
# Validated --set override parsing (injection-safe)
# ---------------------------------------------------------------------------


def test_parse_set_override_types_values():
    assert ch.parse_set_override("7.seed=42") == ("7", "seed", 42)
    assert ch.parse_set_override("5.guidance=3.5") == ("5", "guidance", 3.5)
    assert ch.parse_set_override("3.text=a brass owl") == ("3", "text", "a brass owl")


@pytest.mark.parametrize("bad", ["7seed=42", "=42", "7.=5", ".seed=5", "noequals"])
def test_parse_set_override_rejects_malformed(bad):
    with pytest.raises(ch.ComfyError):
        ch.parse_set_override(bad)


def test_apply_set_overrides_rejects_unknown_node():
    g = ch.load_preset("hero-flux")
    with pytest.raises(ch.ComfyError):
        ch.apply_set_overrides(g, ["999.text=pwn"])


def test_apply_set_overrides_applies_to_existing_node():
    g = ch.load_preset("hero-flux")
    ch.apply_set_overrides(g, ["3.text=a red balloon", "7.seed=5"])
    assert g["3"]["inputs"]["text"] == "a red balloon"
    assert g["7"]["inputs"]["seed"] == 5


# ---------------------------------------------------------------------------
# Model inventory extraction (readiness helper)
# ---------------------------------------------------------------------------


def test_extract_model_filenames_flattens_enums():
    object_info = {
        "CheckpointLoaderSimple": {
            "input": {
                "required": {"ckpt_name": [["flux1-dev-fp8.safetensors", "sd_xl.safetensors"]]}
            }
        },
        "LoraLoader": {
            "input": {"required": {"lora_name": [["steampunk_illustration.safetensors"]]}}
        },
    }
    models = ch.extract_model_filenames(object_info)
    assert "flux1-dev-fp8.safetensors" in models
    assert "steampunk_illustration.safetensors" in models


# ---------------------------------------------------------------------------
# Real-server integration (server-startup Category 1 + E2E Category 4)
# ---------------------------------------------------------------------------

# A 1x1 transparent PNG (the "heavy dep" — the rendered image — mocked cheaply).
_TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6360000002000100ffff03000006000557bfabd400"
    "00000049454e44ae426082"
)


class _FakeComfyHandler(BaseHTTPRequestHandler):
    """Minimal real HTTP server that speaks just enough ComfyUI to drive the
    client's submit -> poll -> fetch path. Bugs in path/query building surface as
    real 404s here, not silently swallowed mocks."""

    def log_message(self, *args):  # silence test output
        return

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/system_stats":
            return self._json({"system": {"comfyui_version": "0.27.0-test"}})
        if self.path == "/queue":
            return self._json({"queue_running": [], "queue_pending": []})
        if self.path.startswith("/history/"):
            pid = self.path.split("/history/", 1)[1]
            return self._json(
                {
                    pid: {
                        "status": {"status_str": "success", "completed": True},
                        "outputs": {
                            "9": {
                                "images": [
                                    {
                                        "filename": "test_00001_.png",
                                        "subfolder": "",
                                        "type": "output",
                                    }
                                ]
                            }
                        },
                    }
                }
            )
        if self.path.startswith("/view?"):
            # Assert the query has no traversal payload (the client validated it).
            assert ".." not in self.path
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(_TINY_PNG)))
            self.end_headers()
            self.wfile.write(_TINY_PNG)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/prompt":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw)  # must be valid JSON (dict-built, dumped once)
            assert isinstance(payload["prompt"], dict)  # graph is an object, not a string
            assert "client_id" in payload
            return self._json({"prompt_id": "11111111-2222-3333-4444-555555555555"})
        self.send_response(404)
        self.end_headers()


@pytest.fixture(scope="module")
def fake_comfy_server():
    server = HTTPServer(("127.0.0.1", 0), _FakeComfyHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host = f"127.0.0.1:{port}"
    try:
        yield host
    finally:
        server.shutdown()
        thread.join(timeout=5)


@pytest.mark.integration
def test_real_server_system_stats(fake_comfy_server):
    client = ch.ComfyClient(fake_comfy_server, allowed_hosts={fake_comfy_server})
    stats = client.system_stats()
    assert stats["system"]["comfyui_version"] == "0.27.0-test"


@pytest.mark.integration
def test_real_server_full_submit_poll_fetch(fake_comfy_server, tmp_path):
    """E2E happy path through the live server: build a graph, submit it, poll
    history, download the PNG via /view — all over real HTTP."""
    client = ch.ComfyClient(fake_comfy_server, allowed_hosts={fake_comfy_server})
    graph = ch.build_graph("hero-flux", positive="a glowing construct", seed=7)

    prompt_id = client.submit(graph, client_id="test-client")
    assert prompt_id == "11111111-2222-3333-4444-555555555555"

    history = client.history(prompt_id)
    images = history[prompt_id]["outputs"]["9"]["images"]
    assert images[0]["filename"] == "test_00001_.png"

    dest = tmp_path / "candidate_0.png"
    saved = client.download_image(
        filename=images[0]["filename"],
        subfolder=images[0]["subfolder"],
        type=images[0]["type"],
        dest=dest,
    )
    assert saved == str(dest)
    assert dest.read_bytes() == _TINY_PNG


@pytest.mark.integration
def test_real_server_view_blocks_traversal_before_request(fake_comfy_server):
    """The traversal guard fires client-side — a malicious filename never even
    reaches the wire."""
    client = ch.ComfyClient(fake_comfy_server, allowed_hosts={fake_comfy_server})
    with pytest.raises(ch.ComfyPathError):
        client.view_bytes(filename="../../etc/passwd", subfolder="", type="output")
