# Agent XML to Markdown Conversion - Handoff Document

## Status: 4 Agents Remaining

**Date:** 2025-11-24
**Session:** Agent conversion continuation
**Remaining Work:** Convert 4 agents from XML to Markdown format

## What's Been Completed

### ✅ Fully Complete
1. **Learnings Infrastructure** - All 24 learnings files created with INDEX sections
2. **develop-learnings Skill** - Complete 5-phase workflow with all resources
3. **agent-protocol-core.md** - Learning Injection Protocol section added (lines 112-200)
4. **quality-validator.md** - Converted to Markdown + Step 0 (359 lines)
5. **clarification-specialist.md** - Converted to Markdown + Step 0 (ready)

### 🟡 Has Step 0, Needs Markdown Conversion
1. **research-discovery.md** - 440 lines, Step 0 at lines 139-161
2. **analysis-agent.md** - 340 lines, Step 0 at lines 109-131
3. **synthesis-agent.md** - 358 lines, Step 0 at lines 125-147
4. **generation-agent.md** - 395 lines, Step 0 at lines 101-123

## Conversion Template

Use `quality-validator.md` and `clarification-specialist.md` as reference templates.

### Conversion Pattern

**YAML Frontmatter:** Keep as-is (lines 1-34 typically)

**Main Structure:**
```markdown
---
[YAML frontmatter - unchanged]
---

# Agent Definition

## Token Budget
[Convert <token_budget> section]

## Identity
[Convert <identity> section]

## [Core Expertise/Capabilities/Functions]
[Convert capability sections]

## Execution Protocol
### Step 0: Learning Injection
[PRESERVE THIS - already correct in XML]

### Step/Phase 1: [Name]
[Convert remaining steps]

## [Additional Sections]
[Convert as needed]

## Output Format Template
[Keep XML template in code block]

## Compression Techniques
[Convert to list]

## Summary
[Final paragraph]
```

### Key Conversion Rules

1. **XML Tags → Markdown Headers:**
   - `<agent_definition>` → `# Agent Definition`
   - `<section>` → `## Section Name`
   - `<subsection>` → `### Subsection Name`

2. **Preserve Step 0 Exactly:**
   - Already formatted correctly in all 4 agents
   - Has correct token budgets and matching triggers
   - Just needs section header conversion

3. **Lists:**
   - `<item>text</item>` → `- text`
   - `<action>text</action>` → `- text`

4. **Bold/Emphasis:**
   - Important terms → `**Term:**`
   - Definitions → `**Definition:** description`

5. **Code Blocks:**
   - Output format templates stay in XML within ```xml blocks
   - This is intentional and correct

## File Locations

All files in: `/home/user/projects/penny/.claude/agents/`

**To Convert:**
- `research-discovery.md`
- `analysis-agent.md`
- `synthesis-agent.md`
- `generation-agent.md`

**Reference Templates:**
- `quality-validator.md` (best reference)
- `clarification-specialist.md` (also good)

## Verification Checklist

After conversion, verify each agent has:
- [ ] YAML frontmatter intact
- [ ] `# Agent Definition` as first heading
- [ ] `## Token Budget` section
- [ ] `## Identity` section
- [ ] `## Execution Protocol` with `### Step 0: Learning Injection`
- [ ] All subsequent steps/phases numbered correctly
- [ ] Output format template in XML code block (intentional)
- [ ] `## Summary` at end
- [ ] No XML tags remaining (except in code blocks)
- [ ] All Step 0 content preserved exactly

## Token Budget per Agent

Rough estimates for conversion:
- **research-discovery:** ~15k tokens (440 lines, most complex)
- **analysis-agent:** ~10k tokens (340 lines)
- **synthesis-agent:** ~11k tokens (358 lines)
- **generation-agent:** ~12k tokens (395 lines)
- **Total:** ~48k tokens for all 4

**Available in fresh session:** 200k tokens
**Required:** ~50k tokens (comfortable margin)

## Quick Start Command for Next Session

```bash
# Navigate to agents directory
cd /home/user/projects/penny/.claude/agents

# Check current format (should see XML tags)
head -50 research-discovery.md | grep "<"

# Reference the converted examples
cat quality-validator.md | head -200

# Start conversion with research-discovery (largest, most complex)
# Then: analysis-agent, synthesis-agent, generation-agent
```

## Success Criteria

✅ All 4 agents converted when:
1. No XML tags outside code blocks
2. All Step 0 sections preserved
3. Markdown formatting consistent with quality-validator.md
4. All content from XML version present in Markdown version
5. Files are clean and readable

## Notes

- **Backups exist:** `.backup` files created before conversion attempt
- **System is functional:** XML format works, this is formatting preference
- **No rush:** Take time to do clean conversions
- **Test after:** Verify agents still have all content by comparing line counts

## Context for Next Session

This task is the final step in implementing the develop-learnings skill system. The skill itself is complete and operational. The agent conversions are a code quality / maintainability improvement to standardize on Markdown format across all agent definitions.

**Priority:** Medium (system works, this improves consistency)
**Complexity:** Low (straightforward XML → Markdown conversion)
**Time:** ~30-45 minutes with fresh token budget
