# Code Quality Standards

## Purpose

Defines quality standards for generated MCP server code including type hints, docstrings, validation, and error handling requirements.

## Type Hints (100% Coverage Required)

All functions/methods MUST have complete type hints including parameters, return types, and exceptions.

**Required:** typing imports, full annotations
**Pattern:** Use `from typing import Dict, List, Optional, Any, Union`

## Google-Style Docstrings (Required for Public Interfaces)

All public functions/methods/classes MUST have Google-style docstrings with Args, Returns, Raises sections.

## Pydantic Validation (All External Inputs)

All external inputs MUST use pydantic models with Field validators.

## Error Handling (No Internal Exposure)

Error messages must be user-friendly without exposing internals. Use custom exception hierarchy.

## Logging (Appropriate Levels)

INFO: Normal operations, WARNING: Recoverable issues, ERROR: Failures, DEBUG: Detailed debugging

## Code Formatting

Black formatting (line length 100), imports ordered, no unused imports, consistent naming (snake_case functions, PascalCase classes)
