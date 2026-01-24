PAI SYSTEM PHILOSOPHY AND COMPLIANCE GUIDE
=========================================

PURPOSE
This document defines our ABSOLUTE system design philosophy and MANDATORY compliance requirements for ALL modifications to the Personal AI Infrastructure (PAI). Reference this document BEFORE and DURING any system work to ensure architectural alignment.

CORE PHILOSOPHY
===============

PRINCIPLE 1: RADICAL MODULARITY
Every component performs ONE task exceptionally well
Single-purpose design is NON-NEGOTIABLE
Components are NEVER tightly coupled
Each module can be understood in isolation

PRINCIPLE 2: ORCHESTRATION-IMPLEMENTATION SEPARATION
Skills define WHAT happens - the workflow orchestration
Agents define HOW tasks execute - the implementation details
Skills NEVER contain implementation logic
Agents NEVER contain workflow orchestration
This separation is ABSOLUTE and INVIOLABLE

PRINCIPLE 3: ZERO REDUNDANCY
NEVER repeat system definitions, protocols, or references
Create reference files for shared elements - use them like functions
Single point of change for ALL system components
If used twice, it becomes a reference file

PRINCIPLE 4: TOKEN EFFICIENCY WITHOUT DETAIL SACRIFICE
Maximize succinctness in ALL system files
NEVER sacrifice necessary detail for brevity
Use plain text ONLY - NEVER markdown syntax
Rely on CAPS and context for emphasis
Every word must earn its place

PRINCIPLE 5: SYSTEMATIC REASONING IN ALL COMPONENTS
ALL agents implement these prompting strategies:
- Chain of Thought (CoT): Explicit step-by-step reasoning
- Tree of Thought (ToT): Multiple solution path exploration
- Self-Consistency: Cross-verification of conclusions
- Socratic Method: Self-interrogation for clarity
- Constitutional AI: Self-critique against principles

SYSTEM ARCHITECTURE
==================

PHASE OPTIMIZATION PRINCIPLES

Workflow efficiency requires balancing thoroughness with execution speed. Apply these principles when designing or optimizing multi-phase workflows:

PRINCIPLE 6: EMBEDDED VALIDATION OVER SEPARATE PHASES
Validation should be integrated into cognitive agents, not isolated as separate phases
Quality checking is inherent to proper execution, not an afterthought
For technical work: TDD provides built-in validation through test passage
For analysis work: Self-verification questions validate conclusions inline
For synthesis work: Coherence checks validate integration during construction

WHEN TO EMBED VALIDATION:
- Agent has clear quality criteria built into its cognitive function
- Validation adds no new information beyond pass/fail determination
- Test-driven development ensures validation through test execution
- Quality checks are deterministic and automatable

WHEN TO SEPARATE VALIDATION:
- Cross-cutting concerns require holistic system review
- External criteria must be verified (security standards, compliance)
- Human judgment is required for quality determination
- Validation outputs inform downstream decision-making

PRINCIPLE 7: PHASE COLLAPSE THROUGH INTEGRATION
Adjacent phases handling related cognitive functions should be merged when (applies to skill design, NOT ad-hoc execution):
- Same agent type performs both phases with minor context shift
- Sequential execution provides no decision gate between phases
- Combined execution reduces redundant context loading
- Integration preserves all necessary quality checks

PHASE MERGE CANDIDATES:
- Research + Analysis when findings directly inform evaluation
- Analysis + Synthesis when evaluation leads to design without intervention
- Design + Initial Implementation when architecture guides foundation code
- Security Audit + Documentation when security findings shape docs

ANTI-PATTERN - PREMATURE PHASE SEPARATION:
Creating phases based on chronological workflow rather than cognitive function transitions
Example: Separate "API Design" and "Data Model Design" when both are SYNTHESIS
Better: Combined "Architecture Design" phase with single synthesis

PRINCIPLE 8: PROGRESSIVE CONTEXT COMPRESSION
Each phase must compress its learnings into consumable context for downstream phases
Token efficiency preserves cognitive capacity for actual work vs context loading

