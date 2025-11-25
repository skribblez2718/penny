# Test Coverage Requirements

## Purpose

Testing standards for MCP server including coverage threshold, fixture requirements, test categories, and uv virtual environment execution.

## CRITICAL: uv Virtual Environment Execution

**ALL tests MUST run inside uv-created virtual environment. NEVER run tests globally.**

**Test Execution Command:**
```bash
# Run tests in uv virtual environment
uv run pytest tests/ --cov=src --cov-report=html --cov-fail-under=80

# Run specific test file
uv run pytest tests/unit/test_tools.py -v

# Run with coverage report
uv run pytest --cov=src --cov-report=term-missing
```

**Setup Requirements:**
- Tests must be runnable immediately after `uv sync` (no manual dependency installation)
- pytest.ini or pyproject.toml must configure pytest properly
- All test dependencies must be in pyproject.toml under `[project.optional-dependencies]` or `[tool.uv]`

## Coverage Threshold: >80% (When Tests Included)

Minimum 80% code coverage required when testing_configuration = "yes". Configure pytest with --cov-fail-under=80.

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

**Must include in pyproject.toml:**
```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
python_classes = ["Test*"]
python_functions = ["test_*"]
addopts = [
    "--cov=src",
    "--cov-report=html",
    "--cov-report=term-missing",
    "--cov-fail-under=80",
    "-v"
]
asyncio_mode = "auto"
```

**Test Dependencies in pyproject.toml:**
```toml
[project.optional-dependencies]
test = [
    "pytest>=7.0.0",
    "pytest-cov>=4.0.0",
    "pytest-asyncio>=0.21.0",
    "pytest-mock>=3.10.0"
]
```

## When to Skip Tests

**Skip test generation when:**
1. **testing_configuration = "skip-requires-api-key"**
   - Service requires live API credentials (Open WebUI, Slack, GitHub with real tokens)
   - Cannot reasonably mock API behavior
   - Manual testing with actual API instance is more practical
   - **Document in README:** Add "Testing" section explaining why tests are not included and how to validate functionality manually

2. **testing_configuration = "no"**
   - Rapid prototyping or internal tools
   - Tests will be added later by development team
   - Minimal documentation needed

**Example README Testing Section (when skip-requires-api-key):**
```markdown
## Testing

This MCP server requires a live Open WebUI instance with valid API credentials to function. Automated testing would require either:
- Mock implementations of all 330 Open WebUI API endpoints
- A dedicated test Open WebUI deployment

For practical validation, we recommend manual testing using your MCP client:

### Manual Testing Checklist

1. **Setup Verification**
   - [ ] MCP server starts without errors
   - [ ] Environment variables loaded correctly (check logs)
   - [ ] Connection to Open WebUI API successful

2. **Core Functionality**
   - [ ] list_chats returns your conversations
   - [ ] list_models shows available models
   - [ ] send_message creates a new chat message
   - [ ] create_chat starts a new conversation

3. **Error Handling**
   - [ ] Invalid API key returns clear error
   - [ ] Network timeout handled gracefully
   - [ ] Invalid chat ID returns appropriate error

Run these tests after setting up your environment variables and confirming connectivity to your Open WebUI instance.
```
