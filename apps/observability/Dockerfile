FROM python:3.12-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir \
    "fastapi>=0.115,<1" \
    "uvicorn[standard]>=0.30,<1" \
    "aiosqlite>=0.20,<1" \
    "python-dotenv>=1.0,<2" \
    "pydantic>=2.0,<3" \
    "apscheduler>=3.11,<4"

# Copy application code
COPY apps/observability/src/ /app/

# Create data directory
RUN mkdir -p /data

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8765/health')" || exit 1

CMD ["python", "-m", "observability"]
