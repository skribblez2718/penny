# Source Quality Criteria

## Purpose

This document defines source quality hierarchies and credibility assessment criteria for research validation. The validation-agent uses these criteria to assess source quality during validation.

## Source Quality Hierarchy

### Tier 1: Primary Sources (High Quality)

**Definition:** Original research, first-hand accounts, authoritative primary documentation

**Source Types:**
- Peer-reviewed academic journals (with impact factor)
- Government publications (.gov domains)
- Official technical documentation from source organizations
- Primary research data and datasets
- Patents and technical specifications
- Original legal documents and legislation
- Direct interviews with subject matter experts
- First-hand experimental results

**Quality Indicators:**
- Published in journals with impact factor > 2.0
- Cited by multiple subsequent works (citation count > 10)
- Authors with established credentials in field
- Rigorous peer review process
- Clear methodology and reproducible results
- Recent publication (within appropriate timeframe for domain)

**Credibility Score:** 1.0

**Usage Guidelines:**
- Prioritize for major claims and core arguments
- Minimum 60% of sources for standard depth, 70% for deep depth
- Always prefer peer-reviewed over non-reviewed when available

### Tier 2: High-Quality Secondary Sources

**Definition:** Expert analysis and synthesis by credible authorities

**Source Types:**
- Academic institution publications (.edu domains)
- Established research institutions (MIT, Stanford, IEEE, ACM)
- Reputable technical organizations (W3C, IETF, ISO standards bodies)
- Expert-authored books from academic publishers
- Technical reports from established think tanks
- Systematic reviews and meta-analyses
- Industry white papers from established companies (with verification)

**Quality Indicators:**
- Author expertise verifiable (credentials, publication history)
- Institutional backing from recognized organizations
- Transparent methodology
- Citations to primary sources
- Editorial oversight or peer review
- Recent and relevant to current state

**Credibility Score:** 0.8

**Usage Guidelines:**
- Acceptable for supporting claims and context
- Should cite primary sources (check citations)
- Good for landscape understanding and comparative analysis

### Tier 3: Credible Tertiary Sources

**Definition:** Reputable journalism, curated content, expert commentary

**Source Types:**
- Established news organizations (NYT, WSJ, BBC, Reuters, AP)
- Reputable technical journalism (Ars Technica, IEEE Spectrum, Nature News)
- Expert blogs from verified domain authorities
- Conference proceedings and presentations
- Technical documentation from established companies
- Wikipedia (with verification of citations)
- Industry publications with editorial standards

**Quality Indicators:**
- Editorial standards and fact-checking processes
- Author bylines with verifiable expertise
- Citations or links to primary sources
- Correction policies in place
- Established publication history
- Domain relevance and focus

**Credibility Score:** 0.6

**Usage Guidelines:**
- Acceptable for context, trends, and general information
- Always verify claims against primary sources when critical
- Good for identifying research directions
- Useful for understanding practical applications

### Tier 4: Questionable Sources (Use with Caution)

**Definition:** Uncurated content, unverified claims, potential bias

**Source Types:**
- Personal blogs without credentials
- Social media posts
- Forums and discussion boards (Reddit, Quora, Stack Overflow answers)
- Marketing content and promotional materials
- Self-published works without peer review
- Anonymous or pseudonymous sources
- Aggregator sites without original content

**Quality Indicators:**
- May lack author credentials
- No editorial oversight
- Potential commercial bias
- Limited or no citations
- Unverifiable claims
- May contain valuable information but requires verification

**Credibility Score:** 0.4

**Usage Guidelines:**
- Use only when no higher-tier sources available
- Require corroboration from multiple sources
- Explicitly note source limitations in research output
- Good for identifying perspectives but not establishing facts
- Stack Overflow accepted answers: usable for technical how-to, not theoretical claims

### Tier 5: Unreliable Sources (Avoid or Flag)

**Definition:** Sources with known credibility issues

**Source Types:**
- Discredited publications or authors
- Sources with documented misinformation history
- Content farms and AI-generated content without verification
- Promotional content disguised as research
- Conspiracy theory sites
- Sources with clear conflicts of interest unacknowledged

**Quality Indicators:**
- Failed fact-checks
- Retracted publications
- Known bias or misinformation patterns
- No author attribution
- Plagiarism detected
- Clickbait headlines disconnected from content

**Credibility Score:** 0.0

**Usage Guidelines:**
- Avoid using as sources
- If encountered, flag and exclude from research
- Note prevalence if indicating disinformation landscape
- Never use for establishing factual claims

## Domain-Specific Adjustments

### Technical/Software Research
- GitHub repositories with high stars (>1K) and active maintenance: Tier 2-3
- Official API documentation: Tier 1
- Stack Overflow accepted answers for practical how-to: Tier 3
- Technical blog posts from library authors: Tier 2

