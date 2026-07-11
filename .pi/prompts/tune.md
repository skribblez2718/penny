---
description: Interactively tune Penny — rate recent work, generate & review amendments, run evals & trust, all in this conversation
argument-hint: "[how-many-recent-sessions] [deep]"
---

You are running Penny's improvement cycle ("tune") **interactively, in this conversation**. Walk the user through it step by step, pausing for their judgment on the human-decision steps. Run every script with the repo venv: `.venv/bin/python`. Do NOT use `make` (its interactive prompts need a terminal); call the scripts directly with the flags below — they take all input as arguments.

The user's judgment is authoritative on ratings and approvals. Your job is to **present faithfully and record** — never to decide a rating yourself, and never to editorialize the work in a way that could bias the user.

## Argument parsing (FR-7)

Parse the user's arguments to extract two values:

- **`count`** — the number of recent sessions to rate (integer, default `10`). Extract the first bare numeric token.
- **`deep`** — whether to run the end-phase producer refresh (boolean, default `false`). Set to `true` if the literal word `deep` appears anywhere in the arguments.

All five variants parse as follows:

| Command | count | deep |
|---------|-------|------|
| `/tune` | 10 | false |
| `/tune 20` | 20 | false |
| `/tune deep` | 10 | true |
| `/tune 20 deep` | 20 | true |
| `/tune deep 20` | 20 | true |

When `deep` is `false`, run Steps 1–5 and Close only — **no Step 6, no Step 3 trajectory exception** (backward compatibility). When `deep` is `true`, also run Step 6 after Step 5 and apply the Step 3 trajectory exception.

Use `${count}` in place of `${1:-10}` throughout.

## Step 1 — Rate recent work (the user judges)

Fetch unrated sessions (goal + the actual response):

    .venv/bin/python scripts/system/outcome_ledger/rate_recent.py --list --limit ${count}

This prints JSON `{"unrated": [{session_id, goal, response, domain}, ...]}`. For **each** unrated session, present to the user:
- the **raw goal, verbatim**, and
- a **faithful excerpt of the response** — show what actually happened; do not summarize in a slanted way.

Then ask them to rate it **match / partial / mismatch**. For partial or mismatch, ask for a one-line reason and (optionally) a failure category, one of: `misread_request, incomplete, wrong_result, unverified_claim, missing_constraint, wrong_intermediate, scope_creep, refused_wrongly, other`.

Record each rating (the categorical `--failure-mode` is what makes recurring failures cluster into amendments):

    .venv/bin/python scripts/system/outcome_ledger/rate_recent.py --record \
      --session <session_id> --verdict <match|partial|mismatch> \
      --reason "<one-line reason>" --failure-mode <category>

For a `match`, `--reason`/`--failure-mode` are unnecessary. Confirm each recorded decision_id back to the user.

## Step 2 — Generate amendments (automated)

    .venv/bin/python scripts/system/self_improve/run_compression.py

Report how many amendments were generated (it clusters the failure categories you just recorded).

## Step 3 — Review amendments (the user approves / applies)

    .venv/bin/python scripts/system/self_improve/review_amendments.py list

This lists amendments needing action, each with a status: **PENDING** (still to review) or **APPROVED** (reviewed, awaiting apply). Handle each by its status:

- **PENDING** — show it (`review_amendments.py show <id>` renders the exact proposed diff: target file + the verbatim old→new text) and ask the user to **approve / reject / skip**:

      .venv/bin/python scripts/system/self_improve/review_amendments.py approve <id>
      .venv/bin/python scripts/system/self_improve/review_amendments.py reject <id>

  `approve` requires a concrete diff (verbatim `old_text`/`new_text`) — it refuses an empty/vague amendment, since approval authorizes applying that exact text. `reject` works from PENDING **or** APPROVED, so a human can always walk back an approval.

- **APPROVED** — reviewed; ask whether to apply now or leave it for later. It stays on this list until applied or rejected, so it won't be lost.

For any amendment the user **explicitly** asks to apply:

    .venv/bin/python scripts/system/self_improve/review_amendments.py apply <id>