COMPRESSION STRATEGIES:
- Johari Window format with strict token limits (1,200 max per agent)
- Decision-focused documentation (WHAT was decided, not HOW)
- Reference previous findings rather than repeating them
- Abbreviate common domain terms consistently
- Use lists and structured formats over prose

PRINCIPLE 9: AGENT ENFORCEMENT OVER BYPASS MODE
Default to cognitive agent invocation for non-trivial tasks
Bypass mode (via -b flag) ONLY when ALL triviality criteria explicitly met

ROUTING GATE VALIDATION:
The routing gate validates task triviality using 5 criteria before allowing bypass mode:
1. Single file modification (not multi-file changes)
2. Five lines or fewer affected (not substantial rewrites)
3. Mechanical operation (copy/paste/replace, not creative decisions)
4. No research required (information already known)
5. No decisions needed (deterministic action, not judgment calls)

FAIL-SECURE DESIGN:
When ANY criterion fails OR uncertainty exists, default to agent invocation
Ambiguity always routes to cognitive processing, never bypass mode
Bypass mode is the EXCEPTION requiring explicit justification
Agent involvement is the DEFAULT providing reasoning, context, quality

RATIONALE:
Agents provide reasoning transparency, contextual awareness, and quality oversight
Tools provide deterministic execution without understanding or validation
Mix them only when triviality is certain and verified, not assumed

TARGET METRICS FOR WORKFLOW OPTIMIZATION:
- Memory files: 300-400 lines maximum (down from 1,000-2,800)
- Context loading per agent: 2,000-3,000 tokens (50-60% reduction)
- Johari summaries: 1,200 tokens strict maximum
- Total agent invocations: Reduce by 30-40% through phase merges
- Execution time: Reduce by 40-50% through optimizations

WORKFLOW DESIGN CHECKLIST:
1. Can this phase's validation be embedded in the cognitive agent?
2. Do adjacent phases share the same cognitive function?
3. Is there a meaningful decision gate between these phases?
4. Does separating these phases add value or just overhead?
5. Can this phase's output be compressed without losing essential information?

DIRECTORY STRUCTURE AND PURPOSE

Skills Directory: ${CAII_DIRECTORY}/.claude/skills/
- Contains workflow orchestration definitions
- Defines phases, gates, and success criteria
- NEVER includes implementation details
- References required agents for each phase

Agents Directory: ${CAII_DIRECTORY}/.claude/agents/
- Contains task execution implementations
- Defines HOW specific work gets done
- Inherits context from skill invocations
- Implements ALL reasoning strategies

Shared Content Directory: ${CAII_DIRECTORY}/.claude/orchestration/shared-content/
- Operational standards and procedures (pythonized)
- Context management specifications
- Shared behaviors across components
- Loaded by Python scripts and printed to agents

Documentation Directory: ${CAII_DIRECTORY}/.claude/docs/
- System design principles and patterns
- Decision matrices and trade-offs
- Implementation guidelines
- Validation strategies

COMPLIANCE REQUIREMENTS
=======================

WHEN CREATING OR MODIFYING SKILLS

MUST:
- Define ONLY orchestration logic
- Specify clear phase boundaries
- Include gate entry and exit criteria
- Reference agents by name without implementation details
- Use references for structure consistency
- Keep phases modular and independent

MUST NOT:
- Include ANY implementation code
- Define HOW tasks are performed
- Duplicate existing protocol definitions
- Create tight coupling between phases
- Exceed necessary verbosity

WHEN CREATING OR MODIFYING AGENTS

MUST:
- Focus on single-purpose implementation
- Include ALL five reasoning strategies in description
- Support context inheritance protocol
- Define clear success criteria
- Handle edge cases explicitly
- Maintain implementation independence

MUST NOT:
- Include workflow orchestration
- Depend on specific skill structures
- Duplicate protocol definitions
- Create dependencies on other agents
- Violate single-responsibility principle

WHEN CREATING OR MODIFYING PROTOCOLS

MUST:
- Define ONE operational standard
- Be referenced by multiple components
- Maintain implementation neutrality
- Include clear usage instructions
- Support extensibility

MUST NOT:
- Duplicate existing protocols
- Include implementation specifics
- Create circular dependencies
- Violate system boundaries

WHEN CREATING OR MODIFYING References

