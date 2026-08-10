FROM rust:1.96.1-bookworm AS build

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY services/market-engine services/market-engine
RUN cargo build --locked --release --package ganso-market-engine

FROM debian:bookworm-slim

COPY --from=build /build/target/release/ganso-market-engine /usr/local/bin/ganso-market-engine
USER 10001:10001
EXPOSE 8081
CMD ["/usr/local/bin/ganso-market-engine"]
