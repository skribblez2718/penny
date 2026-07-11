# AI Application Integration Checklist

For any project that integrates a local or cloud AI model (HuggingFace, OpenAI,
Anthropic, local GGUF, etc.), the implement agent MUST consult this reference.

## 1. Generation Parameters

These are the single most common source of "the model is broken" bugs.
Defaults that work for a 70B model may be catastrophic for a 7B model.

| Parameter | Recommended Starting Value | Anti-Pattern | Why It Fails |
|-----------|---------------------------|--------------|--------------|
| `max_new_tokens` | 1024–2048 | `max_new_tokens=256` | Responses truncated mid-sentence. A single code block with explanation easily exceeds 256 tokens. |
| `repetition_penalty` | 1.15–1.20 | `repetition_penalty=1.0` (disabled) or `1.05` (too weak) | Model loops — repeats the same sentence or paragraph endlessly. |
| `no_repeat_ngram_size` | 3 | Not set | Without this, even high repetition_penalty may not prevent 2-3 word phrase repetition. |
| `temperature` | 0.7 | `temperature=1.0+` (creative chaos) or `temperature=0.1` (robotic) | Too high = incoherent. Too low = repetitive "safe" answers. |
| `top_p` | 0.85–0.95 | `top_p=1.0` (disabled) | Allows too many low-probability tokens through, especially on small models. |
| `top_k` | 40–50 | Not set (unlimited) | Combined with low temp, can force the model into a narrow generation path that repeats. |
| `eos_token_id` | Always set explicitly | `pad_token_id` only | Without it, the model may not know when to stop, generating until `max_new_tokens` is exhausted. |
| `pad_token_id` | `eos_token_id` fallback | Not set | Required by most tokenizers; omitting it causes shape errors or silent failures. |

### Complete recommended kwargs for a 7B-13B local model:

```python
model.generate(
    **inputs,
    max_new_tokens=2048,
    do_sample=True,
    temperature=0.7,
    top_p=0.9,
    top_k=50,
    no_repeat_ngram_size=3,
    repetition_penalty=1.18,
    eos_token_id=tokenizer.eos_token_id,
    pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
)
```

## 2. System Prompt Design

| Do | Don't | Rationale |
|----|-------|-----------|
| "Give thorough, well-structured answers" | "Give short, concise answers. Do not repeat yourself." | "Concise" + "do not repeat" often causes the model to stop prematurely or output fragments. |
| "After answering, stop." | "Once you have answered the question, stop responding." | The latter is ambiguous — the model may interpret "once you have answered" as a trigger to re-answer. |
| Include domain context in the prompt | Use generic "helpful AI assistant" for specialized apps | A cybersecurity chatbot with a generic prompt will give shallow, Wikipedia-level answers. |

### Anti-patterns that cause truncation:
- "Give short answers" — model may stop after 1 sentence regardless of `max_new_tokens`
- "Do not repeat" — model may truncate to avoid any perceived repetition
- Any instruction that can be read as "be brief" in context with a short prompt

## 3. Streaming Patterns

### Backend: SSE (Server-Sent Events)

```python
# DO: Use transformers TextStreamer with a queue
from queue import Queue
from threading import Thread
from transformers import TextStreamer

class QueueStreamer(TextStreamer):
    def on_finalized_text(self, text: str, stream_end: bool = False):
        self.queue.put((text, stream_end))

def stream_response(messages):
    queue = Queue()
    streamer = QueueStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
    streamer.queue = queue

    def _generate():
        model.generate(**inputs, max_new_tokens=2048, streamer=streamer, ...)
        queue.put(("", True))

    Thread(target=_generate, daemon=True).start()
    while True:
        try:
            text, done = queue.get(timeout=120)
            if text:
                yield text
            if done:
                break
        except Empty:
            break
```

### Backend: FastAPI SSE Endpoint

```python
from fastapi.responses import StreamingResponse

@app.post("/chat/stream")
async def chat_stream(body: ChatRequest):
    def _sse_generator():
        for token in stream_response(body.messages):
            yield f"data: {json.dumps({'token': token})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"
    return StreamingResponse(_sse_generator(), media_type="text/event-stream")
```

