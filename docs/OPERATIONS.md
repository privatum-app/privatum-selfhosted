# Operação de uma instância

> Estado: Fase 1, pré-alfa. A instância serve o cliente web e a API do relay no mesmo endereço `.onion`. Leia [SECURITY.md](../SECURITY.md) antes.
>
> Para usar: abra o endereço `.onion` no Tor Browser no nível de segurança **Standard** (o cliente precisa de WebAssembly), crie uma identidade com uma senha local e envie o link de "Meu convite" a quem você quer adicionar.

## Subir

Requisito: Docker com Compose. Nada mais precisa ser instalado; Rust e Tor são compilados ou instalados dentro das imagens.

```bash
cd deploy
docker compose up -d
docker compose exec tor cat /run/onion/hostname
```

A última linha mostra o endereço `.onion` da instância. Na primeira vez, publicar o serviço pode levar alguns minutos.

## O que roda

| Contêiner | Usuário | Rede | Sistema de arquivos |
|---|---|---|---|
| `relay` | `65532` (distroless *nonroot*) | só `internal` (sem acesso à internet) | somente leitura; grava apenas em `/data` |
| `tor` | `debian-tor` | `internal` + `egress` | somente leitura; grava apenas em `/var/lib/tor` e `/run/onion` |
| `info` | `65534` (*nobody*) | só `info` | somente leitura; serve uma página gerada em `/tmp` |

O aplicativo não publica porta no host. A única porta publicada é a da página `info` (`127.0.0.1:8099`, mude com `PRIVATUM_INFO_PORT`), presa ao endereço local: ela só mostra o endereço `.onion` e não dá acesso ao Privatum. Todos os contêineres rodam sem *capabilities* e com `no-new-privileges`.

## Volumes

| Volume | Conteúdo | Perder | Vazar |
|---|---|---|---|
| `privatum_tor-state` | `hs/hs_ed25519_secret_key` (chave do serviço onion) e cache do Tor | O endereço muda; **todos os convites quebram** | Outra pessoa pode se passar pela sua instância |
| `privatum_relay-data` | `relay.sqlite`: chaves públicas e mensagens cifradas ainda não entregues | Mensagens pendentes se perdem; as pessoas precisam se registrar de novo | Metadados (quem envia para quem, quando). Nenhum conteúdo em claro |
| `privatum_onion-hostname` | Só o nome `.onion`, para o relay | Recriado ao subir | Nada além do endereço |

## Backup da chave onion

A chave é o que identifica a instância. Faça backup cifrado e guarde fora da máquina.

```bash
docker run --rm -v privatum_tor-state:/s:ro -v "$PWD":/out debian:bookworm-slim tar -C /s -cf /out/onion-key.tar hs
```

Depois cifre `onion-key.tar` (por exemplo com `age` ou `gpg --symmetric`) e apague a cópia em claro com `shred -u onion-key.tar` (ou o equivalente no seu sistema).

Para restaurar, com a instância parada: decifre o arquivo, extraia em `hs/` dentro do volume e mantenha dono `debian-tor` e permissão `0700` no diretório.

## Trocar o endereço `.onion`

O endereço não é escolhido nem registrado em lugar nenhum: o Tor o calcula a partir da chave privada em `privatum_tor-state` (`hs/hs_ed25519_secret_key`). Mesma chave, mesmo endereço, para sempre; chave nova, endereço novo.

Para trocar, dentro de `deploy/`:

```bash
docker compose down
```

```bash
docker run --rm -v privatum_tor-state:/s debian:bookworm-slim rm -rf /s/hs
```

```bash
docker compose up -d
```

O novo endereço aparece no link `info-1` do Docker Desktop, nos logs e em `docker compose exec tor cat /run/onion/hostname`.

Depois da troca:

- **Convites antigos param de funcionar**: eles apontam para o endereço velho. Envie o novo endereço por um canal confiável.
- **Cada pessoa restaura o próprio backup no endereço novo.** Para o navegador, o endereço novo é outro site, então a identidade não aparece lá até ser restaurada com o arquivo `.privatum` e a senha local.
- **Contatos e mensagens pendentes continuam valendo**, porque o banco do relay (`privatum_relay-data`) não muda. Quem já conversava não precisa trocar convites de novo.