### Medical/Health Research
- Cochrane reviews: Tier 1
- PubMed indexed journals: Tier 1
- FDA/WHO publications: Tier 1
- Health news requires verification against medical journals
- Raise primary source requirement to 80% for deep research

### Legal Research
- Primary legislation and case law: Tier 1
- Law review articles: Tier 1-2
- Legal commentary from practicing attorneys: Tier 2
- Legal blogs: Tier 3 (verify against primary law)

### Business/Market Research
- Market research firms (Gartner, Forrester): Tier 2
- Company financial filings (10-K, 10-Q): Tier 1
- Industry analyst reports: Tier 2
- Business journalism: Tier 3
- Be aware of commercial biases in all business sources

### Historical Research
- Primary historical documents and archives: Tier 1
- Peer-reviewed historical journals: Tier 1
- Historical society publications: Tier 2
- Digitized archives: Tier 1 (verify digitization quality)
- Age of source appropriate to historical period studied

## Currency Requirements

### Recent Topics (Technology, Current Events, Policy)
- **Tier 1-2:** Published within last 2-5 years preferred
- **Tier 3:** Published within last 1-2 years
- **Exception:** Seminal works remain relevant regardless of age

### Stable Topics (Mathematics, Established Science, History)
- **Tier 1-2:** Publication date less critical, focus on authority
- **Classic works:** Timeless value regardless of age
- **Current applications:** May need recent sources for modern context

### Rapidly Evolving Fields (AI, Cryptocurrency, Emerging Tech)
- **Tier 1-2:** Published within last 6-12 months strongly preferred
- **Older sources:** Useful for historical context, not current state
- **Preprints (arXiv):** Tier 2-3 depending on author credentials

## Multi-Source Verification Standards

### Single-Source Claims (Weak)
- Acceptable only for non-critical context
- Must be Tier 1-2 source
- Flag for additional verification if possible

### Two-Source Claims (Moderate)
- Acceptable for supporting claims
- At least one Tier 1-2 source required
- Sources should be independent (not citing each other)

### Three+ Source Claims (Strong)
- Acceptable for major claims
- Majority Tier 1-2 sources
- Independent verification across sources
- Ideal for doctoral-level research

### Contradictory Sources (Requires Resolution)
- Document all perspectives
- Prioritize higher-tier sources for resolution
- If same tier conflict: Present multiple perspectives
- Check recency (more recent may supersede older)
- Consider source potential biases

## Source Metadata Requirements

For each source, catalog:

**Required:**
- Source type (journal, blog, gov, etc.)
- Author (or "Anonymous" if unavailable)
- Publication date
- URL or DOI
- Tier assignment (1-5)

**Recommended:**
- Credibility score (0.0-1.0)
- Citation count (if academic)
- Publisher/institution
- Access date
- Key claims supported by this source

**Optional:**
- Impact factor (if journal)
- Author credentials summary
- Potential biases identified
- Related sources (citations to/from)

## Validation Application

When validation-agent assesses source quality:

1. **Classify each source** using tier hierarchy
2. **Calculate source quality score:**
   ```
   source_quality_score = (
       Σ(credibility_score_i) / total_sources
   )
   ```
3. **Check tier distribution:**
   - Quick: ≥40% Tier 1-2 for score 1.0
   - Standard: ≥60% Tier 1-2 for score 1.0
   - Deep: ≥70% Tier 1-2 for score 1.0
4. **Flag problematic sources:**
   - Any Tier 5 sources → Critical failure warning
   - >40% Tier 4 sources → Quality concern
   - Insufficient Tier 1-2 for depth → Remediation needed
5. **Assess multi-source verification:**
   - Major claims: ≥3 sources (mostly Tier 1-2)
   - Supporting claims: ≥2 sources (at least one Tier 1-2)
   - Context claims: ≥1 source (Tier 3+ acceptable)

## Remediation Guidance

When source quality is insufficient:

**Too many low-tier sources:**
- Suggest specific Tier 1 source types to target
- Provide domain-specific academic databases to search
- Recommend primary source repositories

**Insufficient multi-source verification:**
- List claims needing additional sources
- Suggest alternative search strategies
- Recommend expanding to related keywords

**Outdated sources for recent topics:**
- Specify required publication timeframe
- Suggest current source databases
- Identify specific topics needing updated sources

**Tier 5 sources detected:**
- List specific sources to exclude
- Explain credibility issues
- Suggest reliable alternatives in same domain

## Notes

- Source quality assessment is domain-adaptive—apply appropriate domain adjustments
- When in doubt, prefer transparency: document source limitations explicitly
- Currency is relative to domain: 5-year-old AI paper may be outdated, 50-year-old math proof is timeless
- The goal is reliable research, not perfect sources—balance rigor with practicality
- Tier assignments are guidelines, not absolute rules—use judgment and context
