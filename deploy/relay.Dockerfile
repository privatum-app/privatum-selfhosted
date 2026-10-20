# Privatum instance image: relay + web client + vodozemac WASM. Build context: repo root.
#   docker build -f deploy/relay.Dockerfile -t privatum-relay .
# WASM bindings only (for tests):
#   docker build -f deploy/relay.Dockerfile --target wasm-out --output crypto-wasm/pkg .
# Base images are pinned by digest; update them deliberately, never via floating tags.

ARG RUST_IMAGE=rust:1.90-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

# --- vodozemac WASM bindings ---
FROM ${RUST_IMAGE} AS wasm
# The CLI version must equal the wasm-bindgen crate version pinned in crypto-wasm/Cargo.toml.
ARG WASM_BINDGEN_VERSION=0.2.129
RUN rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-bindgen-cli --version "${WASM_BINDGEN_VERSION}"
WORKDIR /src
ENV RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo" \
    CARGO_INCREMENTAL=0 \
    SOURCE_DATE_EPOCH=0
COPY crypto-wasm/Cargo.toml crypto-wasm/Cargo.lock ./
COPY crypto-wasm/src ./src
RUN cargo build --release --locked --target wasm32-unknown-unknown \
 && W=target/wasm32-unknown-unknown/release/privatum_crypto.wasm \
 && wasm-bindgen --target web --out-dir /out/web "$W" \
 && wasm-bindgen --target nodejs --out-dir /out/node "$W" \
 && echo '{"type":"commonjs"}' > /out/node/package.json

FROM scratch AS wasm-out
COPY --from=wasm /out /

# --- web client ---
FROM ${NODE_IMAGE} AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
COPY --from=wasm /out/web /app/crypto-wasm/pkg/web
# Precompressed copies (served by the relay when the browser accepts gzip); -n keeps builds reproducible.
RUN npm run build \
 && find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' -o -name '*.html' -o -name '*.svg' \) -exec gzip -k -9 -n {} +

# --- relay ---
FROM ${RUST_IMAGE} AS relay
WORKDIR /src
ENV RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo" \
    CARGO_INCREMENTAL=0 \
    SOURCE_DATE_EPOCH=0
COPY relay/Cargo.toml relay/Cargo.lock ./
COPY relay/src ./src
RUN cargo build --release --locked \
 && mkdir -p /out/data \
 && cp target/release/privatum-relay /out/

FROM ${RUNTIME_IMAGE}
COPY --from=relay /out/privatum-relay /usr/local/bin/privatum-relay
COPY --from=client /app/client/dist /srv/client
# Data directory owned by the distroless "nonroot" user (65532); mount a volume here.
COPY --from=relay --chown=65532:65532 /out/data /data
ENV PRIVATUM_STATIC_DIR=/srv/client
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/privatum-relay"]
