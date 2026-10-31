# Names, Comments and Layout

## Applies when

Writing, reviewing or diagnosing names, comments, documentation attached to code, formatting or source organization.

## Name the meaning

Use intention-revealing, searchable and pronounceable names with one consistent term per concept. Prefer domain vocabulary for domain rules and established technical vocabulary for technical mechanisms. Avoid cosmetic distinctions, misleading pluralization, overloaded words, private jokes and visually confusable identifiers. Established abbreviations are useful; invented abbreviations make readers decode the code.

Put necessary context in a type, module or namespace instead of repeating it in every identifier. Do not remove context that distinguishes units, lifecycle, trust or role. A type prefix that merely repeats a declared type is usually noise; a name such as `elapsed_seconds` may prevent a real unit mistake. Choose meaningful noun or action names according to the language and contract rather than enforcing a grammatical rule mechanically.

If a routine's name cannot explain its result or effects, examine its responsibility. Rename when it clarifies the authorized change, not as a repository-wide vocabulary cleanup. Keep public, serialized, reflected and generated names compatible or provide an intentional transition.

## Comments carry information code cannot

Useful comments explain contracts, invariants, design rationale, legal obligations, external constraints, warnings and non-obvious algorithmic facts. Keep that information near the relevant interface or implementation. Comments should not expose internals a caller otherwise need not understand.

Improve a misleading name or tangled expression rather than narrating it line by line. Keep a useful explanation when the algorithm cannot be made obvious without harming it. Do not delete a rationale or external constraint merely because the implementation is short. An assertion can make a programmer invariant executable, but cannot replace external input validation or a required explanation.

Update comments with behavior and remove stale or redundant ones. A necessary TODO should identify an actionable limitation; a vague promise of future cleanup does not contain current risk. Treat source comments, generated documentation and examples as claims that need to agree with the actual contract.

## Layout supports local reasoning

Follow the existing formatter and idioms rather than introducing a local dialect. Keep related statements and concepts close, reveal nesting and scope, and order high-level intent before subordinate detail where it helps navigation. Avoid brittle decorative alignment or dense one-liners that hide side effects and precedence. Where long lines make expressions or contracts hard to follow, restructure for readable local context within the project's formatting conventions; do not impose an unrelated numeric limit.

Do not split a coherent function solely to meet a length target. Conversely, scrolling through mixed responsibilities is evidence to consider a better boundary. Use variables, blank lines and helper names when they expose meaning, not merely to satisfy a style ritual.

## Verification

Read the changed path as a caller or maintainer: can the names predict its result and effects without decoding implementation trivia? Check vocabulary against related APIs, comments against behavior and formatter output against project conventions. Run relevant reference and compatibility checks after renames. Formatting or comment quality does not substitute for behavioral tests.
