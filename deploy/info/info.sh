#!/bin/sh
# Serves a local-only page with the instance's .onion address (Docker Desktop shows it as a link).
set -eu
while [ ! -s /run/onion/hostname ]; do sleep 1; done
host=$(cat /run/onion/hostname)
# Never inject anything but a well-formed v3 onion name into the page.
echo "$host" | grep -Eq '^[a-z2-7]{56}\.onion$' || { echo "invalid onion hostname" >&2; exit 1; }
mkdir -p /tmp/www
sed "s/__ONION__/$host/g" /info/index.html > /tmp/www/index.html
exec httpd -f -p 8080 -h /tmp/www
