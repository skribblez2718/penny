TEST-DRIVEN DEVELOPMENT PROTOCOL

PURPOSE
This protocol defines the systematic test-driven development (TDD) methodology for all code generation agents in the Penny AI system. TDD ensures code correctness, guides design from requirements, and maintains comprehensive test coverage through the Red-Green-Refactor cycle.

CRITICAL REQUIREMENT
ALL code generation agents MUST follow this protocol when creating implementation code. Tests are written BEFORE functional code. Code is written to pass tests. Refactoring maintains passing tests. This is NON-NEGOTIABLE for implementation quality and maintainability.

SCOPE OF APPLICATION
This protocol applies to:
- code-structure-generator (test scaffolding)
- core-implementation-generator (feature implementation)
- test-generator (test suite expansion)
- implementation-plan-generator (TDD milestone planning)
- implementation-validator (test execution validation)

TDD CORE PRINCIPLES

PRINCIPLE 1: TEST-FIRST DEVELOPMENT
Write the test BEFORE writing the code that makes it pass. The test defines the specification for what the code should do.

PRINCIPLE 2: MINIMAL IMPLEMENTATION
Write ONLY enough code to make the current failing test pass. Do not add functionality not required by tests.

PRINCIPLE 3: REFACTOR WITH CONFIDENCE
Improve code structure while keeping all tests passing. Tests provide safety net for refactoring.

PRINCIPLE 4: RED-GREEN-REFACTOR CYCLE
Every feature follows this cycle:
- RED: Write a failing test
- GREEN: Write minimal code to pass
- REFACTOR: Improve code while keeping tests green

PRINCIPLE 5: COMPREHENSIVE COVERAGE
Aim for high test coverage (80%+ for critical paths). Test edge cases, error conditions, and integration points.

THE RED-GREEN-REFACTOR CYCLE

STEP 1: RED - WRITE A FAILING TEST

WHEN: Beginning a new feature, bug fix, or code modification

ACTION: Create a test that describes the desired behavior

EXECUTION:
1. Identify the specific requirement or user story being implemented
2. Determine the smallest testable unit of functionality
3. Write a test that specifies the expected behavior:
   - Arrange: Set up test data and preconditions
   - Act: Execute the function/method being tested
   - Assert: Verify the expected outcome
4. Run the test and CONFIRM it fails with the expected failure message
5. If test passes unexpectedly, the test is invalid - revise
6. Document WHY this test exists (link to requirement)

TEST NAMING CONVENTION:
- test_<function_name>_<scenario>_<expected_result>
- Example: test_calculate_total_with_discount_returns_reduced_price

ASSERTIONS:
- Use specific assertions (assertEqual vs assertTrue when possible)
- Include meaningful failure messages
- Test one logical concept per test

ANTI-PATTERN: Writing test that passes immediately (not testing new code)
ANTI-PATTERN: Writing multiple tests before any implementation
ANTI-PATTERN: Vague test names like test_feature_1

STEP 2: GREEN - WRITE MINIMAL CODE TO PASS TEST

WHEN: After confirming test fails with expected reason

ACTION: Implement ONLY enough code to make the failing test pass

EXECUTION:
1. Review the failing test and its assertion
2. Implement the simplest solution that satisfies the test:
   - Hardcoded values are acceptable initially
   - Naive algorithms are acceptable initially
   - Focus on making test pass, not on elegance
3. Run the test and CONFIRM it now passes
4. Run ALL existing tests to ensure no regressions
5. If other tests fail, fix the implementation or revise tests
6. Commit when all tests pass (if using version control)

MINIMAL IMPLEMENTATION EXAMPLES:
- If test checks return value is 5, returning 5 is valid initially
- If test checks list has 3 items, creating list with exactly 3 items is valid
- Generalization happens in subsequent cycles

ANTI-PATTERN: Implementing features not required by current test
ANTI-PATTERN: Optimizing before tests pass
ANTI-PATTERN: Skipping test execution to "save time"

