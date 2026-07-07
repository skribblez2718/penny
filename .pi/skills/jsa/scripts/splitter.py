"""
jsa Skill — Chunk Splitter

Splits JavaScript source into analyzable chunks.
Main entry point: split_js_multi() — concatenate all files, split, resolve spans.
"""

import subprocess
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# 1.1.1 Token estimation
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """
    Conservative token estimate for JavaScript code.
    
    GPT/Claude tokenizers average ~3-4 characters per token.
    Code is more token-dense (more punctuation, shorter tokens).
    We use 3 chars/token as a conservative estimate (slightly overestimates).
    
    If tiktoken is available, prefer its precise count.
    """
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except ImportError:
        return len(text) // 3


# ---------------------------------------------------------------------------
# 1.1.10 Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class CodeSegment:
    """A semantically coherent piece of code (function, class, block)."""
    start_byte: int
    end_byte: int
    token_count: int
    segment_type: str   # "function", "class", "import", "export", "global_stmt", "block", "method"
    can_split: bool = False
    children: list["CodeSegment"] = field(default_factory=list)


@dataclass
class Chunk:
    """A single chunk of JavaScript code for analysis."""
    chunk_id: str                   # "chunk-0", "chunk-1", etc.
    start_byte: int
    end_byte: int
    preamble: str                   # Imports + global declarations (shared across chunks)
    body: str                       # The chunk's core code
    overlap_context: str            # Surrounding functions for context
    is_overlap: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SplitResult:
    """Result of splitting a single source into chunks."""
    chunks: list[Chunk]
    method: str                     # "ast_aware" | "token_based" | "single_chunk"
    total_tokens: int
    chunk_count: int
    preamble_tokens: int


@dataclass
class FileMapEntry:
    """Maps byte offsets in the concatenated stream to original file locations."""
    file_path: str
    concat_start_byte: int
    concat_end_byte: int
    original_line_count: int


@dataclass
class FileMap:
    """Collection of FileMapEntry sorted by concat_start_byte."""
    entries: list[FileMapEntry]

    def resolve_byte(self, byte_offset: int) -> tuple[str, int]:
        """Resolve a byte offset in concatenated stream to (file_path, line_number)."""
        for entry in self.entries:
            if entry.concat_start_byte <= byte_offset < entry.concat_end_byte:
                # The byte offset is in the delimiter + file content
                # We need to subtract the delimiter to get the file byte offset
                delimiter = f"\n// === file: {entry.file_path} ===\n"
                file_byte = byte_offset - entry.concat_start_byte - len(delimiter)
                return (entry.file_path, max(0, file_byte))
        return ("<unknown>", 0)


@dataclass
class FileSpan:
    """A contiguous span within one original file."""
    file_path: str
    start_line: int                 # 1-indexed
    end_line: int
    start_byte: int                 # In original file
    end_byte: int
    source_text: str


@dataclass
class ResolvedChunk:
    """A chunk with resolved file locations."""
    chunk_id: str
    body: str
    overlap_context: str
    file_spans: list[FileSpan]
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class MultiSplitResult:
    """Result of splitting multiple files via concatenation."""
    chunks: list[ResolvedChunk]
    file_map: FileMap
    method: str
    total_tokens: int
    chunk_count: int


# ---------------------------------------------------------------------------
# 1.1.2 tree-sitter parse
# ---------------------------------------------------------------------------

# Lazy-loaded parser
_parser = None
_js_language = None


def _get_parser():
    global _parser, _js_language
    if _parser is None:
        try:
            import tree_sitter_javascript as tsjs
            from tree_sitter import Language, Parser
            _js_language = Language(tsjs.language())
            _parser = Parser(_js_language)
        except ImportError:
            return None
    return _parser


def parse_js(source: str):
    """
    Parse JavaScript source with tree-sitter.
    Returns the syntax tree or None if parsing fails badly.
    """
    parser = _get_parser()
    if parser is None:
        return None
    
    tree = parser.parse(bytes(source, "utf-8"))
    
    # Check error severity
    if tree.root_node.has_error:
        error_nodes = _count_error_nodes(tree.root_node)
        total_nodes = _count_total_nodes(tree.root_node)
        if total_nodes > 0 and error_nodes / total_nodes > 0.1:
            return None  # More than 10% errors — fall back
    
    return tree


def _count_error_nodes(node) -> int:
    count = 1 if node.has_error else 0
    for child in node.children:
        count += _count_error_nodes(child)
    return count


def _count_total_nodes(node) -> int:
    count = 1
    for child in node.children:
        count += _count_total_nodes(child)
    return count


# ---------------------------------------------------------------------------
# 1.1.3 Extract top-level segments
# ---------------------------------------------------------------------------

