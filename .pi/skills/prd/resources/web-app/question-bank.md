# Web App — Deriving Clarifying Questions

This replaced a fixed list of ~40 questions with enumerated technology options
(“React, Vue, Angular, Svelte…”, “Vercel, AWS, GCP, Railway…”). Two problems with a
bank: the option lists date the moment they are written, and asking from a list
produces questions the brief already answered — noise the user has to wade through.

Measured: on both recorded runs the `generic` pack, which has **no** question bank,
produced sharper questions than a bank would have — because they were derived from the
specific gaps in the specific brief.

## Derive the questions

Ask exactly the questions whose answers you need and cannot infer. Concretely:

1. **Fill the artifact.** You must emit an IDEAL_STATE with measurable
   `success_criteria`, a requirement catalog, and a verification strategy per
   requirement. Any field you cannot fill honestly from the brief is a question.
2. **Every threshold needs provenance** (`nfr-checklist.md`). If you would otherwise
   invent a number, ask for the measurement instead.
3. **Name the decision that changes the design.** A question is worth asking only if
   different answers produce different requirements. If both answers lead to the same
   spec, decide it yourself and record it as an assumption.
4. **Surface the irreversible and the hostile.** What must not silently break, what
   the trust boundary is, what happens on the failure path.
5. **Confirm scope boundaries you are about to write down.** A user who says "out of
   scope: X" in an answer is cheaper than a reviewer who finds X in §6 and disagrees.

## Areas worth a look when the brief is thin

Prompts for *your* thinking, not a script to read out. Skip any the brief settles.

- **Shape**: rendering/deployment model; whether there is a browser surface at all
- **Data**: what is stored, where, what must survive a restart, what is regulated
- **Identity**: who authenticates, how sessions/tokens are handled, what authorises
- **Boundaries**: which third parties are involved, what happens when they are down
- **Operations**: how it ships, how it is observed, who is paged
- **Constraints**: existing stack decisions you must live inside, and what may not change

## Cost discipline

Questions are not free — each one is a round trip for the user. Ask the ones that
change the spec; assume the rest, and write the assumption down in §9 where it can be
corrected. If the brief is already sufficient, ask nothing and synthesise.
