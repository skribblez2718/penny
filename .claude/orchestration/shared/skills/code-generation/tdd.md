# TDD Protocol for Code Generation

## RED-GREEN-REFACTOR Cycle

All code generation MUST follow TDD methodology:

### 1. RED Phase
- Write failing test first
- Test describes expected behavior
- Run test to confirm it fails

### 2. GREEN Phase
- Write minimal code to make test pass
- Focus on functionality, not elegance
- Run test to confirm it passes

### 3. REFACTOR Phase
- Improve code quality
- Remove duplication
- Ensure tests still pass

## Test Categories

### Unit Tests
- Test individual functions/methods
- Mock external dependencies
- Fast execution (<100ms per test)

### Integration Tests
- Test component interactions
- Use real dependencies where practical
- May be slower execution

### End-to-End Tests
- Test complete workflows
- Verify user-facing behavior
- Production-like environment

## Coverage Requirements

- Minimum 80% line coverage
- 100% coverage for critical paths
- All edge cases tested
- Error handling tested

## Test Structure

```python
def test_<function>_<scenario>_<expected_result>():
    # Arrange - set up test data
    # Act - call function under test
    # Assert - verify expected behavior
```

## Anti-Patterns

- Writing implementation before tests
- Testing implementation details instead of behavior
- Skipping refactor phase
- Ignoring test failures
- Over-mocking (testing mocks not code)
