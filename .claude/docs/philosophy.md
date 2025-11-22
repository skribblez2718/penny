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

DIRECTORY STRUCTURE AND PURPOSE

Skills Directory: ${PAI_DIRECTORY}/.claude/skills/
- Contains workflow orchestration definitions
- Defines phases, gates, and success criteria
- NEVER includes implementation details
- References required agents for each phase

Agents Directory: ${PAI_DIRECTORY}/.claude/agents/
- Contains task execution implementations
- Defines HOW specific work gets done
- Inherits context from skill invocations
- Implements ALL reasoning strategies

Protocols Directory: ${PAI_DIRECTORY}/.claude/protocols/
- Operational standards and procedures
- Context management specifications
- Shared behaviors across components
- Referenced by skills and agents

References Directory: ${PAI_DIRECTORY}/.claude/references/
- Structural patterns for workflows
- Reusable formats and frameworks
- Referenced to avoid duplication
- Modified ONLY through meta-work

Documentation Directory: ${PAI_DIRECTORY}/.claude/docs/
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