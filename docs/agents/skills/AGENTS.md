# Skills Feature Index

- [flow-diagrams.md](flow-diagrams.md): Mermaid state diagrams in resources/flow.mmd — requirements and examples
- [loops.md](loops.md): Agentic loop taxonomy (7 classes), termination controls, failure modes, verifier design, task-to-loop mapping, and 5 loop-quality gaps to close
- [mempalace-integration.md](mempalace-integration.md): Context retrieval before workflow, learning storage after
- [orchestration.md](orchestration.md): Engine-backed skill protocol — thin delegate + BasePlaybook subclass, per-state contracts, directives, self-recovery
- [overview.md](overview.md): Skill architecture, directory structure, and how Penny skills extend AgentSkills.io
- [quick-reference.md](quick-reference.md): Quick lookup for skill creation
- [resilience.md](resilience.md): Error handling patterns and recovery strategies for skill orchestrators
- [skill-md-format.md](skill-md-format.md): YAML frontmatter, content sections, prompt layer context, and what does NOT belong in SKILL.md
- [skill-md-template.md](skill-md-template.md): Copy-paste template for new skills with architecture context
- [skill-standard.md](skill-standard.md): Complete reference specification
- [testing.md](testing.md): Unit, integration, E2E test standards, validation checklist

Worked reference implementations live in the repo, not as separate example docs: `.pi/skills/code/SKILL.md` (engine frontmatter + delegate), `apps/orchestration/src/orchestration/playbooks/code.py` and `plan.py` (BasePlaybook subclasses), and `apps/orchestration/tests/test_code_playbook.py` (how playbooks are tested).