### Frontend: Lit

Consume the SSE stream in a Lit component and append tokens to a reactive
property so the UI re-renders incrementally. `EventSource` only supports GET, so
for a POST endpoint use `fetch` + a streaming `ReadableStream` reader:

```ts
import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";

@customElement("chat-stream")
export class ChatStream extends LitElement {
  @state() private response = "";

  async send(messages: ChatMessage[]) {
    this.response = "";
    const res = await fetch("/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n"); // SSE frames are blank-line separated
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.done) return;
        this.response += payload.token; // reactive → re-renders each token
      }
    }
  }

  render() {
    return html`<div class="response">${this.response}</div>`;
  }
}
```

## 4. Context Window Management

| Strategy | When to Use | Implementation |
|----------|------------|----------------|
| Sliding window (last N) | Short conversations, well-defined topics | `messages[-20:]` |
| Summarization | Long conversations, evolving topics | Summarize older messages, prepend as system context |
| Truncation by tokens | Fixed-size models | Count tokens, trim oldest until under limit |

**Default:** Keep last 20 messages for a 7B model. 10 is too few — multi-turn conversations degrade.

## 5. Model Loading

### GPU Detection

```python
def detect_device():
    if torch.cuda.is_available():
        return "cuda"  # NVIDIA or AMD ROCm
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"  # Apple Silicon
    return "cpu"
```

### OOM Fallback Chain

Always attempt multi-GPU sharding first, then single GPU, then CPU:

```python
try:
    model = AutoModelForCausalLM.from_pretrained(name, device_map="auto", torch_dtype="auto")
except Exception:
    for device in ["cuda", "cpu"]:
        try:
            model = AutoModelForCausalLM.from_pretrained(name, device_map={"": device}, torch_dtype="auto")
            break
        except Exception:
            continue
```

## 6. Hardware-Aware Defaults

For any project that infers models locally:
- **Auto-detect GPU**: Always run the detection probe at startup. Never hardcode device.
- **User-configurable override**: Provide an environment variable (`CHATBOT_MODEL_DEVICE`) that overrides the automatic detection.
- **RAM vs VRAM messaging**: Log what hardware was detected so users can debug performance issues.
- **CPU fallback is always available**: Never raise an error if GPU detection fails — fall back to CPU.

## 7. Response Persistence

When streaming AI responses:
- **Start with user message stored immediately** — if the streaming fails, the user's prompt is not lost.
- **Store the full assistant response after streaming completes** — not token by token.
- **Never wipe conversation history on backend errors** — use a defensive merge pattern.

## 8. Multi-GPU Standard (Mandatory for AI Apps)

**All AI applications in this workspace MUST make both RTX 4090s
visible to PyTorch AND pin all models to a single shared device.**
This is a workspace-wide standard — not project-specific. The
convention applies to `simple_chatbot`, `simple_voicebot`,
`simple_meeting_summarizer`, and every future AI app.

### What this means in practice

1. **`.env` and `.env.example` must include `CUDA_VISIBLE_DEVICES=0,1`**
   at the top of the file, with a comment block explaining the
   rationale. The app must still work on 1 GPU, N GPUs, or no GPU —
   the env var makes 2 cards *visible*, but the picker chooses
   which one to use.

2. **All models in a single app share ONE device.** Do NOT split
   multiple models across different cards. Do NOT use
   `device_map="auto"` on small models — it places model submodules
   on different cards and causes runtime cross-device tensor errors.
   Use `device_map={"": device}` (pin everything to one card) instead.

