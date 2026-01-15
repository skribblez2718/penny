# Research Validation Rubric

## Purpose

This rubric defines quality criteria for research output validation. The validation-agent applies these criteria to research findings before synthesis.

## Validation Criteria

### 1. Factual Accuracy (Weight: 0.30)

**Definition:** Do claims match cited sources?

**Evaluation Method:**
- Sample-check 20% of major claims by verifying against cited sources
- Cross-reference key facts across multiple sources
- Identify any misrepresentations or misattributions

**Scoring:**
- 1.0: All sampled claims accurately reflect sources
- 0.8: Minor discrepancies in 1-2 claims, overall accuracy maintained
- 0.6: Several claims misrepresent sources or lack proper context
- 0.4: Major factual errors present, significant misattribution
- 0.0: Critical factual errors, claims contradict sources

**Critical Failure:** Any claim that directly contradicts its cited source

### 2. Citation Accuracy (Weight: 0.25)

**Definition:** Are citations formatted correctly and sources accessible?

**Evaluation Method:**
- Verify citation format consistency
- Test sample of URLs for accessibility
- Check that citations match claims (right source cited)
- Ensure all major claims have citations

**Scoring:**
- 1.0: All citations properly formatted, accessible, and correctly attributed
- 0.8: 1-2 broken links or minor formatting inconsistencies
- 0.6: Multiple broken links (10-20%) or significant formatting issues
- 0.4: Many citations missing or inaccessible (20-40%)
- 0.0: Majority of citations broken or claims lack citations

**Critical Failure:** More than 40% of sources inaccessible or major claims uncited

### 3. Source Quality (Weight: 0.25)

**Definition:** Are primary sources prioritized over secondary? Are sources credible?

**Evaluation Method:**
- Assess source types against quality hierarchy (see source-quality-criteria.md)
- Calculate percentage of primary vs secondary sources
- Evaluate source credibility (peer-reviewed, established institutions, expert authors)
- Check publication dates for currency

**Scoring:**
- 1.0: >60% primary/high-quality sources, all credible, recent
- 0.8: 40-60% primary sources, mostly credible, some older sources
- 0.6: 20-40% primary sources, mix of credibility levels
- 0.4: <20% primary sources, questionable credibility, outdated
- 0.0: No primary sources, low-credibility sources, severely outdated

**Critical Failure:** Reliance on discredited or known-biased sources for major claims

### 4. Completeness (Weight: 0.15)

**Definition:** Are all research subtopics adequately addressed?

**Evaluation Method:**
- Verify coverage of all defined subtopics from research scope
- Check for information gaps within each subtopic
- Assess depth appropriate to research_depth parameter
- Ensure query count meets depth targets

**Scoring:**
- 1.0: All subtopics comprehensively covered, no gaps
- 0.8: Minor gaps in 1-2 subtopics, overall coverage good
- 0.6: Several subtopics under-researched, noticeable gaps
- 0.4: Major subtopics missing or inadequately covered
- 0.0: Critical subtopics entirely missing

**Critical Failure:** Core research question aspects left unaddressed

### 5. Conflict Resolution (Weight: 0.05)

**Definition:** Are contradictory claims acknowledged and explained?

**Evaluation Method:**
- Identify conflicting claims in findings
- Verify conflicts are documented
- Assess whether resolution approach is appropriate
- Check that multiple perspectives are presented fairly

**Scoring:**
- 1.0: All conflicts identified, resolved with clear rationale, fair presentation
- 0.8: Most conflicts addressed, minor omissions
- 0.6: Some conflicts unacknowledged or poorly resolved
- 0.4: Major conflicts ignored or biased resolution
- 0.0: Contradictions presented without acknowledgment

**Critical Failure:** Major contradictions hidden or misrepresented

## Overall Scoring

**Formula:**
```
overall_score = (factual_accuracy × 0.30) +
                (citation_accuracy × 0.25) +
                (source_quality × 0.25) +
                (completeness × 0.15) +
                (conflict_resolution × 0.05)
```

**Pass Threshold:** 0.75

**Gate Status:**
- **PASS:** overall_score ≥ 0.75 AND no critical failures
- **FAIL:** overall_score < 0.75 OR any critical failure detected

## Depth-Specific Adjustments

### Quick Depth
- Reduce factual accuracy sampling to 10%
- Allow 2-3 broken links without penalty
- Accept 40%+ primary sources as sufficient
- Reduce completeness requirement (major themes covered)

### Standard Depth
- Use standard criteria as defined above
- No adjustments

### Deep Depth
- Increase factual accuracy sampling to 30%
- Zero tolerance for broken links in academic sources
- Require 70%+ primary sources for full score
- Demand comprehensive completeness (all subtopics deeply covered)

## Remediation Guidance

When validation fails, provide specific actionable guidance:

### Factual Accuracy Issues
- List specific claims needing re-verification
- Suggest additional cross-reference sources
- Identify areas requiring deeper source reading

### Citation Accuracy Issues
- List broken URLs needing replacement or archive lookup
- Identify uncited claims requiring sources
- Specify formatting corrections needed

### Source Quality Issues
- List low-quality sources to replace with primary sources
- Suggest specific high-quality source types to target
- Identify outdated sources needing current alternatives

### Completeness Issues
- List specific subtopics requiring additional research
- Specify minimum query count needed for adequate coverage
- Suggest specific information gaps to address

### Conflict Resolution Issues
- List unacknowledged conflicts requiring documentation
- Suggest resolution approaches (source hierarchy, multiple perspectives)
- Identify biased presentations needing balance

## Validation Confidence Scoring

After scoring research quality, assess confidence in validation itself:

- **HIGH:** All criteria fully assessed, sufficient sampling, clear pass/fail
- **MEDIUM:** Some criteria partially assessed, adequate sampling, likely accurate
- **LOW:** Limited assessment possible, small sample size, uncertain accuracy
- **INSUFFICIENT:** Cannot adequately validate (e.g., sources mostly inaccessible)

**Action:** If validation confidence < MEDIUM, document limitations and consider additional validation pass.

## Notes

- This rubric follows industry best practices (Agent GPA Framework, LLM-as-Judge patterns)
- Weightings reflect importance: factual accuracy paramount, then citation/source quality
- Critical failures immediately trigger FAIL regardless of overall score
- Remediation guidance should be specific and actionable to enable effective research loop
- Validation is embedded quality assurance, not bureaucratic overhead—focus on meaningful quality metrics
