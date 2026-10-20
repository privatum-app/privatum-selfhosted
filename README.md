# Privatum (autohospedado)

Chat com criptografia de ponta a ponta que qualquer pessoa sobe na própria máquina com Docker. A instância é publicada como serviço onion do Tor e você convida pessoas por um link que leva o endereço `.onion` e a impressão digital da sua chave.

> **Pré-alfa, sem auditoria externa. Não use para nada sensível.** Leia [SECURITY.md](SECURITY.md) e [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) antes: lá está o que o projeto protege e, principalmente, o que **não** protege.

## Importante: nível de segurança do Tor Browser

O cliente **só funciona no nível de segurança "Standard"** do Tor Browser.

- **Por quê:** a criptografia (Olm/Double Ratchet do vodozemac) roda em **WebAssembly**. Desde o Tor Browser 15, os níveis **Safer** e **Safest** bloqueiam WebAssembly em todos os sites (o Safest também bloqueia JavaScript). Sem WebAssembly não há criptografia: o cliente mostra um aviso pedindo o nível Standard em vez de abrir.
- **Não dá para subir o nível sem quebrar o cliente.** Não existe hoje uma configuração do Tor Browser que mantenha Safer/Safest e libere WebAssembly só para este site de forma testada e recomendada.
- **O que isso custa:** o nível Standard deixa o navegador com mais recursos ativos, logo com mais superfície de ataque. Na prática: use o Tor Browser só para o Privatum enquanto conversa, mantenha-o atualizado e feche-o ao terminar.
- **Solução prevista:** um aplicativo local (Fase 2), em que a criptografia não depende das restrições do navegador.

Como mudar: ícone do escudo na barra → **Configurações de segurança** → escolha **Standard** e confirme.

## Quem precisa de quê

| Papel | Precisa de | Sistema |
|---|---|---|
| **Quem hospeda** a instância | Docker + Git | Windows, macOS ou Linux |
| **Quem conversa** (inclusive quem hospeda) | Tor Browser no nível Standard | Windows, macOS ou Linux |

Ninguém precisa abrir portas no roteador, ter domínio, IP fixo ou certificado TLS: o Tor cuida disso.

## Hospedar uma instância

Requisitos: cerca de **6 GB livres** de disco durante o primeiro build (as imagens finais ocupam ~200 MB) e conexão com a internet. O primeiro build leva **vários minutos**, porque compila o relay em Rust e a criptografia em WebAssembly dentro dos contêineres; não é preciso instalar Rust nem Node.

### 1. Instale o Docker e o Git

- **Windows 10/11:** instale o [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) (com o backend **WSL 2**) e o [Git for Windows](https://git-scm.com/download/win). Abra o Docker Desktop e espere ele indicar que está rodando.
- **macOS:** instale o [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) (Apple Silicon ou Intel) e o Git (`xcode-select --install` instala o Git da Apple). Abra o Docker Desktop.
- **Linux:** instale o [Docker Engine](https://docs.docker.com/engine/install/) com o plugin Compose e o Git pelo gerenciador de pacotes da sua distribuição. Para rodar sem `sudo`, adicione seu usuário ao grupo `docker` e faça logout/login.

Confira no terminal (PowerShell no Windows):

```bash
docker compose version
```

### 2. Baixe o projeto e suba a instância

Enquanto o repositório for privado, só contas com acesso conseguem clonar.

```bash
git clone https://github.com/privatum-app/privatum-selfhosted.git
```

```bash
cd privatum-selfhosted/deploy
```

```bash
docker compose up -d
```

### 3. Descubra o endereço `.onion`

```bash
docker compose logs tor
```

Procure a linha `onion service: ....onion`. Na primeira vez o Tor pode levar um ou dois minutos para publicar o serviço. No Windows, para filtrar: `docker compose logs tor | Select-String "onion service"`.

**Esse endereço identifica a sua instância.** A chave que o gera fica no volume `privatum_tor-state`; faça backup dela (veja [docs/OPERATIONS.md](docs/OPERATIONS.md)). Se você a perder, o endereço muda e todos os convites deixam de funcionar.

### Parar, reiniciar, atualizar, apagar

| Ação | Comando (dentro de `deploy/`) |
|---|---|
| Parar (mantém dados e endereço) | `docker compose down` |
| Subir de novo | `docker compose up -d` |
| Atualizar | `git pull` e depois `docker compose up -d --build` |
| **Apagar tudo**, inclusive o endereço `.onion` e mensagens pendentes | `docker compose down -v` |

A instância só fica disponível enquanto o computador estiver ligado e os contêineres rodando. Mensagens enviadas a quem está offline ficam guardadas cifradas por até 14 dias.

## Conversar

1. Baixe o Tor Browser **somente** em [torproject.org/download](https://www.torproject.org/download/) e, se puder, [verifique a assinatura](https://support.torproject.org/tbb/how-to-verify-signature/).
2. Coloque o nível de segurança em **Standard** (veja acima).
3. Abra o endereço `.onion` da instância e crie uma identidade com uma **senha local**. Ela cifra suas chaves e conversas só neste navegador, nunca é enviada ao servidor e **não pode ser recuperada**.
4. Clique em **Meu convite** e envie o link, por um canal em que você confia, a quem você quer adicionar. A pessoa abre o link no Tor Browser, cria a identidade dela e adiciona você.
5. Abra **Código de segurança** na conversa e compare os 30 dígitos com o contato, por voz ou pessoalmente.
6. **Antes de fechar o Tor Browser, clique em "Exportar backup".** O Tor Browser apaga os dados dos sites ao fechar: sem o arquivo `.privatum`, sua identidade, contatos e histórico se perdem. Da próxima vez, abra o endereço e use **Restaurar de um backup** com a mesma senha local.

O backup é cifrado com a sua senha local; quem tiver o arquivo pode tentar adivinhá-la offline, então use uma senha longa e guarde o arquivo em local seguro. Restaurar um backup antigo perde as mensagens trocadas depois dele.

Cada convite abre uma conversa **individual** entre você e quem o usar; não há conversas em grupo.

Celulares: o Tor Browser para Android deve funcionar, mas **não foi testado**. No iOS não há Tor Browser oficial.

## Testado até agora

| | Status |
|---|---|
| Hospedar no macOS (Apple Silicon) | testado |
| Hospedar no Windows ou Linux | **não testado** (as imagens base existem para amd64 e arm64) |
| Conversar pelo Tor Browser (desktop, nível Standard) | testado |
| Tor Browser para Android, Brave com Tor | **não testado** |

## Como funciona

- **Mensagens:** Olm (Double Ratchet) do [vodozemac](https://github.com/matrix-org/vodozemac), compilado para WebAssembly. Este projeto não implementa criptografia própria.
- **Relay:** servidor em Rust que só guarda e entrega envelopes cifrados. Nunca recebe senha nem chave privada. Detalhes em [docs/PROTOCOL.md](docs/PROTOCOL.md).
- **Identidade:** o endereço de cada pessoa é o hash das suas chaves públicas, então o cliente recusa chaves trocadas pelo servidor.
- **Rede:** C Tor em contêiner publica a instância como `.onion`. Nenhuma porta é aberta no host.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `relay/` | Relay em Rust (axum + SQLite) e testes de integração |
| `crypto-wasm/` | Cola `wasm-bindgen` sobre o vodozemac e testes |
| `client/` | Cliente web (React); a lógica fica em `client/src/core/`, sem React |
| `deploy/` | Imagens, `compose.yaml` e configuração do Tor |
| `docs/` | Modelo de ameaças, protocolo e operação |

## Testes (para quem desenvolve)

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
