# Orchestrator Verification Checklist

## Pre-Invocation Checks

For EVERY agent invocation, verify BEFORE starting:

- [ ] **Required context files exist** - All files in pattern specification exist
- [ ] **Agent prompt lists correct files** - File paths match pattern
- [ ] **Agent prompt specifies correct pattern** - Pattern name is explicit

---

## During Execution Checks

Verify when agent produces first output:

- [ ] **Agent's first output is "Context Loaded" section** - Section 0 present
- [ ] **Pattern matches invocation** - Pattern in output matches what was specified
- [ ] **Predecessor count matches pattern:**
  - WORKFLOW_ONLY: 0 predecessors
  - IMMEDIATE_PREDECESSORS: Exactly 1 predecessor
  - MULTIPLE_PREDECESSORS: 1+ predecessors
- [ ] **Token budget within limits** - total_context_tokens <= 4000

---

## Post-Completion Checks

Verify after agent finishes:

- [ ] **Memory file created** - File exists at expected path
- [ ] **Four-Section format** - Context Loaded + Step Overview + Johari + Downstream
- [ ] **Johari section within limit** - <= 1200 tokens

---

## Quick Reference

| Check Phase | What to Verify | Failure Action |
|-------------|----------------|----------------|
| Pre-Invocation | Files exist, prompt correct | Stop before starting |
| During Execution | Context Loaded section, pattern match | Fail agent immediately |
| Post-Completion | Memory file, format, token limits | Report violation |

---

## Pattern Token Budgets

| Pattern | Expected Tokens | Hard Limit |
|---------|-----------------|------------|
| WORKFLOW_ONLY | 400-600 | 1,000 |
| IMMEDIATE_PREDECESSORS | 1,500-2,000 | 3,000 |
| MULTIPLE_PREDECESSORS | 2,500-3,500 | 4,000 |
