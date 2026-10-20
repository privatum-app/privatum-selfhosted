# Privatum onion service: C Tor from deb.torproject.org. Build context: deploy/
#   docker build -f deploy/tor.Dockerfile -t privatum-tor deploy
# Base image and tor version are pinned. When the Tor Project publishes a new
# release the pinned version leaves the repo and this build fails on purpose:
# bump TOR_VERSION after reading the release notes.

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

ARG TOR_VERSION=0.4.9.14-1~d12.bookworm+1
# Tor Project archive signing key (https://support.torproject.org/apt/).
ARG TOR_KEY_FPR=A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates gpg wget; \
    wget -qO /tmp/tor.asc "https://deb.torproject.org/torproject.org/${TOR_KEY_FPR}.asc"; \
    gpg --show-keys --with-colons /tmp/tor.asc | grep -q "^fpr:::::::::${TOR_KEY_FPR}:" \
      || { echo "tor signing key fingerprint mismatch" >&2; exit 1; }; \
    gpg --dearmor < /tmp/tor.asc > /usr/share/keyrings/tor-archive.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/tor-archive.gpg] https://deb.torproject.org/torproject.org bookworm main" \
      > /etc/apt/sources.list.d/tor.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "tor=${TOR_VERSION}"; \
    apt-get purge -y --auto-remove gpg wget; \
    rm -rf /var/lib/apt/lists/* /tmp/tor.asc /root/.gnupg; \
    install -d -o debian-tor -g debian-tor -m 0700 /var/lib/tor/data /var/lib/tor/hs; \
    install -d -o debian-tor -g debian-tor -m 0755 /run/onion

COPY torrc /etc/tor/torrc
COPY tor-entrypoint.sh /usr/local/bin/tor-entrypoint.sh

USER debian-tor
ENTRYPOINT ["/bin/sh", "/usr/local/bin/tor-entrypoint.sh"]
