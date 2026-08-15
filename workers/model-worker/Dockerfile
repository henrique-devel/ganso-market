FROM python:3.13.14-slim-bookworm@sha256:67a1e1f215ccda113cfc024e8639049257e88f273898f595b61476d128d387e8

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ganso
COPY workers/model-worker/src/ganso_model_worker /app/ganso_model_worker

USER 10001:10001
EXPOSE 8090
CMD ["python", "-m", "ganso_model_worker"]
