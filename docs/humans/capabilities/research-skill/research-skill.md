# Research Skill

Conduct structured, evidence-based research on any topic with automatic depth detection and parallel sub-query dispatch.

## Overview

The research skill is a production-grade research workflow that gathers evidence from the web, assesses source credibility, resolves conflicting findings, and synthesizes a coherent report. It operates at three depths:

| Mode         | When Used                                        | What It Does                                                          | Approx. Time |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------------- | ------------ |
| **Quick**    | Simple questions, definitions, overviews         | Direct research + brief report                                        | 1-2 min      |
| **Standard** | Multi-faceted questions, comparisons             | Plan sub-queries → parallel research → synthesis                      | 3-5 min      |
| **Deep**     | Complex topics, tradeoff analysis, due diligence | Plan + critique → parallel research → validate → synthesis + critique | 8-12 min     |

## How to Use

Invoke the skill with a research query:

```
skill({
  skill_name: "research",
  goal: "What are the tradeoffs of microservices vs monoliths?"
})
```

### Optional Constraints

| Constraint      | Type   | Default     | Description                                                |
| --------------- | ------ | ----------- | ---------------------------------------------------------- |
| `mode`          | string | `"auto"`    | Override auto-detection: `"quick"`, `"standard"`, `"deep"` |
| `report_format` | string | `"default"` | `"default"`, `"brief"`, `"academic"`, `"executive"`        |

### Auto-Detection

The skill detects mode automatically from your query:

- **Quick triggers:** "what is", "define", "overview", "quickly", short single-question queries
- **Deep triggers:** "deep research", "comprehensive", "thorough", "detailed analysis"
- **Standard:** Everything else

## What You Get

After the skill completes, Penny presents:

1. **Executive Summary** — 3-4 sentence top-line
2. **Key Findings** — Most important findings with confidence levels
3. **Sources** — Count and quality distribution (T1-T4 tiers)
4. **Recommendations** — Actionable next steps
5. **Constraints** — Hard limits and unknowns

The full report is stored in mempalace and can be retrieved anytime.

## Credibility Framework

Sources are assessed using a 4-tier system:

| Tier | Name                   | Examples                                      |
| ---- | ---------------------- | --------------------------------------------- |
| T1   | Primary/Authoritative  | Official docs, RFCs, arXiv papers, specs      |
| T2   | Expert/Established     | ACM Queue, official blogs, recognized experts |
| T3   | Community/Practitioner | High-vote SO, dev.to, tutorials               |
| T4   | Unverified/Commercial  | Product pages, SEO content, unknown blogs     |

**Confidence markers:**

- ✅ High — multiple authoritative sources agree
- ⚠️ Medium — some credible support
- ❓ Low — thin or lower-tier evidence
- ⚡ Conflicting — sources disagree

## Deep Mode: What Makes It Different

Deep mode adds two quality gates:

1. **Plan critique** — A second agent reviews the research plan before dispatch to catch gaps or low-value sub-queries
2. **Report critique** — A second agent reviews the final report for overclaiming, bias, and fairness to conflicting evidence

Additionally, deep mode includes **verification** — URL verification, cross-reference checks, and systematic conflict resolution using a 5-step hierarchy (tier authority → recency → consensus → context match → escalation).

## When NOT to Use

- Simple lookups (use `web_search` directly)
- Code implementation (use `plan` skill then execute)
- Already have sufficient information (proceed directly)
- Very time-sensitive queries where 8-12 minutes is too long (use quick mode or direct search)

## Resuming Research

Research sessions can be interrupted and resumed. If a session times out or is paused, the skill stores its state in mempalace. Re-invoking with the same query or session ID resumes from where it left off.
