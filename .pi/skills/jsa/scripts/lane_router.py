"""jsa Skill — Lane Router

Maps each vulnerability class to one of 3 lanes and routes FlowCards
to the appropriate agent prompt format.

Lanes (per the document's recommendation):
1. code_static: FlowCard-only (source/sink data flow)
2. page_dom: PageCard + relevant FlowCards (HTML ↔ JS correlation)
3. network_behavior: PageCard with Caido HTTP history (request/response)

CSRF lives in BOTH lanes (analyzer + two prompts) — one for DOM-based
CSRF (form hijacking) and one for network CSRF (token validation).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# Lane constants
LANE_CODE_STATIC = "code_static"
LANE_PAGE_DOM = "page_dom"
LANE_NETWORK_BEHAVIOR = "network_behavior"


@dataclass
class LaneConfig:
    """Configuration for a single lane."""
    name: str
    analyzers: list[str]
    packet_type: str  # "flow_card" | "page_card_with_flow_cards" | "page_card_with_caido_history"
    agent_count_per_unit: int = 1  # Agents per FlowCard or per PageCard
    description: str = ""


# Lane definitions (data-driven, easy to update)
LANE_CONFIGS: dict[str, LaneConfig] = {
    LANE_CODE_STATIC: LaneConfig(
        name=LANE_CODE_STATIC,
        analyzers=[
            "dom_xss",
            "prototype_pollution",
            "csti",
            "postmessage",
            "open_redirect",
            "secret_disclosure",
            "request_override",
            "link_manipulation",
            "dom_data_manipulation",
        ],
        packet_type="flow_card",
        agent_count_per_unit=1,
        description="Code-centric static analyzers that need source/sink/sanitizer data flow slices",
    ),
    LANE_PAGE_DOM: LaneConfig(
        name=LANE_PAGE_DOM,
        analyzers=[
            "dom_clobbering",
            "reflected_xss",
            "stored_xss",
            "csrf_dom",  # DOM-based CSRF
        ],
        packet_type="page_card_with_flow_cards",
        agent_count_per_unit=1,
        description="Page-DOM analyzers that need HTML structure + relevant flow cards",
    ),
    LANE_NETWORK_BEHAVIOR: LaneConfig(
        name=LANE_NETWORK_BEHAVIOR,
        analyzers=[
            "cors",
            "clickjacking",
            "idor",
            "cache_poisoning",
            "http_smuggling",
            "csrf_network",  # Network CSRF (token validation, origin check)
        ],
        packet_type="page_card_with_caido_history",
        agent_count_per_unit=1,
        description="Network-behavior analyzers that need HTTP request/response history",
    ),
}


# Reverse index: analyzer name → lane name
ANALYZER_TO_LANE: dict[str, str] = {}
for lane_name, config in LANE_CONFIGS.items():
    for analyzer in config.analyzers:
        if analyzer in ANALYZER_TO_LANE:
            raise ValueError(
                f"Analyzer {analyzer!r} is in multiple lanes: "
                f"{ANALYZER_TO_LANE[analyzer]} and {lane_name}"
            )
        ANALYZER_TO_LANE[analyzer] = lane_name


def get_lane_for_analyzer(analyzer_name: str) -> Optional[str]:
    """Return the lane for a vulnerability class, or None if unassigned."""
    return ANALYZER_TO_LANE.get(analyzer_name)


def get_lane_config(lane_name: str) -> Optional[LaneConfig]:
    """Return the LaneConfig for a lane name."""
    return LANE_CONFIGS.get(lane_name)


def get_packet_type_for_lane(lane_name: str) -> Optional[str]:
    """Return the packet type that agents in this lane expect."""
    config = LANE_CONFIGS.get(lane_name)
    return config.packet_type if config else None


def get_all_analyzers() -> list[str]:
    """Return all configured analyzer names across all lanes."""
    result = []
    for config in LANE_CONFIGS.values():
        result.extend(config.analyzers)
    return result


def get_lane_summary() -> dict[str, list[str]]:
    """Return a summary of analyzers per lane, for documentation/REPORT."""
    return {
        config.name: list(config.analyzers) for config in LANE_CONFIGS.values()
    }


def select_lane(flow_card) -> str:
    """Determine the lane for a FlowCard based on its vulnerability_class.

    Args:
        flow_card: A FlowCard or dict with vulnerability_class key.

    Returns:
        Lane name (one of LANE_CODE_STATIC, LANE_PAGE_DOM, LANE_NETWORK_BEHAVIOR).
        Falls back to LANE_CODE_STATIC if the vuln class is unassigned.
    """
    if hasattr(flow_card, "vulnerability_class"):
        vuln_class = flow_card.vulnerability_class
    elif isinstance(flow_card, dict):
        vuln_class = flow_card.get("vulnerability_class", "")
    else:
        vuln_class = ""

    lane = ANALYZER_TO_LANE.get(vuln_class, LANE_CODE_STATIC)
    return lane
