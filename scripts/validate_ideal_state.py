"""
IDEAL STATE JSON Schema Validator

Validates IDEAL STATE JSON against the canonical schema.
Used by the define_specs state before the coding loop begins.
Shared across all Ralph Wiggum Loop skills.

Usage:
    python scripts/validate_ideal_state.py <ideal_state.json>
    echo '{"goal": "..."}' | python scripts/validate_ideal_state.py --stdin
"""

import json
import sys
from pathlib import Path
from typing import Optional

try:
    from pydantic import BaseModel, Field, ValidationError
    HAS_PYDANTIC = True
except ImportError:
    HAS_PYDANTIC = False


class IdealState(BaseModel):
    """Canonical IDEAL STATE schema for Ralph Wiggum Loop skills."""

    goal: str = Field(..., min_length=1, description="What are we building? One sentence.")
    source: str = Field(default="user_prompt", description="Origin: PRD, user_prompt, or plan")
    
    success_criteria: list[str] = Field(
        ..., min_length=1, description="Measurable conditions that define 'done'"
    )
    
    anti_criteria: list[str] = Field(
        default_factory=list, description="Things that must NOT happen"
    )
    
    verification: dict[str, bool] = Field(
        default_factory=lambda: {
            "lint": True,
            "type_check": True,
            "unit_tests": True,
            "integration_tests": False,
            "e2e_tests": False,
        },
        description="Verification tiers required. False = not configured in project."
    )
    
    security_review: list[str] = Field(
        default_factory=list, description="Security domains to review (injection, xss, auth, etc.)"
    )
    
    edge_cases: list[str] = Field(
        default_factory=list, description="What-if scenarios"
    )
    
    language: Optional[str] = Field(default=None, description="Primary programming language")
    impacted_files_estimate: int = Field(default=0, ge=0, description="Estimated files affected")
    
    dependencies: list[str] = Field(
        default_factory=list, description="External systems, APIs, packages required"
    )
    
    deliverables: list[str] = Field(
        default_factory=list, description="All artifacts this task produces (code, docs, config)"
    )
    
    build_order: list[str] = Field(
        default_factory=list, description="Implementation sequence, dependencies first"
    )


def validate_json(data: dict) -> tuple[bool, list[str]]:
    """Validate IDEAL STATE JSON. Returns (is_valid, errors)."""
    if not HAS_PYDANTIC:
        # Fallback: basic field presence checks
        errors = []
        if not data.get("goal"):
            errors.append("Missing required field: goal")
        if not data.get("success_criteria"):
            errors.append("Missing required field: success_criteria")
        if not isinstance(data.get("success_criteria"), list):
            errors.append("success_criteria must be a list")
        if len(data.get("success_criteria", [])) == 0:
            errors.append("success_criteria must have at least one item")
        return len(errors) == 0, errors
    
    try:
        IdealState(**data)
        return True, []
    except ValidationError as e:
        errors = [f"{err['loc']}: {err['msg']}" for err in e.errors()]
        return False, errors


def validate_file(path: str) -> tuple[bool, list[str]]:
    """Validate IDEAL STATE from a JSON file."""
    try:
        with open(path) as f:
            data = json.load(f)
        return validate_json(data)
    except json.JSONDecodeError as e:
        return False, [f"Invalid JSON: {e}"]
    except FileNotFoundError:
        return False, [f"File not found: {path}"]


def validate_stdin() -> tuple[bool, list[str]]:
    """Validate IDEAL STATE from stdin."""
    try:
        data = json.load(sys.stdin)
        return validate_json(data)
    except json.JSONDecodeError as e:
        return False, [f"Invalid JSON: {e}"]


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--stdin":
        valid, errors = validate_stdin()
    elif len(sys.argv) > 1:
        valid, errors = validate_file(sys.argv[1])
    else:
        print("Usage: validate_ideal_state.py <file.json> | --stdin", file=sys.stderr)
        sys.exit(2)
    
    if valid:
        print("✅ IDEAL STATE valid")
        sys.exit(0)
    else:
        print("❌ IDEAL STATE invalid:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)