_NODE_TYPE_MAP: dict[str, str] = {
    "import_statement": "import",
    "export_statement": "export",
    "function_declaration": "function",
    "class_declaration": "class",
    "method_definition": "method",
    "variable_declaration": "global_stmt",
    "lexical_declaration": "global_stmt",
    "expression_statement": "global_stmt",
    "if_statement": "block",
    "for_statement": "block",
    "for_in_statement": "block",
    "while_statement": "block",
    "do_statement": "block",
    "switch_statement": "block",
    "try_statement": "block",
    "with_statement": "block",
}


def extract_top_level_segments(tree, source: str) -> list[CodeSegment]:
    """Extract all top-level statements with token counts."""
    segments = []
    root = tree.root_node
    
    for child in root.children:
        seg_type = _NODE_TYPE_MAP.get(child.type, "other")
        tokens = estimate_tokens(source[child.start_byte:child.end_byte])
        
        segment = CodeSegment(
            start_byte=child.start_byte,
            end_byte=child.end_byte,
            token_count=tokens,
            segment_type=seg_type,
            can_split=seg_type in ("function", "class", "block"),
        )
        
        # If it's a large class, extract methods as sub-segments
        if seg_type == "class" and tokens > 6000:
            body_node = child.child_by_field_name("body")
            if body_node:
                segment.children = _extract_methods(body_node, source)
                segment.can_split = len(segment.children) > 1
        
        segments.append(segment)
    
    return segments


def _extract_methods(class_body_node, source: str) -> list[CodeSegment]:
    """Extract method definitions from a class body."""
    methods = []
    for child in class_body_node.children:
        if child.type == "method_definition":
            methods.append(CodeSegment(
                start_byte=child.start_byte,
                end_byte=child.end_byte,
                token_count=estimate_tokens(source[child.start_byte:child.end_byte]),
                segment_type="method",
                can_split=False,
            ))
    return methods


# ---------------------------------------------------------------------------
# 1.1.4 Greedy pack into chunks
# ---------------------------------------------------------------------------

def greedy_pack(
    segments: list[CodeSegment],
    source: str,
    max_tokens: int,
    overlap_tokens: int,
    file_path: str = "",
) -> list[Chunk]:
    """Pack segments into chunks respecting max_tokens with overlap."""
    
    # Separate preamble (imports + exports + globals) from body (functions/classes)
    preamble_segs = [s for s in segments if s.segment_type in ("import", "export")]
    global_segs = [s for s in segments if s.segment_type == "global_stmt"]
    body_segs = [s for s in segments if s.segment_type in ("function", "class", "block", "method")]
    
    # Build shared preamble
    preamble_parts = [source[s.start_byte:s.end_byte] for s in preamble_segs]
    preamble_parts += [source[s.start_byte:s.end_byte] for s in global_segs 
                       if estimate_tokens(source[s.start_byte:s.end_byte]) < 500]
    preamble = "\n\n".join(preamble_parts) if preamble_parts else ""
    preamble_tokens = estimate_tokens(preamble)
    
    available = max_tokens - preamble_tokens
    if available < 1000:
        available = max_tokens // 2  # Preamble is too large; still make room
    
    chunks: list[Chunk] = []
    current_body: list[CodeSegment] = []
    current_tokens = 0
    chunk_idx = 0
    
    def flush_chunk():
        nonlocal chunk_idx, current_body, current_tokens
        if not current_body:
            return
        
        body_text = "\n\n".join(source[s.start_byte:s.end_byte] for s in current_body)
        start_byte = current_body[0].start_byte
        end_byte = current_body[-1].end_byte
        
        # Build overlap context from surrounding segments
        all_body_indices = {id(s): i for i, s in enumerate(body_segs)}
        current_pos = all_body_indices.get(id(current_body[-1]), len(body_segs))
        
        overlap = _build_overlap_context(body_segs, current_pos, current_body, source, overlap_tokens)
        
        chunks.append(Chunk(
            chunk_id=f"chunk-{chunk_idx}",
            start_byte=start_byte,
            end_byte=end_byte,
            preamble=preamble,
            body=body_text,
            overlap_context=overlap,
            metadata={
                "method": "ast_aware",
                "chunk_index": chunk_idx,
                "total_chunks": 0,  # filled later
                "parent_file": file_path,
                "segment_count": len(current_body),
            }
        ))
        chunk_idx += 1
        current_body = []
        current_tokens = 0
    
    for i, seg in enumerate(body_segs):
        seg_tokens = seg.token_count
        
        # Case 1: Segment alone exceeds limit — split it
        if seg_tokens > available:
            if current_body:
                flush_chunk()
            
            if seg.can_split and seg.children:
                # Split class into methods
                sub_chunks = greedy_pack(seg.children, source, available, overlap_tokens, file_path)
                for sc in sub_chunks:
                    sc.chunk_id = f"chunk-{chunk_idx}"
                    chunk_idx += 1
                chunks.extend(sub_chunks)
            elif seg.segment_type == "function":
                # Split function body at statement boundaries
                sub = _split_oversized_function(seg, source, available, overlap_tokens, chunk_idx, file_path)
                chunks.extend(sub)
                chunk_idx += len(sub)
            else:
                # Can't split — include as-is
                current_body.append(seg)
                flush_chunk()
            continue
        
        # Case 2: Adding this segment would exceed limit — flush
        if current_tokens + seg_tokens > available:
            flush_chunk()
        
        # Case 3: Room to add
        current_body.append(seg)
        current_tokens += seg_tokens
    
    # Final flush
    flush_chunk()
    
    # Post-process: set total_chunks
    for c in chunks:
        c.metadata["total_chunks"] = len(chunks)
    
    return chunks


