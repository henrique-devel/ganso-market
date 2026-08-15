FROM rust:1.96.1-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS build

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY services/market-engine services/market-engine
# Cargo carrega todos os manifests do workspace antes de compilar um pacote.
COPY tools/rfc001a-yellowstone-probe tools/rfc001a-yellowstone-probe
RUN cargo build --locked --release --package ganso-market-engine

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

COPY --from=build /build/target/release/ganso-market-engine /usr/local/bin/ganso-market-engine
USER 10001:10001
EXPOSE 8081
CMD ["/usr/local/bin/ganso-market-engine"]
