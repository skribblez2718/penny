"""
sca Skill — Canonical tool manifest (Phase 3).

Single source of truth for the 9 tools the sca (secure code analysis) skill
provisions and/or dispatches. This module is PURE DATA plus a few lookup
helpers: no network, no external process calls, no filesystem access. The 8 tool
extensions (Phase 4) and the P2_BASELINE_SCAN / P7_TARGETED_SCAN local-tool
dispatch (Phase 6/7) consume this registry.

Architecture decisions encoded here (wing_decisions/sca-skill, Carren review):

  - REQUIRED tier: semgrep, osv-scanner, gitleaks. A missing REQUIRED tool
    blocks downstream phases (enforcement lives in provisioning.py's
    check_required_tools; wiring is deferred to a later phase).
  - OPTIONAL tier: everything else. A missing OPTIONAL tool degrades coverage
    but never blocks.
  - codeql is opt-in: ``enabled_by_default`` is False for codeql ONLY.
  - LICENSE tiers:
      * permissive_embed         — source may be vendored/embedded freely.
      * copyleft_invoke_only     — INVOKE the tool as a separate process only;
                                   NEVER embed/commit its source (would create
                                   AGPL/LGPL/MPL distribution obligations). The
                                   copyleft tools are trufflehog (AGPL) and
                                   njsscan (LGPLv3) — both carry a mandatory
                                   re-verification note (Carren N3) because a
                                   prior research contradiction surfaced on
                                   trufflehog's license — plus the combined
                                   eslint entry, which also covers
                                   eslint-plugin-no-unsanitized (MPL-2.0 weak
                                   copyleft) and is treated conservatively as
                                   invoke-only pending legal review.
      * not_applicable_existing_extension — the tool is NOT provisioned or
                                   vendored by this skill at all; it is supplied
                                   by a pre-existing Penny extension. Embedding
                                   is a non-question here, so neither
                                   permissive_embed ("embeddable") nor
                                   copyleft_invoke_only accurately describes it.
  - semgrep is already provisioned by the existing ``.pi/extensions/semgrep``
    extension, so it is recorded with ``source="existing-extension"`` and no
    separate install path / pinned download version. Its license_tier is
    ``not_applicable_existing_extension``: it is LGPL-2.1-only and sca never
    vendors it, so calling it permissive_embed would be factually wrong.

npm's built-in audit command is DELIBERATELY and PERMANENTLY excluded from this
registry: its advisory coverage is subsumed by osv-scanner. There is no entry
for it and no code path in this skill invokes it; the exclusion rationale is
recorded in ``.pi/skills/sca/NOTICE``.

SPDX values are DECLARED with a confidence annotation (PROBABLE for all here),
never asserted CERTAIN in code — upstream LICENSE files are the authority and
must be re-checked at real provisioning time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional


# ── Tier constants ───────────────────────────────────────────────────────
TIER_REQUIRED = "required"
TIER_OPTIONAL = "optional"

# ── License-tier constants ───────────────────────────────────────────────
LICENSE_PERMISSIVE_EMBED = "permissive_embed"
LICENSE_COPYLEFT_INVOKE_ONLY = "copyleft_invoke_only"
# For tools sca neither provisions nor vendors (supplied by a pre-existing
# extension): embedding is a non-question, so honestly say "not applicable".
LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION = "not_applicable_existing_extension"


class UnknownToolError(KeyError):
    """Raised when a tool name is not present in the manifest.

    Subclasses ``KeyError`` (hence ``LookupError``) so callers can catch it
    broadly, while giving a clear, sca-specific type at the boundary.
    """


@dataclass(frozen=True)
class ToolSpec:
    """Immutable declaration of one provisioned/dispatched tool.

    Fields:
      name                 canonical registry key (also the NOTICE key).
      binary               executable name to look up on PATH (may differ from
                           ``name``, e.g. retire.js -> "retire").
      tier                 TIER_REQUIRED | TIER_OPTIONAL.
      pinned_version       exact version to provision, or None when the tool is
                           supplied by an existing extension.
      license_tier         LICENSE_PERMISSIVE_EMBED | LICENSE_COPYLEFT_INVOKE_ONLY
                           | LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION.
      spdx_license         DECLARED SPDX identifier (see license_confidence).
      license_confidence   PROBABLE | POSSIBLE | UNCERTAIN — never CERTAIN in
                           code; upstream LICENSE is the authority.
      license_note         optional caveat (e.g. copyleft re-verify requirement).
      enabled_by_default   whether the tool runs without explicit opt-in.
      source               how the tool is obtained ("download" |
                           "existing-extension").
      source_signatures    substrings that identify this tool's OWN source code
                           (used by license_guard's copyleft build guard). Empty
                           for permissive-embed tools.
    """

    name: str
    binary: str
    tier: str
    pinned_version: Optional[str]
    license_tier: str
    spdx_license: str
    license_confidence: str
    enabled_by_default: bool
    source: str
    license_note: Optional[str] = None
    source_signatures: tuple = ()


# ── The manifest ─────────────────────────────────────────────────────────
#
# Order is the canonical declaration order. Required tools first.
_COPYLEFT_REVERIFY = (
    "PROBABLE -- MUST re-verify against the actual upstream LICENSE file at "
    "real provisioning time, per Carren N3 (a prior research contradiction "
    "surfaced on this tool's license)."
)

TOOL_MANIFEST: List[ToolSpec] = [
    # ── REQUIRED ──
    ToolSpec(
        name="semgrep",
        binary="semgrep",
        tier=TIER_REQUIRED,
        pinned_version=None,  # supplied by the existing semgrep extension
        # semgrep is LGPL-2.1-only and is NOT vendored by sca (it is Penny's
        # pre-existing .pi/extensions/semgrep), so "permissive_embed" would be
        # factually wrong. Embedding is a non-question -> not_applicable.
        license_tier=LICENSE_NOT_APPLICABLE_EXISTING_EXTENSION,
        spdx_license="LGPL-2.1-only",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="existing-extension",
        license_note=(
            "Supplied by the pre-existing .pi/extensions/semgrep extension; sca "
            "neither provisions nor vendors it, so its LGPL-2.1-only source is "
            "never embedded by this skill."
        ),
    ),
    ToolSpec(
        name="osv-scanner",
        binary="osv-scanner",
        tier=TIER_REQUIRED,
        pinned_version="v2.4.0",
        license_tier=LICENSE_PERMISSIVE_EMBED,
        spdx_license="Apache-2.0",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
    ),
    ToolSpec(
        name="gitleaks",
        binary="gitleaks",
        tier=TIER_REQUIRED,
        pinned_version="v8.30.1",
        license_tier=LICENSE_PERMISSIVE_EMBED,
        spdx_license="MIT",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
    ),
    # ── OPTIONAL ──
    ToolSpec(
        name="trivy",
        binary="trivy",
        tier=TIER_OPTIONAL,
        pinned_version="v0.72.0",
        license_tier=LICENSE_PERMISSIVE_EMBED,
        spdx_license="Apache-2.0",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
    ),
    ToolSpec(
        name="trufflehog",
        binary="trufflehog",
        tier=TIER_OPTIONAL,
        pinned_version="v3.95.7",
        license_tier=LICENSE_COPYLEFT_INVOKE_ONLY,
        spdx_license="AGPL-3.0-only",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
        license_note=_COPYLEFT_REVERIFY,
        source_signatures=(
            "github.com/trufflesecurity/trufflehog",
            "trufflesecurity/trufflehog",
            "package trufflehog",
        ),
    ),
    ToolSpec(
        name="njsscan",
        binary="njsscan",
        tier=TIER_OPTIONAL,
        pinned_version="v0.4.3",
        license_tier=LICENSE_COPYLEFT_INVOKE_ONLY,
        spdx_license="LGPL-3.0-only",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
        license_note=_COPYLEFT_REVERIFY,
        source_signatures=(
            "import njsscan",
            "from njsscan",
            "njsscan.cli",
            "class NJSScan",
        ),
    ),
    ToolSpec(
        name="retire.js",
        binary="retire",
        tier=TIER_OPTIONAL,
        pinned_version="v5.4.3",
        license_tier=LICENSE_PERMISSIVE_EMBED,
        spdx_license="Apache-2.0",
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
    ),
    # Single entry covering eslint-plugin-security + eslint-plugin-no-unsanitized.
    ToolSpec(
        name="eslint-plugin-security",
        binary="eslint",
        tier=TIER_OPTIONAL,
        pinned_version="v4.0.1",
        # Combined entry also covers eslint-plugin-no-unsanitized (MPL-2.0 weak
        # copyleft). Classified conservatively as copyleft_invoke_only to match
        # the guard's existing enforcement, with real source_signatures so the
        # guard can actually flag it if the source is ever vendored.
        license_tier=LICENSE_COPYLEFT_INVOKE_ONLY,
        spdx_license="MIT",  # eslint-plugin-security; see note re MPL-2.0
        license_confidence="PROBABLE",
        enabled_by_default=True,
        source="download",
        license_note=(
            "Combined entry: eslint-plugin-security (MIT, permissive) + "
            "eslint-plugin-no-unsanitized (MPL-2.0, file-level weak copyleft). "
            "Treated conservatively as copyleft_invoke_only pending legal "
            "review; both are used as INVOKED npm dependencies, never vendored "
            "source. MUST re-verify the MPL-2.0 classification against the "
            "upstream LICENSE at real provisioning time."
        ),
        source_signatures=(
            "eslint-plugin-no-unsanitized",
            "no-unsanitized/method",
            "no-unsanitized/property",
        ),
    ),
    ToolSpec(
        name="codeql",
        binary="codeql",
        tier=TIER_OPTIONAL,
        pinned_version="v2.25.6",
        license_tier=LICENSE_PERMISSIVE_EMBED,
        spdx_license="LicenseRef-GitHub-CodeQL-Terms",
        license_confidence="PROBABLE",
        enabled_by_default=False,  # opt-in only
        source="download",
        license_note=(
            "GitHub CodeQL CLI terms: free for analysing OPEN-SOURCE code and "
            "for academic research; STATIC (non-live) analysis of private "
            "repositories requires a GitHub Advanced Security / Enterprise "
            "entitlement. Opt-in OFF by default."
        ),
    ),
]

# Index by name for O(1) lookup.
_BY_NAME = {spec.name: spec for spec in TOOL_MANIFEST}


# ── Lookup helpers ───────────────────────────────────────────────────────


def all_tools() -> List[ToolSpec]:
    """Return all tool specs in canonical declaration order."""
    return list(TOOL_MANIFEST)


def tool_names() -> List[str]:
    """Return all tool names in canonical declaration order."""
    return [spec.name for spec in TOOL_MANIFEST]


def get_tool(name: str) -> ToolSpec:
    """Return the ToolSpec for ``name``.

    Raises ``UnknownToolError`` (a KeyError subclass) for any name not in the
    manifest — never silently succeeds (edge case: unknown tool lookup).
    """
    try:
        return _BY_NAME[name]
    except KeyError:
        raise UnknownToolError(
            f"unknown tool {name!r}; known tools: {sorted(_BY_NAME)}"
        ) from None


def required_tools() -> List[ToolSpec]:
    """Return the REQUIRED-tier tools (missing one blocks downstream phases)."""
    return [s for s in TOOL_MANIFEST if s.tier == TIER_REQUIRED]


def optional_tools() -> List[ToolSpec]:
    """Return the OPTIONAL-tier tools (missing one degrades, never blocks)."""
    return [s for s in TOOL_MANIFEST if s.tier == TIER_OPTIONAL]


def copyleft_tools() -> List[ToolSpec]:
    """Return the copyleft_invoke_only tools (source must never be embedded)."""
    return [s for s in TOOL_MANIFEST if s.license_tier == LICENSE_COPYLEFT_INVOKE_ONLY]