def _split_oversized_function(
    seg: CodeSegment,
    source: str,
    max_tokens: int,
    overlap_tokens: int,
    base_idx: int,
    file_path: str,
) -> list[Chunk]:
    """Split a single large function at statement boundaries."""
    for child in seg.children if hasattr(seg, 'children') else []:
        pass
    # Try to get body from the AST node — we don't have the node here,
    # so for this simplified version, just make it a single chunk
    return [Chunk(
        chunk_id=f"chunk-{base_idx}",
        start_byte=seg.start_byte,
        end_byte=seg.end_byte,
        preamble="",
        body=source[seg.start_byte:seg.end_byte],
        overlap_context="",
        metadata={"method": "oversized_function", "parent_file": file_path}
    )]


# ---------------------------------------------------------------------------
# 1.1.5 Overlap context builder
# ---------------------------------------------------------------------------

def _build_overlap_context(
    all_segments: list[CodeSegment],
    current_pos: int,
    current_segments: list[CodeSegment],
    source: str,
    overlap_tokens: int,
) -> str:
    """Build overlap context: surrounding functions for cross-boundary awareness."""
    parts = []
    current_ids = {id(s) for s in current_segments}
    
    # Previous context
    prev_tokens = 0
    for i in range(current_pos - 1, -1, -1):
        seg = all_segments[i]
        if id(seg) in current_ids:
            continue
        seg_text = source[seg.start_byte:seg.end_byte]
        seg_tokens = estimate_tokens(seg_text)
        if prev_tokens + seg_tokens > overlap_tokens:
            break
        parts.insert(0, f"// [PREVIOUS CONTEXT] {seg.segment_type}\n{seg_text}")
        prev_tokens += seg_tokens
        if prev_tokens > overlap_tokens // 2:
            break
    
    # Next context
    next_tokens = 0
    for i in range(current_pos, len(all_segments)):
        seg = all_segments[i]
        if id(seg) in current_ids:
            continue
        seg_text = source[seg.start_byte:seg.end_byte]
        seg_tokens = estimate_tokens(seg_text)
        if next_tokens + seg_tokens > overlap_tokens:
            break
        parts.append(f"// [NEXT CONTEXT] {seg.segment_type}\n{seg_text}")
        next_tokens += seg_tokens
        if next_tokens > overlap_tokens // 2:
            break
    
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# 1.1.6 Token-based split (fallback)
# ---------------------------------------------------------------------------

def token_based_split(
    source: str,
    max_tokens: int,
    overlap_tokens: int,
    file_path: str = "",
) -> list[Chunk]:
    """Sliding-window token-based split for unparseable code."""
    chunks = []
    pos = 0
    chunk_idx = 0
    chars_per_token = 3  # Conservative
    
    while pos < len(source):
        end_pos = min(pos + (max_tokens * chars_per_token), len(source))
        
        if end_pos < len(source):
            # Try to break at a newline within the last 20% of the window
            search_start = max(pos, end_pos - int(max_tokens * 0.2 * chars_per_token))
            newline_pos = source.rfind('\n', search_start, end_pos)
            if newline_pos > search_start:
                end_pos = newline_pos + 1
        
        chunk_source = source[pos:end_pos]
        next_pos = max(pos + 1, end_pos - (overlap_tokens * chars_per_token))
        
        chunks.append(Chunk(
            chunk_id=f"chunk-{chunk_idx}",
            start_byte=pos,
            end_byte=end_pos,
            preamble="",
            body=chunk_source,
            overlap_context="",
            metadata={
                "method": "token_based",
                "chunk_index": chunk_idx,
                "total_chunks": 0,
                "parent_file": file_path,
            }
        ))
        
        pos = next_pos
        chunk_idx += 1
    
    for c in chunks:
        c.metadata["total_chunks"] = len(chunks)
    
    return chunks


