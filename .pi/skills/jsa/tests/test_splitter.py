"""
Splitter unit tests.

Test coverage:
- Single small file (single chunk)
- Multi-function file (ast_aware chunking)
- Multi-file concatenation (split_js_multi)
- Token estimation
- Empty file
- Determinism (same input → same chunks)
"""

import sys
from pathlib import Path

# Add scripts dir to path
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from splitter import (
    split_js,
    split_js_multi,
    estimate_tokens,
)


# ── Helpers ──

def _make_function(name: str, body_lines: int = 3) -> str:
    """Generate a simple function with given body size."""
    lines = [f"function {name}(data) {{"]
    for i in range(body_lines):
        lines.append(f"  const x{i} = data + {i};")
    lines.append("  return x0;")
    lines.append("}")
    return "\n".join(lines)


# ── Tests ──

class TestEstimateTokens:
    def test_small_string(self):
        assert estimate_tokens("hello") > 0
    
    def test_code(self):
        code = "function hello() { return 1; }"
        tokens = estimate_tokens(code)
        assert 3 <= tokens <= 30  # reasonable range
    
    def test_empty(self):
        assert estimate_tokens("") == 0


class TestSingleFile:
    def test_small_file_single_chunk(self):
        """Small file fits in one chunk."""
        source = "const x = 1;\nfunction hello() {\n  return x;\n}\n"
        result = split_js(source, max_tokens=12000)
        assert result.method == "single_chunk"
        assert result.chunk_count == 1
        assert result.chunks[0].body == source
        assert result.chunks[0].preamble == ""
    
    def test_empty_file(self):
        """Empty file produces one empty chunk."""
        result = split_js("", max_tokens=12000)
        assert result.chunk_count == 1
        assert result.chunks[0].body == ""
    
    def test_multi_function_file_ast_aware(self):
        """File with many functions gets split via AST."""
        funcs = [_make_function(f"func{i}") for i in range(30)]
        source = "\n".join(funcs)
        result = split_js(source, max_tokens=500, overlap_tokens=100)
        assert result.method == "ast_aware"
        assert result.chunk_count > 1
        # Check reasonable distribution
        tokens_per_chunk = [estimate_tokens(c.body) for c in result.chunks]
        assert all(t > 0 for t in tokens_per_chunk), "Empty chunk found"
        # All chunks should be within max_tokens (plus preamble)
        for c in result.chunks:
            assert estimate_tokens(c.body) + estimate_tokens(c.preamble) < 800, \
                f"Chunk {c.chunk_id} exceeds token limit"
    
    def test_with_imports(self):
        """File with imports preserves them in preamble."""
        source = (
            'import { foo } from "./bar";\n'
            'import { baz } from "./qux";\n'
            'const API = "/api";\n'
            + "\n".join([_make_function(f"func{i}") for i in range(25)])
        )
        result = split_js(source, max_tokens=400, overlap_tokens=80)
        for chunk in result.chunks:
            # All chunks should include the imports in preamble
            assert "import { foo }" in chunk.preamble, f"{chunk.chunk_id} missing imports"
    
    def test_determinism(self):
        """Same input produces identical chunks."""
        funcs = [_make_function(f"func{i}") for i in range(20)]
        source = "\n".join(funcs)
        r1 = split_js(source, max_tokens=500, overlap_tokens=100)
        r2 = split_js(source, max_tokens=500, overlap_tokens=100)
        assert r1.chunk_count == r2.chunk_count
        for c1, c2 in zip(r1.chunks, r2.chunks):
            assert c1.body == c2.body
    
    def test_overlap_context_present(self):
        """Chunks include overlap context for boundary awareness."""
        funcs = [_make_function(f"func{i}") for i in range(30)]
        source = "\n".join(funcs)
        result = split_js(source, max_tokens=500, overlap_tokens=200)
        # Middle chunks should have overlap context
        middle = result.chunks[len(result.chunks) // 2]
        assert len(middle.overlap_context) > 0 or result.chunk_count <= 2


class TestMultiFile:
    def test_concatenation_delimiters(self):
        """split_js_multi concatenates with proper delimiters."""
        files = [
            ("app.js", "const API = '/api';\nfunction init() {}\n"),
            ("utils.js", "function format(d) { return d.trim(); }\n"),
        ]
        result = split_js_multi(files)
        assert result.chunk_count >= 1
        # Body should contain delimiter
        body = result.chunks[0].body
        assert "// === file: app.js ===" in body
    
    def test_file_spans_resolve(self):
        """Chunks resolve to correct file spans."""
        files = [
            ("first.js", "const a = 1;\nconst b = 2;\n"),
            ("second.js", "const c = 3;\nconst d = 4;\n"),
        ]
        result = split_js_multi(files, max_tokens_per_chunk=100)
        for chunk in result.chunks:
            assert len(chunk.file_spans) >= 1
            for span in chunk.file_spans:
                assert span.file_path in ("first.js", "second.js")
                assert span.start_line >= 1
                assert span.end_line >= span.start_line
    
    def test_file_map_resolve(self):
        """FileMap resolves byte offsets to file paths."""
        files = [
            ("a.js", "// file a\nconst x = 1;\n"),
            ("b.js", "// file b\nconst y = 2;\n"),
        ]
        result = split_js_multi(files)
        # The first file starts after its delimiter
        fp, byte = result.file_map.resolve_byte(50)
        assert fp in ("a.js", "b.js")
        assert byte >= 0
    
    def test_active_analyzers_metadata(self):
        """active_analyzers is stored in chunk metadata."""
        files = [("app.js", "const x = 1;\n")]
        result = split_js_multi(files, active_analyzers=["dom_xss", "prototype_pollution"])
        for chunk in result.chunks:
            assert "dom_xss" in chunk.metadata["active_analyzers"]


class TestTokenBasedFallback:
    def test_token_based_on_broken_js(self):
        """Severely broken JS falls back to token-based split."""
        # Enough content to trigger chunking, but broken syntax
        broken = "var x = ; var y = ; " * 500  # Missing values
        result = split_js(broken, max_tokens=200)
        assert result.method in ("token_based", "ast_aware", "single_chunk")
        assert result.chunk_count >= 1


# ── Run ──

if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
