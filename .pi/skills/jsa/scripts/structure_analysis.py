"""jsa Skill — Structural Analysis Functions (Phase C)

Additive exports added in Phase C of the structure-and-slice
migration. These functions power the STRUCTURE phase:
- build_file_manifest: per-file metadata
- build_ast_index: serialized AST summary per file
- extract_module_exports: import/export extraction
- extract_dangerous_patterns: tree-sitter pattern matching for sinks

All functions are backward-compatible — they don't modify existing
splitter.py behavior. They're called only by structure_handler in fsm.py.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union, Any

# Re-use existing splitter internals
from splitter import (
    _get_parser,
    parse_js,
    _count_error_nodes,
    _count_total_nodes,
)


@dataclass
class FileManifestEntry:
    """One entry in the file manifest produced by build_file_manifest."""
    path: str = ""
    size: int = 0
    tokens_estimated: int = 0
    sha1: str = ""
    line_count: int = 0
    extension: str = ""
    ast_available: bool = False
    parse_errors: int = 0
    parse_error_rate: float = 0.0


def build_file_manifest(
    files: list[tuple[str, str]],
) -> list[dict]:
    """Build a file manifest from (path, content) tuples.

    Args:
        files: List of (filename, content) tuples.

    Returns:
        List of FileManifestEntry dicts with metadata for each file.
    """
    manifest = []
    for path, content in files:
        # Compute SHA1 hash of content
        sha1 = hashlib.sha1(content.encode("utf-8", errors="replace")).hexdigest()

        # Estimate tokens (rough: 1 token per 4 chars)
        tokens = len(content) // 4

        # Count lines
        line_count = content.count("\n") if content else 0

        # Get extension
        ext = Path(path).suffix.lower()

        # Try to parse for AST availability
        ast_available = False
        parse_errors = 0
        parse_error_rate = 0.0
        try:
            tree = parse_js(content)
            if tree is not None:
                ast_available = True
                total_nodes = _count_total_nodes(tree)
                error_nodes = _count_error_nodes(tree)
                parse_errors = error_nodes
                if total_nodes > 0:
                    parse_error_rate = error_nodes / total_nodes
        except Exception:
            pass

        manifest.append({
            "path": path,
            "size": len(content),
            "tokens_estimated": tokens,
            "sha1": sha1,
            "line_count": line_count,
            "extension": ext,
            "ast_available": ast_available,
            "parse_errors": parse_errors,
            "parse_error_rate": round(parse_error_rate, 4),
        })

    return manifest


@dataclass
class ASTNode:
    """One node in the serialized AST index.

    Compact representation of a tree-sitter node for analysis.
    Full tree-sitter trees are too large to store; we keep
    only what agents need (node type, name/range, and selected
    child types).
    """
    id: int  # Unique node ID
    type: str  # Node type (e.g., "function_declaration", "call_expression")
    name: str = ""  # Function/class/variable name if applicable
    start_line: int = 0
    start_column: int = 0
    end_line: int = 0
    end_column: int = 0
    parent_id: Optional[int] = None
    child_ids: list[int] = field(default_factory=list)


@dataclass
class ASTIndex:
    """Compact AST index for a single file.

    Stores: top-level declarations, dangerous call sites, identifier
    usage. Intentionally compact — full trees are reconstructed on
    demand by the slice handler.
    """
    file_path: str = ""
    nodes: list[ASTNode] = field(default_factory=list)
    # Quick access indexes
    top_level_names: list[str] = field(default_factory=list)
    imports: list[str] = field(default_factory=list)
    exports: list[str] = field(default_factory=list)
    function_count: int = 0
    class_count: int = 0
    call_count: int = 0
    parse_errors: int = 0
    parse_error_rate: float = 0.0
    # Tree-sitter source bytes for re-querying
    source_bytes: bytes = b""


def build_ast_index(
    files: list[tuple[str, str]],
    include_source: bool = True,
) -> dict[str, ASTIndex]:
    """Build AST indexes for each file.

    Args:
        files: List of (filename, content) tuples.
        include_source: If True, store source bytes for re-querying.
                        If False, only metadata is stored (smaller memory).

    Returns:
        Dict mapping filename → ASTIndex.
    """
    indices: dict[str, ASTIndex] = {}
    parser = _get_parser()

    for path, content in files:
        index = ASTIndex(file_path=path)
        source_bytes = content.encode("utf-8", errors="replace")
        if include_source:
            index.source_bytes = source_bytes

        try:
            tree = parser.parse(source_bytes)
        except Exception:
            indices[path] = index
            continue

        # Walk the tree and build compact index
        node_id = 0
        total_nodes = 0
        error_nodes = 0

        def walk(node, parent_id=None):
            nonlocal node_id, total_nodes, error_nodes
            if node.type == "ERROR":
                error_nodes += 1
            total_nodes += 1

            # Capture key node types
            this_id = None
            if node.type == "function_declaration" and parent_id is None:
                # Only count top-level function declarations (not nested ones)
                index.function_count += 1
                # Extract function name from child identifier
                name = ""
                for child in node.children:
                    if child.type == "identifier":
                        name = child.text.decode("utf-8", errors="replace")
                        break
                ast_node = ASTNode(
                    id=node_id,
                    type=node.type,
                    name=name,
                    start_line=node.start_point[0] + 1,
                    start_column=node.start_point[1],
                    end_line=node.end_point[0] + 1,
                    end_column=node.end_point[1],
                    parent_id=parent_id,
                )
                index.nodes.append(ast_node)
                this_id = node_id
                if parent_id is None:
                    index.top_level_names.append(name)
                node_id += 1
            elif node.type == "class_declaration" and parent_id is None:
                # Only count top-level class declarations
                index.class_count += 1
                name = ""
                for child in node.children:
                    if child.type == "identifier":
                        name = child.text.decode("utf-8", errors="replace")
                        break
                ast_node = ASTNode(
                    id=node_id,
                    type=node.type,
                    name=name,
                    start_line=node.start_point[0] + 1,
                    start_column=node.start_point[1],
                    end_line=node.end_point[0] + 1,
                    end_column=node.end_point[1],
                    parent_id=parent_id,
                )
                index.nodes.append(ast_node)
                this_id = node_id
                if parent_id is None:
                    index.top_level_names.append(name)
                node_id += 1
            elif node.type == "call_expression" and parent_id is None:
                # Only count top-level call expressions
                index.call_count += 1
                name = ""
                # The function being called is the first child
                func_node = node.children[0] if node.children else None
                if func_node is not None:
                    name = func_node.text.decode("utf-8", errors="replace")
                ast_node = ASTNode(
                    id=node_id,
                    type=node.type,
                    name=name,
                    start_line=node.start_point[0] + 1,
                    start_column=node.start_point[1],
                    end_line=node.end_point[0] + 1,
                    end_column=node.end_point[1],
                    parent_id=parent_id,
                )
                index.nodes.append(ast_node)
                this_id = node_id
                node_id += 1
            elif node.type == "import_statement":
                # Capture the import path
                import_text = node.text.decode("utf-8", errors="replace")
                index.imports.append(import_text)
            elif node.type == "export_statement":
                export_text = node.text.decode("utf-8", errors="replace")
                index.exports.append(export_text)

            # Recurse into children
            for child in node.children:
                walk(child, this_id)

        walk(tree.root_node)

        index.parse_errors = error_nodes
        index.parse_error_rate = (error_nodes / total_nodes) if total_nodes > 0 else 0.0

        indices[path] = index

    return indices


# Tree-sitter query patterns for dangerous sources/sinks
# These are stored as pattern strings; they get compiled when used.
DANGEROUS_SINK_PATTERNS: list[dict] = [
    {
        "pattern_id": "innerHTML_assignment",
        "description": "Assignment to .innerHTML or .outerHTML",
        "tree_sitter_query": """
            (assignment_expression
                left: (member_expression
                    property: (property_identifier) @prop)
                right: (_) @value)
            (#match? @prop \"innerHTML|outerHTML|insertAdjacentHTML\")
        """,
        "severity": "high",
        "vuln_classes": ["dom_xss", "xss"],
    },
    {
        "pattern_id": "eval_call",
        "description": "Call to eval() or new Function()",
        "tree_sitter_query": """
            (call_expression
                function: (identifier) @fn)
            (#eq? @fn \"eval\")
        """,
        "severity": "critical",
        "vuln_classes": ["command_injection", "code_injection"],
    },
    {
        "pattern_id": "document_write",
        "description": "Call to document.write or document.writeln",
        "tree_sitter_query": """
            (call_expression
                function: (member_expression
                    object: (identifier) @obj
                    property: (property_identifier) @prop))
            (#eq? @obj \"document\")
            (#match? @prop \"write|writeln\")
        """,
        "severity": "high",
        "vuln_classes": ["dom_xss", "xss"],
    },
    {
        "pattern_id": "dangerous_setTimeout",
        "description": "setTimeout/setInterval with string argument",
        "tree_sitter_query": """
            (call_expression
                function: (identifier) @fn
                arguments: (arguments (string) @str))
            (#match? @fn \"setTimeout|setInterval\")
        """,
        "severity": "medium",
        "vuln_classes": ["command_injection", "code_injection"],
    },
    {
        "pattern_id": "postMessage_listener",
        "description": "window.addEventListener('message', ...) handler",
        "tree_sitter_query": """
            (call_expression
                function: (member_expression
                    object: (identifier) @obj
                    property: (property_identifier) @prop)
                arguments: (arguments (string (string_literal) @event) ...))
            (#match? @obj \"window|self|globalThis\")
            (#match? @prop \"addEventListener\")
            (#eq? @event \"message\")
        """,
        "severity": "medium",
        "vuln_classes": ["postmessage", "dom_xss"],
    },
    {
        "pattern_id": "object_assign",
        "description": "Object.assign(target, source) — prototype pollution vector",
        "tree_sitter_query": """
            (call_expression
                function: (member_expression
                    object: (identifier) @obj
                    property: (property_identifier) @prop))
            (#eq? @obj \"Object\")
            (#eq? @prop \"assign\")
        """,
        "severity": "high",
        "vuln_classes": ["prototype_pollution"],
    },
    {
        "pattern_id": "fetch_call",
        "description": "fetch(url) — potential SSRF if url is attacker-controlled",
        "tree_sitter_query": """
            (call_expression
                function: (identifier) @fn)
            (#eq? @fn \"fetch\")
        """,
        "severity": "low",
        "vuln_classes": ["ssrf"],
    },
    {
        "pattern_id": "location_access",
        "description": "Access to location.* — possible untrusted input source",
        "tree_sitter_query": """
            (member_expression
                object: (identifier) @obj
                property: (property_identifier) @prop)
            (#eq? @obj \"location\")
        """,
        "severity": "info",
        "vuln_classes": ["dom_xss", "open_redirect"],
    },
]


def extract_dangerous_patterns(
    files: list[tuple[str, str]],
) -> list[dict]:
    """Find dangerous patterns in JS files using tree-sitter queries.

    Args:
        files: List of (filename, content) tuples.

    Returns:
        List of pattern match dicts with:
        - file: filename
        - line: line number
        - column: column number
        - pattern_id: which pattern matched
        - description: human-readable
        - code_snippet: matched code
        - severity: "info" | "low" | "medium" | "high" | "critical"
        - suggested_vuln_classes: list of vuln classes
    """
    findings = []
    parser = _get_parser()

    # Try to get the language for queries
    language = None
    if hasattr(parser, "language"):
        language = parser.language
    elif hasattr(parser, "_language"):
        language = parser._language

    if language is None:
        # No tree-sitter available — return empty
        return findings

    for path, content in files:
        try:
            source_bytes = content.encode("utf-8", errors="replace")
            tree = parser.parse(source_bytes)
        except Exception:
            continue

        for pattern in DANGEROUS_SINK_PATTERNS:
            query_text = pattern["tree_sitter_query"].strip()
            try:
                # Use the new Query API (Query() is deprecated)
                from tree_sitter import Query, QueryCursor
                query = Query(language, query_text)
                matches = QueryCursor(query).matches(tree.root_node)
            except Exception:
                # Query syntax error or unsupported; skip
                continue

            for match in matches:
                # match is a tuple: (pattern_index, captures_dict)
                if not match or len(match) < 2:
                    continue
                captures = match[1]
                if not captures:
                    continue

                # Get the first captured node for location info
                first_capture = next(iter(captures.values()), [None])[0]
                if first_capture is None:
                    continue

                # Extract code snippet around the match
                start_byte = max(0, first_capture.start_byte - 20)
                end_byte = min(len(source_bytes), first_capture.end_byte + 20)
                snippet = source_bytes[start_byte:end_byte].decode(
                    "utf-8", errors="replace"
                )

                findings.append({
                    "file": path,
                    "line": first_capture.start_point[0] + 1,
                    "column": first_capture.start_point[1],
                    "pattern_id": pattern["pattern_id"],
                    "description": pattern["description"],
                    "code_snippet": snippet,
                    "severity": pattern["severity"],
                    "suggested_vuln_classes": pattern["vuln_classes"],
                })

    return findings


def extract_module_exports(
    files: list[tuple[str, str]],
) -> dict[str, list[str]]:
    """Extract import/export statements from each file.

    Returns:
        Dict mapping filename → list of import/export strings.
    """
    result: dict[str, list[str]] = {}
    indices = build_ast_index(files, include_source=False)
    for path, index in indices.items():
        result[path] = list(index.imports) + list(index.exports)
    return result
