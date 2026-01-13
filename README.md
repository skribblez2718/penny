# Penny - A Digital Assistant Built on CAII

## Acknowledgments

This project is built upon the foundational work and inspiration from **Daniel Miessler's Personal AI Infrastructure (PAI)** project. Without his knowledge, vision, and open sharing of ideas, this project would likely not exist.

[danielmiessler/Personal_AI_Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure/)

---

Penny is a personal Digital Assistant implementation built on the [Cognitive Augmented Intelligence Infrastructure (CAII)](https://github.com/skribblez2718/caii) framework.

---

![Cognitive Augmented Intelligence Infrastructure](img/penny.png)

---

While CAII shares PAI's goal of providing a highly customizable system to augment humans with AI, it takes a fundamentally different approach. This implementation sometimes diverges from popular opinion and Claude Code documentation, though these divergences are based on my personal research and experimentation. Notable differences include:

- **Cognitive-first agent design** - Rather than task or domain-specific agents, CAII uses agents organized by cognitive function (clarification, research, analysis, synthesis, generation, validation, memory). This approach draws inspiration from established cognitive architectures, particularly [ACT-R](https://act-r.psy.cmu.edu/about/) (Adaptive Control of Thought—Rational) developed by John Anderson at Carnegie Mellon University, and [Soar](https://soar.eecs.umich.edu/), created by Allen Newell, John Laird, and Paul Rosenbloom. ACT-R models cognition through the interaction of declarative memory (facts and knowledge) and procedural memory (production rules), while Soar uses universal subgoaling and chunking to automatically generate goal hierarchies and compile learned behaviors into efficient rules. CAII's memory agent and learning systems became heavily influenced by these architectures—particularly Soar's chunking mechanism, which converts complex reasoning into automatic/reactive processing over time. The decision to use cognitive-based agents versus task/domain-specific agents stemmed primarily from maintainability concerns. As the system grows, so would the number of task-specific agents, and so would the overhead in maintaining them. Claude Code also supports only a limited number of agents before "performance may degrade." With the cognitive approach, we should only ever need a small number of agents that receive context "on the spot," adapting to any domain without modification.

- **External skill protocols** - Skill orchestration logic lives in Python protocols rather than within SKILL.md files. This is probably the biggest divergence from Claude Code documentation. In practice, I noticed that some steps in Markdown-based protocols would be skipped, resulting in errors or otherwise undesired behavior. This appeared to stem from using prompting (protocols in Markdown files) in conjunction with the non-deterministic nature of LLMs—main steps would be followed, but sub-steps were skipped at the LLM's discretion. "Pythonizing" the skill protocols was the solution: skill protocols are now managed from the relevant directory under `.claude/orchestration/protocols/skill/`, while basic information still resides in `SKILL.md` and relevant resources in `.claude/skills/{skill-name}/resources/`. This ties in with...

- **Mandatory Python orchestration** - A Python layer enforces protocol adherence through deterministic state machines, rather than relying on prompting alone. This approach is rooted in the principles of [rule-based AI and expert systems](https://en.wikipedia.org/wiki/Symbolic_artificial_intelligence) (sometimes called "Good Old-Fashioned AI" or GOFAI), which dominated AI research in the 1970s-80s. Systems like MYCIN and DENDRAL demonstrated that deterministic IF-THEN production rules could achieve expert-level performance in specific domains. However, prompting alone cannot guarantee an LLM will take the same steps every time due to its inherent non-determinism. The goal here is to use Python to prompt the LLM one step at a time, strictly following a given protocol to obtain more consistent results. While the non-deterministic nature of AI will execute a given step slightly differently each time, by enforcing the same process we gain more consistency and transparency in how results are generated. 

- **Johari Window framework** - Systematic discovery using the SHARE/ASK/ACKNOWLEDGE/EXPLORE model to surface unknowns, ensure they are considered, and hopefully answered by task completion. The [Johari Window](https://en.wikipedia.org/wiki/Johari_window) is a psychological framework originally developed by Joseph Luft and Harrington Ingham in 1955 to help people understand their relationship with themselves and others through four quadrants: Open (known to both), Hidden (known to self), Blind (known to others), and Unknown (known to neither). The idea for applying this to LLM prompting stemmed from finding an approach that would minimize ambiguity. Even well-written and well-structured prompts have ambiguity, which I believe stems from the fact "we don't know what we don't know." For example, you may begin a task thinking you've identified all critical aspects, but then realize something you initially missed. This is what I mean by "ambiguity" beyond the obvious definition. The Johari approach leverages what you know and what the LLM knows to help identify and clarify these ambiguities and missed aspects up front. Additionally, there are things that neither you nor the LLM will inherently know up front. The Johari protocol identifies these and ensures they are considered throughout task execution. As the task progresses and new information becomes available, these unknowns are updated. The aim is to reduce the chance the LLM goes off and does something you did not intend.

- **Agent-First Approach** - CAII routes cognitive work through specialized agents rather than having the Directing Agent (DA) execute tasks directly. This is supported by two execution routes: the Skill route (for tasks matching defined skill patterns) and the Dynamic orchestration route (for tasks requiring ad-hoc agent sequencing). In Claude Code, agents get their own context windows, which enables this approach to achieve two primary goals:
  - **Domain expertise** - Each cognitive agent (clarification, research, analysis, synthesis, generation, validation, memory) specializes in its function, ensuring the relevant portion of each task is handled by a "domain expert"
  - **Context efficiency** - By delegating cognitive work to agents with their own context windows, the DA's context window remains as clean as possible, preserving capacity for coordination and user interaction

This is an experimental approach that may not suit every use case, but it represents one possible direction for human-AI augmentation systems.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Prompt Flags](#prompt-flags)
4. [Extending the System](#extending-the-system)
5. [Memory and Learnings System](#memory-and-learnings-system)
6. [The Johari Window Approach](#the-johari-window-approach)
7. [Core Philosophy](#core-philosophy)
8. [Architecture Overview](#architecture-overview)
9. [The Directing Agent (DA)](#the-directing-agent-da)
10. [Reasoning Protocol](#reasoning-protocol)
11. [Deterministic Orchestration + Non-Deterministic Execution](#deterministic-orchestration--non-deterministic-execution)
12. [Execution Routes](#execution-routes)
13. [Cognitive Domain Agents](#cognitive-domain-agents)
14. [Skills Architecture](#skills-architecture)
15. [Directory Structure](#directory-structure)

---

## Overview

CAII is a **cognitive orchestration framework** for Claude Code that transforms how AI assistants approach complex tasks. Instead of relying on ad-hoc prompting, CAII enforces systematic reasoning through Python-orchestrated protocols before any task execution.

**Core Goals:**
- **Systematic reasoning** - Every query goes through a 9-step reasoning protocol by default (bypass with `-b` flag)
- **Domain-adaptive agents** - 7 cognitive agents that adapt to any domain without modification
- **Progressive learning** - The system learns from each workflow, requiring less instruction over time

**Key differentiator:** CAII combines Python-enforced deterministic orchestration ("guaranteed" step sequences) with LLM non-determinism (creative execution within each step). This ensures protocol adherence while preserving the flexibility that makes LLMs powerful.

```
                              USER QUERY
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │   REASONING PROTOCOL     │
                    │   (9 Steps: 0-8)         │
                    │   Default: ON (-b: OFF)  │
                    └──────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
           ┌───────────────┐          ┌──────────────────┐
           │    SKILL      │          │    DYNAMIC       │
           │ ORCHESTRATION │          │ SKILL SEQUENCING │
           └───────────────┘          └──────────────────┘
                    │                           │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │   COGNITIVE AGENTS       │
                    │   (7 Specialists)        │
                    └──────────────────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │   MEMORY FILES           │
                    │   + LEARNINGS            │
                    └──────────────────────────┘
```

---

## Quick Start

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Python 3.8+ installed
- Git installed

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/skribblez2718/caii.git
   cd caii
   ```

2. **Configure settings**
   ```bash
   cp .claude/settings.example.json .claude/settings.json
   ```

3. **Set required environment variables**

   Edit `.claude/settings.json` and populate the required values in the `env` section:

   ```json
   {
     "env": {
       "DA_NAME": "YourAssistantName",
       "CAII_DIRECTORY": "/absolute/path/to/caii",
       "PROJECT_ROOT": "/absolute/path/to/your/projects"
     }
   }
   ```

4. **Start Claude Code**
   ```bash
   claude
   ```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DA_NAME` | Yes | Name of your Directing Agent (displayed in responses) |
| `CAII_DIRECTORY` | Yes | Absolute path to the CAII installation directory |
| `PROJECT_ROOT` | Yes | Path where all projects exist and new projects are created |
| `VOICE_SERVER_PORT` | No | Port for text-to-speech voice server ([voice-server](https://github.com/skribblez2718/voice-server)) |
| `OPENAI_BASE_URL` | No | OpenAI-compatible endpoint for external model enhancements |
| `OPENAI_API_KEY` | No | API key for the OpenAI-compatible endpoint |
| `OPENAI_SUMMARIZATION_MODEL` | No* | Model ID for summarization (used with voice server) |
| `OPENAI_PROMPT_IMPROVER_MODEL` | No* | Model ID for the `-i` flag prompt improvement |

*Requires `OPENAI_BASE_URL` and `OPENAI_API_KEY` to be set.

The system can be extended by adding additional environment variables in `settings.json`.

### Basic Usage

1. **Start a conversation** - Any query triggers the reasoning protocol by default
   ```
   User: "Help me build an authentication system"
   ```

2. **Expect clarifying questions** - Step 0 may identify unknowns
   ```
   Claude: "Before proceeding, I need to understand:
            1. What authentication methods? (OAuth, JWT, session-based)
            2. What's the target platform?
            ..."
   ```

3. **Observe structured execution** - Tasks route through cognitive agents systematically

### Viewing Memory Files

```bash
ls .claude/memory/
cat .claude/memory/{task_id}-{agent}-memory.md
```

### Key Points

- **Reasoning runs by default** - Bypass with `-b` flag when not needed
- **Clarification is expected** - The system asks before assuming
- **Learnings accumulate** - The system improves over time

---

## Prompt Flags

CAII supports prompt flags that modify how queries are processed. Flags can appear in any order at the end of a prompt.

### Available Flags

| Flag | Purpose |
|------|---------|
| `-i` | Improve prompt via external model before processing |
| `-b` | Bypass reasoning protocol (direct execution mode) |

### Examples

```
"fix the bug -b"         → Bypass reasoning, execute directly
"add feature -i"         → Improve prompt, then run reasoning
"refactor code -i -b"    → Improve prompt, then bypass reasoning
"refactor code -b -i"    → Same as above (order doesn't matter)
```

### Prompt Improvement (-i flag)

The `-i` flag sends your prompt to an external model for improvement before processing:

```
User: "build me a web app -i"
    │
    ▼
Hook detects "-i" flag
    │
    ▼
Sends to external model for improvement
    │
    ▼
Returns improved prompt
    │
    ▼
Normal reasoning protocol continues (unless -b also specified)
```

**Configuration** - Required environment variables:

```bash
OPENAI_BASE_URL="https://your-api-endpoint"
OPENAI_API_KEY="your-key"
OPENAI_PROMPT_IMPROVER_MODEL="model-name"
```

### Bypass Mode (-b flag)

The `-b` flag skips the 9-step reasoning protocol entirely, allowing Claude to handle the prompt directly. Useful for:

- Trivial tasks (typo fixes, simple renames)
- Follow-up prompts where context is already established
- Quick questions that don't require systematic reasoning

**Note:** The `-b` flag bypasses all reasoning steps, so use it when you're confident the task doesn't benefit from structured analysis.
**Note:** While the reasoning protocol is executed in Plan Mode as part of developing the plan (assuming no `-b` flag is passed), the reasoning protocol does not execute after exiting plan mode and executing the plan. This was initially unintentional, but I think the behavior makes sense.
---

## Extending the System

CAII provides only the **minimum required skills** out of the box. The system is designed as a foundation for building domain-specific extensions.

### Creating New Skills

Use the **develop-skill** meta-skill:

```
User: "Create a code-review skill"
    │
    ▼
develop-skill workflow (6 phases)
    │
    ▼
1. Requirements Clarification
2. Complexity Analysis
3. Pattern Research
4. Design Synthesis
5. Skill Generation
6. DA.md Registration
    │
    ▼
New skill ready to use
```

### Skill Templates

Located in `.claude/skills/develop-skill/resources/`:

| Template | Use Case |
|----------|----------|
| simple-skill-template.md | 2-3 phases, straightforward workflow |
| complex-skill-template.md | 4+ phases, conditional logic |
| atomic-skill-template.md | Single agent wrapper |

### What Gets Generated

For a new composite skill:

```
.claude/skills/{skill-name}/
├── SKILL.md                    # Skill definition
└── resources/                  # Skill-specific resources

.claude/orchestration/protocols/skill/composite/{skill_name}/
├── entry.py                    # Entry point
├── complete.py                 # Completion handler
├── __init__.py                 # Module init
└── content/                    # Prompts/instructions executed for each phase
    ├── phase_0_*.md
    ├── phase_1_*.md
    └── ...
```

The `content/` directory contains the actual prompts and instructions that get executed for each skill phase. This is where manual editing of skill protocols should occur if needed. When adding or removing steps, it is recommended to have your DA handle this to ensure any related Python code is updated accordingly.

Plus registration in:
- `config/config.py` (phase definitions)
- `DA.md` (semantic triggers)
- `skill-catalog.md` (documentation)

---

## Memory and Learnings System

### Goal: Progressive Autonomy

The memory system's goal is to need to **tell the system less over time**. As learnings accumulate, the system in theory requires fewer explicit instructions and makes better decisions autonomously.

**The Learnings Workflow:**

1. **Learning Injection** - Before performing any tasks, agents have explicit instructions to check the learnings index (`.claude/learnings/`) for relevant learnings that apply to their cognitive function
2. **Memory Creation** - Upon task completion, agents always create a memory file in the memory directory (`.claude/memory/`)
3. **Learning Extraction** - The `develop-learnings` skill uses these memory files to extract insights and add structured learnings to the learnings directory

This cycle ensures that valuable discoveries from each workflow are captured and made available for future tasks.

### Memory File Contract

Every agent MUST produce a memory file at:
```
.claude/memory/{task_id}-{agent}-memory.md
```

**Mandatory sections:**

| Section | Content |
|---------|---------|
| Section 0: Context Loaded | JSON verification of what was loaded |
| Section 1: Step Overview | What was accomplished, key decisions |
| Section 2: Johari Summary | Open/Hidden/Blind/Unknown (1,200 tokens max) |
| Section 3: Downstream Directives | Instructions for next agent/phase |

**Critical:** Phase advancement **BLOCKS** until the memory file exists. There is no bypass mechanism.

### Learnings Directory Structure

```
.claude/learnings/
├── clarification/
│   ├── heuristics.md
│   ├── anti-patterns.md
│   ├── checklists.md
│   └── domain-snippets/
├── research/
├── analysis/
├── synthesis/
├── generation/
└── validation/
```

### Learning Types

| Type | Purpose |
|------|---------|
| **heuristics** | Rules of thumb that improve decisions |
| **anti-patterns** | Mistakes to avoid |
| **checklists** | Verification steps |
| **domain-snippets** | Domain-specific knowledge |

### Learning Injection (Step 0)

Every agent's Step 0 loads relevant learnings before task work:

```
Step 0: Learning Injection
    │
    ▼
Load .claude/learnings/{cognitive_function}/*.md
    │
    ▼
Inject relevant learnings into agent context
    │
    ▼
Step 1: Begin actual work
```

### Impasse Detection

The memory agent monitors for four impasse types:

| Impasse | Description | Remediation |
|---------|-------------|-------------|
| CONFLICT | Contradictory requirements | Invoke clarification |
| MISSING-KNOWLEDGE | Required info absent | Invoke research |
| TIE | Multiple valid options, no criteria | Invoke analysis |
| NO-CHANGE | No meaningful progress | Re-invoke with enhanced context |

### Creating Learnings

Learnings are created via the **develop-learnings** skill after workflows complete:

```
Completed Workflow → develop-learnings skill → 7 phases → Learnings committed
```

---

## The Johari Window Approach

CAII is built around the **Johari Window** framework for systematic discovery. The core mission: **transform unknown unknowns into known knowns**.

### The Four Quadrants

| Quadrant | What It Represents | Action |
|----------|-------------------|--------|
| **Open** | Known knowns - what both parties understand | Share explicitly |
| **Hidden** | Known unknowns - what we know we don't know | Ask to discover |
| **Blind** | Unknown knowns - gaps we don't realize exist | Acknowledge through probing |
| **Unknown** | Unknown unknowns - what neither party recognizes | Explore systematically |

### The SHARE/ASK/ACKNOWLEDGE/EXPLORE Framework

Every interaction begins with Step 0 of the reasoning protocol, which applies this framework:

- **SHARE** - What can be inferred from the user's prompt
- **ASK** - What critical information is missing (max 5 clarifying questions)
- **ACKNOWLEDGE** - Boundaries, assumptions, and constraints
- **EXPLORE** - Unknown unknowns that should be considered

### Why This Matters

The Johari Window approach prevents:
- **Premature execution** - Acting before understanding
- **Assumption errors** - Building on unstated requirements
- **Scope creep** - Missing boundaries and constraints
- **Blind spots** - Overlooking critical considerations

**Mission statement:** "Every interaction must advance collective understanding or it has failed."

---

## Core Philosophy

CAII is built on five non-negotiable principles that guide all system design decisions.

### Principle 1: Radical Modularity

Every component performs **ONE task exceptionally well**. This is the Single Cognitive Responsibility Principle (SCRP):

- Each agent handles exactly one cognitive function
- Components can be understood in isolation
- Dependencies are minimal and explicit

### Principle 2: Orchestration-Implementation Separation

The boundary between WHAT and HOW is sacred:

- **Skills** define WHAT happens (workflow orchestration, phase sequences)
- **Agents** define HOW tasks execute (implementation details)
- Skills NEVER contain implementation logic
- Agents NEVER contain workflow orchestration

### Principle 3: Zero Redundancy

- Never repeat system definitions, protocols, or references
- Create reference files for shared elements
- Single point of change for all system components
- If something is used twice, it becomes a reference file

### Principle 4: Token Efficiency

Maximize succinctness without sacrificing necessary detail:

- Progressive context compression between phases
- Johari Window format with strict token limits (1,200 max per agent)
- Decision-focused documentation (WHAT was decided, not HOW)
- Reference previous findings rather than repeating them

### Principle 5: Systematic Reasoning

ALL agents implement these prompting strategies:

| Strategy | Purpose |
|----------|---------|
| **Chain of Thought (CoT)** | Explicit step-by-step reasoning |
| **Tree of Thought (ToT)** | Multiple solution path exploration |
| **Self-Consistency** | Cross-verification of conclusions |
| **Socratic Method** | Self-interrogation for clarity |
| **Constitutional AI** | Self-critique against principles |

---

## Architecture Overview

CAII operates as a layered system where each layer has distinct responsibilities.

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLAUDE CODE                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐    ┌───────────────────┐    ┌────────────┐  │
│  │     DA.md      │◄──►│     Python        │◄──►│   Hooks    │  │
│  │  (Coordination │    │  Orchestration    │    │  (Entry    │  │
│  │   Framework)   │    │     Layer         │    │   Points)  │  │
│  └────────────────┘    └───────────────────┘    └────────────┘  │
│                               │                                  │
│                               ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      PROTOCOLS                            │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │   │
│  │  │  Reasoning   │  │  Execution   │  │    Agent     │    │   │
│  │  │  (9 Steps)   │  │  (2 Routes)  │  │  (7 Agents)  │    │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                               │                                  │
│                               ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                       SKILLS                              │   │
│  │  ┌────────────────┐        ┌────────────────┐            │   │
│  │  │  Atomic Skills │        │   Composite    │            │   │
│  │  │  (7 wrappers)  │        │    Skills      │            │   │
│  │  └────────────────┘        └────────────────┘            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**How the pieces connect:**

1. **Hooks** intercept user prompts and trigger the Python orchestration layer
2. **Python Orchestration** enforces protocol adherence through mandatory directives
3. **Protocols** define the step sequences for reasoning, execution, and agents
4. **Skills** orchestrate which agents to invoke and in what order
5. **Agents** perform the actual cognitive work
6. **Memory/Learnings** persist knowledge between sessions

---

## The Directing Agent (DA)

### What the DA is NOT

- NOT an executing agent that performs tasks
- NOT one of the 7 cognitive agents
- NOT invoked via the Task tool

### What the DA IS

The DA is a **coordination framework** defined in `DA.md` that:

- Establishes the system's identity and mission
- Orchestrates the 6 task-performing agents through Python orchestration
- Enforces the mandatory reasoning protocol before any task execution
- Routes tasks to the appropriate execution path

### Key Responsibilities

| Responsibility | Description |
|---------------|-------------|
| **Enforce Reasoning** | Every query goes through 9 steps (0-8) by default (bypass with `-b`) |
| **Route Tasks** | Direct to Skill Orchestration or Dynamic Skill Sequencing |
| **Maintain Discovery** | Apply Johari Window principles to every interaction |
| **Verify Outputs** | Apply confidence scoring and assumption declaration |

### Default Behavior

**The reasoning protocol executes for every user query by default.** The `user-prompt-submit` hook triggers the reasoning protocol before Claude sees any prompt. However, users can bypass this with the `-b` flag for trivial tasks or follow-up prompts where systematic reasoning is unnecessary.

---

## Reasoning Protocol

The reasoning protocol is a **9-step sequence (Steps 0-8)** that runs by default for every user query. This ensures systematic reasoning before any task execution. Users can bypass this protocol using the `-b` flag when systematic reasoning isn't needed.

```
Step 0: Johari Window Discovery
        │
        ▼
Step 1: Semantic Understanding
        │
        ▼
Step 2: Chain of Thought
        │
        ▼
Step 3: Tree of Thought
        │
        ▼
Step 3b: Skill Detection
        │
        ▼
Step 4: Task Routing ──────────────────┐
        │                              │
        ▼                              │ (Skipped in Agent Mode)
Step 5: Self-Consistency               │
        │                              │
        ▼                              │
Step 6: Socratic Interrogation         │
        │                              │
        ▼                              │
Step 7: Constitutional Critique        │
        │                              │
        ▼                              │
Step 8: Knowledge Transfer ◄───────────┘
        │
        ├──► PROCEED (dispatch to execution)
        │
        ├──► HALT (ask clarifying questions)
        │
        └──► LOOP_BACK (contradiction detected, retry Steps 4-8)
```

### Step Descriptions

| Step | Name | Purpose |
|------|------|---------|
| 0 | Johari Discovery | Apply SHARE/ASK/ACKNOWLEDGE/EXPLORE framework |
| 1 | Semantic Understanding | Parse and understand the query's meaning |
| 2 | Chain of Thought | Break down the problem step-by-step |
| 3 | Tree of Thought | Explore multiple solution paths |
| 3b | Skill Detection | Identify if a known skill pattern matches |
| 4 | Task Routing | Determine execution route (skill vs dynamic) |
| 5 | Self-Consistency | Cross-verify conclusions for coherence |
| 6 | Socratic Interrogation | Challenge assumptions through questioning |
| 7 | Constitutional Critique | Verify against system principles |
| 8 | Knowledge Transfer | Final checkpoint with PROCEED/HALT/LOOP_BACK |

### Critical Rule

**If Step 0 identifies clarifying questions, the protocol HALTS and asks before proceeding.** This prevents wasted effort on tasks with unclear requirements.

### Agent Mode

When agents execute (they're already routed), they use `--agent-mode` which skips Step 4:
```
Steps: 0 → 1 → 2 → 3 → 3b → 5 → 6 → 7 → 8
                        (Step 4 skipped)
```

---

## Deterministic Orchestration + Non-Deterministic Execution

### The Problem with Prompting Alone

Prompting alone **cannot guarantee strict protocol adherence**. LLMs may:

- Skip steps when they seem unnecessary
- Reorder operations based on perceived efficiency
- Combine steps that should be separate
- Forget to save state before proceeding

### The Solution: Python Orchestration

Python scripts output **mandatory Markdown directives** that Claude must execute:

```
**MANDATORY - EXECUTE IMMEDIATELY BEFORE ANY OTHER ACTION:**
`python3 step_1_semantic_understanding.py --state {file}`

DO NOT proceed with any other action until this command is executed.
```

### Key Enforcement Mechanisms

| Mechanism | Purpose |
|-----------|---------|
| `format_mandatory_directive()` | Wraps commands in enforcement language |
| **FSM (Finite State Machine)** | Validates legal state transitions |
| **State Persistence** | State saved BEFORE printing next directive |
| **Blocking Verification** | Phase advancement blocks until memory file exists |

### What's Deterministic vs Non-Deterministic

| Deterministic (Python Enforced) | Non-Deterministic (LLM Flexibility) |
|--------------------------------|-------------------------------------|
| Step sequence (always 0-8) | Content of each step's output |
| State transitions | Creative reasoning within steps |
| Memory file creation | How to phrase clarifying questions |
| Phase advancement | Solution design decisions |
| Skill selection routing | Code generation approaches |

### Crash Recovery

Because state is persisted before directives are printed:
- If crash occurs mid-step: Resume from saved state
- Session ID enables recovery: `entry.py --resume {session_id}`

---

## Execution Routes

After the reasoning protocol completes, execution flows through ONE of two routes.

### Route 1: Skill Orchestration

Used when the task matches a **formal skill pattern** (e.g., "create a new skill").

```
Reasoning Step 4 Output: "skill-orchestration"
    │
    ▼
protocols/execution/skill/entry.py
    │
    ▼
Phase 0 (Clarification) → Phase 1 → ... → Phase N
    │
    ▼
Each phase invokes: orchestrate-{agent} atomic skill
    │
    ▼
Agent produces memory file
    │
    ▼
advance_phase.py (BLOCKS until memory file exists)
```

### Route 2: Dynamic Skill Sequencing

Used when the task requires **multiple cognitive functions but doesn't match an existing skill**.

```
Reasoning Step 4 Output: "dynamic-skill-sequencing"
    │
    ▼
protocols/execution/dynamic/entry.py
    │
    ▼
1. Analyze Requirements
2. Plan Sequence (determine which orchestrate-* skills)
3. Invoke Skills (sequence of atomic skills)
4. Verify Completion
5. Complete
```

---

## Cognitive Domain Agents

CAII uses **7 cognitive agents**, each specializing in exactly one cognitive function.

### Agent Roster

| Agent | Cognitive Function | Purpose |
|-------|-------------------|---------|
| **clarification** | CLARIFICATION | Transform vague inputs into actionable specifications |
| **research** | RESEARCH | Discover and gather information from sources |
| **analysis** | ANALYSIS | Examine information to identify patterns, risks, issues |
| **synthesis** | SYNTHESIS | Integrate disparate findings into coherent designs |
| **generation** | GENERATION | Create artifacts using TDD methodology |
| **validation** | VALIDATION | Verify artifacts against quality criteria |
| **memory** | METACOGNITION | Monitor progress, detect impasses (automatic invocation) |

### Single Cognitive Responsibility Principle (SCRP)

Each agent performs **exactly ONE cognitive function**. This is non-negotiable because:

1. **Maintainability** - 7 agents to maintain vs potentially dozens of task-specific agents
2. **Reusability** - Same agent works across any domain
3. **Composability** - Combine agents into workflows without overlap
4. **Testability** - Each function can be validated independently

### Domain Adaptation

Agents adapt to ANY domain while maintaining consistent methodology:

| Domain | Same Methodology | Different Evaluation Criteria |
|--------|-----------------|------------------------------|
| Technical | Socratic questioning | Architecture, security, performance |
| Personal | Socratic questioning | Values, goals, priorities |
| Creative | Socratic questioning | Tone, audience, message |
| Professional | Socratic questioning | Business objectives, stakeholders |
| Recreational | Socratic questioning | Preferences, inclusivity |

The cognitive PROCESS stays constant; only the VOCABULARY and SUCCESS CRITERIA change.

### Agent Invocation Pattern

Agents are **NEVER invoked directly**. The call chain is:

```
Skill Phase → orchestrate-{agent} (atomic skill) → Task tool → Agent Entry
```

---

## Skills Architecture

Skills define **workflow orchestration** - the sequence of cognitive agents to invoke and when.

### Two Skill Types

| Type | Description | Example |
|------|-------------|---------|
| **Atomic** | Single-agent wrappers for individual cognitive functions | orchestrate-clarification |
| **Composite** | Multi-phase workflows using multiple agents | develop-skill |

### 7 Atomic Skills

Each wraps exactly one cognitive agent:

| Skill | Agent | Purpose |
|-------|-------|---------|
| orchestrate-clarification | clarification | Transform vague inputs into specifications |
| orchestrate-research | research | Investigate options, gather domain knowledge |
| orchestrate-analysis | analysis | Decompose problems, assess complexity |
| orchestrate-synthesis | synthesis | Integrate findings into recommendations |
| orchestrate-generation | generation | Create artifacts using TDD |
| orchestrate-validation | validation | Verify artifacts against criteria |
| orchestrate-memory | memory | Monitor progress, detect impasses |

### 2 Built-in Composite Skills

| Skill | Purpose | Phases |
|-------|---------|--------|
| **develop-skill** | Meta-skill for creating new skills | 6 phases |
| **develop-learnings** | Transform experiences into reusable learnings | 7 phases |

### Phase Types

| Type | Behavior |
|------|----------|
| LINEAR | Standard sequential execution (default) |
| OPTIONAL | Skip if trigger condition not met |
| ITERATIVE | Execute sub-phases in sequence (e.g., 3A→3B→3C) |
| REMEDIATION | Retry on validation failure (max 2 retries) |
| PARALLEL | Execute branches concurrently, merge results |

### Skill-to-Skill Composition

Skills can invoke other skills, enabling complex workflows through composition rather than monolithic definitions.

---

## Directory Structure

```
.claude/
├── DA.md                           # Directing Agent definition
├── settings.json                   # Configuration
│
├── agents/                         # 7 agent definitions
│   ├── clarification.md
│   ├── research.md
│   ├── analysis.md
│   ├── synthesis.md
│   ├── generation.md
│   ├── validation.md
│   └── memory.md
│
├── docs/                           # System documentation
│   ├── philosophy.md               # Core principles
│   ├── cognitive-function-taxonomy.md
│   ├── skill-catalog.md
│   └── ...
│
├── hooks/                          # Claude Code hooks
│   ├── user-prompt-submit/         # Entry point for all queries
│   ├── session-start/              # Session initialization
│   └── ...
│
├── learnings/                      # Progressive learning storage
│   ├── clarification/
│   ├── research/
│   ├── analysis/
│   ├── synthesis/
│   ├── generation/
│   └── validation/
│
├── memory/                         # Workflow memory files (gitignored)
│
├── orchestration/                  # Python orchestration layer
│   ├── protocols/
│   │   ├── reasoning/              # 9-step reasoning protocol
│   │   ├── execution/              # Post-reasoning execution
│   │   ├── agent/                  # Agent protocol implementations
│   │   └── skill/                  # Skill definitions
│   └── shared/                     # Reusable content
│
└── skills/                         # Skill definitions
    ├── develop-skill/              # Meta-skill for creating skills
    ├── develop-learnings/          # Learning capture skill
    └── orchestrate-*/              # 7 atomic skills
```

---

## TODO

### Skills to Build

- perform-research
- develop-prd
- develop-backend-web-app
- develop-frontend-web-app
- perform-qa-analysis-web-app
