# Protocolo do relay e do convite — Fase 1

> Estado: **especificação em rascunho**, nada implementado. Requisitos R1–R10 e limites L1–L8 vêm de [THREAT-MODEL.md](THREAT-MODEL.md).

## Decisões

| Item | Escolha |
|---|---|
| Protocolo de mensagens | Olm (Double Ratchet) via **vodozemac 0.11.1** (fixado), compilado para WASM. Configuração de sessão **v1** (a auditada e usada pela Matrix; a v2 ainda é experimental no vodozemac). Nenhuma primitiva própria. |
| Relay | **Rust** (axum + tokio + SQLite). Assinaturas verificadas com `ed25519-dalek`. |
| Cliente | Novo, enxuto (Vite + React + TypeScript), reaproveitando só componentes visuais do cliente antigo. |
| Transporte | HTTP + WebSocket dentro do serviço onion. Sem TLS próprio. |
| Escopo da Fase 1 | Conversa 1:1, só texto, um dispositivo por identidade. Arquivos, grupos e multi-dispositivo ficam para depois. |

## 1. Identidade e endereço autocertificável

Cada pessoa tem uma `Account` do vodozemac, com duas chaves públicas: Ed25519 (assinatura) e Curve25519 (identidade Olm).

```
fingerprint = SHA-256( "privatum-id-v1" || ed25519_pub || curve25519_pub )
mailbox_id  = base32(fingerprint)          # 52 caracteres, sem padding
```

O **endereço da caixa é a própria impressão digital**. Quando o relay entrega as chaves de alguém, o cliente recalcula o hash e compara com o `mailbox_id` que pediu. Se divergir, a conversa é bloqueada (R2, R3). Isso fecha a troca de chave pelo servidor sem depender de TOFU.

Código de segurança mostrado às duas pessoas: os primeiros 30 dígitos decimais derivados do hash dos dois `fingerprint` em ordem lexicográfica, em 6 grupos de 5. Serve para conferência por voz ou presencial; a segurança principal já vem do endereço autocertificável.

## 2. Convite

```
http://<56 caracteres>.onion/#c=<mailbox_id>
```

- O fragmento (`#...`) nunca é enviado ao servidor pelo navegador.
- O endereço onion autentica o relay; o `mailbox_id` autentica a pessoa.
- Pode ser passado como texto ou QR, por um canal em que as duas pessoas confiam (L4).

## 3. Autenticação no relay (R1, R9)

O relay nunca recebe senha.

1. `POST /v1/auth/challenge {mailbox_id}` → `{nonce}` (32 bytes aleatórios, vale 60 s, uso único).
2. O cliente assina `"privatum-auth-v1" || onion_host || nonce` com a Ed25519 da `Account`.
3. `POST /v1/auth/verify {mailbox_id, nonce, signature}` → `{token}` (aleatório, 32 bytes, vale 15 min, guardado só em memória no cliente e como hash no relay).

## 4. API

Todas as respostas levam os cabeçalhos de R8. Tamanhos máximos e limites de taxa são configuráveis.

| Método e rota | Autenticação | Função |
|---|---|---|
| `POST /v1/register` | assinatura | Cria a caixa: `{ed25519, curve25519, signature, invite?}`. O relay recalcula o `mailbox_id`. Caixa já existente: sempre aceita. Caixa nova: depende do modo de registro (`open`; `invite` exige um código válido, que é consumido; `closed` recusa). Erros: `invite_required`, `invalid_invite`, `registration_closed`. |
| `GET /v1/instance` | nenhuma | `{registration}`: o modo de registro, para o cliente avisar antes de tentar. |
| `POST /v1/invites` | token | Só no modo `invite`: gera um código de uso único válido por 7 dias para o convite do membro (`#c=<mailbox>&r=<código>`). Limite de 10 por minuto por caixa. |
| `PUT /v1/keys` | token | Envia chaves de uso único e a chave reserva (fallback), assinadas pela Ed25519. Um lote novo de chaves de uso único **substitui** o anterior (até 100 por envio). |
| `GET /v1/keys/{mailbox_id}` | token | Devolve identidade + **uma** chave de uso único (consumida) ou a reserva. |
| `POST /v1/messages` | token | `{to, envelope}`. O relay grava `to`, o remetente autenticado, o horário e o blob. |
| `GET /v1/inbox` (WebSocket) | token | Entrega mensagens pendentes e novas. |
| `DELETE /v1/messages/{id}` | token | Confirmação de recebimento: apaga do relay. |

