"""
cve_lookup.py — Hybrid CVE lookup for the jsa skill CVE_RESEARCH phase.

Queries OSV.dev (primary for JS/npm libraries — semver-aware server-side
matching, no rate limits, no API key) and Vulnerability-Lookup (fallback,
CIRCL's successor to cve-search.org, CPE-based).

Uses only Python stdlib (urllib, json, datetime) — no external deps.

Usage:
    from cve_lookup import lookup_cves
    from npm_name_map import wappalyzer_to_npm

    cves = lookup_cves(
        {"jQuery": "3.7.1", "React": "18.2.0"},
        wappalyzer_to_npm,
        months_back=6,
    )
    # Returns list of dicts: [{library, version, cve_id, summary, ...}]
"""

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OSV_API_BASE = "https://api.osv.dev"
VULN_LOOKUP_BASE = "https://vulnerability.circl.lu/api/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_TIMEOUT = 10  # seconds per request
# Default months back for CVE lookup. Set to a very large number (1200 = 100 years)
# to effectively disable the date filter. Old CVEs on old libraries are the most
# common bug bounty findings — date is a ranking signal, not an inclusion gate.
# See /tmp/jsa-description.md for rationale.
DEFAULT_MONTHS_BACK = 1200

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _http_get_json(url: str, timeout: int = DEFAULT_TIMEOUT):
    """Perform GET request and return JSON response. Returns None on error."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as e:
        print(f"[cve_lookup] GET {url} failed: {e}", file=sys.stderr)
        return None


def _product_match_confirmed(cna: dict, queried_npm_name: str) -> bool:
    """Check if the CNA's affected list contains a real npm package match.

    Bug fix 2026-06-08: VulnLookup's ?product=X is a free-text search that
    returns false positives. To validate, we check the CVE's CNA `affected`
    list and accept it only if at least one entry's product OR a
    sensible vendor+product reconstruction matches the queried npm name.

    CNAs encode npm packages in several different shapes:
        vendor="@clerk", product="react"      → "@clerk/react"   (scoped pkg)
        vendor="google",  product="angularjs" → "angularjs"     (unscoped, vendor=org)
        vendor="facebook",product="react"    → "react"         (unscoped, vendor=org)
        vendor="",        product="react"    → "react"         (unscoped, no vendor)
        vendor="angular", product="angular"   → "angular"       (rare; vendor==product)
        vendor="clerk",   product="react"     → "clerk-react"   (rare, malformed)

    Heuristic for distinguishing scope vs org-name vendor:
        - vendor starts with "@"           → scope (e.g. @clerk)
        - vendor contains "/"               → scope (e.g. @clerk)
        - vendor is a single short word     → org name (e.g. "google", "facebook")
        - otherwise                          → scope (conservative)

    This isn't perfect, but in practice CNAs follow the org-name convention
    for unscoped packages (Google/Facebook/Meta/etc.) and the @scope/name
    convention for scoped packages. The edge case of a multi-word org name
    (e.g. "IBM Cloud") is rare and treated as a scope, which means we'd
    accept it via the scoped reconstruction rule.

    Conservative: if the CNA is ambiguous, prefer rejection. It's easier
    to manually add a missed CVE than to triage 5 false positives.
    """
    if not cna or not queried_npm_name:
        return False
    qn = queried_npm_name.lower().strip()
    if qn.startswith("@"):
        qn = qn[1:]
    if "/" in qn:
        qn_scope, qn_name = qn.split("/", 1)
    else:
        qn_scope, qn_name = "", qn

    def _is_org_name(vendor: str) -> bool:
        """Heuristic: is vendor an org name (e.g. 'google') rather than a scope (e.g. '@clerk')?

        True for: 'google', 'facebook', 'meta', 'microsoft'
        False for: '@clerk', '@angular', anything with '/' or whitespace
        """
        if not vendor:
            return True  # empty vendor = no scope, treat as org-less
        if vendor.startswith("@"):
            return False
        if "/" in vendor:
            return False
        if " " in vendor:
            return False  # multi-word = likely malformed, treat as scope
        # Single word, no @ prefix, no slashes: treat as org name
        return True

    for affected in cna.get("affected", []) or []:
        vendor = (affected.get("vendor", "") or "").lower().strip()
        product = (affected.get("product", "") or "").lower().strip()
        if not product:
            continue
        if vendor.startswith("@"):
            vendor_stripped = vendor[1:]
        else:
            vendor_stripped = vendor

        is_scoped_vendor = not _is_org_name(vendor)
        # If vendor starts with @, we treat it as scoped. For non-@ single
        # word vendors (google, facebook), we treat them as org names.
        # If the heuristic gets it wrong, we'll accept a false positive
        # (vendor=@something, product=react, queried=react) but reject
        # the false negative case (vendor=google, product=angularjs, queried=angularjs)
        # is the more common scenario to get right.

        # If query is scoped (e.g. @angular/core), the CNA must also be scoped
        # for the product to match. @angular/core query against
        # vendor="@angular", product="core" should match.
        if qn_scope:
            if is_scoped_vendor and f"{vendor_stripped}/{product}" == qn:
                return True
            # No unscoped fallthrough for scoped queries
            continue

        # Query is unscoped (e.g. "react", "angular", "angularjs")
        # Rule 1: product matches AND vendor is empty OR an org name.
        if (not vendor or _is_org_name(vendor)) and product == qn_name:
            return True

        # Rule 2: unscoped hyphenated reconstruction (rare).
        # Only if both vendor and product are present and distinct.
        if vendor and product and vendor_stripped != product and f"{vendor_stripped}-{product}" == qn:
            return True

        # Rule 3: vendor == product == queried (covers vendor=product=qn).
        if vendor_stripped == product == qn_name:
            return True

        # Rule 4: vendor is scoped (e.g. @clerk) and @vendor/product matches.
        # For unscoped query, this should NEVER match (we want to avoid the
        # Clerk false positive where vendor=@clerk, product=react, query=react).
        # So we skip this rule.

    return False


def _http_post_json(url: str, body: dict, timeout: int = DEFAULT_TIMEOUT):
    """Perform POST request with JSON body and return JSON response. Returns None on error."""
    try:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as e:
        print(f"[cve_lookup] POST {url} failed: {e}", file=sys.stderr)
        return None


def _compute_since_date(months_back: int = DEFAULT_MONTHS_BACK) -> str:
    """Return ISO date string (YYYY-MM-DD) for current_date - months_back."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=30 * months_back)
    return cutoff.strftime("%Y-%m-%d")


