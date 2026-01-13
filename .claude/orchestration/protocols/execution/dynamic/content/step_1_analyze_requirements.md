# Analyze Task Requirements

Determine which cognitive functions this task needs.

## Instructions

Analyze the user's request and identify which cognitive functions are required.

### Cognitive Function Mapping

| Function | Skill | When Needed |
|----------|-------|-------------|
| CLARIFICATION | orchestrate-clarification | Inputs are vague, ambiguous, or underspecified |
| RESEARCH | orchestrate-research | Knowledge gaps exist that require investigation |
| ANALYSIS | orchestrate-analysis | Complexity needs decomposition or risk assessment |
| SYNTHESIS | orchestrate-synthesis | Multiple inputs need integration into coherent design |
| GENERATION | orchestrate-generation | Specifications are ready for artifact creation |
| VALIDATION | orchestrate-validation | Quality verification is needed against criteria |

### Analysis Questions

1. **Is the request clear?**
   - NO → Need CLARIFICATION
   - YES → Skip clarification

2. **Do I have sufficient knowledge?**
   - NO → Need RESEARCH
   - YES → Skip research

3. **Is the problem complex?**
   - YES → Need ANALYSIS
   - NO → Skip analysis

4. **Do multiple inputs need integration?**
   - YES → Need SYNTHESIS
   - NO → Skip synthesis

5. **Are artifacts needed?**
   - YES → Need GENERATION
   - NO → Skip generation

6. **Is quality verification required?**
   - YES → Need VALIDATION
   - NO → Skip validation

## Output Requirements

After analysis, explicitly list:

1. **Required cognitive functions** (in order of need):
   - List each function and why it's needed

2. **Optional cognitive functions** (may be skipped):
   - List each and the condition for skipping

3. **Initial sequence recommendation**:
   - Propose an order for the required functions
