---
description: Polish a rough prompt into a clear instruction, then execute it
argument-hint: "<rough prompt>"
---

I have a rough or underspecified instruction below.

1. **Internally polish** it into a precise, well-structured prompt using ONLY the information I provided.
2. **Show me** the polished prompt inside a `<polished>` XML block so I can audit your understanding.
3. **STOP and ask for my confirmation or edits** before executing. Do not proceed with implementation until I explicitly approve the polished prompt.

## Polish constraints

- Do not add requirements, constraints, facts, file names, or technologies I did not mention.
- Do not change my goal or scope.
- Preserve my tone and level of detail.
- If critical context is missing, note "Needs clarification: ..." and proceed with what you have.

## Rough instruction

$@