STEP 3: REFACTOR - IMPROVE CODE WHILE KEEPING TESTS GREEN

WHEN: After all tests pass and before writing next test

ACTION: Improve code structure, readability, and efficiency without changing behavior

EXECUTION:
1. Review implementation for improvement opportunities:
   - Remove duplication (DRY principle)
   - Improve naming (variables, functions, classes)
   - Simplify complex logic
   - Extract methods/functions for clarity
   - Apply design patterns where appropriate
   - Optimize algorithms if needed
2. Make ONE refactoring change at a time
3. Run ALL tests after each refactoring change
4. If tests fail, revert the refactoring
5. Commit each successful refactoring (if using version control)
6. Repeat until code meets quality standards

REFACTORING TARGETS:
- Magic numbers → named constants
- Long functions → extracted smaller functions
- Duplicated code → shared utilities
- Complex conditionals → guard clauses or strategy pattern
- Hardcoded values → configuration or parameters

ANTI-PATTERN: Changing behavior during refactoring
ANTI-PATTERN: Making multiple refactoring changes simultaneously
ANTI-PATTERN: Skipping test execution during refactoring
ANTI-PATTERN: Refactoring without comprehensive test coverage

STEP 4: REPEAT - CONTINUE CYCLE FOR NEXT REQUIREMENT

WHEN: Current feature complete and all tests passing

ACTION: Return to Step 1 for next requirement

EXECUTION:
1. Select next requirement from implementation plan
2. Begin new RED-GREEN-REFACTOR cycle
3. Gradually build comprehensive functionality through iteration
4. Maintain high test coverage throughout

TEST TYPES AND COVERAGE

UNIT TESTS
Definition: Test individual functions/methods in isolation
Coverage: All public functions, edge cases, error conditions
Isolation: Use mocks/stubs for dependencies
Speed: Fast execution (milliseconds per test)
Quantity: Majority of test suite (70-80% of tests)

Example domains:
- Pure functions with inputs and outputs
- Class methods with clear responsibilities
- Utility functions and helpers
- Data transformation logic

INTEGRATION TESTS
Definition: Test interaction between multiple components
Coverage: API endpoints, database operations, external services
Isolation: Use test databases, mock external services
Speed: Moderate execution (seconds per test)
Quantity: 15-25% of test suite

Example domains:
- API request/response flows
- Database CRUD operations
- Authentication/authorization flows
- Inter-module communication

END-TO-END TESTS
Definition: Test complete user workflows through entire system
Coverage: Critical user journeys, happy paths, key error paths
Isolation: Full system with test data
Speed: Slow execution (seconds to minutes per test)
Quantity: 5-10% of test suite

Example domains:
- User registration and login flow
- Complete transaction workflows
- Multi-step processes
- UI interactions (for web/mobile apps)

TEST COVERAGE TARGETS
- Critical business logic: 90-100%
- Core functionality: 80-90%
- Utility functions: 70-80%
- UI components: 60-70%
- Overall project: 80%+ minimum

TOOLS AND FRAMEWORKS

TEST FRAMEWORK SELECTION BY LANGUAGE
JavaScript/TypeScript: Jest, Vitest, Mocha + Chai
Python: pytest, unittest
Java: JUnit, TestNG
C#: NUnit, xUnit, MSTest
Ruby: RSpec, Minitest
Go: testing package, Testify
Rust: built-in test framework
PHP: PHPUnit

