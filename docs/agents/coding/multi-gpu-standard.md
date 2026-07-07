# Multi-GPU Standard for AI Applications

**Status:** Mandatory. Applies to every AI app in this workspace.
**Applies to:** `simple_chatbot`, `simple_voicebot`, `simple_meeting_summarizer`, and all future AI projects.

## The Rule

All AI applications in this workspace **MUST** make both RTX 4090s
visible to PyTorch, but they **MUST NOT** assume 2 GPUs.

Concretely:
1. `.env` and `.env.example` must contain `CUDA_VISIBLE_DEVICES=0,1` at
   the top — this makes both cards visible, but the app must still
   handle 1 GPU, N GPUs, or no GPU gracefully.
2. **All models in a single app share ONE device.** Do NOT split
   multiple models across different cards. Do NOT use
   `device_map="auto"` on small models.
3. The device is chosen once at startup by a shared helper and cached.
   The app code uses `get_device()` to read the choice.
4. A `MEETING_DEVICE` (or project-specific) env var lets the user
   override the choice (e.g. `MEETING_DEVICE=cuda:0`,
   `MEETING_DEVICE=cpu`).
5. No hardcoded `"cuda"`, `"cuda:0"`, or `"cpu"` in model-loading
   paths.

## Why one device for everything

The single biggest cause of cross-device tensor errors in this
workspace is **splitting one model's submodules across GPUs**:

- `device_map="auto"` on Qwen TTS places the text encoder on one
  card and the audio decoder on another. At inference time, a tensor
  flow hits `torch.cat` and PyTorch raises
  *"tensors on cuda:0, different from cuda:1"*.
- Two models in the same app each picking a different GPU creates
  a similar coupling: data lives on GPU 0, the model lives on GPU 1,
  and the first request fails.

The fix is to pin all models in an app to the same single device. Both
Whisper medium (~1.5 GB) and Qwen3-TTS-0.6B (~1.2 GB) fit on one
24 GB card with ~20 GB of headroom. Splitting is wasteful AND broken.

## `.env` Template

```bash
# ----------------------------------------------------------------------------
# Compute — both RTX 4090s are visible to PyTorch. The app picks ONE
# device at startup (whichever has the most free VRAM, with CPU fallback).
# Set MEETING_DEVICE below to force a specific device.
# ----------------------------------------------------------------------------
CUDA_VISIBLE_DEVICES=0,1
# MEETING_DEVICE=cuda:0   # uncomment to force a specific device
```

## Code Pattern — Shared Device Picker

Create a `backend/_gpu.py` (or equivalent) module that is the single
source of truth for device selection:

```python
# backend/_gpu.py
from __future__ import annotations

import logging
import os
import threading

import torch

logger = logging.getLogger(__name__)

DEVICE_OVERRIDE: str | None = os.environ.get("MEETING_DEVICE")

_selected_device: str | None = None
_selection_lock = threading.Lock()


def get_device() -> str:
    """Return the single device all models should load onto.

    Resolves in this order:
    1. MEETING_DEVICE env var, if set and valid
    2. GPU with the most free VRAM (across CUDA_VISIBLE_DEVICES)
    3. Apple MPS
    4. CPU

    The result is cached after the first call.
    """
    global _selected_device
    with _selection_lock:
        if _selected_device is not None:
            return _selected_device

        device = _resolve_device()
        _selected_device = device
        logger.info("Selected compute device for all models: %s", device)
        return device


def reset_device_cache() -> None:
    """Clear the cached device selection. For tests only."""
    global _selected_device
    with _selection_lock:
        _selected_device = None


def _resolve_device() -> str:
    if DEVICE_OVERRIDE:
        override = DEVICE_OVERRIDE.strip().lower()
        if _is_valid_device(override):
            logger.info("Using MEETING_DEVICE override: %s", override)
            return override
        logger.warning(
            "MEETING_DEVICE=%r is not valid; ignoring.", DEVICE_OVERRIDE
        )

    try:
        if torch.cuda.is_available():
            return _pick_best_cuda_device()
    except Exception as exc:
        logger.warning("CUDA detection failed: %s", exc)

    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass

    return "cpu"


def _pick_best_cuda_device() -> str:
    """Return 'cuda:N' for the GPU with the most free VRAM."""
    try:
        n = torch.cuda.device_count()
        if n <= 0:
            return "cpu"
        if n == 1:
            return "cuda:0"
        free_per_dev: list[tuple[int, int]] = []
        for i in range(n):
            try:
                free, _total = torch.cuda.mem_get_info(i)
                free_per_dev.append((free, i))
            except Exception:
                continue
        if not free_per_dev:
            return "cuda:0"
        free_per_dev.sort(reverse=True)
        return f"cuda:{free_per_dev[0][1]}"
    except Exception:
        return "cuda:0"


def _is_valid_device(device: str) -> bool:
    if device in ("cpu", "mps", "cuda"):
        return True
    if device.startswith("cuda:"):
        return device[5:].isdigit()
    return False
```

