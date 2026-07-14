---
name: imagegen
description: Generate images locally — blog art, concept illustrations, hero headers, or general-purpose visuals — with a built-in critique-and-revise pass for quality. Use when the task requires producing image or illustration assets. Do not use when the request is text or diagram overlays only (media pipeline), when editing an existing image, or when no local image backend is reachable (the skill fails fast in its readiness check).
license: MIT
metadata:
  version: "1.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - annie
      - synthia
      - vera
      - carren
---

# imagegen — Local Image Generation

Generate images locally over the running ComfyUI HTTP API. A `BasePlaybook` FSM
routes each request to one of four shipped presets, composes a wordless prompt,
generates candidates one at a time, runs a two-critic parallel critique, iterates
a bounded revise loop, and presents the best candidate with a provenance manifest
that makes every result exactly re-generatable.

## When to Use

- Produce blog / post / hero / concept illustration assets locally.
- You want reproducible, provenance-tracked image generation (seed + prompt +
  preset recorded per candidate).
- You have a running local ComfyUI (`comfy-ui.service` on `127.0.0.1:8188`).

## When NOT to Use

- Adding text/labels to an image (that is an HTML/SVG overlay in the media
  pipeline — imagegen is deliberately wordless).
- Editing / inpainting an existing image (v1 generates fresh).
- No local ComfyUI is reachable — the skill **fails fast** in its readiness check
  with an actionable error rather than hanging.

## Invocation

```
skill({
  skill_name: "imagegen",
  goal: "a steampunk owl professor for the blog post",
  project_root: "/path/to/project",
  constraints: {
    // all optional:
    preset: "blog-flux-steampunk",   // override the deterministic route
    count: 3,                          // candidates (default 3, clamped to 10)
    seed: 777,                         // fixed seed (else a random seed is recorded)
    raw_prompt: "…",                   // pass a prompt through verbatim (positive slot)
    width: 1536, height: 1024,
    output_dir: "/tmp/imagegen-mypost",
    max_iterations: 2                  // bounded revise loop (default 2)
  }
})
```

The host is **locked** to `127.0.0.1:8188` and is never caller-overridable.

## States

```
intake → framing(annie) → composing(synthia) → generating(TOOL)
                                                     │
                                          critiquing(vera ‖ carren)
                                            │APPROVE        │NEEDS_REVISION
                                            ▼               ▼ (budget remains)
                                        presenting     adjusting(synthia)
                                          (TOOL)            │
                                            │               └──► generating (regen failed only)
                                            ▼
                                         complete    (NEEDS_REVISION + budget spent → presenting, met=False)
```

| State | Type | Run By | What happens |
|-------|------|--------|--------------|
| **framing** | AGENT | annie | Confirm the routed preset + candidate count; write a one-line brief. (Routing + readiness are deterministic and run before this.) |
| **composing** | AGENT | synthia | Build the positive (subject + scaffold) and wordless negative; raw-override passthrough; ≤4000 chars. |
| **generating** | TOOL | — | Submit each candidate **one at a time**, poll `/history`, fetch via `/view`, write `manifest.json`. Regenerates only failed candidates on a revise loop. |
| **critiquing** | PARALLEL | vera + carren | vera = technical validity (valid render, dimensions, no baked-in text); carren = aesthetic + brief fidelity. NEEDS_REVISION if **either** flags. |
| **adjusting** | AGENT | synthia | Propose prompt tweaks for the failed candidates; regenerate only those. |
| **presenting** | TOOL | — | Pick the best **vera-valid** candidate; emit the dual-format result. |

Escalation: any agent state (`framing`, `composing`, `critiquing`, `adjusting`)
escalates to the user on `UNCERTAIN` confidence (or `needs_clarification`), then
resumes at `framing` once clarified. Any state can `abort` to `error`.

## Guarantees (acceptance criteria)

- **Fail-fast readiness.** A run against a reachable ComfyUI produces ≥1 candidate
  PNG + `manifest.json`, or fails inside the readiness check with an actionable
  error — no silent hangs (every HTTP call is timeout-bounded).
- **Deterministic routing.** `route_preset` is a pure function; the 4-way matrix
  (steampunk/blog, lesson/concept, hero/abstract, general/caller-specified) has 0
  misroutes.
- **Graceful LoRA fallback.** A missing `steampunk_illustration.safetensors`
  degrades to base FLUX with a WARN — never a hard failure.
- **Reproducibility.** Same `preset + seed + prompt + settings` builds a
  byte-identical graph (`graph_hash`); the manifest records everything needed to
  reproduce or prompt-tweak-iterate.
- **Bounded, honest loop.** The revise loop never exceeds `max_iterations`
  (default 2); an exhausted run completes with `met=False` and itemized
  unresolved issues — never a fabricated APPROVE.

## Security

- **SSRF:** the `comfy_http` client is pinned to a loopback host allow-list
  (default `{127.0.0.1:8188}`) and refuses redirects — no request can target
  another host.
- **Path traversal:** `/view` `filename`/`subfolder` reject `..`, absolute paths,
  and null bytes (fuzz-tested); `prompt_id` is restricted to a safe token.
- **Injection:** the `/prompt` body is built as a dict and `json.dumps`-ed once —
  prompt text is never concatenated into the JSON string.
- **Resource exhaustion:** candidate count clamped to 10; one candidate submitted
  at a time (single-queue safe); prompts capped at 4000 chars.
- **Data exposure:** only file paths + metadata are persisted — never image bytes.

## Resources

- `resources/reference.md` — condensed ComfyUI reference (endpoints, presets,
  detail scaffolds, wordless policy, reproduction).
- `resources/presets/*.api.json` — the 4 preset graphs.
- `scripts/comfy_http.py` — hardened HTTP client + deterministic graph builder.
- `scripts/comfy-generate.py` — provenance-aware CLI (`--count`, `--seed`,
  `--manifest`, validated `--set`).

## Testing

The full suite is hermetic (no live ComfyUI):

```
pytest apps/orchestration/tests/test_imagegen_playbook.py \
       .pi/skills/imagegen/tests/test_comfy_http.py \
       .pi/skills/imagegen/tests/test_comfy_generate.py -q
```

The opt-in live smoke test runs only with `PENNY_IMAGEGEN_LIVE=1`.
