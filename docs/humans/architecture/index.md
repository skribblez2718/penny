# Architecture Documentation

This is the human-facing hub for Penny's architecture. Start with the
[overview](overview.md) for the whole path from a request to a durable result. Use
the [Penny glossary](../glossary.md) for unfamiliar terms and the
[human-documentation hub](../index.md) to browse other domains. For broader
project orientation, see the [Penny README](../../../README.md).

| Document                                            | What it explains                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Overview](overview.md)                             | How guidance, routing, artifacts, checkpoints, and optional memory fit together                              |
| [Project Standards](project-standards.md)           | How one current canonical implementation is maintained, challenged, and replaced with evidence               |
| [Bitter-Lesson Doctrine](bitter-lesson.md)          | Why Penny protects capabilities and safety outcomes while treating model-limiting scaffolding as replaceable |
| [Atomic Loop Components](atomic-loop-components.md) | Optional concepts for composing policy-led, verifiable loops without imposing one universal procedure        |
| [Tiered Memory](tiered-memory.md)                   | The conceptual T0–T4 memory model and the boundary between memory, artifacts, and checkpoints                |
| [Binary Image Artifacts](binary-artifacts.md)       | Exact-ID PNG delivery, canonicalization, bounded decoding, and model capability checks                       |
| [Asynchronous Host Operations](host-operations.md)  | Registered host adapters, durable operation journals, global leases, fencing, and quarantine                 |
| [Safe Image Generation](image-generation.md)        | Private profiles, typed admission, deterministic candidates, conservative retry, PNG validation, and export  |
| [Video Generation Foundation](video-generation.md)  | What provider-free checks establish, and why finished video/native delivery remains blocked                  |
| [Skill Tool Modes](skill-tool-modes.md)             | A compatibility pointer to the canonical skill capability and orchestration documentation                    |
