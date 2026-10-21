#!/bin/sh
# Privatum: starts the instance and opens the page with its .onion address.
# Same file is shipped as iniciar.command (double-click on macOS) and iniciar.sh (Linux).
cd "$(dirname "$0")" || exit 1
pause() { printf '\nPressione Enter para fechar esta janela.'; read -r _ || true; }

if ! command -v docker >/dev/null 2>&1; then
  echo "O Docker não está instalado."
  echo "Instale o Docker Desktop (macOS) ou o Docker Engine (Linux): https://docs.docker.com/get-docker/"
  pause; exit 1
fi

if ! docker info >/dev/null 2>&1; then
  [ "$(uname)" = Darwin ] && open -a Docker 2>/dev/null
  echo "Aguardando o Docker iniciar..."
  i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 90 ]; then echo "O Docker não respondeu. Abra o Docker e tente de novo."; pause; exit 1; fi
    sleep 2
  done
fi

echo "Iniciando o Privatum (na primeira vez ele baixa as imagens; pode levar alguns minutos)..."
if ! docker compose up -d; then echo "Não foi possível iniciar o Privatum."; pause; exit 1; fi

echo "Aguardando o endereço .onion..."
host=""
i=0
while [ -z "$host" ] && [ "$i" -lt 90 ]; do
  host=$(docker compose exec -T tor cat /run/onion/hostname 2>/dev/null | tr -d '\r\n')
  [ -z "$host" ] && sleep 2
  i=$((i + 1))
done
if [ -z "$host" ]; then echo "O Tor ainda não publicou o endereço. Rode este atalho de novo em alguns minutos."; pause; exit 1; fi

echo
echo "Seu Privatum está no ar:  http://$host"
echo "Abra este endereço no Tor Browser (nível de segurança Standard)."
url="http://127.0.0.1:${PRIVATUM_INFO_PORT:-8099}"
case "$(uname)" in
  Darwin) open "$url" ;;
  *) xdg-open "$url" >/dev/null 2>&1 || echo "Página com o endereço: $url" ;;
esac
echo "O Privatum continua rodando em segundo plano depois que esta janela for fechada."
pause
