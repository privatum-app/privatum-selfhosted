#!/bin/sh
# Builds the end-user bundle: a compose.yaml that uses prebuilt images and the double-click start/stop shortcuts. The compose file is derived from
# deploy/compose.yaml (build: blocks removed) so the two never drift apart.
#   usage: deploy/release/make-bundle.sh <relay-image> <tor-image> <output-dir>
set -eu
relay=$1
tor=$2
out=$3
here=$(cd "$(dirname "$0")" && pwd)
deploy=$(dirname "$here")

mkdir -p "$out"
awk '/^    build:$/ { skip = 1; next } skip && /^      / { next } { skip = 0; print }' "$deploy/compose.yaml" \
  | sed -e "s#image: privatum-relay:local#image: $relay#" \
        -e "s#image: privatum-tor:local#image: $tor#" \
        -e "s#^\#   cd deploy && #\#   #" > "$out/compose.yaml"
if grep -q 'build:' "$out/compose.yaml" || ! grep -q "image: $relay" "$out/compose.yaml" || ! grep -q "image: $tor" "$out/compose.yaml"; then
  echo "make-bundle: unexpected compose.yaml layout" >&2
  exit 1
fi

cp "$here/iniciar.sh" "$out/iniciar.sh"
cp "$here/iniciar.sh" "$out/iniciar.command"
cp "$here/parar.sh" "$out/parar.sh"
cp "$here/parar.sh" "$out/parar.command"
cp "$here/iniciar.bat" "$here/parar.bat" "$here/LEIA-ME.txt" "$out/"
chmod 755 "$out"/*.sh "$out"/*.command
