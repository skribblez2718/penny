# Worker Protocol — JavaScript Security Analysis

> Injected as `skillContext` into every jsa worker agent.

## Mission

Analyze a specific code chunk for a specific vulnerability class. You are READ-ONLY — analyze code, never modify it.

## Protocol

### 1. Join the Mesh
On startup, announce yourself:
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-mesh", content={ agent: "{agent_name}", chunk_id: "{chunk_id}", vuln_class: "{vuln_class}", status: "starting" })
```

### 2. Load Context
Query the mesh to discover concurrent workers and their chunk boundaries:
```
memory_search(wing="wing_jsa", room="{session_id}-mesh")
memory_search(wing="wing_jsa", room="{session_id}-feed", limit=10)
```

### 3. Analyze (READ-ONLY)
- Parse the chunk code
- Run semgrep with the rulesets specified in your vuln-class prompt
- Trace sources to sinks using AST patterns and data flow analysis
- Flag cross-chunk patterns found in overlap regions
- Check mesh feed for cross-chunk hints from adjacent workers

### 4. Report Findings
Each finding must include:
- `finding_id`: UUID
- `vuln_class`: the vulnerability class
- `chunk_id`: your assigned chunk
- `file`: resolved from chunk metadata
- `line_start` / `line_end`: in original file
- `source`: normalized source pattern (e.g., "location.hash")
- `sink`: normalized sink pattern (e.g., "element.innerHTML")
- `confidence`: "confirmed" | "probable" | "possible"
- `description`: 1-3 sentences describing the vulnerability
- `code_snippet`: 5-10 lines of vulnerable code
- `data_flow`: source → transforms → sink trace
- `is_boundary`: true if finding is in overlap region
- `scanner`: which tool found it ("semgrep", "ast_trace", "grep", "jsluice")
- `evidence`: scanner-specific evidence

Store to MemPalace:
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-findings", content={ findings: [...] })
```

### 5. Post Cross-Chunk Hints
If a tainted variable flows across a chunk boundary (visible via overlap context or file delimiters), post a hint:
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-feed", content={
  type: "cross_chunk_hint",
  from_chunk: "{chunk_id}",
  pattern: "tainted variable 'userData' flows to {next_file}:{function_name}",
  direction: "forward"
})
```

### 6. Complete
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-mesh", content={ agent: "{agent_name}", status: "completed", findings_count: N })
```

## Rules

1. **Never fabricate.** Every finding must have observable evidence in the code.
2. **Distinguish theoretical from exploitable.** Flag sanitizer presence, CSP protection, and dead code.
3. **Use tools aggressively.** semgrep, grep, jsluice, tree-sitter AST — exhaust available scanners before reporting.
4. **Respect boundaries.** Only analyze YOUR chunk. Use mesh feed for cross-chunk awareness.
5. **Output format.** Follow the finding schema exactly. Structured output enables automated dedup.