def _compute_age_days(published_date: str) -> int | None:
    """Compute age in days from a YYYY-MM-DD published date.

    Returns None if the date is unparseable.
    Used as a ranking signal — older CVEs are not excluded, just deprioritized.
    """
    if not published_date or len(published_date) < 10:
        return None
    try:
        published = datetime.strptime(published_date[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - published).days
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# OSV.dev client
# ---------------------------------------------------------------------------

class OSVClient:
    """Query OSV.dev for vulnerabilities by npm package + version."""

    def query(
        self,
        package_name: str,
        ecosystem: str = "npm",
        version: str | None = None,
    ) -> list[dict]:
        """
        POST /v1/query with package+version. Returns parsed CVE list.
        Each entry: {id, summary, published, modified, severity_score, aliases, source}.
        Returns [] on error or no results.
        """
        body: dict = {
            "package": {"name": package_name, "ecosystem": ecosystem}
        }
        if version:
            body["version"] = version

        result = _http_post_json(f"{OSV_API_BASE}/v1/query", body)
        if not result:
            return []

        vulns = result.get("vulns", [])
        parsed: list[dict] = []
        for v in vulns:
            vuln_id = v.get("id", "")
            # Extract CVE ID from aliases (OSV.dev uses GHSA-IDs, linked to CVEs)
            aliases = v.get("aliases", [])
            cve_id = ""
            for alias in aliases:
                if alias.startswith("CVE-"):
                    cve_id = alias
                    break

            # Extract severity score
            severity_score = None
            for sev in v.get("severity", []) or []:
                if sev.get("type") == "CVSS_V3":
                    try:
                        severity_score = float(sev.get("score", 0))
                    except (ValueError, TypeError):
                        pass
                    break

            parsed.append({
                "id": vuln_id,
                "cve_id": cve_id,
                "summary": v.get("summary", ""),
                "published": v.get("published", ""),
                "modified": v.get("modified", ""),
                "severity_score": severity_score,
                "aliases": aliases,
                "source": "osv.dev",
            })
        return parsed


# ---------------------------------------------------------------------------
# Vulnerability-Lookup client (CIRCL's successor to cve-search.org)
# ---------------------------------------------------------------------------

class VulnLookupClient:
    """Query Vulnerability-Lookup (vulnerability.circl.lu) for CVEs by product."""

    def query(
        self,
        product: str,
        since_date: str | None = None,
        max_pages: int = 5,
        npm_name: str | None = None,
    ) -> list[dict]:
        """
        GET /api/vulnerability/?product=X&since=YYYY-MM-DD with pagination.
        Returns parsed CVE list. Each entry: {cve_id, summary, cvss_score, published, source}.
        Returns [] on error or no results.

        Args:
            product: search term for VulnLookup's ?product= URL param.
            npm_name: actual npm package name to validate against. If provided,
                CVEs whose CNA `affected` list doesn't include a matching
                vendor/product pair are flagged with product_match_confirmed=False.
                If None, no validation is done (backward compat).
        """
        # Normalize product name: lowercase, hyphens
        product_norm = product.lower().replace(" ", "-")
        seen: set[str] = set()
        results: list[dict] = []

        for page in range(1, max_pages + 1):
            url = f"{VULN_LOOKUP_BASE}vulnerability/?product={product_norm}&per_page=100&page={page}"
            if since_date:
                url += f"&since={since_date}"
            data = _http_get_json(url)
            if data is None:
                break

            # The API returns 3 different response formats depending on query params/result count:
            #   Format A: [ { results: { metadata: {...}, cvelistv5: [[id, obj], ...] }, total_count: N } ]
            #   Format B: [ { results: [[id, obj], ...], total_count: N, page_size: N, page: N } ]  (direct list)
            #   Format C: [ [id, obj], [id, obj], ... ]  (raw CVE tuples)
            #   Format D: { data: [...], metadata: {...}, count: N }
            if isinstance(data, list):
                if not data:
                    break

                first = data[0]
                if isinstance(first, dict) and "results" in first:
                    # Format A or B — wrapper dict in first position.
                    # `results` can be either a dict { metadata, cvelistv5 } or a raw list.
                    wrapper = first
                    rv = wrapper.get("results", None)
                    if isinstance(rv, dict):
                        items = rv.get("cvelistv5", [])
                    else:
                        items = rv if rv else []
                    total = wrapper.get("total_count", 0)
                else:
                    # Format C — raw CVE tuples in the list directly
                    items = data
                    total = len(data)
            elif isinstance(data, dict):
                # Format D — dict with 'data' key
                items = data.get("data", [])
                metadata = data.get("metadata", {})
                total = metadata.get("count", 0)
            else:
                break

            if not items:
                break

            for item in items:
                # Each item is a [cve_id, cve_object] tuple from cvelistv5
                if isinstance(item, list) and len(item) >= 2:
                    cve_id_raw, cve_obj = item[0], item[1]
                elif isinstance(item, dict):
                    cve_obj = item
                    cve_id_raw = item.get("cveMetadata", {}).get("cveId", "")
                else:
                    continue

                if not isinstance(cve_obj, dict):
                    continue

                cve_id = cve_id_raw if isinstance(cve_id_raw, str) else cve_obj.get("cveMetadata", {}).get("cveId", "")
                if not cve_id or cve_id in seen:
                    continue
                seen.add(cve_id)

                # Extract summary from containers.cna
                containers = cve_obj.get("containers", {})
                cna = containers.get("cna", {})
                descriptions = cna.get("descriptions", [])
                summary = ""
                for d in descriptions:
                    if d.get("lang") == "en":
                        summary = d.get("value", "")
                        break
                if not summary and descriptions:
                    summary = descriptions[0].get("value", "")

                # Extract CVSS v3.1 score
                cvss_score = None
                metrics = cna.get("metrics", [])
                for m in metrics:
                    if "cvssV3_1" in m:
                        cvss_score = m["cvssV3_1"].get("baseScore")
                        break

                results.append({
                    "cve_id": cve_id,
                    "summary": summary,
                    "cvss_score": cvss_score,
                    "published": cve_obj.get("cveMetadata", {}).get("datePublished", ""),
                    "source": "vuln-lookup",
                    # Track whether the CNA confirms this product is affected.
                    # Bug fix 2026-06-08: VulnLookup's ?product=X is a TEXT
                    # search, not a strict product match. Without this check,
                    # asking for "react" returns CVEs about Clerk, Vue tooling,
                    # etc. that merely mention "react" in the description.
                    # We require at least one entry in cna.affected[] to
                    # have vendor/product matching the queried product.
                    "product_match_confirmed": _product_match_confirmed(
                        cna, npm_name or product_norm
                    ),
                })

            # Check if we've hit the last page
            if seen and (len(seen) >= total or not items):
                break

        return results

    def get_details(self, cve_id: str) -> dict | None:
        """GET /api/vulnerability/{cve_id} for full details. Returns dict or None."""
        url = f"{VULN_LOOKUP_BASE}vulnerability/{cve_id}"
        return _http_get_json(url)


# ---------------------------------------------------------------------------
# Convenience orchestrator
# ---------------------------------------------------------------------------

def lookup_cves(
    library_versions: dict[str, str],
    npm_mapper,
    months_back: int = DEFAULT_MONTHS_BACK,
) -> list[dict]:
    """
    Look up CVEs for each detected library+version.

    Args:
        library_versions: dict of Wappalyzer canonical name → version string.
        npm_mapper: callable (wappalyzer_name) → dict | None (from npm_name_map).
        months_back: Only include CVEs published within this many months. Default
            is effectively unlimited (1200 months = 100 years). Date is a ranking
            signal, not an inclusion gate — old CVEs on old libraries are often
            the most relevant bug bounty findings.

    Returns:
        List of normalized CVE dicts:
        [{library, version, cve_id, summary, cvss_score, published_date, source, age_days}]
    """
    if not library_versions:
        return []

    osv = OSVClient()
    vuln = VulnLookupClient()
    since_date = _compute_since_date(months_back)
    all_cves: dict[str, dict] = {}  # cve_id → dict (deduped)

    for lib_name, version in library_versions.items():
        if not version or not lib_name:
            continue

        # Map Wappalyzer name → npm package info
        info = npm_mapper(lib_name)
        if not info:
            continue

        npm_name = info["npm"]
        ecosystem = info.get("ecosystem", "npm")

        # OSV.dev (primary for npm packages)
        osv_results = osv.query(npm_name, ecosystem, version)
        for cve in osv_results:
            cve_id = cve.get("cve_id") or cve.get("id", "")
            cve_id = cve_id.upper()  # Normalize to uppercase for dedup
            if not cve_id:
                continue
            # Filter by date
            if cve.get("published") and cve.get("published", "")[:10] < since_date:
                continue
            if cve_id not in all_cves:
                pub_date = cve.get("published", "")[:10] or cve.get("published", "")
                all_cves[cve_id] = {
                    "library": lib_name,
                    "version": version,
                    "cve_id": cve_id,
                    "summary": cve.get("summary", ""),
                    "cvss_score": cve.get("severity_score") or cve.get("cvss_score"),
                    "published_date": pub_date,
                    "age_days": _compute_age_days(pub_date),
                    "source": cve.get("source", "osv.dev"),
                }

        # Vulnerability-Lookup (fallback)
        vl_results = vuln.query(npm_name, since_date, npm_name=npm_name)
        for cve in vl_results:
            cve_id = cve.get("cve_id", "").upper()  # Normalize to uppercase
            if not cve_id or cve_id in all_cves:
                continue
            if cve.get("published", "")[:10] < since_date:
                continue
            # Bug fix 2026-06-08: reject text-search false positives. VulnLookup's
            # ?product= is not strict — it returns CVEs that merely mention the
            # product name. The CNA's affected[] array tells us if the CVE
            # actually applies to this product. Only accept CVEs where the CNA
            # confirms a vendor/product match.
            if not cve.get("product_match_confirmed", False):
                # Debug log to help future investigations
                print(
                    f"[cve_lookup] Dropped text-search false positive: "
                    f"{cve_id} (product={npm_name!r}, summary={cve.get('summary', '')[:60]!r})",
                    file=sys.stderr,
                )
                continue
            all_cves[cve_id] = {
                "library": lib_name,
                "version": version,
                "cve_id": cve_id,
                "summary": cve.get("summary", ""),
                "cvss_score": cve.get("cvss_score"),
                "published_date": cve.get("published", "")[:10] or cve.get("published", ""),
                "age_days": _compute_age_days(cve.get("published", "")),
                "source": cve.get("source", "vuln-lookup"),
            }

    return list(all_cves.values())


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Smoke test: verify imports and helper functions work
    from npm_name_map import wappalyzer_to_npm
    print("[cve_lookup] Self-test:")
    print(f"  OSV_API_BASE: {OSV_API_BASE}")
    print(f"  VULN_LOOKUP_BASE: {VULN_LOOKUP_BASE}")
    print(f"  _compute_since_date(6): {_compute_since_date(6)}")
    print(f"  wappalyzer_to_npm('jQuery'): {wappalyzer_to_npm('jQuery')}")
    print(f"  lookup_cves signature: OK")
