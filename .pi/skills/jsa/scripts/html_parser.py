"""jsa Skill — HTML Parser

Uses Python stdlib html.parser to extract security-relevant HTML
structure for PageCard DOM inventory:
- <script src="..."> tags (external scripts)
- <script>...</script> inline blocks
- DOM IDs and names
- Form actions and method
- Inline event handlers (onclick, onsubmit, etc.)
- Iframe sources
- Meta tags (CSP-related, viewport, etc.)
- CSP header (from <meta http-equiv="Content-Security-Policy">)

This module is intentionally stdlib-only to avoid adding new dependencies.
For more sophisticated parsing, we could use html5lib or BeautifulSoup,
but the stdlib parser is sufficient for security analysis.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional, Union
from urllib.parse import urljoin


@dataclass
class ParsedHTMLPage:
    """Result of parsing one HTML page."""
    page_url: str = ""

    # <script src="..."> external scripts
    external_scripts: list[str] = field(default_factory=list)
    # <script>...</script> inline blocks
    inline_scripts: list[str] = field(default_factory=list)
    # integrity and crossorigin attrs for each external script
    script_integrity: dict[str, str] = field(default_factory=dict)  # url → integrity hash
    script_crossorigin: dict[str, str] = field(default_factory=dict)  # url → crossorigin

    # DOM elements
    dom_ids: list[str] = field(default_factory=list)
    dom_names: list[str] = field(default_factory=list)

    # Forms
    form_actions: list[str] = field(default_factory=list)
    form_methods: list[str] = field(default_factory=list)
    form_inputs: list[dict[str, str]] = field(default_factory=list)

    # Inline event handlers (e.g., onclick="...")
    inline_event_handlers: list[str] = field(default_factory=list)

    # Iframes
    iframe_srcs: list[str] = field(default_factory=list)

    # Meta tags
    meta_tags: dict[str, str] = field(default_factory=dict)

    # CSP from <meta> tag (if present)
    csp_meta: Optional[str] = None

    # Title
    title: str = ""


class _SecurityHTMLParser(HTMLParser):
    """Internal HTMLParser subclass that captures security-relevant elements."""

    def __init__(self, page_url: str):
        super().__init__(convert_charrefs=True)
        self.result = ParsedHTMLPage(page_url=page_url)
        self._in_title = False
        self._title_buf: list[str] = []
        self._in_inline_script = False
        self._inline_script_buf: list[str] = []
        self._current_form_attrs: Optional[dict[str, str]] = None
        self._in_input = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]):
        attrs_dict = {k: (v or "") for k, v in attrs}

        if tag == "script":
            src = attrs_dict.get("src", "")
            if src:
                # Resolve relative URLs
                resolved = urljoin(self.result.page_url, src) if self.result.page_url else src
                self.result.external_scripts.append(resolved)
                if "integrity" in attrs_dict:
                    self.result.script_integrity[resolved] = attrs_dict["integrity"]
                if "crossorigin" in attrs_dict:
                    self.result.script_crossorigin[resolved] = attrs_dict["crossorigin"]
            else:
                # Inline script — start capturing
                self._in_inline_script = True
                self._inline_script_buf = []

        elif tag == "title":
            self._in_title = True
            self._title_buf = []

        elif tag == "iframe":
            src = attrs_dict.get("src", "")
            if src:
                resolved = urljoin(self.result.page_url, src) if self.result.page_url else src
                self.result.iframe_srcs.append(resolved)

        elif tag == "form":
            self._current_form_attrs = attrs_dict
            action = attrs_dict.get("action", "")
            if action:
                resolved = urljoin(self.result.page_url, action) if self.result.page_url else action
                self.result.form_actions.append(resolved)
            self.result.form_methods.append(attrs_dict.get("method", "GET").upper())

        elif tag == "input":
            # Capture form inputs
            if self._current_form_attrs is not None:
                input_data = {
                    "name": attrs_dict.get("name", ""),
                    "type": attrs_dict.get("type", "text"),
                    "value": attrs_dict.get("value", ""),
                }
                self.result.form_inputs.append(input_data)
            self._in_input = True

        # Capture DOM id and name attributes (any element with id/name)
        if "id" in attrs_dict:
            self.result.dom_ids.append(attrs_dict["id"])
        if "name" in attrs_dict:
            self.result.dom_names.append(attrs_dict["name"])

        if tag == "meta":
            name = attrs_dict.get("name", "")
            http_equiv = attrs_dict.get("http-equiv", "")
            content = attrs_dict.get("content", "")
            if http_equiv.lower() == "content-security-policy":
                self.result.csp_meta = content
            elif name:
                self.result.meta_tags[name] = content

        # Capture inline event handlers (any element with on* attrs)
        for attr_name, attr_value in attrs:
            if attr_name.startswith("on") and attr_value:
                self.result.inline_event_handlers.append(
                    f"{tag}[{attr_name}]={attr_value[:200]}"
                )

    def handle_endtag(self, tag: str):
        if tag == "script" and self._in_inline_script:
            self.result.inline_scripts.append("".join(self._inline_script_buf))
            self._in_inline_script = False
            self._inline_script_buf = []
        elif tag == "title":
            self.result.title = "".join(self._title_buf).strip()
            self._in_title = False
            self._title_buf = []
        elif tag == "form":
            self._current_form_attrs = None
        elif tag == "input":
            self._in_input = False

    def handle_data(self, data: str):
        if self._in_title:
            self._title_buf.append(data)
        elif self._in_inline_script:
            self._inline_script_buf.append(data)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, Optional[str]]]):
        # Self-closing tags like <meta ... />
        self.handle_starttag(tag, attrs)
        # No endtag for self-closing, no body content


def parse_html_page(
    html_content: str,
    page_url: str = "",
) -> ParsedHTMLPage:
    """Parse HTML and extract security-relevant structure.

    Args:
        html_content: The HTML string to parse.
        page_url: The URL of the page (for resolving relative URLs in src/href).

    Returns:
        ParsedHTMLPage with extracted elements.
    """
    parser = _SecurityHTMLParser(page_url=page_url)
    try:
        parser.feed(html_content)
        parser.close()
    except Exception:
        # Best-effort: return what we got
        pass
    return parser.result


def parse_html_file(
    file_path: Union[str, Path],
    page_url: str = "",
) -> Optional[ParsedHTMLPage]:
    """Parse an HTML file from disk.

    Returns None if the file can't be read.
    """
    p = Path(file_path)
    if not p.exists() or not p.is_file():
        return None
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return parse_html_page(content, page_url=page_url)


# Common security-relevant patterns
CSP_HEADER_PATTERN = re.compile(
    r"^Content-Security-Policy\s*:\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)

DANGEROUS_INTEGRITY_MISSING = re.compile(
    r"<script\s+src=[^>]*>(?![^>]*integrity=)",
    re.IGNORECASE,
)


def find_external_scripts_without_sri(html_content: str) -> list[str]:
    """Find external <script src="..."> tags missing Subresource Integrity.

    Returns the list of src URLs that should have integrity attributes but don't.
    """
    parser = _SecurityHTMLParser(page_url="")
    parser.feed(html_content)
    result = []
    for script in parser.result.external_scripts:
        if script not in parser.result.script_integrity:
            result.append(script)
    return result
