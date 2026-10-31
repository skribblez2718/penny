# Tool Authority Profiles

## The problem this solves

Three of Penny's agents used to declare themselves read-only in prose while holding tools
that could fill in forms, upload files, and execute arbitrary code.

Echo's definition said its read-only boundary was **absolute**. Echo also held
`playwright_run_code_unsafe`, whose own description begins "UNSAFE: Execute arbitrary
Playwright Node.js code with full system access." Vera, which "inspects, judges, and
reports", held the same set. So did Annie.

Nothing was exploiting this. The point is narrower and more uncomfortable: the runtime had
no idea those roles were supposed to be read-only. The prose said one thing and the
permission envelope said another, and only the envelope is real. A prompt-level "READ-ONLY"
and a capability-level read-only are different guarantees, and only the weaker one existed.

## What a profile is

Instead of granting tools one at a time, each role declares two things: how much authority
it is allowed to have (`authority`), and which named bundles it draws from
(`tool_profiles`). A CI check expands the bundles and asserts they equal the YAML tool
list exactly. Drift fails the build. Profiles are static lint metadata for that maximum.
Runtime activation follows the [binding runtime rule](../../agents/agents/discovery-and-tools.md#binding-runtime-rule),
including its guarded zero-tool exception. Tasks, trust profiles, runtime state, and optional
services cannot select a subset, and phase selection does not mutate profile assignments.

The bundles form **ladders** — each rung contains everything below it plus a named
increment:

```
filesystem.read  ⊂  filesystem.observe  ⊂  filesystem.write
browser.observe  ⊂  browser.reveal  ⊂  browser.interact  ⊂  browser.execute
```

That shape is deliberate. It makes "how much authority does this role have?" a question
with a one-word answer, and it makes restoring a rung a one-line edit if a reduction turns
out to have been too aggressive.

## Why `browser.reveal` exists

The browser ladder has a rung in the middle that looks redundant and is not.

Clicking a tab, opening an accordion, or hovering to expose a menu are _interactions_, but
their purpose is observation — the information is already on the page, just not rendered
yet. Submitting a form or uploading a file is a different kind of act: it changes something
on the other side.

The middle rung avoids granting dedicated fill/upload/evaluate interfaces just to inspect
a tabbed page. It does not make browser activity read-only: a click or key can submit a form
or change remote state. The target and consequences still need inspection and any required
authorization.

## Why the shell profile is called `shell.unbounded`

There is no `shell.inspect`, and the omission is the point.

`bash` can write files, delete them, install packages, and reach the network. Calling that
"inspection" would be a comfortable lie, and the comfortable lie is what produced the
original problem — a reassuring label standing in for an actual boundary. Naming the
profile `shell.unbounded` keeps the gap visible in the metadata rather than disguised by
the vocabulary.

## What this actually guarantees

This is the part worth reading carefully, because it is easy to overstate.

**Tool-interface exclusion is structural; read-only browser behavior is not.** The
`read`/`inspect` ceiling excludes dedicated fill, upload, and arbitrary Playwright/Node
execution tools. Clicks and keys remain available at `browser.reveal`, with no general
submit guard. A role's no-mutation rule is still an instruction and authorization boundary.

**Shell access is unbounded where granted.** Consult current generated assignments rather
than assuming every role holds `bash`.
An ordinary exact-YAML "read-only" session can still write files, delete them, install
packages, and reach the network — through a single tool that the profile system grants
openly rather than pretending away.

A fixed orchestration phase subset can omit `bash` from that session's model-visible calls.
It does not reduce the Pi process's host permissions, create OS/process sandboxing, or stop
provider extension code from loading. So the honest summary is: the ordinary shell hole is
documented and still open, while a narrow phase surface is a tool-call boundary rather than
process isolation.

Closing the `bash` gap is a separate, harder design problem. The plausible directions are a
command-allowlisted shell wrapper, dropping `bash` from roles that only ever need
`read`/`grep`/`find`/`ls`, or real container isolation. None of them is free, and picking
one prematurely would trade a known limitation for an unknown one.

## What changed

One detail worth recording, because it nearly went the other way: Synthia held only `read`,
not the full observe bundle. Giving it `filesystem.observe` would have made the table
tidier and **broadened** its authority from one filesystem tool to four. A narrower
`filesystem.read` rung was added instead. Tidiness is not a reason to grant permissions.

## Where the details live

The exact ladder, the per-agent assignment, and the CI contract are in the agent-facing
twin: [`docs/agents/agents/tool-profiles.md`](../../agents/agents/tool-profiles.md). That
page's ladder and assignment tables are generated from the checker; its surrounding prose
still requires source review.
