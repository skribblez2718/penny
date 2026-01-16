"""develop-ui-ux Composite Skill

Platform-agnostic UI/UX design system generation with token architecture
and accessibility compliance.

Phases:
  0. Design Requirements Clarification (LINEAR - MANDATORY)
  1. Design Pattern Research (LINEAR)
  2. Platform Analysis (LINEAR)
  3. Design Token Architecture (LINEAR - CRITICAL PATH)
  4. Component Library Design (LINEAR)
  5. Accessibility Compliance (LINEAR)
  6. Prototype & Validation (REMEDIATION → Phase 4)
"""

__all__ = ["SKILL_METADATA"]

SKILL_METADATA = {
    "name": "develop-ui-ux",
    "type": "composite",
    "composition_depth": 0,
    "total_phases": 7,
    "critical_path_phase": 3,  # Design Token Architecture
    "remediation_phase": 6,
    "remediation_target": 4,  # Loop to Component Library Design
    "max_remediation": 2,
}
