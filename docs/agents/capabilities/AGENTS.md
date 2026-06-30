# Capabilities Feature Index

- [Agent Skill](agent-skill/AGENTS.md): Generate validated Penny agent definitions from a goal using a 7-state FSM
- [Ambient Watchers](ambient-watchers/AGENTS.md): Signal generation, session-start checks, proactive awareness
- [Error Logging](error-logging/AGENTS.md): Structured error codes from logger.ts; human-readable cross-reference
- [JSA Skill](jsa-skill/AGENTS.md): Multi-agent JavaScript security analysis pipeline with SAST, structure/slice lanes, and browser PoC verification
- [Observability Server](observability-server/AGENTS.md): FastAPI + SQLite backend for log ingestion, session history queries, and watcher signal diagnostics
- [Outcome Ledger](outcome-ledger/AGENTS.md): When to record decisions, how the feedback flow works, delta score conventions
- [Plan Skill](plan-skill/AGENTS.md): Structured planning workflow that explores, plans, critiques, and taskifies goals into execution-grade steps
- [PRD Skill](prd-skill/AGENTS.md): Generate layered PRDs (narrative + atomic requirements + verification matrix + IDEAL_STATE) from a goal
- [Progress Heartbeats](progress-heartbeats/AGENTS.md): Staleness-based progress monitoring replacing naive kill-timer for long-running agents
- [Research Skill](research-skill/AGENTS.md): Structured research workflow with Quick/Standard/Deep modes, parallel evidence gathering, and synthesis
- [Skill Tool](skill-tool/AGENTS.md): Four invocation modes (single/parallel/chain/resume) mirroring subagent tool architecture
- [Tiered Memory](tiered-memory/AGENTS.md): 5-tier architecture (T0–T4), injection protocols, token budgets, distillation pipeline
- [Unknown State](unknown-state/AGENTS.md): FSM handling when agent cannot proceed; UNKNOWN_STATE protocol
- [Verification State](verification-state/AGENTS.md): High-stakes FSM gate; counter-argument generation, mempalace outcome lookup
- [Weekly Digest](weekly-digest/AGENTS.md): Accountability summaries, digest generation script
- [XSS Skill](xss-skill/AGENTS.md): Find, verify, and report stored/reflected XSS vulnerabilities with production-safe payloads
