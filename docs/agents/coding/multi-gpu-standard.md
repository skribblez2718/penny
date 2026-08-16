# Multi-Accelerator Standard for AI Applications

## Scope

Use this standard when a caller-selected project can run models on CUDA, MPS, or CPU. Tracked Penny code and documentation remain hardware- and downstream-project-neutral; deployment profiles supply visible devices, model names, memory requirements, and overrides.

## Invariant

Select one compatible device at startup, reuse it for every tightly coupled model/tensor path, and degrade safely to CPU. Never encode a host's hardware inventory, fixed device index, or downstream model layout in Penny.

## Rules

1. **Caller-owned visibility.** Deployment configuration controls which accelerators are visible. Application code discovers only that visible set.
2. **One selection point.** A shared helper chooses and caches the device. Model loaders do not choose independently.
3. **One device for coupled work.** Models that exchange tensors use the same device unless the selected project explicitly implements and tests distributed execution.
4. **Validated override.** A project-specific environment variable may request `cpu`, `mps`, `cuda`, or `cuda:<index>`. Invalid or unavailable requests fail clearly or fall back according to caller policy.
5. **Capability-first fallback.** Prefer an available compatible accelerator; otherwise use CPU. Detection failure does not crash startup unless an accelerator is a declared project requirement.
6. **No automatic sharding by default.** Automatic multi-device maps are allowed only when the selected model cannot fit one device and the caller has explicit distributed-execution tests.
7. **No Penny deployment profile.** Device counts, memory sizes, model footprints, and visibility values belong to the selected target or deployment registry.

## Generic device picker

```python
from __future__ import annotations

import logging
import os
import threading

import torch

logger = logging.getLogger(__name__)

_DEVICE_ENV = "APP_DEVICE"
_selected_device: str | None = None
_selection_lock = threading.Lock()


def get_device() -> str:
    """Return the cached device selected for this process."""
    global _selected_device
    with _selection_lock:
        if _selected_device is None:
            _selected_device = _resolve_device(os.environ.get(_DEVICE_ENV, ""))
        return _selected_device


def reset_device_cache() -> None:
    """Clear selection for isolated tests."""
    global _selected_device
    with _selection_lock:
        _selected_device = None


def _resolve_device(raw_override: str) -> str:
    override = raw_override.strip().lower()
    if override:
        if _is_available(override):
            return override
        logger.warning("Configured device is unavailable; using capability fallback")

    try:
        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            return _best_visible_cuda_device()
    except Exception as exc:
        logger.warning("CUDA capability detection failed: %s", exc)

    try:
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _best_visible_cuda_device() -> str:
    candidates: list[tuple[int, int]] = []
    for index in range(torch.cuda.device_count()):
        try:
            free_bytes, _total_bytes = torch.cuda.mem_get_info(index)
            candidates.append((free_bytes, index))
        except Exception:
            continue
    if not candidates:
        return "cuda"
    _free_bytes, selected_index = max(candidates)
    return f"cuda:{selected_index}"


def _is_available(device: str) -> bool:
    if device == "cpu":
        return True
    if device == "mps":
        return bool(hasattr(torch.backends, "mps") and torch.backends.mps.is_available())
    if device == "cuda":
        return bool(torch.cuda.is_available() and torch.cuda.device_count() > 0)
    if device.startswith("cuda:") and device.removeprefix("cuda:").isdigit():
        index = int(device.removeprefix("cuda:"))
        return bool(torch.cuda.is_available() and 0 <= index < torch.cuda.device_count())
    return False
```

The selected project may use a different helper or framework. The invariant is one validated, cached selection—not this exact implementation.

## Model loading

```python
from project_runtime.device import get_device


def load_model(model_factory):
    device = get_device()
    model = model_factory()
    return model.to(device)
```

For libraries that accept a device map, use an explicit single-device map based on `get_device()`. Automatic sharding requires separate project evidence.

## Verification

The author and verifier confirm:

- [ ] tracked Penny files contain no host-specific accelerator inventory or downstream model/profile;
- [ ] deployment configuration owns device visibility and overrides;
- [ ] one helper selects and caches the device;
- [ ] coupled models/tensors use the same selected device;
- [ ] invalid/unavailable overrides follow the documented policy;
- [ ] accelerator detection failure has a tested CPU fallback;
- [ ] automatic sharding is absent unless explicit distributed tests justify it;
- [ ] tests cover override, unavailable override, one visible accelerator, multiple visible accelerators, detection failure, and no accelerator.

## Test shape

Use mocks; CI does not require accelerator hardware.

```python
def test_no_accelerator_falls_back_to_cpu(monkeypatch):
    from project_runtime import device

    device.reset_device_cache()
    monkeypatch.setattr(device.torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(device.torch.backends.mps, "is_available", lambda: False)
    assert device.get_device() == "cpu"


def test_coupled_loaders_share_cached_selection(monkeypatch):
    from project_runtime import device

    device.reset_device_cache()
    monkeypatch.setattr(device, "_resolve_device", lambda _override: "cpu")
    assert device.get_device() == device.get_device()
```
