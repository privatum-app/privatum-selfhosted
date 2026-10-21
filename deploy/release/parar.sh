#!/bin/sh
# Privatum: stops the instance. Data and the .onion address are kept.
cd "$(dirname "$0")" || exit 1
docker compose down && echo "Privatum parado. Seus dados e o endereço .onion foram mantidos."
printf '\nPressione Enter para fechar esta janela.'; read -r _ || true
