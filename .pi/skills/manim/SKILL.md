---
name: manim
description: "Generate a render bundle — validated storyboard, Manim scene code composing a render app's primitive library, and narration audio with measured durations — from lesson source files. Use when the user wants authored lessons turned into an educational animation/video bundle. Do not use when the task is rendering, editing, or exporting finished video (the companion render application owns those), or authoring the lesson content itself."
license: MIT
metadata:
  version: "1.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - echo
      - annie
      - piper
      - skribble
      - vera
      - carren
      - synthia
---

# manim — Educational Video Render Bundles

Turn lesson source files (Markdown / JSON / notebooks) into a **render bundle**
the companion render application (e.g. Superpose) consumes: a schema-valid
storyboard, one generated Manim scene per storyboard entry composing the app's
primitive library, and per-scene narration audio with measured durations.
The skill **never renders** — no Manim execution, no FFmpeg.

## When to Use

- Authored lesson material exists and you want a 3Blue1Brown-style video bundle.
- The render app's primitive-library schema export is available (a JSON file).
- You want human review of the design (canon gate) before mass generation.

## When NOT to Use

- Rendering/preview/export — the render application owns that loop.
- Authoring the lessons themselves (that is `learn` / normal authoring).
- Local source-tree review (`sca`) or live-URL JS analysis (`jsa`).

## Invocation

```
skill({
  skill_name: "manim",
  goal: "Produce a video bundle for the superposition lesson",
  project_root: "/path/to/penny",
  constraints: {
    lesson_path: "/path/to/lessons/qc-03",        // REQUIRED
    output_dir: "/path/to/bundles",               // REQUIRED
    primitive_schema: "/path/to/primitives.json", // REQUIRED (app's schema export)
    // optional:
    video_id: "qc-03-superposition",
    theme: "quantum-dark",
    voice_id: "narrator-en",
    voice_studio_url: "http://127.0.0.1:8001",    // loopback-only enforced
    target_duration_minutes: 8,
    max_scenes: 20,                                // budget (clamped to 60)
    max_fan_width: 4,                              // ingest fan budget
    max_iterations: 3,                             // verify⇄fix budget
    allow_estimated_durations: true,               // proceed if Voice Studio is down
    ingest_branches: {"concepts": "…"}             // caller topology skips scoping
  }
})
```

## States

```
intake → scoping(echo) → ingesting(echo fan) → designing_canon(annie) → canon_gate(HITL)
   storyboarding(piper) → narrating(TOOL: Voice Studio) → authoring(skribble, per-scene loop)
   → verifying(vera) ⇄ fixing(skribble) → critiquing(carren) → packaging(synthia) → complete
```

| State | Type | Run by | Job |
|---|---|---|---|
| scoping | AGENT | echo | Emit the ingest fan topology (model-owned) |
| ingesting | PARALLEL | echo | Read-only lesson inventory per focus |
| designing_canon | AGENT | annie | ALL global decisions: scene boundaries, visual vocabulary, notation, theme, narration register, pronunciation rules |
| canon_gate | GATE | you | Approve / refine / deny before the expensive span |
| storyboarding | AGENT | piper | storyboard.json against the locked canon |
| narrating | TOOL | — | Voice Studio synth → bundle audio/ + measured durations (audio-first) |
| authoring | AGENT | skribble | One scene file per pass, primitives only, duration-aware |
| verifying | AGENT | vera | Static evidence via `scripts/validate_bundle.py` (py_compile/AST/signatures/durations) |
| fixing | AGENT | skribble | Repair cited violations; always re-verifies |
| critiquing | AGENT | carren | Pedagogy, pacing, visual clarity (judgment after evidence) |
| packaging | AGENT | synthia | manifest.json + report.md; degraded flags |

## Guarantees

- **Never renders, never executes generated code** (verification is static).
- **Audio-first sync**: narration synthesized (or explicitly estimated) before
  any scene is authored; durations are hard constraints.
- **Bounded, honest loops**: verify⇄fix capped by `max_iterations`; exhaustion
  packages a degraded bundle with `met=False` and itemized unresolved issues.
- **Voice Studio down** → actionable failure (or estimation fallback when
  explicitly allowed) — never a crash, never silent.
- **SSRF-safe narration**: loopback-only host, no redirects, timeout-bounded.
- **Compatibility seam**: the bundle manifest records the primitive-library
  version it was generated against; the app refuses mismatches.

## Resources

- `resources/reference.md` — what good math animation is; bundle contract.
- `resources/storyboard-schema.json` — the storyboard JSON Schema.
- `resources/flow.mmd` — state diagram mirroring the playbook machine.
- `scripts/validate_bundle.py` — the static validator (vera's evidence).
- `scripts/voice_client.py` — hardened loopback Voice Studio client.

## Testing

```
pytest apps/orchestration/tests/test_manim_playbook.py -q
```
Hermetic: schema/output/narration seams stubbed; no Voice Studio required.
