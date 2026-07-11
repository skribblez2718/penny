# Server-Startup Integration Tests — Mandatory Checklist

This reference is for any code-skill iteration that produces a server-based
project (FastAPI, Flask, Django, Express, Fastify, Next, Koa, etc.). The
code-skill orchestrator enforces these checks at the verify phase, and
**the orchestrator will fail verification if any of them are missing**.

## Why this exists

Unit tests with mocked framework classes catch a lot — handler logic,
validation, persistence — but they consistently miss an entire class of
real-world bugs:

- The CORS middleware is misconfigured (works in unit tests, fails from a
  browser).
- A startup hook crashes on first import (works in tests because the
  fixture monkey-patches the dependency).
- The server binds to the wrong host/port, or a different process is
  already on the port.
- The lifespan event is misspelled and silently no-ops.
- The entry-point script (e.g. a Python frontend runner or a CLI wrapper)
  changes cwd to its own directory and then fails to import a sibling
  module because `sys.path` does not contain the project root.

The last item is the most common and the most embarrassing. It is a
recurring bug class: a Python entry-point script fails to import a sibling
backend module because the runner sets the working directory to the
script's own directory, not the project root. A test that runs the entry
point as a subprocess from its own directory would catch it on the first
verify pass.

## The mandatory four-category test suite

For a server project, the implement phase MUST produce tests in all four
of these categories. The verify phase explicitly checks for them by name
and fails if any are absent.

### Category 1 — Real server, real HTTP

Start the actual server (uvicorn / Flask dev server / node http) in a
background thread or subprocess, with **heavy dependencies mocked** but
the framework, middleware, CORS, and handlers **left real**. Make real
HTTP requests against it.

```python
# tests/test_integration.py — Python / FastAPI example
import sys
import socket
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests
import uvicorn

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEST_HOST = "127.0.0.1"
TEST_PORT = 18765


def _port_is_open(host, port, timeout=0.2):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


@pytest.fixture(scope="module")
def real_backend_server():
    """A real uvicorn server with the model mocked."""
    with (
        patch("transformers.AutoModelForCausalLM") as mock_model_cls,
        patch("transformers.AutoTokenizer") as mock_tokenizer_cls,
    ):
        # ... build a realistic mock that the FastAPI app can call into
        # (apply_chat_template returns a string, generate returns a fake
        # tensor, decode returns a string, etc.) ...
        mock_tokenizer = MagicMock()
        mock_tokenizer.eos_token_id = 0
        mock_tokenizer.pad_token_id = 0
        mock_tokenizer.apply_chat_template.return_value = (
            "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n"
        )
        mock_tokenizer.decode.return_value = "hello from test"
        batch = MagicMock()
        input_ids = MagicMock()
        input_ids.shape = [1, 5]
        batch.__getitem__.return_value = input_ids
        batch.to.return_value = batch
        mock_tokenizer.return_value = batch
        mock_tokenizer_cls.from_pretrained.return_value = mock_tokenizer

        mock_model = MagicMock()
        mock_model.device = "cpu"
        out = MagicMock()
        out.shape = [1, 6]
        mock_model.generate.return_value = out
        mock_model_cls.from_pretrained.return_value = mock_model

        sys.path.insert(0, str(PROJECT_ROOT))
        from backend.main import app as backend_app

        config = uvicorn.Config(
            app=backend_app,
            host=TEST_HOST,
            port=TEST_PORT,
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()

        base_url = f"http://{TEST_HOST}:{TEST_PORT}"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                if requests.get(f"{base_url}/health", timeout=1).status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(0.2)
        else:
            raise RuntimeError("server did not start in 15s")

        yield base_url
        server.should_exit = True
        thread.join(timeout=5)


def test_real_server_health(real_backend_server):
    resp = requests.get(f"{real_backend_server}/health", timeout=5)
    assert resp.status_code == 200
```

### Category 2 — Entry-point script from its own directory

This is a recurring bug class. For every entry point (anything the user
actually runs — `uvicorn X:app`, `python X.py`, a bundler dev server,
etc.), add a test that:

1. Changes the cwd to the entry point's directory.
2. Runs the entry point as a subprocess (or imports it in a subprocess
   Python) — exercising exactly the import chain the production runner
   would.
3. Asserts the import chain works (i.e. no `ModuleNotFoundError`).

