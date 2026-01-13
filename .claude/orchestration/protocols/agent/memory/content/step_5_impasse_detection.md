# Impasse Detection

## Instructions

1. **Check for CONFLICT Impasse** (Highest Priority)
   - Are there contradictory requirements?
   - Do hard constraints conflict with each other?
   - Did previous decisions create impossible situations?
   - **Evidence:** Contradictory goals, incompatible directives

2. **Check for MISSING-KNOWLEDGE Impasse**
   - Does the Unknown Registry have unresolved blocking items?
   - Did research find no relevant information?
   - Are critical parameters undefined?
   - **Evidence:** Unresolved blocking unknowns, empty research results

3. **Check for TIE Impasse**
   - Are there multiple equally-valid options?
   - Is there insufficient criteria to choose between alternatives?
   - Did analysis produce equivalent-weighted choices?
   - **Evidence:** Multiple alternatives, no selection criteria

4. **Check for NO-CHANGE Impasse** (Lowest Priority)
   - Does output repeat input without addition?
   - Did agent explicitly state inability to proceed?
   - Is output significantly shorter than expected?
   - **Evidence:** Repeated patterns, circular reasoning, stagnation

## Classification Requirements

- Require **multiple indicators** for high-confidence classification
- For ambiguous cases, default to **lower confidence**
- Priority ordering: CONFLICT > MISSING-KNOWLEDGE > TIE > NO-CHANGE

## Confidence Scoring

| Level | Criteria |
|-------|----------|
| CERTAIN (0.9+) | Multiple strong indicators |
| PROBABLE (0.7-0.9) | Single strong indicator |
| POSSIBLE (0.5-0.7) | Weak indicators |
| UNCERTAIN (<0.5) | Ambiguous evidence |

## Completion Criteria

- [ ] All four impasse types evaluated
- [ ] Impasse type classified (or NONE)
- [ ] Confidence score assigned
- [ ] Evidence documented for classification
- [ ] Ready to proceed to Remediation Determination
