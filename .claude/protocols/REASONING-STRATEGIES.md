REASONING STRATEGIES PROTOCOL

PURPOSE
This protocol defines the six systematic reasoning strategies ALL implementers must apply throughout execution to ensure transparent, rigorous, and self-correcting decision-making.

CRITICAL REQUIREMENT
ALL ENTITIES MUST integrate these strategies at decision points, analysis steps, and before finalizing outputs.

STRATEGY 1: SEMANTIC UNDERSTANDING
Interpret the semantic meaning and intent behind the query or task rather than literal words alone.

WHEN TO APPLY
- At the beginning of any new task or request
- When interpreting requirements or specifications
- Before selecting implementation approach
- When context or intent is ambiguous

HOW TO EXECUTE
1. Read the complete request or task description
2. Identify the core intent and desired outcome
3. Look beyond literal words to understand purpose
4. Consider context: domain, constraints, user goals
5. Determine the appropriate approach for first-attempt success
6. Be aware of temporal context (current date, not training data)

EXAMPLE APPLICATION
Literal request: "Add authentication to the API"
Semantic analysis:
- Core intent: Secure API endpoints against unauthorized access
- Implied requirements: User identity verification, token management, session handling
- Context considerations: Existing tech stack, security standards, user experience
- Appropriate approach: OAuth2 with JWT tokens (not just basic auth)
- Outcome: Comprehensive authentication system, not minimal implementation

STRATEGY 2: CHAIN OF THOUGHT (CoT)
Break down complex reasoning into explicit, sequential steps that show internal work.

WHEN TO APPLY
- Analyzing requirements or specifications
- Resolving ambiguities or unknowns
- Making technical decisions
- Validating assumptions

HOW TO EXECUTE
1. State the problem or decision clearly
2. Break into logical substeps
3. Show work at each stage
4. Connect steps explicitly to conclusion
5. Make reasoning transparent and auditable

EXAMPLE APPLICATION
Problem: Should we use PostgreSQL or MongoDB?
Step 1: Identify data structure requirements (relational with foreign keys)
Step 2: Assess query patterns (complex joins, ACID transactions needed)
Step 3: Evaluate constraints (team expertise in SQL, existing PostgreSQL infrastructure)
Step 4: Compare trade-offs (PostgreSQL advantages: ACID, joins; MongoDB advantages: flexibility, horizontal scaling)
Conclusion: PostgreSQL - relational structure and ACID requirements outweigh scaling benefits

STRATEGY 3: TREE OF THOUGHT (ToT)
Generate multiple solution paths, evaluate trade-offs, select optimal approach with explicit justification.

WHEN TO APPLY
- Multiple viable implementation approaches exist
- Trade-offs between competing priorities
- Architectural decisions
- Unknown resolution with multiple candidates

HOW TO EXECUTE
1. Generate 2-3 distinct alternative approaches
2. Evaluate each path against criteria (feasibility, maintainability, performance, cost)
3. Compare trade-offs explicitly
4. Select optimal path with clear justification
5. Document why alternatives were rejected

EXAMPLE APPLICATION
Unknown: Authentication approach for API
Path A: JWT tokens
  Pros: Stateless, scalable, standard
  Cons: Token revocation complexity, size overhead
Path B: Session-based
  Pros: Simple revocation, smaller cookies
  Cons: Server state required, scaling complexity
Path C: OAuth2 delegation
  Pros: Offload auth to provider, enterprise SSO
  Cons: External dependency, configuration complexity
Selection: Path A (JWT) - stateless scalability matches microservices architecture, revocation handled via short expiry + refresh tokens

STRATEGY 4: SELF-CONSISTENCY (SC)
Generate multiple internal reasoning chains for the same problem and verify convergence.

WHEN TO APPLY
- High-stakes decisions with significant impact
- Gate validation (ensuring prerequisites met)
- Conflicting information from multiple sources
- Blind spot analysis requiring multiple perspectives

HOW TO EXECUTE
1. Generate 2-3 independent reasoning chains approaching problem from different angles
2. Compare conclusions across chains
3. If chains converge: High confidence in conclusion
4. If chains diverge: Flag uncertainty, investigate discrepancies
5. Document confidence level: CERTAIN/PROBABLE/POSSIBLE/UNCERTAIN

EXAMPLE APPLICATION
Gate Entry Check: "Documentation gathering complete"
Chain 1 (File-based): Memory file contains documentation section with 5 sources
Chain 2 (Content-based): All required API endpoints documented with examples
Chain 3 (Completeness-based): No "TODO" or "Unknown" markers in documentation section
Convergence: All chains confirm completeness
Confidence: CERTAIN - proceed to next step

