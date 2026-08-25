# Questionnaire extension

Provides the `questionnaire` tool for presenting one or more structured questions in Pi's interactive UI.

## Tool

- `questionnaire`: accepts one or more questions with predefined choices and an optional free-form answer. In non-interactive mode it returns a structured representation for the caller to relay. It also supports the trusted approval transport used by approved workflows.

## Configuration

No extension-specific environment variables are required.

## Development

```sh
bun run typecheck
bun run test:unit
bun run test:all
```

The tool schema is the runtime validation and static parameter contract. Run its unit tests after changes to question rendering, answer collection, or trusted transport handling.
