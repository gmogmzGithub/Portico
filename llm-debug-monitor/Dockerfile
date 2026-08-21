FROM python:3.11-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

COPY backend/requirements.txt ./backend/requirements.txt
RUN python -m pip install --prefix=/install -r ./backend/requirements.txt

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/install/bin:${PATH}" \
    PYTHONPATH="/install/lib/python3.11/site-packages:/app"

WORKDIR /app

COPY --from=builder /install /install
COPY backend/ ./backend/
COPY dist/ ./static/

EXPOSE 8879

ENV REDIS_HOST=redis
ENV REDIS_PORT=6379
ENV DEBUG=false

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8879/api/health', timeout=5).read()"

CMD ["python", "-m", "uvicorn", "backend.server:app", "--host", "0.0.0.0", "--port", "8879"]

# PORTICO-205: ownership labels so cleanup tooling can select PORTICO-built images.
LABEL com.portico.ai-chat.artifact="true" \
      com.portico.ai-chat.image-role="llm-debug-monitor"
