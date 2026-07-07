"""
Tests for asset_classify.py — JS file classification (bundle detection).
"""

import sys
from pathlib import Path

# Ensure scripts directory is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from asset_classify import (
    classify_file,
    classify_files,
    ClassificationResult,
    SINGLE_COMPONENT,
    MULTI_COMPONENT_BUNDLE,
    FIRST_PARTY,
    INLINE,
    CDN_BUNDLE,
    UNKNOWN,
    VALID_CLASSIFICATIONS,
    _is_inline,
    _is_cdn,
    _is_bundle_filename,
    _is_first_party_filename,
    _is_library_filename,
    _count_source_map_packages,
)


# ---------------------------------------------------------------------------
# Heuristic function tests
# ---------------------------------------------------------------------------

class TestInlineDetection:
    def test_inline_underscore_convention(self):
        assert _is_inline("_inline_page1_script1.js") is True
        assert _is_inline("page_inline_chunk.js") is True

    def test_not_inline(self):
        assert _is_inline("jquery.min.js") is False
        assert _is_inline("app.js") is False


class TestCdnDetection:
    def test_cdnjs_url(self):
        assert _is_cdn("jquery.min.js", "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js") == "cdnjs"

    def test_jsdelivr_url(self):
        assert _is_cdn("react.min.js", "https://cdn.jsdelivr.net/npm/react@18/umd/react.min.js") == "jsdelivr"

    def test_unpkg_url(self):
        assert _is_cdn("vue.min.js", "https://unpkg.com/vue@3/dist/vue.min.js") == "unpkg"

    def test_no_cdn_url(self):
        assert _is_cdn("jquery.min.js", "https://example.com/js/jquery.min.js") is None

    def test_empty_url(self):
        assert _is_cdn("jquery.min.js", "") is None


class TestBundleFilename:
    def test_vendor(self):
        assert _is_bundle_filename("vendor.js") is True
        assert _is_bundle_filename("vendors.min.js") is True

    def test_chunk(self):
        assert _is_bundle_filename("chunk-12345.js") is True
        assert _is_bundle_filename("chunks/main.js") is True

    def test_polyfill(self):
        assert _is_bundle_filename("polyfill.min.js") is True

    def test_runtime(self):
        assert _is_bundle_filename("runtime.js") is True
        assert _is_bundle_filename("commons.js") is True

    def test_not_bundle(self):
        assert _is_bundle_filename("jquery-1.9.0.min.js") is False
        assert _is_bundle_filename("app.js") is False
        assert _is_bundle_filename("lodash.min.js") is False


class TestFirstPartyFilename:
    def test_exact_match(self):
        assert _is_first_party_filename("app.js") is True
        assert _is_first_party_filename("main.js") is True
        assert _is_first_party_filename("index.js") is True

    def test_prefix_match(self):
        assert _is_first_party_filename("app.bundle.js") is True
        assert _is_first_party_filename("main.entry.js") is True

    def test_router_store(self):
        assert _is_first_party_filename("router.js") is True
        assert _is_first_party_filename("store.js") is True

    def test_not_first_party(self):
        assert _is_first_party_filename("jquery.min.js") is False
        assert _is_first_party_filename("vendor.js") is False


class TestLibraryFilename:
    def test_jquery(self):
        assert _is_library_filename("jquery-1.9.0.min.js") is True
        assert _is_library_filename("jquery.min.js") is True

    def test_react(self):
        assert _is_library_filename("react.production.min.js") is True
        assert _is_library_filename("react-dom.min.js") is True

    def test_lodash(self):
        assert _is_library_filename("lodash.min.js") is True
        assert _is_library_filename("lodash.core.min.js") is True

    def test_axios_d3(self):
        assert _is_library_filename("axios.min.js") is True
        assert _is_library_filename("d3.min.js") is True

    def test_not_library(self):
        assert _is_library_filename("app.js") is False
        assert _is_library_filename("vendor.js") is False


