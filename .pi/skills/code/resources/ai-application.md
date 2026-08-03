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

## 8. Hardware Placement Comes From the Selected Target Profile

Hardware topology, accelerator visibility, device placement, model sharding, and
environment-variable conventions are project/deployment-specific. Penny must not
hardcode an operator's GPU model, count, index, memory capacity, or device variable.

For an existing target, use only conventions backed by selected target-profile source
evidence (configuration, deployment manifests, and tests). For greenfield or ambiguous
hardware, request clarification before planning or implementation. Keep a CPU-safe or
otherwise project-native fallback only when the target evidence requires it. Verify
that all interacting models/tensors use compatible devices, but do not impose a
universal placement recipe.
