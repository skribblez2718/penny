# Carren Protocol — Reflection & Pattern Learning

> Injected as `skillContext` for carren in the jsa REFLECT phase.

## Mission

Critique the completed analysis session. Identify false positive patterns, missed vulnerability classes, coverage gaps, and systemic weaknesses. Generate actionable pattern corrections for cross-session learning.

## Protocol

### 1. Audit False Positives
Review all findings that vera marked as FALSE_POSITIVE. For each:
- **Why** was it a false positive? (sanitizer, CSP, dead code, test file, server-controlled source)
- **Pattern**: What code pattern caused the FP? Can we add a pre-filter rule?
- **Scanner blame**: Which scanner flagged it? Can we improve its rules?

Generate pattern corrections:
```json
{
  "type": "false_positive_pattern",
  "vuln_class": "dom_xss",
  "pattern": "innerHTML assignment in test files (*.test.js, *.spec.js, __tests__/)",
  "action": "exclude",
  "rule": "skip files matching *_test.js or __tests__/**",
  "scanner": "semgrep",
  "confidence": "high"
}
```

### 2. Audit Missed Vulnerabilities (if known)
If the target has known vulnerabilities (from prior analysis, bug bounty reports, or user feedback), check if our analysis found them. For any MISSED:
- **Why** was it missed? (source not in our catalog, sink not detected, sanitizer bypass not attempted)
- **Pattern addition**: What new source/sink/payload should we add?

```json
{
  "type": "pattern_addition",
  "vuln_class": "dom_xss",
  "pattern": "Range.createContextualFragment() with user input",
  "action": "add_sink",
  "detection": "grep: createContextualFragment\\(|AST: call_expression[function=\"createContextualFragment\"]",
  "severity": "high"
}
```

### 3. Evaluate Coverage
- What % of discovered pages had forms tested?
- What % of JS files were analyzed (vs skipped by pre-filter)?
- Were any analyzer classes completely silent (zero findings)?
- Check: `memory_search(wing="wing_jsa", room="{session_id}-research")` for total inventory vs analyzed count

Flag coverage gaps:
```json
{
  "type": "coverage_gap",
  "description": "80 files had 'innerHTML' sinks but only 45 were analyzed — 35 skipped by pre-filter. Pre-filter threshold may be too aggressive.",
  "recommendation": "Lower pre-filter confidence threshold for dom_xss from 0.8 to 0.5"
}
```

### 4. Cross-Session Pattern Learning
Query existing learnings:
```
memory_search(wing="wing_jsa", room="jsa-learnings", limit=20)
```

Merge new corrections with existing ones. Don't duplicate. If a correction already exists, increment its `occurrence_count`. If a correction contradicts an existing one, flag for human review.

### 5. Store Learnings
```
memory_add_drawer(wing="wing_jsa", room="jsa-learnings", content={
  session_id: "{session_id}",
  timestamp: "{iso_timestamp}",
  target: "{target_url}",
  corrections: [...],
  additions: [...],
  coverage_gaps: [...],
  stats: {
    total_findings: N,
    confirmed: X,
    false_positives: Y,
    coverage_percentage: Z,
    analyzers_silent: ["sqli", "ssrf"]
  }
})
```

### 6. AAAK Diary Entry
Write a compressed session summary:
```
memory_diary_write(agent_name="carren", entry="SESSION:YYYY-MM-DD|jsa-reflection|{target}: {N} findings ({X} confirmed, {Y} FP), {Z}% coverage, {W} pattern corrections|★★★")
```

## Rules
- Corrections must have CAUSAL evidence from this session, not speculation
- Minimum 3 occurrences of the same FP before adding a permanent exclusion rule
- Pattern additions must include exact detection signatures (regex, AST pattern, or semgrep rule)
- Flag corrections that may be target-specific vs generalizable
