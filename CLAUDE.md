# Privatum autohospedado — instruções do projeto

Chat com criptografia de ponta a ponta que qualquer pessoa sobe com `docker compose up`. A instância vira um serviço onion do Tor e as pessoas são convidadas por um link com o endereço `.onion` e a impressão digital da chave de quem convida. Licença AGPL-3.0, sem fins comerciais.

## Estrutura

| Pasta | O que é |
|---|---|
| `relay/` | Relay em Rust (axum + SQLite). Guarda e entrega envelopes cifrados; nunca recebe senha nem chave privada. O painel local (`src/bin/privatum-admin.rs`) roda da mesma imagem. |
| `crypto-wasm/` | Cola `wasm-bindgen` sobre o vodozemac (Olm/Double Ratchet). Nenhuma criptografia própria. |
| `client/` | Cliente web e painel em React (`src/admin/`). A lógica fica em `client/src/core/` (sem React, roda também no Node). |
| `deploy/` | `relay.Dockerfile` (imagem única: WASM + cliente + relay), `tor.Dockerfile`, `torrc`, `compose.yaml`. |
| `docs/` | `THREAT-MODEL.md` (adversários, limites L1–L8, requisitos R1–R10), `PROTOCOL.md`, `OPERATIONS.md`. |

## Decisões tomadas

- Protocolo: Olm v1 do **vodozemac 0.11.1** (fixado; a v2 ainda é experimental). Trocar só por protocolo auditado.
- Endereço da caixa = base32(SHA-256("privatum-id-v1" ‖ ed25519 ‖ curve25519)). O cliente recusa chaves que não batem com o convite.
- Autenticação no relay por assinatura de desafio, ligada ao hostname onion configurado (nunca ao cabeçalho Host).
- Tor: **C Tor** de `deb.torproject.org`, versão fixada. Arti só será reavaliado na Fase 2.
- Docker serve o relay; o cliente é servido pela própria instância. App local fica para a Fase 2.
- Blockchain descartada.

## Como construir e testar

Rust não está instalado na máquina: tudo compila em contêiner.

- Relay: `docker run --rm -v "$PWD/relay":/src -w /src rust:1.90-bookworm cargo test`
- Cola WASM: mesmo comando em `crypto-wasm/`; depois `docker build -f deploy/relay.Dockerfile --target wasm-out --output crypto-wasm/pkg .` e `node --test crypto-wasm/tests/*.test.mjs`
- Ponta a ponta: construir `privatum-relay:local`, rodá-lo com `PRIVATUM_HOST=localhost:18080` em `127.0.0.1:18080` e executar `PRIVATUM_TEST_BASE=http://localhost:18080 node --test client/test/*.test.ts`
- Instância completa: `cd deploy && docker compose up -d`

## Regras

- Não escrever criptografia própria. Usar só as primitivas do vodozemac e da WebCrypto.
- Toda mudança de segurança passa pelos requisitos R1–R10 de `docs/THREAT-MODEL.md`. Verificação que falha deve bloquear (falhar fechado).
- Imagens: sem root, sistema de arquivos somente leitura, sem segredos, bases fixadas por digest. Releases (tag `v*`) publicam imagens amd64/arm64 assinadas com cosign e com SBOM via `.github/workflows/release.yml`, mais o pacote simples (`deploy/release/make-bundle.sh`).
- A chave do serviço onion fica no volume `privatum_tor-state`; documentar backup e permissões em `docs/OPERATIONS.md`.
- Não afirmar "100% seguro", "sigilo perfeito" ou "anônimo". O anonimato depende de como a pessoa hospeda e usa; o cliente exige o nível Standard do Tor Browser (WASM).
- Não commitar `.env`, chaves, bancos SQLite, backups da chave onion nem `node_modules`.
- Commits na `main` só quando pedido; **nunca fazer push** sem pedido explícito.
- Não fazer testes ativos contra servidores de terceiros sem confirmação na hora.
- GitHub (`privatum-app/privatum-selfhosted`, público desde 2026-11-17): só o dono grava; a organização exige 2FA. Rulesets sem exceção: `main` não pode ser apagada nem receber push forçado; tags `v*` não podem ser movidas nem apagadas. Release que falhar ou sair errada vira **versão nova** (foi assim de v0.2.1 a v0.2.3), nunca a mesma tag de novo. Reescrever histórico exige desligar a regra da `main` de propósito.
- Nunca apagar versões sem etiqueta dos pacotes de uma release publicada: guardam a assinatura cosign e o SBOM.
- O Tor é fixado numa versão exata e o repositório do Tor só mantém a mais recente: quando sair versão nova do Tor, a release falha até atualizar `TOR_VERSION` em `deploy/tor.Dockerfile`.

## Próximos passos

As funcionalidades estão fechadas na **0.2**: daqui em diante só testes e correções do que eles encontrarem, sem funções novas. Versão oficial publicada: **v0.2.3** (repositório e imagens públicos).

1. Testes no Tor Browser que faltam: mensagens temporárias, troca de nome, alerta de nome repetido (3 contas) e Onion Browser no iPhone.
2. Testar o pacote simples em Linux e Windows.
3. Build reproduzível: a imagem arm64 do relay da v0.2.3 (CI) e um build no Mac deram os 42 arquivos idênticos em 2026-11-17, depois de fixar a etapa do WASM em linux/amd64. Falta conferir a imagem amd64 do relay e a do Tor. Canal de vulnerabilidades: contato@privatum.app (`SECURITY.md`).
4. Depois: Fase 2 (app local opcional e Arti) e Fase 3 (auditoria externa antes de divulgar ao público em geral).