## Code Pattern — Model Loading

Every model loader calls `get_device()` and uses the returned string
as the device. **Do not** use `device_map="auto"`.

```python
# backend/stt.py
from backend._gpu import get_device
import whisper

def load_stt_model() -> bool:
    device = get_device()  # "cuda:0", "cuda:1", or "cpu"
    model = whisper.load_model("medium", device=device)  # NOT device_map=
    return True
```

```python
# backend/tts.py
from backend._gpu import get_device
from qwen_tts import Qwen3TTSModel

def load_tts_model() -> bool:
    device = get_device()  # SAME device as STT
    model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        device_map=device,  # single device, NOT "auto"
    )
    return True
```

For the LLM (`simple_chatbot` / `simple_voicebot` use a 7B model that
WANTS to be sharded):

```python
# backend/main.py (single-LLM app)
from backend._gpu import get_device
from transformers import AutoModelForCausalLM

def load_model() -> None:
    device = get_device()  # "cuda:0" — pin the entire model to one card
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_NAME,
        torch_dtype="auto",
        device_map={"": device},  # explicit single-device map
    )
```

`device_map={"": device}` is the recommended pattern for
single-model apps: it pins everything to the chosen device and works
the same on 1-GPU, 2-GPU, and CPU machines.

## Why not `device_map="auto"`?

`device_map="auto"` lets Accelerate split a model across multiple
GPUs. For a 7B model on a single 24 GB card, this is necessary.
For small models (Whisper medium, Qwen TTS-0.6B), it is broken:

- The model's submodules end up on different cards.
- At runtime, a tensor flow between submodules hits
  `torch.cat` and fails with cross-device errors.
- There is no clean way to fix this without patching the model
  internals.

**Always pin to a single device string.**

## Code-Skill Agent Responsibility

When the code skill creates or modifies an AI project, the
`implement` and `verify` agents MUST:

- [ ] Confirm `CUDA_VISIBLE_DEVICES=0,1` is in both `.env` and `.env.example`
- [ ] Confirm a `get_device()`-style helper exists and is the single
      source of truth for device selection
- [ ] Confirm `device_map="auto"` is **not** used in any model-loading
      path
- [ ] Confirm no hardcoded `"cuda"`, `"cuda:0"`, or `"cpu"` in
      model-loading paths
- [ ] Add a test for the device picker covering: override, single-GPU,
      multi-GPU, no-GPU
- [ ] Add a regression test that verifies STT and TTS use the same
      device
- [ ] Fail verification if any of the above is missing

## Tests

```python
def test_get_device_uses_override(monkeypatch):
    monkeypatch.setenv("MEETING_DEVICE", "cpu")
    from backend._gpu import get_device, reset_device_cache
    reset_device_cache()
    assert get_device() == "cpu"


def test_get_device_picks_best_gpu(monkeypatch):
    from backend import _gpu
    _gpu.reset_device_cache()
    monkeypatch.setattr("torch.cuda.is_available", lambda: True)
    monkeypatch.setattr("torch.cuda.device_count", lambda: 2)

    def fake_mem(dev):
        return (4 * 1024**3, 24 * 1024**3) if dev == 0 else (20 * 1024**3, 24 * 1024**3)

    monkeypatch.setattr("torch.cuda.mem_get_info", fake_mem)
    assert _gpu.get_device() == "cuda:1"


def test_stt_and_tts_share_device(monkeypatch):
    """Regression test for the cross-device tensor error."""
    from backend import _gpu
    _gpu.reset_device_cache()
    monkeypatch.setattr(_gpu, "get_device", lambda: "cuda:0")
    # ... load both models, assert both use cuda:0
```

The `simple_meeting_summarizer` project has full reference tests in
`tests/test_stt.py::TestSTTModelLoading::test_load_stt_model_uses_shared_device`
and `tests/test_tts.py::TestTTSModelLoading::test_load_tts_model_uses_shared_device`.
