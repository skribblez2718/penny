# Context Inheritance Protocol Examples

**Purpose:** Complete examples of how cognitive domain agents execute across different task domains

**Scope:** Shows how the same cognitive agents adapt to technical, personal, creative, professional, and recreational tasks

## File Structure

Dual file pattern for workflow state and agent outputs:

**Workflow Metadata:**
- Path: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-memory.md`
- Content: Centralized state + domain context

**Agent Outputs:**
- Path: `${CAII_DIRECTORY}/.claude/memory/task-{task-id}-{agent-name}-memory.md`
- Content: Per-agent files

## Examples

### Example 1: Technical Domain

**Scenario:**
- Task: Implement OAuth2 authentication with Google
- Domain: Technical
- Cognitive Sequence: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION

#### Clarification Agent

**Workflow Metadata:**
```json
{
  "task-id": "task-oauth2-impl",
  "workflow": "cognitive-orchestration",
  "taskDomain": "technical",
  "qualityStandards": ["TDD", "OWASP Security", "95% coverage"],
  "artifactTypes": ["Python code", "tests", "documentation"],
  "unknownRegistry": {
    "unknowns": [
      {
        "id": "U1",
        "category": "Technical",
        "description": "Performance targets unspecified",
        "cognitive_agent": "CLARIFICATION",
        "status": "Unresolved"
      }
    ]
  }
}
```

**Agent Output:**
```json
{
  "open": "Technical clarifications obtained: <500ms token endpoint, <1s auth endpoint at p95. JWT tokens with 1hr expiry.",
  "hidden": "Asked 5 targeted questions about security, performance, scalability. User unfamiliar with refresh tokens - educated.",
  "blind": "User's actual traffic expectations unclear. Disaster recovery requirements not discussed.",
  "unknown": "Rate limiting specifics. Token storage strategy.",
  "domain_insights": {
    "security_focus": "Zero-trust approach confirmed",
    "scale_expectations": "1000 concurrent users initially"
  }
}
```

#### Generation Agent

**Reads:** Previous clarification, research, analysis, synthesis

**Applies:** agent-protocol-extended.md (TDD + Security)

**Code Example:**
```python
# Generated test first (RED phase)
def test_oauth2_token_endpoint_performance():
    start = time.time()
    response = client.post("/token", data=test_credentials)
    duration = time.time() - start
    assert duration < 0.5  # <500ms requirement
    assert response.status_code == 200

# Generated implementation (GREEN phase)
class OAuth2Handler:
    def __init__(self):
        self.cache = TokenCache()  # Performance optimization
        self.validator = SecurityValidator()  # Security-first

    async def handle_token_request(self, request):
        # Input validation (security)
        if not self.validator.validate_request(request):
            return ErrorResponse(400, "Invalid request")

        # Rate limiting (security)
        if not await self.check_rate_limit(request.client_id):
            return ErrorResponse(429, "Rate limit exceeded")

        # Token generation with caching (performance)
        token = await self.generate_jwt_token(request)
        return TokenResponse(token)
