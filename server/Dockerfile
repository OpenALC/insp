FROM rust:1-bookworm AS builder

WORKDIR /build
COPY . .
RUN cargo build --locked --release --bin insp-sync-server

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 insp \
    && useradd --system --uid 10001 --gid insp --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin insp \
    && mkdir -p /data \
    && chown insp:insp /data

COPY --from=builder /build/target/release/insp-sync-server /usr/local/bin/insp-sync-server

ENV INSP_LISTEN=0.0.0.0:8787 \
    INSP_DATA_DIR=/data

USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/insp-sync-server"]