class TestSourceMapPackageCount:
    def test_zero_packages(self):
        assert _count_source_map_packages([]) == 0

    def test_single_package(self):
        sources = [
            "webpack:///./node_modules/jquery/dist/jquery.js",
            "webpack:///./src/app.js",
        ]
        assert _count_source_map_packages(sources) == 1

    def test_two_packages(self):
        sources = [
            "webpack:///./node_modules/jquery/dist/jquery.js",
            "webpack:///./node_modules/lodash/index.js",
        ]
        assert _count_source_map_packages(sources) == 2

    def test_three_packages_with_scoped(self):
        sources = [
            "webpack:///./node_modules/jquery/dist/jquery.js",
            "webpack:///./node_modules/lodash/index.js",
            "webpack:///./node_modules/@babel/runtime/helpers/esm/asyncToGenerator.js",
        ]
        assert _count_source_map_packages(sources) == 3

    def test_no_node_modules(self):
        sources = ["webpack:///./src/app.js", "webpack:///./src/main.js"]
        assert _count_source_map_packages(sources) == 0


# ---------------------------------------------------------------------------
# classify_file tests — INLINE
# ---------------------------------------------------------------------------

class TestClassifyInline:
    def test_inline_filename(self):
        result = classify_file("_inline_page1_script1.js")
        assert result.classification == INLINE
        assert result.confidence == "certain"
        assert "filename_convention" in result.signals


# ---------------------------------------------------------------------------
# classify_file tests — CDN_BUNDLE
# ---------------------------------------------------------------------------

class TestClassifyCdn:
    def test_cdnjs_url(self):
        result = classify_file(
            "jquery.min.js",
            url="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
        )
        assert result.classification == CDN_BUNDLE
        assert result.confidence == "certain"

    def test_jsdelivr_url(self):
        result = classify_file(
            "react.min.js",
            url="https://cdn.jsdelivr.net/npm/react@18/umd/react.min.js",
        )
        assert result.classification == CDN_BUNDLE


# ---------------------------------------------------------------------------
# classify_file tests — MULTI_COMPONENT_BUNDLE
# ---------------------------------------------------------------------------

class TestClassifyMultiComponentBundle:
    def test_source_map_two_packages(self):
        sources = [
            "webpack:///./node_modules/jquery/dist/jquery.js",
            "webpack:///./node_modules/lodash/index.js",
        ]
        result = classify_file(
            "vendor.js",
            source_map_sources=sources,
        )
        assert result.classification == MULTI_COMPONENT_BUNDLE
        assert result.confidence == "certain"
        assert "source_map_multiple_packages" in result.signals

    def test_bundle_filename_no_components(self):
        result = classify_file("vendor.js")
        assert result.classification == MULTI_COMPONENT_BUNDLE
        assert result.confidence == "possible"
        assert "filename_bundle_pattern" in result.signals


# ---------------------------------------------------------------------------
# classify_file tests — SINGLE_COMPONENT
# ---------------------------------------------------------------------------

class TestClassifySingleComponent:
    def test_jquery_with_banner(self):
        result = classify_file(
            "jquery-1.9.0.min.js",
            content_head="/*! jQuery v1.9.0 | (c) 2005-2012 jQuery Foundation */\n...",
        )
        assert result.classification == SINGLE_COMPONENT
        assert result.confidence == "certain"
        assert "content_banner" in result.signals

    def test_jquery_with_source_map(self):
        sources = ["webpack:///./node_modules/jquery/dist/jquery.js"]
        result = classify_file(
            "jquery-1.9.0.min.js",
            source_map_sources=sources,
        )
        assert result.classification == SINGLE_COMPONENT
        assert "source_map_single_package" in result.signals

    def test_jquery_with_detector_only(self):
        # Library name matches but no banner/source map
        result = classify_file(
            "jquery-1.9.0.min.js",
            detection_details=[{"technology": "jQuery", "vector": "scriptSrc"}],
        )
        # Detected by Wappalyzer but no banner/sourcemap — weaker
        assert result.classification == SINGLE_COMPONENT
        assert result.confidence == "possible"


# ---------------------------------------------------------------------------
# classify_file tests — FIRST_PARTY
# ---------------------------------------------------------------------------