ASSERTION LIBRARIES
Provide expressive, readable test assertions
Examples: Chai (JS), Hamcrest (Java), Shouldly (C#)

MOCKING FRAMEWORKS
Isolate units under test from dependencies
Examples: Jest mocks (JS), unittest.mock (Python), Mockito (Java)

COVERAGE TOOLS
Measure test coverage percentage
Examples: Istanbul/nyc (JS), Coverage.py (Python), JaCoCo (Java)

TDD WORKFLOW INTEGRATION

DURING CODE STRUCTURE GENERATION (code-structure-generator)
1. Create test directory structure mirroring source structure
2. Set up test framework configuration
3. Create initial test files with skeleton tests
4. Configure test runner scripts
5. Verify test infrastructure works (run empty test suite)

DURING IMPLEMENTATION PLANNING (implementation-plan-generator)
1. Break features into testable units
2. Define test milestones per feature:
   - Unit tests for core logic
   - Integration tests for component interaction
   - E2E tests for user workflows
3. Estimate test count per feature (ratio: 3-5 tests per function)
4. Schedule refactoring milestones after green phases

DURING CORE IMPLEMENTATION (core-implementation-generator)
1. For each feature in implementation plan:
   a. Write failing unit test (RED)
   b. Implement minimal code (GREEN)
   c. Refactor for quality (REFACTOR)
   d. Repeat for next test
2. Write integration tests after unit tests pass
3. Write E2E tests after integration tests pass
4. Document test coverage achieved

DURING TEST GENERATION (test-generator)
1. Review existing implementation for coverage gaps
2. Add missing unit tests for edge cases
3. Add integration tests for component interactions
4. Add E2E tests for user workflows
5. Achieve target coverage percentage (80%+)

DURING VALIDATION (implementation-validator)
1. Execute complete test suite via Bash
2. Verify all tests pass (zero failures)
3. Check coverage percentage meets targets
4. Review test quality (meaningful assertions, good naming)
5. Flag gaps in test coverage as validation issues

TDD ANTI-PATTERNS TO AVOID

ANTI-PATTERN 1: WRITING TESTS AFTER CODE
Bad: Implement feature, then write tests to match
Impact: Tests validate existing behavior, not requirements
CORRECT: Write test first, implement to satisfy test

ANTI-PATTERN 2: TESTING IMPLEMENTATION DETAILS
Bad: Tests coupled to internal implementation
Impact: Refactoring breaks tests unnecessarily
CORRECT: Test public interface and behavior, not internals

ANTI-PATTERN 3: OVER-MOCKING
Bad: Mock every dependency, testing mocks not real code
Impact: Tests pass but integration fails
CORRECT: Mock external dependencies, use real internal dependencies when reasonable

ANTI-PATTERN 4: LARGE TESTS WITH MULTIPLE ASSERTIONS
Bad: One test validates many unrelated behaviors
Impact: Unclear what failed when test breaks
CORRECT: One logical concept per test, focused assertions

ANTI-PATTERN 5: SLOW TEST SUITES
Bad: Tests take minutes to run, discouraging frequent execution
Impact: Developers skip running tests, bugs slip through
CORRECT: Keep tests fast (< 10 seconds total for unit tests)

ANTI-PATTERN 6: IGNORING FAILING TESTS
Bad: Comment out or skip failing tests to make suite pass
Impact: Actual bugs hidden, false confidence
CORRECT: Fix implementation or fix test, never ignore

ANTI-PATTERN 7: NO REFACTORING PHASE
Bad: Write test, write code, move to next feature
Impact: Code quality degrades, technical debt accumulates
CORRECT: Always refactor after green, maintain quality

ANTI-PATTERN 8: TESTING FRAMEWORKS INSTEAD OF CODE
Bad: Tests verify Jest works or database driver works
Impact: No value added, wasted effort
CORRECT: Test your code's behavior, trust frameworks

EXAMPLE TDD SESSION

REQUIREMENT: Implement function to calculate discounted price

TEST 1 (RED):
```python
def test_calculate_discounted_price_with_10_percent_returns_90():
    # Arrange
    original_price = 100
    discount_percent = 10

    # Act
    result = calculate_discounted_price(original_price, discount_percent)

    # Assert
    assert result == 90, "10% discount on $100 should be $90"
```

Run test: FAILS (function doesn't exist)

IMPLEMENTATION 1 (GREEN):
```python
def calculate_discounted_price(original_price, discount_percent):
    return 90  # Hardcoded to pass test
```

Run test: PASSES

REFACTOR 1:
```python
def calculate_discounted_price(original_price, discount_percent):
    discount_amount = original_price * (discount_percent / 100)
    return original_price - discount_amount
```

Run test: PASSES

TEST 2 (RED):
```python
def test_calculate_discounted_price_with_zero_discount_returns_original():
    assert calculate_discounted_price(100, 0) == 100
```

Run test: PASSES (implementation already handles this)

TEST 3 (RED):
```python
def test_calculate_discounted_price_with_negative_price_raises_error():
    with pytest.raises(ValueError):
        calculate_discounted_price(-100, 10)
```

Run test: FAILS (no validation)

IMPLEMENTATION 3 (GREEN):
```python
def calculate_discounted_price(original_price, discount_percent):
    if original_price < 0:
        raise ValueError("Price cannot be negative")
    discount_amount = original_price * (discount_percent / 100)
    return original_price - discount_amount
```

Run tests: ALL PASS

REFACTOR 3:
```python
def calculate_discounted_price(original_price: float, discount_percent: float) -> float:
    """Calculate price after applying percentage discount.

    Args:
        original_price: Original price (must be non-negative)
        discount_percent: Discount percentage (0-100)

    Returns:
        Discounted price

    Raises:
        ValueError: If price is negative or discount invalid
    """
    if original_price < 0:
        raise ValueError("Price cannot be negative")
    if discount_percent < 0 or discount_percent > 100:
        raise ValueError("Discount must be between 0 and 100")

    discount_amount = original_price * (discount_percent / 100)
    return original_price - discount_amount
```

Run tests: ALL PASS

Cycle continues for next requirement...

INTEGRATION WITH OTHER PROTOCOLS

CONTEXT-INHERITANCE.md
- Load previous test coverage metrics from task memory
- Identify untested areas from previous Unknown quadrant
- Update Open quadrant with achieved coverage percentage

SECURITY-FIRST-DEVELOPMENT.md
- Write security tests for authentication, authorization, input validation
- Test for SQL injection, XSS, CSRF vulnerabilities
- Include security assertions in test cases

AGENT-EXECUTION-PROTOCOL.md
- Include TDD progress in phase outputs
- Document test count and coverage in Johari Summary
- Flag insufficient coverage in Unknown quadrant

REASONING-STRATEGIES.md
- Chain of Thought: Break requirements into testable units
- Tree of Thought: Evaluate test approaches (unit vs integration)
- Socratic Method: Question test completeness and edge cases

CONFIDENCE SCORING FOR TDD COMPLIANCE

CERTAIN: All code has test-first development, 90%+ coverage, all tests pass
PROBABLE: Most code test-first, 80%+ coverage, all tests pass
POSSIBLE: Some test-first development, 70%+ coverage, most tests pass
UNCERTAIN: Tests written after code, <70% coverage, or failing tests

VALIDATION CHECKLIST

Before marking TDD work complete:
- [ ] All tests written before implementation code
- [ ] All tests currently passing (zero failures)
- [ ] Test coverage meets targets (80%+ overall)
- [ ] Unit tests for all public functions
- [ ] Integration tests for component interactions
- [ ] E2E tests for critical user workflows
- [ ] Edge cases and error conditions tested
- [ ] Test names are descriptive and follow convention
- [ ] No tests skipped or commented out
- [ ] Refactoring phase completed for all features
- [ ] Test execution is fast (< 10 seconds for units)
- [ ] Mocks used appropriately (external dependencies only)

RELATED DOCUMENTATION
- .claude/protocols/SECURITY-FIRST-DEVELOPMENT.md - Security testing requirements
- .claude/protocols/CONTEXT-INHERITANCE.md - Test coverage tracking in memory
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md - Quality output standards
- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Progressive disclosure of test results

REMEMBER
Test-driven development is not optional overhead - it IS development. Writing tests first clarifies requirements, guides design, and provides confidence for refactoring. The RED-GREEN-REFACTOR cycle produces higher quality code faster than code-first approaches. Trust the process.