Quando faz sentido trocar: se a chave vazou (quem a tem pode se passar pela sua instância) ou para cortar o vínculo com um endereço que circulou demais. Para voltar a um endereço antigo, só restaurando o backup da pasta `hs` (seção anterior); sem ele, o endereço antigo está perdido.

## Quando o endereço `.onion` não abre

Ninguém se conecta diretamente à máquina: o navegador e a instância só fazem conexões de saída para a rede Tor. Firewall, roteador e "mesma rede Wi-Fi" não influenciam. Siga nesta ordem:

1. **A instância está no ar?** `docker compose ps` deve mostrar `relay`, `tor` e `info` rodando. O computador precisa estar ligado e acordado (desative o repouso).
2. **O Tor do aparelho funciona com outros `.onion`?** Teste, por exemplo, `https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion`. Se nem esse abre, o problema é o Tor do aparelho.
3. **Primeira visita:** depois de abrir o Tor Browser, o primeiro acesso pode demorar ou dar "a conexão expirou". Espere dois minutos e tente de novo; recarregar em sequência piora, porque o Tor guarda a falha por alguns minutos.
4. **Depois de reiniciar o `tor` ou mudar o `torrc`**, o serviço publica uma descrição nova na rede Tor. Por alguns minutos, alguns aparelhos ainda recebem a antiga e falham com "Não foi possível conectar". Espere de 10 a 15 minutos antes de concluir que não funciona.
5. **Guarda ruim:** se `docker compose logs tor` mostrar *"Guard … is failing more circuits than usual"* e o endereço falhar com frequência, faça o Tor escolher outro guarda. A chave do `.onion` não é tocada; o endereço continua o mesmo:

   ```bash
   docker compose stop tor
   ```

   ```bash
   docker run --rm -v privatum_tor-state:/s debian:bookworm-slim rm -f /s/data/state
   ```

   ```bash
   docker compose start tor
   ```

   O Tor mantém o mesmo guarda por meses de propósito (dificulta certos ataques de identificação), então só faça isso quando o guarda estiver de fato falhando.

O serviço é configurado com 5 pontos de introdução (o padrão do Tor é 3), o que dá aos visitantes mais caminhos de entrada quando parte dos circuitos falha.

## Conferir as imagens

As imagens publicadas (`ghcr.io/privatum-app/privatum-relay` e `ghcr.io/privatum-app/privatum-tor`) são compiladas pelo GitHub Actions (`.github/workflows/release.yml`), assinadas com **cosign** sem chave guardada (identidade OIDC do workflow) e acompanhadas de **SBOM** e de proveniência do build. O `compose.yaml` do pacote fixa cada imagem pelo digest, então o Docker recusa uma imagem trocada.

Para conferir a assinatura (troque a versão):

```bash
cosign verify ghcr.io/privatum-app/privatum-relay:v0.1.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp '^https://github.com/privatum-app/privatum-selfhosted/\.github/workflows/release\.yml@refs/tags/v'
```

Repita com `privatum-tor`. Para ver o SBOM: `docker buildx imagetools inspect ghcr.io/privatum-app/privatum-relay:v0.1.0 --format '{{ json .SBOM }}'`.

## Atualizar

As imagens base e a versão do Tor são fixadas. Quando o Tor Project publica uma versão nova, o build do contêiner `tor` passa a falhar de propósito. Leia as notas da versão, ajuste `TOR_VERSION` em `deploy/tor.Dockerfile` e rode `docker compose build && docker compose up -d`.

## Anonimato de quem hospeda

O serviço onion esconde o IP do servidor de quem usa. Ele **não** esconde você do seu provedor de hospedagem: um VPS pago com cartão ou cadastrado no seu nome liga a instância a você. Veja o limite L6 em [THREAT-MODEL.md](THREAT-MODEL.md).

## Ainda não feito

- Verificação de build reproduzível (as imagens já fixam bases e removem caminhos do binário, mas a reprodutibilidade não foi testada).