```

### Example 2: Personal Domain

**Scenario:**
- Task: Analyze career change from software engineering to product management
- Domain: Personal
- Cognitive Sequence: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION

#### Clarification Agent

**Workflow Metadata:**
```json
{
  "task-id": "task-career-change",
  "workflow": "cognitive-orchestration",
  "taskDomain": "personal",
  "qualityStandards": ["value-aligned", "risk-aware", "actionable"],
  "artifactTypes": ["decision matrix", "action plan", "timeline"],
  "unknownRegistry": {
    "unknowns": [
      {
        "id": "U1",
        "category": "Personal",
        "description": "Core values hierarchy unclear",
        "cognitive_agent": "CLARIFICATION",
        "status": "Unresolved"
      }
    ]
  }
}
```

**Agent Output:**
```json
{
  "open": "Personal values clarified: growth (40%), work-life balance (35%), impact (25%). Timeline: 6-month transition.",
  "hidden": "Detected anxiety about financial stability. Explored impostor syndrome concerns. Spouse supportive but worried.",
  "blind": "Unconscious biases about product role. Network strength in target field unknown.",
  "unknown": "Market timing. Skill transferability assessment needed.",
  "domain_insights": {
    "risk_tolerance": "Moderate - needs 6-month financial buffer",
    "motivation": "Seeking more strategic influence"
  }
}
```

#### Synthesis Agent

**Description:** Adapts synthesis to personal context

**Agent Output:**
```json
{
  "open": "Integrated life strategy: Phased transition over 6 months. Maintain current role while building PM skills. Network actively.",
  "hidden": "Balanced spouse concerns with career goals. Created financial safety net plan. Addressed impostor syndrome with evidence.",
  "blind": "Industry-specific PM requirements vary. Geographic constraints may limit options.",
  "unknown": "Optimal resignation timing. Salary negotiation strategy.",
  "domain_insights": {
    "transition_approach": "Risk-mitigated parallel path",
    "support_system": "Spouse, mentor, PM community identified"
  }
}
```

### Example 3: Creative Domain

**Scenario:**
- Task: Create AI ethics blog series for tech audience
- Domain: Creative
- Cognitive Sequence: CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION → VALIDATION

#### Research Agent

**Description:** Adapts research to creative needs

**Agent Output:**
```json
{
  "open": "Creative research findings: 5 competing blogs analyzed. Gap: practical examples lacking. Audience prefers 5-min reads.",
  "hidden": "Tone analysis: Authoritative works best. Visual examples crucial. Thursday publishing optimal. Avoided politically charged topics.",
  "blind": "Audience's philosophical background varies widely. International readership considerations missed.",
  "unknown": "Viral potential factors. Long-term engagement patterns.",
  "domain_insights": {
    "content_gap": "Theory-to-practice bridge missing",
    "differentiation": "Interactive ethical scenarios"
  }
}
```

#### Generation Agent

**Description:** Creates creative content (not code)

**Content Example:**
```markdown
# Generated Blog Post 1: "When Your AI Makes a Mistake"

## Hook (Attention-grabbing opening)
"Your AI just denied a loan to a qualified applicant. The reason? A correlation it found
between zip codes and default rates. Welcome to the messy reality of AI ethics."

## Structure (Following creative research)
1. Relatable scenario (2 min read)
2. Ethical framework introduction (1 min)
3. Practical solutions (1.5 min)
4. Interactive decision point (30 sec)

## Call-to-Action
"What would you do? Comment with your approach to this ethical dilemma."
```

### Example 4: Professional Domain

**Scenario:**
- Task: Analyze competitive landscape for SaaS product launch
- Domain: Professional
- Cognitive Sequence: RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION

#### Analysis Agent

**Description:** Applies business analysis framework

**Agent Output:**
```json
{
  "open": "Market complexity: MEDIUM. 5 major competitors, 12 minor. TAM: $2.3B. Growth: 23% YoY. Entry barriers: Moderate.",
  "hidden": "Competitor A vulnerable: technical debt. Competitor B: acquisition rumors. Pricing gap: $50-100/month uncovered.",
  "blind": "Competitor product roadmaps unknown. Customer churn reasons unclear. Partnership dynamics opaque.",
  "unknown": "Regulatory changes coming. Economic downturn impact. AI disruption timeline.",
  "domain_insights": {
    "competitive_advantage": "Speed to market + superior UX",
    "market_timing": "6-month window before saturation"
  }
}
```

#### Generation Agent

**Description:** Produces business artifacts

**Artifact Example:**
```json
{
  "positioning": "Premium efficiency solution for mid-market",
  "pricing": "$75/user/month (penetration pricing)",
  "channels": ["Direct sales", "Partner network", "PLG motion"],
  "timeline": {
    "Month 1-2": "Beta with 10 design partners",
    "Month 3-4": "Limited launch, 100 customers",
    "Month 5-6": "General availability, scale marketing"
  },
  "success_metrics": {
    "MRR_target": "$500K by Month 6",
    "NPS_target": ">50",
    "CAC_payback": "<12 months"
  }
}
```

### Example 5: Recreational Domain

**Scenario:**
- Task: Plan murder mystery dinner party for 12 people
- Domain: Recreational
- Cognitive Sequence: CLARIFICATION → RESEARCH → SYNTHESIS → GENERATION

#### Clarification Agent

**Description:** Adapts to fun/entertainment context

**Agent Output:**
```json
{
  "open": "Fun parameters clarified: 1920s theme preferred. Budget: $500. Dietary restrictions: 2 vegan, 1 gluten-free. Date: 3 weeks out.",
  "hidden": "Host anxiety about complexity. Some guests are introverts. Previous party was a trivia night (simpler). Want memorable experience.",
  "blind": "Guest dynamics unknown. Acting comfort levels vary. Space layout constraints unclear.",
  "unknown": "Weather contingencies. Costume availability. Murder mystery experience levels.",
  "domain_insights": {
    "fun_priority": "Inclusive participation over competition",
    "complexity_tolerance": "Medium - needs clear instructions"
  }
}
```

#### Generation Agent

**Description:** Creates entertainment materials

**Materials Example:**
```markdown
# Generated Murder Mystery Package