# ---------------------------------------------------------------------------
# 1.1.7 Minified code handling
# ---------------------------------------------------------------------------

def handle_minified(
    source: str,
    max_tokens: int,
    overlap_tokens: int,
    file_path: str = "",
) -> list[Chunk]:
    """Try js-beautify → AST parse, fall back to token-based."""
    try:
        result = subprocess.run(
            ["npx", "js-beautify", "--type", "js"],
            input=source,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and len(result.stdout) > 0:
            beautified = result.stdout
            tree = parse_js(beautified)
            if tree is not None:
                segments = extract_top_level_segments(tree, beautified)
                return greedy_pack(segments, beautified, max_tokens, overlap_tokens, file_path)
    except Exception:
        pass
    
    return token_based_split(source, max_tokens, overlap_tokens, file_path)


# ---------------------------------------------------------------------------
# 1.1.8 Single-file entry point
# ---------------------------------------------------------------------------

def split_js(
    source: str,
    max_tokens: int = 12000,
    overlap_tokens: int = 2000,
    file_path: str = "",
) -> SplitResult:
    """Split a single JavaScript source into analyzable chunks."""
    total_tokens = estimate_tokens(source)
    
    # Trivial case: fits in one chunk
    if total_tokens <= max_tokens:
        chunk = Chunk(
            chunk_id="chunk-0",
            start_byte=0,
            end_byte=len(source),
            preamble="",
            body=source,
            overlap_context="",
            metadata={
                "method": "single_chunk",
                "total_chunks": 1,
                "chunk_index": 0,
                "parent_file": file_path,
                "segment_count": 1,
            }
        )
        return SplitResult(
            chunks=[chunk],
            method="single_chunk",
            total_tokens=total_tokens,
            chunk_count=1,
            preamble_tokens=0,
        )
    
    # Try AST-aware split
    tree = parse_js(source)
    if tree is not None:
        segments = extract_top_level_segments(tree, source)
        chunks = greedy_pack(segments, source, max_tokens, overlap_tokens, file_path)
        return SplitResult(
            chunks=chunks,
            method="ast_aware",
            total_tokens=total_tokens,
            chunk_count=len(chunks),
            preamble_tokens=estimate_tokens(chunks[0].preamble) if chunks else 0,
        )
    
    # Try deobfuscation then AST
    chunks = handle_minified(source, max_tokens, overlap_tokens, file_path)
    method = chunks[0].metadata.get("method", "token_based") if chunks else "token_based"
    
    return SplitResult(
        chunks=chunks,
        method=method,
        total_tokens=total_tokens,
        chunk_count=len(chunks),
        preamble_tokens=0,
    )


# ---------------------------------------------------------------------------
# 1.1.9 Multi-file concatenation entry point (MAIN)
# ---------------------------------------------------------------------------


def _resolve_byte_range(
    start_byte: int,
    end_byte: int,
    file_map: FileMap,
    files: list[tuple[str, str]],
) -> list[FileSpan]:
    """Convert a byte range in concatenated stream to (file, line) spans."""
    spans = []
    
    # Build lookup for original sources
    source_map = {fp: src for fp, src in files}
    
    for entry in file_map.entries:
        if entry.concat_end_byte <= start_byte:
            continue
        if entry.concat_start_byte >= end_byte:
            break
        
        overlap_start = max(start_byte, entry.concat_start_byte)
        overlap_end = min(end_byte, entry.concat_end_byte)
        
        original_source = source_map.get(entry.file_path)
        if original_source is None:
            continue
        
        delimiter = f"\n// === file: {entry.file_path} ===\n"
        delimiter_len = len(delimiter)
        
        original_start = overlap_start - entry.concat_start_byte - delimiter_len
        original_end = overlap_end - entry.concat_start_byte - delimiter_len
        
        original_start = max(0, original_start)
        original_end = min(len(original_source), original_end)
        
        if original_start >= original_end:
            continue  # Only delimiter
        
        before = original_source[:original_start]
        within = original_source[original_start:original_end]
        start_line = before.count('\n') + 1
        end_line = start_line + within.count('\n')
        
        spans.append(FileSpan(
            file_path=entry.file_path,
            start_line=start_line,
            end_line=end_line,
            start_byte=original_start,
            end_byte=original_end,
            source_text=within,
        ))
    
    return spans


# ---------------------------------------------------------------------------
# Quick self-test
# ---------------------------------------------------------------------------