Note: applying the approved diff **is** the human-in-the-loop, so `apply` writes the exact approved change to **any** target file (skill prompt, config, docs, code, or SYSTEM.md) and **git-commits** it (gated by the trajectory ratchet). The one hard line: a change touching the immutable security-directives block (`<system_directives>`/`<system_boundary>`) is refused even when approved. Apply only on explicit go-ahead, one at a time, and report the result. Approved-but-unapplied amendments keep showing (here and in the session brief) until applied or rejected.

### Step 3 exception — trajectory staleness (FR-9, deep mode only)

When `deep` is `true`, before applying any amendment, check whether the trajectory producer is stale:

    .venv/bin/python -c "
    import sys; sys.path.insert(0, 'scripts/system/evals')
    from tune_freshness import check_all_stale
    results = check_all_stale()
    info = results.get('trajectory', {})
    print(f\"trajectory: {info.get('reason', 'unknown')} (stale={info.get('stale', False)})\")
    "

If trajectory is **stale or invalidated**, warn the user:

> ⚠️ The trajectory ratchet gate that `apply` relies on is based on stale results
> ({reason}). The gate may not reflect current system behavior. Consider running
> `make trajectory` (or `/tune deep` Step 6) before applying amendments so the
> ratchet is trustworthy. You can proceed anyway — the gate still runs, just on
> older data.

This exception does **not** block the apply — it surfaces the risk so the user
can make an informed call. Skip this check entirely when `deep` is `false`.

## Step 4 — Evals (automated)

    .venv/bin/python scripts/system/evals/run_evals.py

Summarize what moved: any regression (which metric) or improvement against the ratchet.

## Step 5 — Trust (automated)

    .venv/bin/python scripts/system/autonomy/dashboard.py

Summarize per-domain trust and whether any domain is near graduating toward unattended action.

## Step 6 — Refresh stale producers (FR-8,10,15,19, deep mode only)

> **Skip this step entirely when `deep` is `false`** (backward compatibility).

This step refreshes the expensive eval producer artifacts (trajectory, prompt
efficacy, judgment) that have gone stale or been invalidated. It runs **only**
stale/invalidated producers — fresh ones are skipped. Each producer runs with
**default models** (no `--models` / `--driver-model` / `--judge-model` flags),
sequentially, with errors caught and reported but never fatal.

### 6a — Check which producers are stale

    .venv/bin/python -c "
    import sys, json; sys.path.insert(0, 'scripts/system/evals')
    from tune_freshness import check_all_stale
    results = check_all_stale()
    for producer, info in results.items():
        status = 'STALE' if info['stale'] else 'FRESH'
        print(f\"  {producer}: {status} — {info['reason']} (age: {info.get('age_days', '?')}d)\")
    "

Report the results to the user. If all producers are fresh, say so and skip to
Step 6c (signal resolve).

### 6b — Re-run each stale producer (sequential, default models)

For each stale/invalidated producer, run the corresponding script. **Do not
pass `--models`, `--driver-model`, or `--judge-model` flags** — use default
models. Run them one at a time, report each result, and continue on failure.

The scripts (use the repo venv):

| Producer | Script |
|----------|--------|
| trajectory | `scripts/system/trajectory/run_trajectory.py` |
| prompt_efficacy | `scripts/system/evals/run_prompt_efficacy.py` |
| judgment | `scripts/system/judgment/run_judge_agreement.py` |

Example invocation for a stale trajectory:

    .venv/bin/python scripts/system/trajectory/run_trajectory.py

For each producer:
1. Run the script.
2. Report whether it succeeded or failed (with a brief error summary on failure).
3. Continue to the next stale producer — a failure in one does not block the others.

### 6c — Resolve tune_due signals (FR-11,12)

After all stale producers have been refreshed (or attempted), resolve any
PENDING `tune_due` signals so the session brief stops surfacing a reminder
that has been acted on:

    .venv/bin/python -c "
    import sys; sys.path.insert(0, 'scripts/system/watchers')
    from signal_generators import resolve_tune_due_signals
    count = resolve_tune_due_signals('tune_deep')
    print(f'Resolved {count} tune_due signal(s)')
    "

Report how many signals were resolved.

## Close

Give a short summary: how many sessions rated (and the verdict split), how many amendments generated / approved / applied, and any eval or trust movement. If nothing needed attention at a step, say so and move on.

When `deep` is `true`, also include in the close summary:
- Which producers were stale and which were refreshed (or failed).
- How many tune_due signals were resolved.