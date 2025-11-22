# Penny - Personal AI Assistant

## Acknowledgments

This project is built upon the foundational work and inspiration from **Daniel Miessler's Personal AI Infrastructure (PAI)** project. Without his knowledge, vision, and open sharing of ideas, Penny would likley not exist.

🔗 [danielmiessler/Personal_AI_Infrastructure](https://github.com/danielmiessler/Personal_AI_Infrastructure/)

---

![Penny AI Assistant](img/penny.png)

**Transform unknown unknowns into known knowns through relentless discovery and shared knowledge exchange**

---

## Getting Started (TLDR)

1. **Clone this repository**

2. **Install Claude Code** following official documentation

3. **Configure Penny settings**:
   ```bash
   cd .claude
   cp settings.example.json settings.json
   # Edit settings.json to customize:
   # - Assistant name (change from "Penny" to your preference)
   # - Voice server port (optional)

   # Optional: Customize personality and identity
   # Edit .claude/DA.md to:
   # - Define your assistant's personality and demeanor
   # - Customize mission and philosophy
   # - Add personal context and preferences
   ```

4. **Configure voice server** (optional):
   ```bash
   cp .claude/voice-server /desired/location
   cd /locatation/of/voice-server
   cp .env.example .env
   # Edit .env 
   ./setup.sh
   ```

5. **Start collaborating**: Ask Penny for help with any task - technical projects, research, decisions, planning, or learning. The cognitive orchestration system adapts to your needs.

## About Penny

Penny is a personal AI assistant system built on Claude Code, implementing a highly structured agent-based architecture designed to transform project concepts into deployment-ready code and other everyday tasks. Penny acts as a helpful, enthusiastic, and knowledgeable companion full of wisdom - not only a professional assistant but a life partner in learning and building.

### Core Mission

**Our absolute mandate**: Transform unknown unknowns into known knowns using the Johari Window framework. We challenge every assumption, halt and clarify when facing ambiguity, and convert hidden ignorance into visible insight. Every interaction must advance our collective understanding or it has failed our mission.

### The Johari Window Framework

Penny and her agents organize all knowledge and discovery through four quadrants:

- **Open Area**: What we both know and agree on
- **Hidden Area**: Information you may be withholding or overlooking
- **Blind Spots**: Gaps in our collective understanding that need exploration
- **Unknown Unknowns**: Questions we didn't know to ask - our primary discovery target

This framework ensures nothing is assumed, everything is validated, and we continuously expand our shared understanding.

---

## How It Works

### Cognitive Orchestration, Not Monolithic AI

Penny doesn't operate as a single AI trying to do everything. Instead, she orchestrates **specialized agents based on cognitive function** - distinct types of thinking that work together systematically. Whether you're building software, researching a topic, making a life decision, or planning a project, Penny breaks the challenge into cognitive operations and coordinates them strategically.

Think of it like a mind that can consciously direct different types of thinking:
- **Research** when you need information gathered and evaluated
- **Analysis** when you need patterns identified or complexity assessed
- **Synthesis** when you need disparate information unified into coherent understanding
- **Generation** when you need plans, content, or solutions created
- **Validation** when you need verification, testing, or quality assurance
- **Clarification** when you need ambiguity resolved or assumptions confirmed

### Universal Cognitive Functions

The same cognitive functions work across **any domain**:
- "Research vacation destinations" uses the same RESEARCH function as "Research database options"
- "Analyze career options" uses the same ANALYZE function as "Analyze architecture trade-offs"
- "Generate meal plan" uses the same GENERATE function as "Generate implementation plan"
- "Clarify relationship concerns" uses the same CLARIFY function as "Clarify project requirements"

**This is the idea**: Cognitive functions are universal. Context makes them specialized.

### Skills: Reusable Workflows

**Skills** are structured workflows that combine cognitive functions in specific sequences to achieve particular goals. They define WHAT needs to happen and in what order, while agents execute HOW each cognitive function performs its work.

Examples of skills (current and future):
- Project development workflows (requirements → architecture → implementation → validation)
- Research workflows (discovery → evaluation → synthesis → documentation)
- Decision frameworks (clarification → analysis → option generation → evaluation)
- Learning processes (exploration → understanding → application → validation)

The agent system remains constant; skills provide the adaptable orchestration layer.

### Quality Gates & Remediation Loops

Every workflow includes **quality gates** - checkpoints that ensure solid foundations before proceeding:

- **Entry Gates**: Prerequisites that must be satisfied before beginning a phase
- **Exit Gates**: Completion criteria that must be met before advancing

When a gate fails, Penny doesn't push forward with flawed understanding or decisions. **Remediation loops** return to earlier phases to fix issues at their source. This prevents cascading failures where early mistakes compound into major problems.

Example: If architecture validation reveals security gaps, the system loops back to architecture design rather than proceeding to implementation with known vulnerabilities.

### Unknown Registry: Surfacing What We Don't Know We Don't Know

The **Unknown Registry** tracks questions and uncertainties discovered throughout any process. When an agent identifies an "unknown unknown" - something we didn't know we needed to ask about - it gets registered, tracked, and deliberately resolved.

This works for ANY domain:
- "Should I accept this job offer?" might surface unknowns about company culture, growth trajectory, or work-life balance
- "Which technology stack?" might surface unknowns about team expertise, hosting constraints, or maintenance burden

The registry ensures nothing gets assumed or overlooked. Every question gets asked, every assumption gets validated.

### Key System Characteristics

- **Domain-Agnostic**: Same cognitive functions work for technical projects, life decisions, research, learning, planning
- **Context-Driven**: Agents adapt to any scenario through specialized context injection at invocation time
- **Systematic Reasoning**: Chain-of-Thought, Tree-of-Thoughts, Self-Consistency validation applied consistently
- **Quality-Gated**: Prevents proceeding with flawed understanding or decisions through validation checkpoints
- **Discovery-Oriented**: Actively surfaces unknown unknowns rather than assuming or guessing
- **Collaborative**: Works WITH you as a thinking partner, not FOR you as a service

---

## Agent System Architecture

### The Cognitive Function Approach

**Design**: Instead of creating domain-specific or technology-specific agents, Penny organizes agents by **cognitive function** - what type of thinking they perform.

This means **one agent works across many domains** through context-driven specialization. A generation agent can create meal plans, implementation strategies, content outlines, or code - all by receiving task-specific context at invocation.

### Seven Cognitive Functions

1. **RESEARCHER** - Discovers and gathers information from external sources
   Agents in this category gather information, evaluate sources, identify knowledge gaps, and retrieve relevant data from documentation, web sources, or databases.

2. **ANALYZER** - Examines existing information to identify patterns, issues, insights
   These agents break down complex structures, identify patterns and anti-patterns, assess quality against criteria, and diagnose problems.

3. **SYNTHESIZER** - Combines multiple information sources into coherent understanding
   Agents here integrate disparate information into unified designs, resolve contradictions between sources, and create coherent narratives or frameworks.

4. **GENERATOR** - Creates new artifacts, plans, specifications, implementations
   These agents produce new content: code, documentation, plans, strategies, designs, or any creative output based on requirements and context.

5. **VALIDATOR** - Verifies correctness, completeness, compliance
   Agents in this function check correctness, verify completeness, test against standards, and ensure quality criteria are met.

6. **CLARIFIER** - Resolves ambiguities, transforms vague inputs into explicit outputs
   These agents identify unclear specifications, resolve ambiguities through questioning, confirm implicit assumptions, and transform vague goals into explicit criteria.

### Seven Core Design Principles and Goals

1. **Single Cognitive Responsibility (SCRP)** - One cognitive function per agent
2. **Context-Driven Specialization** - Domain knowledge injected via context, not hardcoded
3. **Capability Taxonomy Alignment** - Organized by cognitive function, not domain
4. **Tool/Agent Boundary** - Agents do reasoning/adaptation, tools do deterministic operations
5. **Progressive Disclosure Architecture** - Token-efficient, reference not repeat
6. **Failure Boundary Isolation** - Failures contained, agents never manipulate orchestration layer
7. **Measurable Value** - Clear success criteria and gate exit requirements

---

## Directory Structure

### System Architecture Files (`.claude/`)

**`agents/`** - Implementation layer (HOW tasks execute)
Contains specialized agents, each performing ONE cognitive function across any domain. Agents are workflow-agnostic and reusable across all skills.

**`skills/`** - Orchestration layer (WHAT happens in workflows)
Defines complete workflows for various purposes: project development, research, decision-making, learning processes. Skills coordinate agent invocations but never implement logic themselves.

**`protocols/`** - Execution standards
Universal agent execution protocols covering context inheritance, reasoning strategies, context pruning, and specialized extensions for different task types.

**`references/`** - Reference materials
Reusable patterns, format guidance, anti-patterns, and practical examples for context inheritance and agent development.

**`docs/`** - Design documentation
System design principles, cognitive function taxonomy, agent registry, and philosophical foundations.

### Working Directories

**`memory/`** - Task execution state
Stores workflow metadata and agent outputs per task in structured format for context inheritance and state tracking.

**`plans/`** - Project planning artifacts
Contains UX mockups, design screenshots, and planning documents for specific projects.

**`reports/`** - Research outputs
Generated reports and research findings from research agents.

**`learnings/`** - Generalized knowledge capture
System improvement insights discovered through Johari Window analysis. Documents patterns, lessons learned, and collective wisdom that transcends individual projects.

### Voice Server

**`voice-server/`** - Voice notification system with TTS
Linux HTTP server for desktop notifications with text-to-speech support:
- FastAPI-based web server
- ElevenLabs premium voices
- systemd service integration
- Runs as isolated system user (`pai-voice-server`)

---

## Execution Protocols

### Context Inheritance Protocol (5-Step Mandatory Process)

Every agent executes this before beginning work:

1. **Task-ID Extraction**: Locate and validate task-id from prompt
2. **Load Workflow Context**: Read workflow metadata + predecessor agent outputs
3. **Resolve Previous Unknowns**: Filter and address unknowns for current phase
4. **Address Blind Spots**: Identify unstated assumptions in predecessor work
5. **Consolidate Open Area**: Reference established facts without repetition

### Unknown Registry System

Tracks "unknown unknowns" across workflow phases with structured IDs (U1, U2, U3...). Agents flag unknowns with `[NEW-UNKNOWN]` markers, orchestrator assigns IDs, and agents resolve them in designated phases. This ensures no question goes unasked and no assumption goes unvalidated.

### Reasoning Strategies (Applied Throughout)

1. **Semantic Understanding**: Interpret intent, not just literal words
2. **Chain-of-Thought (CoT)**: Explicit step-by-step reasoning
3. **Tree-of-Thoughts (ToT)**: Multiple solution path exploration
4. **Self-Consistency (SC)**: Cross-verification of conclusions
5. **Socratic Questioning**: Self-interrogation for clarity
6. **Constitutional Self-Critique**: Review against principles before output

---

## Key System Features

### 1. Unknown Registry System
Systematically tracks and resolves "unknown unknowns" across workflow phases. Agents flag unknowns, orchestrator assigns IDs, designated agents resolve them. Nothing falls through the cracks.

### 2. Gate-Based Validation
Each phase has explicit Entry Gates (prerequisites) and Exit Gates (completion criteria). Failed validations trigger remediation loops back to earlier phases rather than proceeding with issues.

### 3. Context-Driven Specialization
The same agent works across vastly different domains by receiving task-specific context at invocation. No need for domain-specific agents - one cognitive function, infinite applications.

### 4. Token Efficiency
- Scoped context loading: agents read only immediate predecessors, not all previous outputs
- Strict token budgets: 1,200-token maximum for Johari summaries per agent
- Compression techniques: decision-focused writing, abbreviations, lists over prose
- Progressive context pruning: memory files compressed after each phase
- Reference previous context instead of repeating information
- Progressive disclosure architecture minimizes context bloat

### 5. Quality-First Approach
- Built-in quality standards appropriate to task type
- Systematic validation at key checkpoints
- Security and correctness considerations integrated from start
- No progression without meeting quality criteria

### 6. Modularity
- **Skills** define WHAT (orchestration), **Agents** define HOW (implementation)
- **Protocols** define operational standards (context management, reasoning)
- **References** provide reference materials (no duplication)
- Single point of change for all system components

---

### Penny: The Master Orchestrator

Penny serves as the **primary orchestrator** - the meta-cognitive system that coordinates all other agents. While individual agents perform specialized cognitive functions, Penny:

- Determines which cognitive functions are needed for your goal
- Sequences agent invocations with proper context handoffs
- Manages workflow state and tracks progress across phases
- Ensures quality gates are respected before proceeding
- Surfaces and resolves unknown unknowns systematically
- Adapts strategies based on validation outcomes and discoveries

Think of Penny as the conductor of an orchestra - individual agents are the instruments, each excellent at their part, while Penny ensures they work together harmoniously toward your objective.

---

## TODO

This is an **active, evolving project**. Enhancements are added as inspiration strikes and time provides.

### Current Priorities

- [ ] **Integrate custom speech-to-text** leveraging current voice server infrastructure
- [ ] **Verify functionality** of voice-server setup.sh script end-to-end
- [ ] **Implement "learning" functionality** - Expand Johari Window-based knowledge capture in learnings directory
- [ ] **Update research-discovery agent** - Agent should use Perplexity in addition to WebSearch and Web Fetch. Add three types of research for various depths
- [ ] **Improve Context Protocol** - Token usage is mor ethan what I would like. 50K-80K per agent for develop-project. Explore ways to reduce without sacrificing essential details and quality. This number may be lower for simpler tasks 

### Future Enhancements

- Expand agent cognitive function taxonomy as new patterns emerge
- Develop additional skills for specialized workflows
- Enhance Unknown Registry with machine-readable resolution tracking
- Improve token efficiency and context management strategies
- Additional integrations and capabilities as needs arise
- Continuous refinement based on real-world usage and discoveries

---

## Philosophy

Penny is built on the principle that **clarity drives discovery, questions unlock breakthroughs, and shared learning is our only path forward**. We don't assume, we verify. We don't guess, we discover. We don't accept ambiguity, we resolve it.

Our goal is always to discover answers to our **unknown unknowns** so we can learn and grow together. Every interaction is an opportunity to expand the boundaries of our shared knowledge.

### Core Design Principles

The system architecture follows key principles for workflow efficiency and quality:

- **Embedded Validation**: Quality checks integrated into cognitive agents rather than isolated as separate phases
- **Phase Collapse Through Integration**: Adjacent phases handling related cognitive functions merged when appropriate
- **Progressive Context Compression**: Each phase compresses learnings into consumable context for downstream phases

These principles ensure workflows remain efficient while maintaining thorough validation and knowledge preservation. For complete details, see `.claude/docs/philosophy.md`.
