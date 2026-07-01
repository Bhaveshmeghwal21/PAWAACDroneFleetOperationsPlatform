# =============================================================================
# Service 4 — Vision AI Results (Python 3.11 + FastAPI)
# =============================================================================
# Build context is this directory (./services/vision-ai) per docker-compose.yml.
# The container listens on the fixed port 8000.
# =============================================================================
FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install runtime dependencies first for better layer caching. Only the project
# metadata is copied so dependency resolution is not invalidated by code edits.
COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

# Copy the application source and migration tooling.
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini

EXPOSE 8000

# Liveness check mirrors the docker-compose healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=40s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