3. **For models that only accept a single `device` string**
   (e.g. `openai-whisper`'s `load_model`), use a `get_device()`
   helper that:
   - Honors a `MEETING_DEVICE` (or per-project) env var override
   - Picks the GPU with the most free VRAM via `torch.cuda.mem_get_info()`
   - Falls back to MPS, then CPU
   - Caches its result so multiple `get_device()` calls return the
     same value

4. **Never hardcode `"cuda"`, `"cuda:0"`, or `"cpu"`.** Always go
   through the shared helper so the app is GPU-agnostic.

### Why one device, not two

`device_map="auto"` on Qwen TTS (a small 1.2 GB model) places the
text encoder on one card and the audio decoder on another. At
runtime, a tensor flow hits `torch.cat` and PyTorch raises:

```
Expected all tensors to be on the same device, but got tensors
is on cuda:0, different from other tensors on cuda:1
```

Splitting one model across cards is broken for small models.
Splitting multiple models in one app across cards is broken because
data lives on one card and the model on the other. The fix is to
pin all models to a single card. They all fit on one 24 GB card
with ~20 GB of headroom.

### Reference: shared device picker

```python
# backend/_gpu.py
import threading
import torch

DEVICE_OVERRIDE: str | None = os.environ.get("MEETING_DEVICE")
_selected_device: str | None = None
_lock = threading.Lock()


def get_device() -> str:
    global _selected_device
    with _lock:
        if _selected_device is not None:
            return _selected_device
        device = _resolve()
        _selected_device = device
        return device


def _resolve() -> str:
    if DEVICE_OVERRIDE and _is_valid(DEVICE_OVERRIDE):
        return DEVICE_OVERRIDE
    if torch.cuda.is_available():
        return _pick_best()
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _pick_best() -> str:
    n = torch.cuda.device_count()
    if n <= 0: return "cpu"
    if n == 1: return "cuda:0"
    free = []
    for i in range(n):
        try:
            f, _ = torch.cuda.mem_get_info(i)
            free.append((f, i))
        except Exception: pass
    if not free: return "cuda:0"
    free.sort(reverse=True)
    return f"cuda:{free[0][1]}"
```

### Reference: model loading

```python
# Multiple models in one app
from backend._gpu import get_device

def load_stt():
    device = get_device()
    return whisper.load_model("medium", device=device)

def load_tts():
    device = get_device()  # SAME device as STT
    return Qwen3TTSModel.from_pretrained(name, device_map=device)  # NOT "auto"
```

```python
# Single 7B model that wants to be sharded — pin instead of auto
device = get_device()  # "cuda:0"
model = AutoModelForCausalLM.from_pretrained(
    name, torch_dtype="auto", device_map={"": device}
)
```

### Reference: `.env` template block

```bash
# ----------------------------------------------------------------------------
# Compute — both RTX 4090s are visible to PyTorch. The app picks ONE
# device at startup (whichever has the most free VRAM, with CPU fallback).
# Set MEETING_DEVICE below to force a specific device.
# ----------------------------------------------------------------------------
CUDA_VISIBLE_DEVICES=0,1
# MEETING_DEVICE=cuda:0   # uncomment to force a specific device
```

### Why this is mandatory

- A 7B BF16 model (~14 GB) plus a 1.2 GB TTS model (~15.2 GB total)
  fits comfortably on a single 24 GB card with headroom for
  activations and KV cache. Running both on a single card avoids
  cross-device errors entirely.
- The user has standardized on this 2-GPU-visible / 1-device-used
  setup across all their AI projects. Skipping it in a new project
  will cause inconsistent OOM behavior and wasted VRAM.
- `device_map={"": device}` is the *only* placement strategy that
  is both OOM-safe and runtime-safe (no cross-device tensor bugs).

### Code-skill agent responsibility

When the code skill creates a new AI project (or modifies an existing
one), the `implement` and `verify` agents MUST:
1. Verify `CUDA_VISIBLE_DEVICES=0,1` is in both `.env` and `.env.example`
2. Verify a `get_device()`-style helper exists and is the single
   source of truth for device selection
3. Verify `device_map="auto"` is NOT used in any model-loading path
4. Verify no hardcoded `"cuda"`, `"cuda:0"`, or `"cpu"` strings in
   model-loading paths
5. Add or update device-picker tests covering: env override, single
   GPU, multi-GPU, no-GPU
6. Add a regression test that STT and TTS (or any two models in the
   same app) use the same device
7. Fail verification if any of the above is missing
