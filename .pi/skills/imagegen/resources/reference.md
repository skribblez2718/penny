# imagegen — ComfyUI reference (condensed)

Condensed from `plans/blog/20-comfyui-image-generation.md` (verified live
2026-07-11). The full doc has the download script, model licenses, and the
canvas/UI workflow; this file is the skill-facing subset: endpoints, presets,
detail scaffolds, and the wordless-illustration policy.

## Environment (facts)

| Thing | Value |
|---|---|
| Endpoint | `http://127.0.0.1:8188` (loopback only — never exposed) |
| Service | systemd `comfy-ui.service`, `--enable-manager`, user `comfy-ui` |
| Models dir | `/home/comfy-ui/comfy-ui/models/{checkpoints,diffusion_models,text_encoders,vae,loras}` |
| Health | `GET /system_stats` |

The skill talks to this host and **only** this host. The `comfy_http` client's
allow-list is pinned to `127.0.0.1:8188`; any other host is refused (SSRF guard).

## HTTP API (the automation path)

| Endpoint | Use |
|---|---|
| `POST /prompt` | body `{"prompt": <api-graph>, "client_id": "<uuid>"}` → `{prompt_id}` |
| `GET /history/{prompt_id}` | poll until present; `outputs[*].images[]` lists results |
| `GET /view?filename=..&subfolder=..&type=output` | fetch the PNG bytes |
| `GET /object_info` | node schemas incl. installed-model enums (readiness) |
| `GET /system_stats`, `/queue` | health + queue state |

The skill submits **one candidate at a time** (ComfyUI is single-queue); it never
batches multiple candidates into a graph and never submits concurrently.

## Preset registry (routing table)

| Preset (file) | Model | Style scaffold | LoRA | Key settings | Prompt field | Use for |
|---|---|---|---|---|---|---|
| `blog-flux-steampunk.api.json` | FLUX.1 dev | steampunk hyper-detail | steampunk_illustration (optional) | guidance 3.5, cfg 1.0, 30 steps, 1536×1024 | `3.text` | branded blog art |
| `learning-qwen.api.json` | Qwen-Image | hyperreal concept | — | cfg 4.0, 30 steps, 1664×928, anti-text neg | `4.text` | lesson / concept visuals |
| `hero-flux.api.json` | FLUX.1 dev | clean minimal abstract | — | guidance 3.5, cfg 1.0, 30 steps, 1664×928 | `3.text` | premium abstract headers |
| `general-flux.api.json` | FLUX.1 dev | none (caller supplies) | — | guidance 3.5, cfg 1.0, 30 steps, 1664×928 | `3.text` | anything else |

**Routing heuristic (deterministic — `route_preset`):**
- steampunk / brass / clockwork / blog / branded → `blog-flux-steampunk`
- lesson / concept / explain / diagram / flowchart / teach → `learning-qwen`
- hero / abstract / header / banner / minimal → `hero-flux`
- everything else / caller-specified style → `general-flux`

A caller-specified valid preset always wins over the heuristic.

## Required vs optional models (readiness)

Readiness fails **hard** (before any generation) if a preset's REQUIRED model is
absent, naming the file:
- `blog-flux-steampunk`, `hero-flux`, `general-flux` → `flux1-dev-fp8.safetensors`
- `learning-qwen` → `qwen_image_fp8_e4m3fn.safetensors`, `qwen_2.5_vl_7b_fp8_scaled.safetensors`, `qwen_image_vae.safetensors`

The **only** optional model is `steampunk_illustration.safetensors` (blog preset).
Missing → **WARN + fall back to base FLUX** (the LoRA strength is zeroed in the
constructed graph). Never a hard failure.

## Detail scaffolds (composing)

The single biggest quality lever is prompt detail vocabulary. Naming specific
textures/lighting pulls out fine detail.

**Blog (FLUX + steampunk):** keep trigger `steampunk illustration` at prompt
start. Append: *intricate exposed clockwork with visible gear teeth, fine etched
engravings, filigree and copper piping, weathered brass patina, tiny rivets,
richly textured detail, layered graphic-novel linework with cross-hatching,
glowing amber rim light, volumetric light, hyper-detailed, ultra intricate.*
LoRA strength `0.8`, FluxGuidance `3.5`, steps `30`, **cfg `1.0`** (FLUX steers
via guidance, not cfg), size `1536×1024`.

**Learning (Qwen):** describe the **concrete mechanism** (beam → filter → wave),
not just a mood. Append: *hyper-realistic 3D render, cinematic science
illustration, subsurface scattering, ray-traced reflections, volumetric god rays,
fine microdetail, sharp focus, shallow depth of field, octane render, physically
based rendering, Ultra HD, 4K.* cfg `4.0`, steps `30`, size `1664×928` or
`1328×1328`. Anti-text negative is the default.

**Hero (FLUX, no LoRA):** clean/abstract wordless headers. guidance `3.5`, steps
`30`, cfg `1.0`, 16:9.

**General (FLUX, no LoRA, no scaffold):** the caller supplies the entire style.

## Wordless policy (non-negotiable)

**All illustrations are wordless.** We never bake text/labels into an image — a
wordless negative (`text, words, letters, numbers, labels, captions, typography,
watermark, signature`) is applied to every generation regardless of preset or
raw-prompt override. Labels are added later as an HTML/SVG overlay in the media
pipeline (crisp, correct, restyleable). v1 does not block a positive prompt that
*mentions* text; it only enforces the negative.

## Provenance / reproduction

Every run writes a `manifest.json` capturing the preset, positive/negative
prompts, base seed (fixed if supplied, else recorded random), per-candidate seed
+ constructed-graph SHA-256, and the produced file paths. Same
`preset + seed + prompt + settings` reconstructs a **byte-identical** graph
(`graph_hash`), so any candidate is exactly re-generatable and prompt-tweak
iterable. Only paths + metadata are persisted — never image bytes.