**Resposta, reação e mensagens temporárias** (dentro do conteúdo cifrado, em conversa individual ou de grupo):

- `text` pode levar `q {id, by}`: a referência da mensagem respondida (id e autor). O texto citado não viaja; cada aparelho o busca no próprio histórico, então ninguém consegue citar algo que a pessoa não escreveu. Se a original não existe mais, aparece "mensagem original indisponível".
- `react {id, by, e}`: `e` é um de 👍 ❤️ 😂 😮 😢 🙏, ou `null` para tirar a própria reação. Uma por pessoa por mensagem; fora do conjunto é ignorado.
- `timer {s}`: prazo das mensagens temporárias, `0` (desligado), 1 hora, 1 dia ou 7 dias. Em conversa individual qualquer um muda; em grupo, só quem o criou. Cada `text` leva o prazo de quem envia em `x`, e o aparelho apaga a mensagem quando ele vence (conferido a cada 15 s e ao abrir). Limites: não impede captura de tela nem cópia em backup feito antes, e a cópia cifrada ainda não entregue fica no relay até ser entregue (no máximo 14 dias).

**Grupos:** não existem para o relay. Cada mensagem do grupo é cifrada separadamente para cada membro pelas sessões Olm de um para um, com o campo `g` (id aleatório do grupo) dentro do conteúdo cifrado. Tipos: `ginfo {g, name, m}` (nome e lista de membros; só é aceito de quem criou o grupo, e quem anuncia um grupo novo é o dono), `text`/`edit`/`del` com `g`, e `gleave {g}`. A lista de membros só muda por `ginfo` do dono; um membro fora da lista é ignorado, e quem sai da lista passa a ler só o histórico. Até 20 membros. O relay vê N mensagens de um para um (metadados: quem envia para quem e quando, como em qualquer conversa).

**Códigos de convite:** 16 bytes aleatórios em base32 (26 caracteres). O relay guarda só o SHA-256 do código, a validade e os usos restantes, e se foi criado pelo painel ou por um membro; **não guarda quem criou nem quem usou**, para não formar um mapa de quem convidou quem. O link do painel é `#r=<código>` (só registro, sem contato).

**API administrativa interna** (porta 8081, só na rede interna; o `.onion` não encaminha para ela; exige o token do painel): `GET /admin/stats`, `GET /admin/access`, `POST /admin/registration {mode}`, `POST /admin/invites {uses, days}`, `POST /admin/invites/revoke {id}`, `POST /admin/mailboxes/remove {id}`. Devolve só contagens, datas e identificadores de caixa; nunca conteúdo nem remetentes.

Envelope (JSON, tudo fora de `ciphertext` é visível ao relay):

```
{ "v": 1, "from_ed25519": "...", "from_curve25519": "...", "type": 0|1, "ciphertext": "..." }
```

O destinatário recalcula `mailbox_id(from_ed25519, from_curve25519)` e descarta o envelope se não bater com o remetente informado pelo relay. A sessão Olm, por sua vez, só decifra se o remetente tiver a chave privada Curve25519 correspondente; assim nem o relay nem outro usuário consegue se passar por uma caixa.

O texto claro dentro do Olm é JSON `{kind, body, sent_at}`, preenchido até o próximo múltiplo de 256 bytes antes de cifrar (R5).

## 5. O que o relay guarda

