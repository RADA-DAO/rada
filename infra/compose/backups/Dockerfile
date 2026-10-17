FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
# Debian snapshot and exact package version make the encryption layer repeatable.
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260301T000000Z bookworm main\n' > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/* \
    && apt-get update && apt-get install -y --no-install-recommends age=1.1.1-1+b3 \
    && rm -rf /var/lib/apt/lists/*
COPY infra/compose/backups /backup
