# learned/ — machine-authored, self-improving SAST rules

This is the persistent home for semgrep rules **authored automatically by a
skill's REFLECT phase** — distinct from `../vendor/` (pinned upstream rulesets)
and `../custom/` (hand-authored Tier-2 rules).

## Layout — one subdir per authoring skill

```
learned/
  jsa/   ← rules written by the jsa skill's reflect phase (carren)
  sca/   ← (future) rules written by the sca skill
```

## How they get here

When a run confirms a vulnerability the deterministic semgrep scan missed, the
skill's reflect phase proposes a new semgrep rule. The rule is **validated with
`semgrep --validate` before it is ever written here** (a malformed rule can never
land, so it can never break a future scan), then persisted into its skill's
subdir. See `.pi/skills/jsa/scripts/learned_rules.py`.

## How future runs use them

The skills invoke semgrep with the whole `.pi/extensions/semgrep/rules/` tree as
`--config`, so every `*.yaml` under `learned/**` is loaded automatically on the
next run — the scanner gets permanently more robust each run. (`.semgrepignore`
only prunes scan *targets*; it never affects rule *configs*.)

Rule `id`s are prefixed with `<skill>-learned-` so learned findings are easy to
attribute (e.g. `jsa-learned-dom-xss-createcontextualfragment`).
