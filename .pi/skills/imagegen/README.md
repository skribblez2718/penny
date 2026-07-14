# imagegen

Local image generation over the self-hosted ComfyUI HTTP API, as a
`BasePlaybook` orchestration skill.

- **What:** framing → composing → generating → critiquing → [adjusting →
  generating]\* → presenting, across 4 presets (blog steampunk, learning concept,
  hero abstract, general), with a vera+carren parallel critique, a bounded revise
  loop, and a provenance manifest for exact reproduction.
- **Where:** the FSM lives in
  `apps/orchestration/src/orchestration/playbooks/imagegen.py` (registered in
  `playbooks/__init__.py`); the HTTP client + CLI live in `scripts/`.

## Layout

```
.pi/skills/imagegen/
├── SKILL.md                     # skill card (routing, states, guarantees, security)
├── README.md                    # this file
├── assets/prompts/
│   ├── annie.md                 # framing
│   ├── synthia.md               # composing / adjusting
│   ├── vera.md                  # critique — technical validity oracle
│   └── carren.md                # critique — aesthetic + brief fidelity
├── resources/
│   ├── reference.md             # condensed ComfyUI reference
│   └── presets/
│       ├── blog-flux-steampunk.api.json
│       ├── learning-qwen.api.json
│       ├── hero-flux.api.json
│       └── general-flux.api.json
├── scripts/
│   ├── comfy_http.py            # hardened client + deterministic graph builder
│   └── comfy-generate.py        # provenance CLI (--count/--seed/--manifest/--set)
└── tests/
    ├── conftest.py
    ├── test_comfy_http.py       # SSRF, traversal fuzz, graph determinism, real-server E2E
    └── test_comfy_generate.py   # CLI helpers + entry-point-from-own-dir
```

## Quick CLI use

```bash
# 3 candidates from the hero preset with a manifest:
python3 .pi/skills/imagegen/scripts/comfy-generate.py hero-flux \
    --set 3.text="a glowing abstract data construct" --count 3 \
    --out /tmp/imagegen_run --manifest /tmp/imagegen_run/manifest.json

# Reproduce an exact prior render (fixed seed):
python3 .pi/skills/imagegen/scripts/comfy-generate.py blog-flux-steampunk \
    --set 3.text="steampunk owl professor" --seed 777
```

## Testing

```bash
# Hermetic suite (no live ComfyUI):
pytest apps/orchestration/tests/test_imagegen_playbook.py \
       .pi/skills/imagegen/tests -q

# Opt-in live smoke (needs comfy-ui.service on 127.0.0.1:8188):
PENNY_IMAGEGEN_LIVE=1 pytest apps/orchestration/tests/test_imagegen_live_smoke.py -q
```

## Security posture

SSRF (loopback allow-list + redirect refusal), path-traversal guards on `/view`,
dict-built `/prompt` payloads (no string concatenation), candidate clamping +
single-queue submission, and metadata-only persistence (never image bytes). See
`SKILL.md` → Security.

## Provenance

Each run writes `manifest.json` (preset, prompts, base seed, per-candidate seed +
graph SHA-256, file paths). Same `preset + seed + prompt + settings` →
byte-identical constructed graph → exact reproduction / prompt-tweak iteration.