class TestClassifyFirstParty:
    def test_app_js_no_libraries(self):
        result = classify_file("app.js")
        assert result.classification == FIRST_PARTY
        assert result.confidence == "probable"
        assert "filename_app_pattern" in result.signals

    def test_app_js_no_components_detected(self):
        result = classify_file(
            "main.js",
            detection_details=[],  # no libraries detected
        )
        assert result.classification == FIRST_PARTY

    def test_app_js_with_libraries_detected(self):
        # If a library IS detected, it's not pure first-party
        result = classify_file(
            "app.js",
            detection_details=[{"technology": "jQuery", "vector": "scriptSrc"}],
        )
        # jQuery detected in app.js — this is unusual; falls through to unknown
        # because it's not a bundle, not a single component, and not a first-party-with-no-libs
        assert result.classification in (UNKNOWN, FIRST_PARTY, MULTI_COMPONENT_BUNDLE)


# ---------------------------------------------------------------------------
# classify_file tests — UNKNOWN
# ---------------------------------------------------------------------------

class TestClassifyUnknown:
    def test_random_filename(self):
        result = classify_file("random-file-12345.js")
        assert result.classification == UNKNOWN

    def test_minified_with_no_clues(self):
        result = classify_file("a1b2c3d4.js")
        assert result.classification == UNKNOWN


# ---------------------------------------------------------------------------
# Priority/confidence tests
# ---------------------------------------------------------------------------

class TestClassificationPriority:
    def test_inline_takes_priority_over_anything(self):
        # _inline_ in filename, but content has library banner
        result = classify_file(
            "_inline_jquery.js",
            content_head="/*! jQuery v1.9.0 */",
        )
        assert result.classification == INLINE

    def test_cdn_takes_priority_over_bundle(self):
        # CDN URL but filename is "vendor.js"
        result = classify_file(
            "vendor.js",
            url="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
        )
        assert result.classification == CDN_BUNDLE

    def test_source_map_two_packages_takes_priority_over_bundle_filename(self):
        sources = [
            "webpack:///./node_modules/jquery/dist/jquery.js",
            "webpack:///./node_modules/lodash/index.js",
        ]
        result = classify_file(
            "jquery-1.9.0.min.js",  # library filename
            source_map_sources=sources,
        )
        # 2+ packages in source map wins
        assert result.classification == MULTI_COMPONENT_BUNDLE


# ---------------------------------------------------------------------------
# classify_files batch tests
# ---------------------------------------------------------------------------

class TestClassifyFiles:
    def test_batch(self):
        js_files = [
            {"filename": "jquery-1.9.0.min.js", "content_head": "/*! jQuery v1.9.0 */"},
            {"filename": "vendor.js", "url": "https://example.com/vendor.js"},
            {"filename": "_inline_page1.js"},
            {"filename": "app.js"},
        ]
        results = classify_files(js_files)
        assert results["jquery-1.9.0.min.js"].classification == SINGLE_COMPONENT
        assert results["vendor.js"].classification == MULTI_COMPONENT_BUNDLE
        assert results["_inline_page1.js"].classification == INLINE
        assert results["app.js"].classification == FIRST_PARTY

    def test_empty_batch(self):
        assert classify_files([]) == {}


# ---------------------------------------------------------------------------
# Component detection propagation
# ---------------------------------------------------------------------------

class TestComponentDetection:
    def test_components_propagated(self):
        result = classify_file(
            "vendor.js",
            detection_details=[
                {"technology": "jQuery", "vector": "scriptSrc"},
                {"technology": "Lodash", "vector": "scriptSrc"},
            ],
        )
        assert "jQuery" in result.components_detected
        assert "Lodash" in result.components_detected

    def test_no_components(self):
        result = classify_file("app.js")
        assert result.components_detected == []


# ---------------------------------------------------------------------------
# Serialization / Validation
# ---------------------------------------------------------------------------

class TestValidation:
    def test_valid_classifications(self):
        for c in VALID_CLASSIFICATIONS:
            assert c in (
                SINGLE_COMPONENT,
                MULTI_COMPONENT_BUNDLE,
                FIRST_PARTY,
                INLINE,
                CDN_BUNDLE,
                UNKNOWN,
            )

    def test_result_dataclass(self):
        result = ClassificationResult(
            file="test.js",
            classification=SINGLE_COMPONENT,
            confidence="certain",
            components_detected=["jQuery"],
            source_map_present=True,
            signals=["test"],
            reason="unit test",
        )
        assert result.file == "test.js"
        assert result.classification == SINGLE_COMPONENT
        assert result.confidence == "certain"
        assert result.components_detected == ["jQuery"]
        assert result.source_map_present is True
        assert result.signals == ["test"]
        assert result.reason == "unit test"
