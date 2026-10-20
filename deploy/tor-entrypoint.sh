#!/bin/sh
# Runs tor and publishes only the onion hostname (not the key) to /run/onion,
# a volume the relay mounts read-only to bind its auth signatures to it.
set -eu

tor -f /etc/tor/torrc &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

while [ ! -s /var/lib/tor/hs/hostname ]; do
  kill -0 "$pid" 2>/dev/null || exit 1
  sleep 1
done
cp /var/lib/tor/hs/hostname /run/onion/hostname.tmp
# tor writes it 0600; the relay runs as another user and only needs to read it.
chmod 0644 /run/onion/hostname.tmp
mv /run/onion/hostname.tmp /run/onion/hostname
# Shown in "docker compose logs" and in Docker Desktop (container tor-1 > Logs).
echo "=================================================="
echo " Seu Privatum está no ar:"
echo " http://$(cat /run/onion/hostname)"
echo " Abra este endereço no Tor Browser (nível Standard)."
echo "=================================================="

# wait returns early when a signal arrives; keep waiting until tor has exited.
while kill -0 "$pid" 2>/dev/null; do
  wait "$pid" || true
done
