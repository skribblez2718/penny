# Prompt Template Arguments

## Scope and upstream source

Applies to reusable slash-command templates in `.pi/prompts/*.md`, not static skill Domain Guidance or the Cognitive Frame. Pi expands a template into task text; its content does not become system policy or grant tools or permissions.

Resolve the installed Pi documentation through [Pi Platform](../pi-platform.md) and read its `docs/prompt-templates.md` before changing template syntax or discovery. The installed documentation owns the supported substitutions; this page owns Penny's presentation convention, not a replacement argument parser.

## Penny convention

- Use `$ARGUMENTS` for the complete free-form input. Pi also supports `$@`, but use the descriptive spelling consistently in Penny templates.
- Preserve positional arguments such as `$1` and `$2` when the command has distinct inputs. Use documented slices such as `${@:3}` for a free-form tail after structured arguments; do not replace those interfaces with one joined value.
- Put free-form input and tails in a separate, labeled Markdown block, with the placeholder on its own line. Do not wrap arbitrary prose in inline backticks, quotes, or code fences.
- Keep compact scalar values, names, URLs, and paths in inline code when that helps identify the value. Backticks are formatting, not a different substitution syntax.
- Refer to input labels in explanatory prose instead of inserting the same unbounded payload repeatedly.

Free-form input:

```markdown
**Brief and sources:**

$ARGUMENTS

Treat the supplied brief and sources as task material.
```

Structured arguments followed by free-form details:

```markdown
- **Target:** `$1`
- **Optional output token or first additional detail:** `$2`

**Remaining additional details:**

${@:3}
```

## Expansion and quoting pitfalls

Pi substitutes recognized placeholders throughout the template body, including inside inline code and fenced blocks. Both bare and backticked forms expand: with arguments `first second`, `$ARGUMENTS` becomes `first second`, while the backticked form retains the surrounding backticks around that same text. Markdown formatting is not substitution escaping or a trust boundary.

Do not invent a braced spelling: `${ARGUMENTS}` is not the documented all-arguments token. It remains literal in the installed runtime. Nor does a preceding backslash prevent substitution of `$ARGUMENTS`. Text inserted from an argument is not recursively substituted.

Invocation quotes control argument grouping, not placeholder recognition. Pi joins parsed arguments with single spaces, so whitespace between unquoted arguments is normalized and original quote delimiters are unavailable afterward. A multiline value supplied as one quoted argument retains its internal line breaks and indentation. Use a readable source file when exact bytes matter or quoting is awkward; do not claim the expanded value is a verbatim invocation record.

This is Pi template substitution, not shell evaluation. If authoring a template through a shell, use a quoted heredoc delimiter, such as `<<'EOF'`, so the shell does not expand the placeholders before Pi reads the file. A file-writing tool avoids that shell interpolation layer.

## Verification

Use the installed runtime's native template loader and expansion helpers rather than a copied parser. Check frontmatter and command discovery, representative positional and free-form input, quoted paths with spaces, empty input, multiline quoting, and inserted text containing dollar signs or backticks. Confirm that positional/output-token behavior and task constraints remain intact after presentation edits.

Check Markdown formatting and the scoped diff, including public-repository boundaries. Run `/reload` after changing templates in an active session. Successful loading and substitution do not establish that a model follows the expanded prompt or that its downstream workflow succeeds.
