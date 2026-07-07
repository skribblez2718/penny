# Resilience Patterns

Language- and framework-agnostic defensive coding patterns that prevent
the most common production bugs. Applicable to all project types.

## 1. Error-Boundary State

Never replace existing state with potentially-empty results from a
network call, file read, or computation.

```python
# ❌ DANGEROUS
items = api.get_items()
st.session_state.items = items  # If API returns [], everything is wiped

# ✅ SAFE — Only merge on success
backend_items = api.get_items()
if backend_items:              # Guard against empty/error response
    st.session_state.items = backend_items

# ✅ SAFER — Merge with fallback
backend_items = api.get_items()
if backend_items is not None:  # Guard against None AND empty
    st.session_state.items = backend_items
else:
    logger.warning("Backend unreachable, keeping local state")
```

### Rule of thumb
If a fetch replaces local state, it MUST succeed (non-empty, non-None)
before the replacement happens. The local state is the source of truth
until the remote state is verified.

## 2. Garbage Collection

Auto-cleanup orphaned records that accumulate from partial operations.

```python
# After every data mutation, prune invalid states
def prune_empty_conversations():
    for item in list(state.items):
        if not item.get("data"):  # Empty = orphaned
            api.delete(item["id"])
            state.items.remove(item)
```

### Common orphan patterns:
- Conversations created before the first message (failed network)
- Sessions started but never confirmed
- Uploads initiated but never completed
- Drafts saved on crash but never submitted

## 3. Loading UX

Every potentially-blocking operation needs an explicit loading state.

```python
# ❌ Missing — silent block
result = slow_operation()

# ✅ Correct — explicit feedback
ph = st.empty()
ph.markdown("🔄 Processing...")
try:
    result = slow_operation()
finally:
    ph.empty()
```

### Coverage checklist:
- Initial page load (backend not yet reachable)
- Model loading (multi-second startup)
- Network requests (>500ms typical)
- File I/O operations
- Computations that may exceed a frame

## 4. State Initialization Order

Initialization order bugs are the second most common class of production
crash (behind import chain failures).

```python
# ❌ WRONG ORDER — session_state accessed before set_page_config
st._config.set_option("theme.base", theme)
st.set_page_config(...)

# ✅ CORRECT ORDER — page_config MUST be first
st.set_page_config(...)
st._config.set_option("theme.base", theme)
```

### General principle
Framework initialization hooks MUST precede application state reads.
Violating this causes silent failures (theme mismatch, config ignored)
rather than crashes, making the bugs very hard to detect.

## 5. Idempotency

Operations that may be retried (network calls, file writes, DB inserts)
should be safe to call multiple times with the same input.

```python
# ❌ Not idempotent — creates duplicates on retry
def create_item(data):
    db.insert(data)

# ✅ Idempotent — checks before creating
def create_item(data):
    existing = db.find_by_id(data["id"])
    if existing:
        return existing  # Return the existing one, don't create duplicate
    db.insert(data)
```

### Common idempotency targets:
- POST endpoints (use PUT when possible, or add idempotency keys)
- File writes (use atomic rename: write → temp, then rename)
- State transitions (check current state before advancing)

## 6. Graceful Degradation

When a dependency is unavailable, show reduced functionality rather than
an error page or crash.

```python
# ❌ Crash on missing dependency
model = load_model_or_die()

# ✅ Graceful degradation
try:
    model = load_model()
except Exception:
    model = None
    logger.warning("Model unavailable, using fallback")
    # Show UI with "Model loading..." state
```

### Degradation tiers:
1. **Full functionality** — all dependencies available
2. **Reduced functionality** — core features work, nice-to-haves disabled with explanation
3. **Read-only mode** — data visible, mutations disabled
4. **Maintenance page** — service entirely unavailable, clear ETA

## 7. Cleanup on Failure

When an operation fails partway through, clean up partially-created state.

```python
def create_and_populate(item):
    item_id = api.create(item)  # This succeeds
    result = api.populate(item_id, data)  # This fails
    if result is None:
        api.delete(item_id)  # Clean up the orphan
        return None
    return result
```

### Cleanup checklist:
- Database records created before a transaction commit fails
- Files written before the full operation completes
- Session state set before the full flow finishes
- Temporary resources (locks, handles, connections)
