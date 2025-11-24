# Test Coverage Requirements

## Purpose

Testing standards for MCP server including coverage threshold, fixture requirements, and test categories.

## Coverage Threshold: >80%

Minimum 80% code coverage required. Configure pytest with --cov-fail-under=80.

## Realistic Fixtures (Based on API Documentation)

Mock data must match actual API responses from API documentation. Include all required fields, correct data types, realistic values.

## Test Categories Required

**Unit Tests:**
- All tools (success, validation error, API error, rate limit, timeout, edge cases)
- All services (business logic, API orchestration, error handling)
- All utilities (validation, rate limiting, logging)

**Integration Tests:**
- Complete MCP server flow (initialization, tool listing, tool execution)
- End-to-end with mock API server

## Edge Case Coverage

Test boundary conditions, empty inputs, null values, malformed data, timeout scenarios, rate limit exceeded

## Test Structure

Mirror source structure in tests/, conftest.py for shared fixtures, fixtures/ directory for mock data

## Pytest Configuration

Coverage reporting (html and terminal), fail on <80%, verbose output, asyncio support
