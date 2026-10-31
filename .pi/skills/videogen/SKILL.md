---
name: videogen
description: "Drive a gated story-to-video workflow with voice, current reviews and local master/native-project delivery. Use when an operator has explicitly installed private runtime providers and requests exact-name execution. Do not use without those providers, for external publication, or as evidence of live production qualification."
disable-model-invocation: true
metadata:
  penny:
    engine: orchestration
    mempalace: false
    subagents: ["annie", "carren", "demetri", "echo", "ida", "piper", "skribble", "synthia", "vera"]
---

# Videogen

## When to Use

Run the hidden, registered story → script → G1 → references/voice → G2 → animatic → G3 → drafts/rough → G4 → finals/finish → G5 → local delivery workflow with explicit private host configuration.

## When Not to Use

Do not invoke without explicit private activation, exact provider/profile bindings and current rights. Do not use for external publication, automatic qualification, model-selected backends or silent substitutes for voice. Optional informational children require a separate explicit parent-only binding; ordinary seven-child authority is unchanged.

## Invocation

Enter the native Pi command:

```text
/skill:videogen <description>
```

Pi loads this package through normal native discovery. No additional resource hook or manual
`--skill` flag is needed. Use `/reload` in an already-running session after package changes.
Keep `disable-model-invocation: true` to omit videogen from automatic model advertising while
preserving manual invocation. The skill extension must still supply the registered entrypoint.

Pi expands this manifest and appends the description; the parent model must then call
the registered `skill` tool. Expansion alone does not execute or approve a workflow.
The description alone is not a complete request: ask for missing request fields rather
than inventing paths, rights, routes or budgets.

Exact-name ingress is registered but hidden from automatic model discovery. A trusted host must construct the skill extension with `createSkillExtension({ videogen: privateProviders })`, or construct `OrchestrationService` with `playbookName: "videogen"` and the same `videogen` providers. Alternatively, the default extension loads `PENNY_VIDEOGEN_RUNTIME_MANIFEST_FILE`, an explicit owner-only private JSON manifest. Without either binding, construction refuses before creating a run. See [private-runtime.md](resources/private-runtime.md) for the closed manifest and qualification limits.

Invoke `skill_name: "videogen"` with `goal` equal to the request brief and `constraints` containing the complete closed `penny.videogen-request.v1` value. All paths, profiles, rights, limits and local destinations belong to private host bindings; public code supplies no deployment defaults. See [reference.md](resources/reference.md).

## Exact Artifact Handoff

Cognitive stages receive owner-selected exact `input_artifacts` IDs/refs, read each needed ID with `artifact_read` through `next_range`, and return complete stage content for owner capture before routing. Memory availability cannot affect workflow correctness and is not handoff transport.

## Output

The intended terminal is the exact `penny.videogen-terminal.v1` artifact, exposing `output_artifact_ref` only after owner capture. Positive delivery requires both a reviewed audible master and a relocated, reopenable native Kdenlive package plus current gates, rights, settled effects and local readbacks. Isolated tests drive the executor and publish synthetic products, not playable films or qualified native projects. Provider-free native-command tests establish command-path conformance through real-engine G1 only, with fixture cognition; they do not establish live parent-model dispatch, a completed film or all-route qualification. No live production or route qualification is claimed.

## Recovery and Escalation

The runtime uses exact `status`, `recover`, `respond` and `cancel` against the shared engine run ID and journals. Independent human playback is captured through the trusted host service API before answering its clarification gate. No memory, name search or filesystem scan may recover a missing predecessor. Missing qualification or evidence is a blocker, never an implied approval.
