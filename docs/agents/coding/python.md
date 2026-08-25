# Python Coding Standards — Contracts, validation, and delivery gates

## What

All retained Python utilities, services, watchers, and scripts use explicit, reviewable contracts. Type annotations, data models, validation, and tests reduce ambiguity for both human maintainers and AI-assisted changes. Skill orchestration remains TypeScript-only.

## Required toolchain

1. **Lint passes with zero errors.** `bun run py:lint`
2. **Format passes.** `bun run py:format:check`
3. **Typecheck passes.** `bun run py:typecheck`
4. **Tests pass.** Run focused pytest tests plus the applicable aggregate suite.

Mypy is a delivery gate. Do not silence an error with an untyped definition, `Any`, or a blanket ignore when a concrete model or narrow protocol can express the contract.

## Type and model rules

- Add parameter and return annotations to public functions, methods, and module-level callables. Annotate meaningful local boundaries when inference would hide a domain decision.
- Use `@dataclass(frozen=True)` or a Pydantic model for durable domain/state records. Use `TypedDict` for dictionary-shaped interoperability data when a class model would add no behavior.
- Model mutually exclusive states and results with tagged/discriminated unions (`Literal` tags plus dataclasses/Pydantic models), not a bag of optional dictionary keys.
- Do not use `dict[str, Any]` as a substitute for a known model. If the shape is intentionally open, use `Mapping[str, object]` and document why.
- Use `pathlib.Path` for filesystem paths, not `os.path` or string concatenation.
- Do not implement skill workflows in Python. `python-statemachine` remains permitted only for independently owned Python subsystems such as the memory-canary authority FSM.

## Boundaries and validation

- Treat JSON, environment variables, subprocess output, files, HTTP payloads, queues, and plugin data as `object`/`Unknown` at entry.
- Parse and validate once at the boundary with a Pydantic model, `TypeAdapter`, dataclass parser, or small explicit type guard. Return a contextual error on invalid input.
- After validation, pass concrete domain models inward. Do not propagate unvalidated mappings through business logic.
- `Any`, `typing.cast`, `# type: ignore`, and `# mypy: ignore-errors` are exceptional interoperability tools, not routine fixes. Keep an exception to one line or adapter, document its reason and removal condition, and add a test for the real boundary.

## Tests

Test fakes should implement a narrow `Protocol` or a small concrete fake rather than a generic mock dictionary. Use real data models in fixtures when they cross a module boundary. A deliberately partial third-party fake is acceptable only at the test boundary and should name the unsupported surface.

## Existing conventions

- Use structured Python logging; do not use ad-hoc print debugging in retained runtime code.
- Do not hardcode paths. Resolve them relative to project root or through explicit configuration.
- Do not use `sys.path` hacks; use proper package structure.

## Verification

- [ ] `bun run py:lint` passes
- [ ] `bun run py:format:check` passes
- [ ] `bun run py:typecheck` passes
- [ ] Focused pytest tests pass
- [ ] Public APIs and durable state have explicit models/types
- [ ] External data is validated before use
- [ ] No broad `Any`, cast, or ignore bypasses a known contract
