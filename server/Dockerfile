FROM rust:1-bookworm AS rust
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --locked --release --bin packserver

FROM python:3.12-slim-bookworm AS valhalla
RUN pip install --no-cache-dir --target /wheel pyvalhalla==3.9.1

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool ca-certificates curl libstdc++6 libgcc-s1 libgomp1 && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home packserver \
    && mkdir -p /var/lib/packserver && chown packserver:packserver /var/lib/packserver
COPY --from=rust /build/target/release/packserver /usr/local/bin/packserver
COPY --from=valhalla /wheel/valhalla/bin/ /opt/valhalla/bin/
COPY --from=valhalla /wheel/pyvalhalla.libs/ /opt/pyvalhalla.libs/
ENV PACKSERVER_VALHALLA_BIN=/opt/valhalla/bin/valhalla_build_tiles
ENV LD_LIBRARY_PATH=/opt/pyvalhalla.libs
USER packserver
VOLUME /var/lib/packserver
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD curl --fail --silent http://localhost:8787/healthz || exit 1
ENTRYPOINT ["packserver"]
CMD ["serve"]
