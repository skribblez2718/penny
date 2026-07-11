"""Configuration — loads Penny root .env and exposes typed settings."""

import os
from pathlib import Path

from dotenv import load_dotenv

from observability import logger as _logger

# Resolve Penny project root (this file is at apps/observability/src/observability/)
# In Docker, the .env is mounted at /app/.env or config comes from environment variables.
try:
    _PENNY_ROOT = Path(__file__).resolve().parents[4]
    _ENV_PATH = _PENNY_ROOT / ".env"
    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH)
except IndexError:
    # Not running from the Penny source tree (fewer than 4 parent dirs) — expected
    # under Docker. Try /app/.env, then fall back to environment variables only.
    _logger.debug(
        "observability.config",
        "Source-tree root not resolvable (IndexError); using Docker/.env-var fallback",
    )
    _docker_env = Path("/app/.env")
    if _docker_env.exists():
        load_dotenv(_docker_env)


class Config:
    """Observability backend configuration (immutable after import)."""

    # Server
    HOST: str = os.getenv("PI_OBSERVABILITY_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PI_OBSERVABILITY_PORT", "8765"))

    # Auth
    API_KEY: str = os.getenv("PI_OBSERVABILITY_API_KEY", "")

    # Paths
    DATA_DIR: Path = Path(
        os.getenv("PI_OBSERVABILITY_DATA_DIR", Path.home() / ".local/share/penny/observability")
    )
    DB_PATH: Path = DATA_DIR / "observability.db"

    # WebSocket
    WS_PATH: str = "/ws"

    # Size-based rotation (replaces age+cron cleanup). The observability DB's
    # disk use is bounded in-process: when the on-disk file reaches the cap, the
    # oldest rows are evicted across ALL tables until the live bytes fall back to
    # the floor. No VACUUM, no cron, no systemd.
    DB_SIZE_MAX_GB: float = float(os.getenv("PI_OBSERVABILITY_DB_SIZE_MAX_GB", "5.0"))
    DB_SIZE_FLOOR_GB: float = float(os.getenv("PI_OBSERVABILITY_DB_SIZE_FLOOR_GB", "1.0"))

    @classmethod
    def ensure_directories(cls) -> None:
        """Create data directory if it doesn't exist."""
        cls.DATA_DIR.mkdir(parents=True, exist_ok=True)