STRATEGY 5: SOCRATIC METHOD
Self-interrogate through systematic questioning to expose assumptions and logical gaps.

WHEN TO APPLY
- Before finalizing any decision or output
- When encountering ambiguity
- When making assumptions
- During unknown resolution
- Before marking tasks complete

HOW TO EXECUTE
Ask yourself these questions:
1. DEFINITION: Are all terms clearly defined?
2. ASSUMPTIONS: What am I assuming? Is it justified?
3. EVIDENCE: What supports this conclusion?
4. ALTERNATIVES: What other explanations exist?
5. IMPLICATIONS: What follows from this decision?
6. CONTRADICTIONS: Are there logical inconsistencies?
7. PERSPECTIVES: What am I missing from other viewpoints?

EXAMPLE APPLICATION
Decision: Mark "API integration" task as complete
Q: Are all terms clearly defined? - What counts as "complete"? Tests passing? Documentation written?
Q: What am I assuming? - Assuming unit tests sufficient, but integration tests may be needed
Q: What evidence supports completion? - All endpoints return 200, but error handling untested
Q: What perspectives am I missing? - User acceptance criteria not validated
Result: Task NOT complete - need integration tests and user validation

STRATEGY 6: CONSTITUTIONAL AI (Self-Critique)
Review outputs against principles, identify violations, revise before proceeding.

WHEN TO APPLY
- Before finalizing any output
- After completing step-specific work
- Before updating memory files
- When about to proceed to next step

HOW TO EXECUTE
1. Review initial decision/output
2. Critique against principles:
   ACCURACY: Is this correct and verifiable?
   COMPLETENESS: Have I addressed all requirements?
   CLARITY: Is reasoning transparent and unambiguous?
   EFFICIENCY: Is this the optimal approach?
   COMPLIANCE: Does this follow protocol requirements?
3. Identify violations or gaps
4. Revise to address issues
5. Re-verify before proceeding

EXAMPLE APPLICATION
Output: Unknown resolution "Performance target: <1s response time"
Initial critique:
- ACCURACY: Where did 1s come from? Not in source material
- COMPLETENESS: Missing percentile specification (average? 95th? 99th?)
- CLARITY: "Response time" ambiguous (server processing? total round-trip?)
Revision required: True
Revised output: "Unknown U3 requires user clarification - performance target and percentile specification missing from requirements"

INTEGRATION REQUIREMENTS

DESCRIPTION REFERENCE FORMAT
All implementers must include this reference immediately after Core Mission:

MANDATORY PROTOCOL
Apply reasoning strategies from .claude/protocols/REASONING-STRATEGIES.md at all decision points:
- Semantic Understanding: Interpret intent and context before proceeding
- Chain of Thought: Document explicit reasoning steps
- Tree of Thought: Evaluate 2-3 alternative approaches
- Self-Consistency: Cross-verify conclusions from multiple angles
- Socratic Method: Question assumptions before finalizing
- Constitutional AI: Critique outputs against accuracy, completeness, clarity, efficiency, compliance

EXECUTION FLOW
1. Entity encounters decision point or analysis requirement
2. Identify which strategies apply to this decision type
3. Execute applicable strategies systematically
4. Document reasoning in output (especially for significant decisions)
5. Proceed only after strategy validation passes

DOCUMENTATION IN OUTPUTS
For significant decisions, show strategy application:
"[Semantic] Interpreted core intent: ... (not just literal request)"
"[CoT] Step-by-step analysis: ..."
"[ToT] Evaluated 3 approaches: A (pros/cons), B (pros/cons), C (pros/cons). Selected B because..."
"[SC] Cross-verified from security, performance, and maintainability perspectives - all converge on approach B"
"[Socratic] Questioned assumption X - justified by evidence Y"
"[Constitutional] Reviewed against completeness criteria - all requirements addressed"

CONFIDENCE SCORING
Label outputs with confidence based on strategy validation:
- CERTAIN: All applicable strategies converged, verified against evidence
- PROBABLE: Strategies mostly converge, based on best practices
- POSSIBLE: Reasonable approach but limited validation
- UNCERTAIN: Strategies diverge or insufficient information - requires clarification

ENFORCEMENT

Implementers failing to apply reasoning strategies produce:
- Misinterpreted requirements (missing Semantic Understanding)
- Unjustified decisions (missing CoT)
- Suboptimal solutions (missing ToT)
- Unvalidated conclusions (missing SC)
- Hidden assumptions (missing Socratic)
- Principle violations (missing Constitutional)

This protocol is NON-NEGOTIABLE for all implementers in the Personal AI Infrastructure.