```python
def test_frontend_app_works_from_frontend_dir():
    """Running frontend/app.py from the frontend/ dir changes cwd — so the
    import chain must work from there."""
    original_cwd = os.getcwd()
    try:
        os.chdir(PROJECT_ROOT / "frontend")
        driver = (
            "import sys; "
            f"sys.path.insert(0, {str(PROJECT_ROOT)!r}); "
            "import frontend.app as fa; "
            "from backend.main import app as backend_app; "
            "print('OK')"
        )
        result = subprocess.run(
            [sys.executable, "-c", driver],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT / "frontend"),
            timeout=15,
        )
        assert result.returncode == 0, result.stderr
    finally:
        os.chdir(original_cwd)
```

If the production entry point script is the *right* place to fix this,
the script itself should add the project root to `sys.path` at module
load time:

```python
# At the top of frontend/app.py, BEFORE any project-relative imports
from pathlib import Path
import sys

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
```

### Category 3 — CORS preflight from a real browser origin

If the server uses CORS, the unit tests with `TestClient` will pass even
if the allow-list is misconfigured. Hit it from a real HTTP client and
assert the headers.

```python
def test_cors_preflight(real_backend_server):
    resp = requests.options(
        f"{real_backend_server}/chat",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
        timeout=5,
    )
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:5173"
```

### Category 4 — End-to-end happy path

At least one test exercises the **main business flow** through the live
server, end-to-end. This is the test that catches "the routes are
registered, the model mock returns a string, but the response shape
doesn't match what the client expects" — bugs that show up only when
the full wire path is traversed.

```python
def test_full_chat_flow(real_backend_server):
    # Create a conversation
    create = requests.post(
        f"{real_backend_server}/conversations",
        json={"title": "test"},
        timeout=5,
    )
    assert create.status_code == 201
    conv_id = create.json()["id"]

    # Send a message
    msg = requests.post(
        f"{real_backend_server}/conversations/{conv_id}/messages",
        json={"content": "hello"},
        timeout=10,
    )
    assert msg.status_code == 200
    body = msg.json()
    assert body["user_message"]["content"] == "hello"
    assert body["assistant_message"]["content"]  # non-empty

    # Fetch the conversation
    fetched = requests.get(f"{real_backend_server}/conversations/{conv_id}", timeout=5)
    assert len(fetched.json()["messages"]) == 2

    # Clean up
    requests.delete(f"{real_backend_server}/conversations/{conv_id}", timeout=5)
```

## Mocking heavy dependencies

The point of starting a real server in tests is to catch *integration*
bugs, not to test the model output. Mock at the boundary of the
framework so that:

- The real framework, app object, router, middleware, CORS, lifespan
  events, and startup hooks all run.
- Anything that downloads multi-gigabyte artifacts (HuggingFace models,
  DB engines, cloud SDK clients) is replaced with a `MagicMock` that
  returns realistic-shaped responses.

Common patterns:

| Heavy dep              | How to mock                                                  |
| ---------------------- | ------------------------------------------------------------ |
| HuggingFace model      | `patch("transformers.AutoModelForCausalLM")` / `AutoTokenizer` |
| OpenAI / Anthropic API | `patch("openai.OpenAI")` / `patch("anthropic.Anthropic")`    |
| SQLAlchemy engine      | `patch("sqlalchemy.create_engine")`                          |
| Redis client           | `patch("redis.Redis")`                                       |
| Boto3 / AWS            | `patch("boto3.client")`                                      |

When patching the tokenizer, the test must also patch the chained calls
the production code uses (`tokenizer(text, return_tensors="pt").to(device)`,
`tokenizer.apply_chat_template(...)`, `tokenizer.decode(...)`).

## Performance

The full server-startup test suite should run in **under 30 seconds**
end-to-end. If yours takes longer:

- Use `scope="module"` or `scope="session"` fixtures so the server boots
  once and is reused across tests.
- Bind to a high port (e.g. `18765`) you don't expect anything else to use.
- Use `log_level="warning"` and `access_log=False` on the uvicorn config
  to keep stdout clean.

## Quick checklist for the implement phase

Before reporting the iteration as complete, run through this in your head:

- [ ] **Category 1 (real server, real HTTP)** — at least one test starts the
      server in a thread and hits it with `requests`.
- [ ] **Category 2 (entry-point from its own dir)** — for every entry point
      the user runs, a test simulates the production runner's cwd and
      confirms the import chain works.
- [ ] **Category 3 (CORS preflight)** — if CORS is used, an OPTIONS request
      from a real browser origin returns the right `access-control-allow-origin`.
- [ ] **Category 4 (E2E happy path)** — at least one test exercises the
      main business flow through the live server.
- [ ] **Mocked at the right boundary** — heavy deps are mocked, the
      framework is real.
- [ ] **Under 30s** — full suite finishes quickly.

If any checkbox is missing, the verify phase will report a gap and the
Ralph Wiggum Loop will cycle back to implement.