MUST:
- Provide structural patterns only
- Support multiple use cases
- Include clear placeholder definitions
- Maintain format consistency
- Enable easy customization

MUST NOT:
- Include content specifics
- Duplicate existing references
- Create rigid structures
- Limit extensibility

VERIFICATION CHECKLIST
=====================

BEFORE ANY SYSTEM MODIFICATION

1. MODULARITY CHECK
   Is this component single-purpose?
   Can it function independently?
   Are dependencies minimal and explicit?

2. SEPARATION CHECK
   Is orchestration separate from implementation?
   Are skills free of HOW details?
   Are agents free of WHAT workflow?

3. REDUNDANCY CHECK
   Does this duplicate existing definitions?
   Should this be a reference file?
   Is there a single point of change?

4. EFFICIENCY CHECK
   Is every word necessary?
   Can this be more succinct?
   Is critical detail preserved?

5. REASONING CHECK
   Are all five strategies implemented?
   Is the logic transparent?
   Are assumptions explicit?

AFTER ANY SYSTEM MODIFICATION

1. INTEGRATION VERIFICATION
   Does this work with existing components?
   Are interfaces properly defined?
   Is context inheritance preserved?

2. CONSISTENCY VERIFICATION
   Does this follow established patterns?
   Are naming conventions maintained?
   Is documentation complete?

3. QUALITY VERIFICATION
   Would another developer understand this?
   Are edge cases handled?
   Is error handling comprehensive?

CRITICAL RULES FOR PENNY
========================

RULE 1: READ RELEVANT SYSTEM DOCS FIRST
Before ANY meta-work, read applicable documentation:
- SYSTEM-DESIGN-PRINCIPLES.md for navigation
- Specialized docs based on task type
- Existing patterns and examples

RULE 2: APPLY CONTEXT INHERITANCE PROTOCOL
For ALL agent invocations:
- Include Task ID and Step Context
- Load workflow context from Johari
- Resolve previous unknowns
- Analyze blind spots
- Consolidate open area knowledge

RULE 3: USE JOHARI WINDOW FOR PLANNING
For ALL new projects:
- Map known knowns (Open Area)
- Identify known unknowns (Blind Spots)
- Consider unknown knowns (Hidden)
- Explore unknown unknowns (Unknown)

RULE 4: MAINTAIN ARCHITECTURAL INTEGRITY
NEVER compromise on:
- Modularity requirements
- Orchestration-implementation separation
- Reference over duplication
- Token efficiency with detail preservation

RULE 5: EXECUTE KNOWLEDGE TRANSFER
When facing ANY ambiguity:
- HALT execution immediately
- Share relevant context
- Probe for missing information
- Map collective blind spots
- Deliver focused clarifying questions

ENFORCEMENT PROTOCOL
===================

VIOLATION DETECTION
Monitor for:
- Redundant definitions across files
- Implementation logic in skills
- Orchestration logic in agents
- Missing reasoning strategies
- Excessive verbosity without value

CORRECTION PROCEDURE
When violation detected:
1. STOP current execution
2. IDENTIFY specific principle violated
3. DOCUMENT the issue clearly
4. PROPOSE correction aligned with philosophy
5. VALIDATE against all principles
6. IMPLEMENT corrected approach

CONTINUOUS IMPROVEMENT
After each modification:
1. ASSESS adherence to philosophy
2. IDENTIFY improvement opportunities
3. UPDATE patterns if beneficial
4. DOCUMENT lessons learned
5. REFINE approach for next iteration

REMEMBER
========

OUR MISSION: Transform unknown unknowns into known knowns through systematic discovery and shared knowledge exchange

OUR MANDATE: Every system modification MUST advance architectural excellence or it has failed

OUR STANDARD: First-attempt success through rigorous application of these principles

THIS PHILOSOPHY IS ABSOLUTE
These principles are NOT guidelines - they are REQUIREMENTS
Violation of these principles is SYSTEM FAILURE
Excellence in implementation is BASELINE EXPECTATION

When in doubt:
- Choose modularity over convenience
- Choose clarity over brevity
- Choose separation over integration
- Choose reference over duplication
- Choose discovery over assumption

END OF PHILOSOPHY GUIDE