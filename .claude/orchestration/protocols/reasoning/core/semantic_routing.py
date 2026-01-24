"""
semantic_routing.py
===================

Semantic routing system for the orchestration system.

This module generates routing prompts for PURE SEMANTIC routing.
No keyword matching - the orchestrator makes routing decisions based on
understanding of task requirements and skill patterns from DA.md.

Key Principles:
1. Routing is based on semantic understanding of user intent
2. The orchestrator evaluates query against "When to Use" patterns from DA.md
3. Bypass mode (via -b flag) is available for genuinely trivial tasks
4. When in doubt, route to skill orchestration (fail-secure)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List


@dataclass
class SemanticRoutingContext:
    """Context for semantic routing decision."""
    user_query: str
    domain: str
    complexity_score: float


# Execution routes available (2-route model)
EXECUTION_ROUTES = {
    "skill-orchestration": {
        "description": "Use formal skill workflow (multi-phase cognitive process)",
        "when_to_use": [
            "Task matches a defined composite skill pattern",
            "Multi-phase cognitive work required (clarify → research → analyze → synthesize → generate → validate)",
            "Complex deliverable spanning multiple components",
            "Production-grade output needed with TDD and security review",
            "System modifications (skills, agents, protocols, architecture) - route to develop-skill",
        ],
        "examples": [
            "Build me a CLI tool",
            "Create an app with frontend, backend, and database",
            "What are the best practices for microservices security?",
            "Test this before release",
            "Review this code for security issues",
            "Create a new skill for code review workflows",
            "Update the routing system",
        ],
    },
    "dynamic-skill-sequencing": {
        "description": "The orchestrator determines and invokes sequence of orchestrate-* skills",
        "when_to_use": [
            "Task requires multiple cognitive functions but doesn't match existing composite skill",
            "Novel task requiring coordination of clarification, research, analysis, synthesis, generation, or validation",
            "Work that needs structured cognitive flow but isn't a standard pattern",
        ],
        "examples": [
            "Help me understand this codebase and suggest improvements",
            "Analyze our architecture and propose a migration strategy",
            "Research options and design a solution for X",
        ],
    },
}


def generate_routing_prompt(context: SemanticRoutingContext) -> str:
    """
    Generate a semantic routing prompt for the orchestrator to make the routing decision.

    This prompt provides context for PURE SEMANTIC routing:
    - User query
    - Route definitions with examples
    - Domain and complexity context

    NO keyword suggestions - the orchestrator uses semantic understanding.

    Args:
        context: Semantic routing context

    Returns:
        Markdown prompt for routing decision
    """
    # Format route options
    routes_text = "\n### Available Execution Routes\n\n"
    for route_name, route_info in EXECUTION_ROUTES.items():
        routes_text += f"#### {route_name}\n\n"
        routes_text += f"**Description:** {route_info['description']}\n\n"
        routes_text += "**When to Use:**\n"
        for condition in route_info['when_to_use']:
            routes_text += f"- {condition}\n"
        routes_text += "\n**Examples:**\n"
        for example in route_info['examples']:
            routes_text += f"- \"{example}\"\n"
        routes_text += "\n"

    # Format task context
    context_text = f"""
### Task Context

**Domain:** {context.domain}
**Complexity Score:** {context.complexity_score:.2f}
"""

    return f"""## Semantic Routing Decision

{context.user_query}

{routes_text}
{context_text}

### Your Routing Decision

Based on your semantic understanding of the user's request and the DA.md "When to Use" patterns:

1. **Evaluate** the user query against each route's conditions
2. **Consider** the semantic INTENT of the request
3. **Apply** the fail-secure principle: when uncertain, default to skill-orchestration

**Respond with your routing decision in this format:**

```
ROUTE: [skill-orchestration|dynamic-skill-sequencing]
SKILL: [skill-name if skill-orchestration, or null]
REASON: [Brief explanation of why this route matches the task]
```

If routing to skill-orchestration, specify which skill (e.g., develop-skill, develop-learnings)

*Note: Trivial tasks (single file, ≤5 lines, mechanical) can still be handled directly via tools without a full protocol, but routing gate handles that determination.*
"""


def build_routing_context(
    user_query: str,
    step_outputs: Dict[str, Any],
) -> SemanticRoutingContext:
    """
    Build semantic routing context from reasoning protocol outputs.

    Args:
        user_query: Original user query
        step_outputs: Outputs from reasoning protocol steps

    Returns:
        SemanticRoutingContext for routing decision
    """
    step_2 = step_outputs.get(2, {})
    step_3 = step_outputs.get(3, {})

    return SemanticRoutingContext(
        user_query=user_query,
        domain=step_2.get("domain", "unknown"),
        complexity_score=step_3.get("complexity_score", 0.5),
    )


def generate_routing_prompt_from_state(state) -> str:
    """
    Generate routing prompt from a ProtocolState object.

    Args:
        state: ProtocolState object

    Returns:
        Semantic routing prompt
    """
    context = build_routing_context(
        user_query=state.user_query,
        step_outputs=dict(state.step_outputs),
    )
    return generate_routing_prompt(context)


# CLI for testing
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Semantic Routing Test")
    parser.add_argument("query", help="User query to route")
    parser.add_argument("--domain", default="technical", help="Task domain")
    parser.add_argument("--complexity", type=float, default=0.5, help="Complexity score")

    args = parser.parse_args()

    context = SemanticRoutingContext(
        user_query=args.query,
        domain=args.domain,
        complexity_score=args.complexity,
    )

    print(generate_routing_prompt(context))