| Tabela | Colunas |
|---|---|
| `mailboxes` | `id`, `ed25519`, `curve25519`, `created_at` |
| `one_time_keys` | `mailbox_id`, `key_id`, `key`, `signature` |
| `fallback_keys` | `mailbox_id`, `key`, `signature` |
| `messages` | `id`, `to_mailbox`, `from_mailbox`, `envelope`, `created_at` |
Desafios e tokens ficam **só em memória** (hash do token, caixa, validade): reiniciar o relay obriga todos a se autenticar de novo, e nada disso vai para o disco.

Nada de senha, chave privada (nem cifrada), nome, avatar ou lista de contatos (R4). Mensagens são apagadas ao confirmar o recebimento ou após **14 dias** (configurável). `from_mailbox` existe porque o relay já sabe quem enviou; está registrado como metadado em L3.

## 6. Armazenamento no cliente

- `Account` e sessões Olm em IndexedDB, como *pickle* cifrado do vodozemac.
- A chave do *pickle* vem de uma senha local via PBKDF2-SHA256 (WebCrypto) com **600.000 iterações fixas no código** (R10). A senha nunca sai do dispositivo.
- Contatos e histórico também ficam só no dispositivo, cifrados com a mesma chave.
- Nada em `localStorage` além de preferências visuais.
- Backup: arquivo `.privatum` exportado pelo cliente, com o mesmo estado selado (AES-GCM, chave derivada da senha local) e o sal. Sem backup no relay.
- O Tor Browser apaga os dados dos sites ao fechar, então o backup é o que preserva a identidade entre sessões.
- Ao restaurar, as sessões Olm do backup só servem para **decifrar**: antes de enviar a cada contato, o cliente abre uma sessão nova, porque cifrar com um ratchet atrasado reutilizaria chaves de mensagem. Mensagens recebidas depois do backup em sessões que mudaram podem não ser decifráveis.
- A cada login o cliente publica um lote novo de chaves de uso único, que substitui o anterior no relay; assim o relay não entrega chaves cujas partes privadas se perderam numa restauração.

## 7. Implantação

```
deploy/
  compose.yaml        # relay + tor, rede interna, sem portas publicadas
  relay.Dockerfile    # build Rust multi-estágio -> imagem distroless, sem root, FS somente leitura
  tor.Dockerfile      # Debian fixado + tor de deb.torproject.org (assinatura verificada)
  torrc               # HiddenServiceDir no volume, HiddenServicePort 80 -> relay:8080
```

Volumes: `relay-data` (SQLite) e `tor-keys` (`0700`, chave do serviço onion). Compilação de Rust e WASM dentro de contêineres; nada precisa ser instalado na máquina de quem hospeda além do Docker.

## 8. Ordem de implementação (Etapa 3)

1. **3b — Relay** em Rust: rotas acima, SQLite, limites de taxa, cabeçalhos, testes de integração.
2. **3c — Docker + Tor**: `docker compose up` publica o relay como `.onion`.
3. **3d — Cola WASM** sobre o vodozemac (`wasm-bindgen`): só expor `Account`, `Session` e *pickle*; nenhuma lógica criptográfica nova.
4. **3e — Cliente** novo: criar identidade, senha local, convite, conversa, verificação do endereço autocertificável.
5. **3f — Teste ponta a ponta** com dois perfis do Tor Browser em nível Standard. *Feito em 2026-10-20:* Tor Browser (nível Standard) → `.onion` → relay, conversando com um participante de teste no Node ligado à rede interna da instância. Mensagens nos dois sentidos, contato que iniciou a conversa marcado como "não verificado". Ainda não testado: dois Tor Browsers reais, o aviso no nível Safer, e a reconexão após o token expirar (15 min).
6. **3g — Limpeza**: remover Supabase, Stripe, funções de borda, migrações e documentação do Privatum comercial. *Feito em 2026-10-20*, com o histórico do Git recomeçado do zero.

Depois: Fase 2 (app local, Arti), Fase 3 (auditoria externa e lançamento).

## Em aberto

- Política anti-spam para `POST /v1/messages` (hoje: só limite de taxa por caixa autenticada).
- Ocultar o remetente do relay (*sealed sender*) — fora da Fase 1.
- Rotação e reposição automática das chaves de uso único.
