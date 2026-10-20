# Privatum (autohospedado)

Chat com criptografia de ponta a ponta que qualquer pessoa sobe na própria máquina com `docker compose up`. A instância é publicada como serviço onion do Tor e você convida pessoas por um link que leva o endereço `.onion` e a impressão digital da sua chave.

> **Pré-alfa, sem auditoria externa. Não use para nada sensível.** Leia [SECURITY.md](SECURITY.md) e [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) antes: lá está o que o projeto protege e, principalmente, o que **não** protege.

## Como funciona

- **Mensagens:** Olm (Double Ratchet) do [vodozemac](https://github.com/matrix-org/vodozemac), compilado para WebAssembly. Este projeto não implementa criptografia própria.
- **Relay:** servidor em Rust que só guarda e entrega envelopes cifrados. Nunca recebe senha nem chave privada. Detalhes em [docs/PROTOCOL.md](docs/PROTOCOL.md).
- **Identidade:** o endereço de cada pessoa é o hash das suas chaves públicas, então o cliente recusa chaves trocadas pelo servidor.
- **Rede:** C Tor em contêiner publica a instância como `.onion`. Nenhuma porta é aberta no host.

## Subir uma instância

Requisito: Docker com Compose.

```bash
cd deploy
docker compose up -d
docker compose logs tor | grep "onion service"
```

Abra o endereço `.onion` no Tor Browser, no nível de segurança **Standard** (o cliente precisa de WebAssembly). Backup da chave onion, volumes e atualização: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `relay/` | Relay em Rust (axum + SQLite) e testes de integração |
| `crypto-wasm/` | Cola `wasm-bindgen` sobre o vodozemac e testes |
| `client/` | Cliente web (React); a lógica fica em `client/src/core/`, sem React |
| `deploy/` | Imagens, `compose.yaml` e configuração do Tor |
| `docs/` | Modelo de ameaças, protocolo e operação |

## Testes

Tudo compila dentro do Docker; não é preciso instalar Rust.

```bash
docker run --rm -v "$PWD/relay":/src -w /src rust:1.90-bookworm cargo test
```

```bash
docker run --rm -v "$PWD/crypto-wasm":/src -w /src rust:1.90-bookworm cargo test
```

```bash
docker build -f deploy/relay.Dockerfile --target wasm-out --output crypto-wasm/pkg .
```

```bash
node --test crypto-wasm/tests/*.test.mjs
```

Ponta a ponta (cliente contra um relay real):

```bash
docker build -f deploy/relay.Dockerfile -t privatum-relay:local .
```

```bash
docker run -d --name privatum-e2e -e PRIVATUM_HOST=localhost:18080 -p 127.0.0.1:18080:8080 privatum-relay:local
```

```bash
PRIVATUM_TEST_BASE=http://localhost:18080 node --test client/test/*.test.ts
```

## Licença

[AGPL-3.0](LICENSE). Projeto sem fins comerciais.
