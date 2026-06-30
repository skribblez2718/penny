# Web UI Integration Checklist

For any project that includes a frontend UI (Streamlit, React, Next.js, Vue,
Svelte, HTMX, etc.), the implement agent MUST consult this reference.

## 1. CSS Selector Hygiene

Framework-generated DOM is NOT your DOM. Avoid naive selectors.

### Streamlit

| ❌ Don't Use | ✅ Use Instead | Why |
|-------------|---------------|-----|
| `.st-key-my-button button` (assumes class format) | `[data-testid="stSidebar"] button` or `[class*="st-key-"]` | Emotion CSS-in-JS generates volatile class names. The key prefix is stable but the full class differs per widget instance. |
| `.stChatMessage .avatar` (assumes structure) | `[data-testid="stChatMessage"]:has([aria-label="Chat message from user"])` | Custom emoji avatars do NOT get `data-testid` attributes. Only default avatars ("U", "A") do. |
| `#my-element` (ID selectors) | `[data-testid="stSomeElement"]` | Streamlit generates no IDs on widgets. |
| `.element-container:first-child` (positional) | Use `data-testid` or `aria-label` attributes | Element order changes as the page re-renders. |

### General Rules for All Frameworks

1. **Prefer `data-testid` and `aria-label` attributes** — they are the most stable selectors.
2. **When targeting custom classes**: use attribute selectors (`[class*="prefix"]`) over direct class selectors (`.prefix-*`) because generated suffixes vary.
3. **Never use positional selectors** (`:nth-child`, `:first-child`) unless the structure is fully under your control.
4. **Test selectors in the actual browser** — what looks right in the source does not always match the DOM after framework processing.

## 2. Theme System Interaction

| ❌ Anti-Pattern | ✅ Correct Pattern | Rationale |
|----------------|-------------------|-----------|
| Overriding background colors in custom CSS | Let the framework handle base colors; use CSS for layout only (padding, border, alignment) | Frameworks like Streamlit use CSS-in-JS with `!important` internally. Your custom color overrides WILL conflict. |
| Injecting light-mode colors unconditionally | Use the framework's built-in theme switching API | Streamlit: `.streamlit/config.toml` for base, `st._config.set_option("theme.base", ...)` for runtime. React: CSS variables with `data-theme` attribute. |
| Assuming system preference == user preference | Default to a fixed theme (dark or light), provide toggle | OS dark mode ≠ user wants dark mode in YOUR app. Explicit is better. |
| Theme toggle at bottom of long sidebar | Place theme toggle at TOP of sidebar/navbar | "Set and forget" controls should be visible without scrolling. |

### Streamlit Theme Setup

```python
# Module level — MUST be the first Streamlit command
st.set_page_config(page_title="App", layout="wide", ...)

# Then initialize theme (after set_page_config — NOT before!)
if "theme" not in st.session_state:
    st.session_state.theme = "dark"

# Toggle handler
if st.button("🌙 Dark" if st.session_state.theme == "light" else "☀️ Light"):
    st.session_state.theme = "dark" if st.session_state.theme == "light" else "light"
    st._config.set_option("theme.base", st.session_state.theme)
    st.rerun()
```

```toml
# .streamlit/config.toml
[theme]
base = "dark"
```

**Key ordering rule**: `st.set_page_config()` MUST be called before `st._config.set_option()`. Calling them in reverse causes theme flash/mismatch on rerun.

## 3. State Synchronization

### Session State Patterns

```python
# ❌ DANGEROUS: Unconditional replacement on fetch
st.session_state.items = api.get_items()  # If API returns [], everything is wiped

# ✅ SAFE: Defensive merge
backend_items = api.get_items()
if backend_items:  # Only replace if fetch succeeded
    st.session_state.items = backend_items
```

### Loading States

Every asynchronous operation needs a loading state:

```python
# ❌ Missing: Silent wait, user sees nothing
data = api.fetch_slow()

# ✅ Correct: Show feedback
if st.session_state.get("loading") is None:
    ph = st.empty()
    ph.markdown("🔄 Loading...")
    data = api.fetch_slow()
    ph.empty()
```

## 4. User Interaction Patterns

### Destructive Actions

```python
# ❌ One-click delete
if st.button("Delete"): delete_item(item_id)

# ✅ Two-click confirmation
confirm_key = f"confirm_delete_{item_id}"
if st.session_state.get(confirm_key):
    if st.button("🗑 Confirm", key=f"del_confirm_{item_id}"):
        delete_item(item_id)
        del st.session_state[confirm_key]
        st.rerun()
else:
    if st.button("✕", key=f"del_{item_id}"):
        st.session_state[confirm_key] = True
        st.rerun()
```

### Empty States

Every list that can be empty needs an explicit empty-state message:

```python
if not items:
    st.caption("Nothing here yet. Create something!")
```

### Search/Filter

Add a filter input when lists exceed 5 items:

```python
if len(items) > 5:
    query = st.text_input("Search", placeholder="Filter...")
    if query:
        items = [i for i in items if query.lower() in i["name"].lower()]
```

## 5. Framework-Specific Gotchas

### Streamlit

| Gotcha | Fix |
|--------|-----|
| `st.html()` strips `<script>` tags | Keyboard shortcuts and dynamic JS injection are NOT possible in Streamlit. Use CSS-only solutions or `st.components`. |
| `st.set_page_config()` must be FIRST | Any `st.session_state` access or `st._config.set_option()` before it causes undefined behavior. |
| `st.rerun()` resets local variables | All persistent state MUST be in `st.session_state`. |
| Theme flash on first load | Set base theme in `.streamlit/config.toml`. |
| Custom CSS with emotion classes | `.st-emotion-cache-XXXXX` classes change between Streamlit versions. Never target them directly. |

### React

| Gotcha | Fix |
|--------|-----|
| useEffect double-fire in strict mode | Idempotent setup/teardown. |
| State updates batching | Use functional updates: `setCount(c => c + 1)`. |
| CSS-in-JS class volatility | Use `data-` attributes, not generated class names. |
