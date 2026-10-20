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

Nenhuma porta é publicada no host. Os dois contêineres rodam sem *capabilities* e com `no-new-privileges`.

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

## Atualizar

As imagens base e a versão do Tor são fixadas. Quando o Tor Project publica uma versão nova, o build do contêiner `tor` passa a falhar de propósito. Leia as notas da versão, ajuste `TOR_VERSION` em `deploy/tor.Dockerfile` e rode `docker compose build && docker compose up -d`.

## Anonimato de quem hospeda

O serviço onion esconde o IP do servidor de quem usa. Ele **não** esconde você do seu provedor de hospedagem: um VPS pago com cartão ou cadastrado no seu nome liga a instância a você. Veja o limite L6 em [THREAT-MODEL.md](THREAT-MODEL.md).

## Ainda não feito

- Assinatura das imagens (cosign) e SBOM.
- Verificação de build reproduzível (as imagens já fixam bases e removem caminhos do binário, mas a reprodutibilidade não foi testada).