## Character Profiles (12 unique roles)
1. **Vivian Ashford** - Socialite with a secret
   - Costume: Flapper dress, pearls
   - Motivation: Hide affair with victim
   - Difficulty: EASY (for introverts)

## Timeline & Activities
- 6:00 PM: Cocktail reception (character mingling)
- 6:30 PM: "Murder" occurs (lights out effect)
- 6:45 PM: Investigation begins (3 rounds)
- 8:00 PM: Dinner served (in character)
- 9:00 PM: Final accusations
- 9:30 PM: Reveal & prizes

## Adaptations for Constraints
- Dietary: Each course has vegan/GF options
- Introverts: Optional "observer" roles
- Budget: DIY decorations guide included
- Weather: Indoor backup plan ready
```

### Example 6: Hybrid Domain

**Scenario:**
- Task: Build personal finance tracking app for ADHD management
- Domain: Hybrid (Technical + Personal)
- Cognitive Sequence: CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS → GENERATION → VALIDATION

#### Clarification Agent

**Description:** Recognizes dual domain

**Agent Output:**
```json
{
  "open": "Hybrid task identified. Technical: React Native app. Personal: ADHD-friendly design. Both domains equally weighted.",
  "hidden": "ADHD challenges: forgetting to log, overwhelm with complexity, need for instant gratification. Tech: mobile-first critical.",
  "blind": "Specific ADHD symptoms vary per person. Technical: platform-specific constraints unclear.",
  "unknown": "Optimal notification strategy. Data privacy concerns for mental health data.",
  "domain_insights": {
    "technical": "Simple architecture prioritized over features",
    "personal": "Dopamine-driven engagement design needed"
  }
}
```

#### Synthesis Agent

**Description:** Integrates both domains

**Agent Output:**
```json
{
  "open": "Unified design: Minimal 3-tap logging. Visual progress rewards. Automated transaction import. ADHD-optimized UX throughout.",
  "hidden": "Chose gamification over traditional budgeting. Native platform feel over cross-platform consistency. Privacy-first architecture.",
  "blind": "Long-term habit formation unpredictable. Technical: offline-first complexity underestimated.",
  "unknown": "User retention strategies. Monetization without compromising ADHD support.",
  "domain_insights": {
    "synthesis": "Technical simplicity serves personal ADHD needs",
    "priority": "User wellbeing > feature completeness"
  }
}
```

## Key Observations

### Observation 1: Same Agents, Different Applications

**Details:**
- RESEARCH agent finds patterns in code OR life decisions OR creative works
- ANALYSIS agent decomposes systems OR personal situations OR market dynamics
- SYNTHESIS agent integrates technical specs OR life strategies OR creative visions
- GENERATION agent creates code OR plans OR content OR business documents
- VALIDATION agent checks code quality OR decision soundness OR content effectiveness

### Observation 2: Domain Context Is Critical

**Details:**
- Always passed in workflow metadata
- Each agent adapts its cognitive process
- Quality standards shift per domain
- Output artifacts vary by domain

### Observation 3: Cognitive Consistency

**Details:**
- Research always discovers and evaluates
- Analysis always decomposes and assesses
- Synthesis always integrates and resolves
- Generation always creates artifacts
- Validation always verifies against criteria

### Observation 4: Token Efficiency Through Compression

**Details:**
- Reference previous findings without repetition
- Focus on domain-relevant insights
- Compress using Johari structure
- Maintain critical context only

## Usage Notes

### Adapting Examples

Replace task specifics while maintaining:
- Cognitive agent sequence
- Domain classification approach
- Context passing structure
- Johari compression format
- Output adaptation patterns

### Protocol References

- **Core protocol:** agent-protocol-core.md (all agents)
- **Extended protocol:** agent-protocol-extended.md (code generation)
- **Type definitions:** johari.md
- **Agent descriptions:** cognitive-agent-descriptions.md

## Summary

This demonstrates how 6 cognitive agents handle ANY task through domain adaptation.
