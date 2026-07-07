# Memory Extension Tests

This directory contains tests for the MemPalace memory extension at three layers of the stack.

## Test Files

| File                            | Layer                | Purpose                                                                  |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `unit/extension.test.ts`        | TypeScript Extension | Unit tests for tool definitions, parameter validation, result formatting |
| `integration/mempalace.test.ts` | Full Stack           | Integration tests that exercise the Python bridge against live MemPalace |
| `e2e/memory.e2e.test.ts`        | E2E                  | End-to-end tests verifying Pi binary and extension structure             |
| `integration/test_bridge.py`    | Python Bridge        | Direct tests for the bridge layer, routing, and error handling           |

## Running Tests

### TypeScript Unit Tests

Tests the extension layer without needing a live Python bridge:

```bash
cd <project-root>/.pi/extensions/memory
bun install
bun test
```

### TypeScript Integration Tests

Tests the full stack against live MemPalace:

```bash
bun run test:integration
```

**Prerequisites:**

- MemPalace initialized (`.mempalace` directory exists)
- Python venv with `mempalace` installed (`source .venv/bin/activate && pip install mempalace`)

### Python Bridge Tests

Tests the bridge routing directly:

```bash
cd <project-root>
source .venv/bin/activate
pytest .pi/extensions/memory/tests/test_bridge.py -v
```

### All Tests

Run all test layers:

```bash
bun run test:all
```

## Test Categories

### Palace Read Tools (7 tools)

- `memory_status` - Palace overview
- `memory_list_wings` - List wings with counts
- `memory_list_rooms` - List rooms in wings
- `memory_get_taxonomy` - Full hierarchy
- `memory_search` - Semantic search
- `memory_check_duplicate` - Duplicate detection
- `memory_get_aaak_spec` - AAAK format spec

### Palace Write Tools (2 tools)

- `memory_add_drawer` - Store content
- `memory_delete_drawer` - Remove content

### Knowledge Graph Tools (5 tools)

- `memory_kg_query` - Query relationships
- `memory_kg_add` - Add facts
- `memory_kg_invalidate` - End facts
- `memory_kg_timeline` - Chronological view
- `memory_kg_stats` - Graph statistics

### Navigation Tools (3 tools)

- `memory_traverse` - Walk palace graph
- `memory_find_tunnels` - Find cross-wing connections
- `memory_graph_stats` - Connectivity stats

### Agent Diary Tools (2 tools)

- `memory_diary_write` - Write entries
- `memory_diary_read` - Read entries

## Cleanup

Integration tests create temporary data during execution:

- Test drawers are tracked and deleted in `afterAll` hooks
- Test knowledge graph facts are invalidated after tests
- Test diary entries remain (no delete API exists)

## Manual Verification

For quick manual verification of all 19 tools:

```bash
# From Penny project root
source .venv/bin/activate

# Quick smoke test
python3 -c "
import json
import subprocess

bridge = '<project-root>/.venv/lib/python3.12/site-packages/penny_memory_bridge.py'
python = '<project-root>/.venv/bin/python'

tools = [
    ('status', {}),
    ('list_wings', {}),
    ('list_rooms', {}),
    ('get_taxonomy', {}),
    ('search', {'query': 'test'}),
    ('check_duplicate', {'content': 'test'}),
    ('get_aaak_spec', {}),
    ('kg_stats', {}),
    ('graph_stats', {}),
    ('diary_read', {'agent_name': 'penny', 'last_n': 1}),
]

for tool, params in tools:
    result = subprocess.run([python, bridge], input=json.dumps({'tool': tool, 'params': params}), capture_output=True, text=True)
    r = json.loads(result.stdout)
    status = '✓' if r.get('success') else '✗'
    print(f'{status} {tool}')
"
```

## Test Coverage Goals

| Layer                | Coverage Target | Notes                                           |
| -------------------- | --------------- | ----------------------------------------------- |
| TypeScript Extension | 80%+            | Parameter validation, formatting, observability |
| Python Bridge        | 80%+            | All tool routes, error handling, JSON parsing   |
| Integration          | All 19 tools    | Happy path for every tool                       |

## Debugging Failed Tests

### Bridge Connection Errors

If you see "Bridge exited with code X":

1. Verify Python path in `CONFIG.venvPython`
2. Verify bridge path in `CONFIG.bridgePath`
3. Run bridge manually: `echo '{"tool":"status","params":{}}' | .venv/bin/python .venv/lib/python3.12/site-packages/penny_memory_bridge.py`

### MemPalace Errors

If you see "No palace found":

1. Verify `.mempalace` directory exists
2. Verify ChromaDB collections exist: `ls .mempalace/chroma.sqlite3`
3. Re-initialize: `mempalace init <project-root>`

### Import Errors

If TypeScript can't find modules:

```bash
cd <project-root>
bun install
cd .pi/extensions/memory
bun install
```
