# Modelo de ameaças — Privatum autohospedado

> Estado: **rascunho de projeto (Fase 1)**. Nada do que está descrito aqui como "alvo" foi implementado ainda.
> Este projeto nasceu de um sistema anterior (Supabase + Stripe), cujo código não faz parte deste repositório. A seção 6 resume o que a auditoria daquele sistema encontrou e o que este projeto evita por construção.

## 1. Sistema avaliado

Uma instância é um `docker compose` com:

- **relay**: recebe, guarda temporariamente e entrega blobs cifrados; guarda pacotes de chaves públicas; serve o cliente web estático.
- **tor**: C Tor publicando o relay como serviço onion v3. Sem domínio, sem IP público, sem TLS próprio (o endereço onion autentica o servidor).
- **cliente web**: roda no navegador da pessoa (Tor Browser). Faz toda a criptografia localmente.

Protocolo de mensagens: **Olm (Double Ratchet) via vodozemac** (Rust compilado para WASM), auditado pela Least Authority em 2022. Nenhuma criptografia é escrita neste projeto; só a cola entre o WASM e o cliente.

Convite: `<endereço>.onion` + **impressão digital da chave de identidade** de quem convida, transmitidos fora do relay.

## 2. Ativos

| Ativo | Onde vive |
|---|---|
| Conteúdo de mensagens e arquivos | Só em texto claro no dispositivo de quem envia e de quem recebe |
| Chave de identidade (privada) | Dispositivo, cifrada em repouso por senha local que **nunca** sai do dispositivo |
| Estado do ratchet (chaves de sessão) | Dispositivo |
| Grafo social (quem fala com quem) | Inferível pelo relay |
| Endereço onion e sua chave privada | Volume do contêiner `tor` |
| Identidade real de quem hospeda e de quem usa | Fora do sistema; depende de comportamento |

## 3. Adversários

| ID | Adversário | Capacidade assumida |
|---|---|---|
| A1 | Observador de rede (provedor, Wi-Fi) | Vê tráfego até a entrada do Tor |
| A2 | Operador da instância (quem roda o relay) | Controla o relay, o banco, os logs **e o código do cliente servido** |
| A3 | Quem tem acesso ao servidor (VPS, hospedagem, invasor) | Igual a A2 |
| A4 | Outro usuário da mesma instância | Conta própria, consegue enviar requisições ao relay |
| A5 | Contato malicioso | Recebe as mensagens legitimamente |
| A6 | Acesso físico ou malware no dispositivo | Lê memória e armazenamento local |
| A7 | Cadeia de suprimentos (dependências, imagens, build) | Pode introduzir código malicioso |
| A8 | Adversário global da rede Tor | Correlaciona tráfego de entrada e saída |

## 4. O que se pretende proteger, e contra quem

| Propriedade | Alvo | Contra | **Não** protege contra |
|---|---|---|---|
| Sigilo do conteúdo | E2E com Olm | A1, A2*, A3*, A4 | A5, A6, A2/A3 servindo cliente adulterado (ver L1) |
| Sigilo futuro | Double Ratchet | Roubo posterior da chave de identidade | Roubo do estado atual do ratchet (A6) |
| Autenticidade do contato | Impressão digital no convite, conferida fora do relay | Troca de chave pelo relay (A2, A3) | Convite interceptado e trocado no próprio canal externo |
| IP de quem usa | Tor | A1, A2, A3 | A8; erro de configuração do navegador |
| Localização de quem hospeda | Serviço onion | A1, A4 | A3 (o provedor sabe onde a máquina está); pagamento identificável |
| Integridade das mensagens | AEAD do Olm | A2, A3 (não conseguem forjar) | A2/A3 **descartando ou atrasando** mensagens |

\* Desde que o cliente executado seja o legítimo (L1).

## 5. Limites conhecidos (dizer isto às pessoas)

- **L1 — O operador da instância entrega o código do cliente.** Na Fase 1 o cliente web é servido pelo próprio relay. Quem controla a instância pode servir JavaScript adulterado que lê as chaves. Isto vale para qualquer E2EE entregue por página web. Mitigações planejadas: build reproduzível com hash publicado; app local na Fase 2 (o cliente deixa de vir do servidor). Até lá: **use a instância de alguém em quem você confia, ou a sua.**
- **L2 — WASM exige o nível "Padrão" do Tor Browser.** O Tor Browser 15 bloqueia WebAssembly nos níveis "Safer" e "Safest" (via NoScript). O vodozemac é WASM. Logo o cliente só funciona no nível "Standard", que expõe mais superfície de ataque do navegador. Não verificado: se uma exceção de NoScript só para o `.onion` da instância funciona e é recomendável.
- **L3 — Metadados.** O relay vê: identificador público de cada caixa, horário de cada envio e busca, tamanho dos blobs (com preenchimento, aproximado), e qual caixa entrega para qual. Ou seja, o grafo social e o ritmo das conversas. Tor esconde o IP, não esses padrões.
- **L4 — Primeiro contato depende do canal do convite.** Se o canal externo (mensagem, papel, QR) estiver comprometido, a impressão digital pode ser trocada junto com o endereço.
- **L5 — Dispositivo comprometido.** Malware ou acesso físico com o cliente desbloqueado lê tudo. A senha local só protege em repouso.
- **L6 — Anonimato não é garantido.** Depende de como a pessoa hospeda e usa: VPS pago com cartão, conta de e-mail real, horários de uso e conteúdo das mensagens identificam pessoas. Hospedar em casa atrás do Tor é melhor, mas não é prova de anonimato.
- **L7 — Disponibilidade.** O operador pode descartar, atrasar ou recusar mensagens. O protocolo detecta adulteração, não censura.
- **L8 — Auditoria.** O protocolo (vodozemac) foi auditado em 2022; este projeto (cola WASM, relay, cliente) **não foi auditado**. Auditoria externa é pré-requisito do lançamento público (Fase 3).

## 6. Requisitos derivados da auditoria do sistema anterior

A Fase 0 (somente leitura, 2026-10-20) encontrou no sistema de origem problemas que este projeto deve evitar por construção:

| Achado no sistema anterior | Requisito na versão autohospedada |
|---|---|
| A senha que decifra a chave privada também é enviada ao servidor de autenticação | **R1.** O relay nunca recebe senha. Autenticação por assinatura de desafio com a chave de identidade. |
| A chave pública do contato vem só do servidor; TOFU aceita o primeiro valor sem conferência | **R2.** A chave só é aceita se bater com a impressão digital do convite. Divergência ou ausência **bloqueia** a conversa. |
| Regressão de RLS fez a busca de chaves voltar vazia e a verificação TOFU ser pulada em silêncio | **R3.** Falhas de verificação falham fechado: sem chave verificada, sem envio. |
| Papéis de banco da plataforma ignoram RLS e podem ler sessões e inserir convites | **R4.** O relay não guarda nada que dê poder sobre contas: sem senhas, sem tokens de sessão de longa duração, sem chaves privadas, nem cifradas. |
| Nome, tipo e tamanho de arquivo em texto claro | **R5.** Todo metadado de conteúdo vai dentro do texto cifrado; o relay vê só um blob com tamanho preenchido. |
| Mensagens sem AAD; servidor pode reordenar ou mover | **R6.** Usar o envelope do Olm sem reinventar; ordem e duplicação detectadas pelo ratchet. |
| Sem sigilo futuro | **R7.** Double Ratchet (vodozemac). |
| CSP só por `<meta>`, sem `frame-ancestors`, sem `X-Frame-Options` | **R8.** O relay envia CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Permissions-Policy`, COOP/CORP como cabeçalhos HTTP. |
| Token de sessão em `localStorage` | **R9.** Nenhum segredo em `localStorage`; credenciais de curta duração em memória. |
| Iterações de PBKDF2 vindas do servidor, sem piso | **R10.** Parâmetros de derivação de chave local fixados no cliente, nunca lidos do servidor. |

## 7. Requisitos operacionais

- Imagens: usuário sem root, sistema de arquivos somente leitura, sem segredos na imagem, versões fixadas por digest, assinadas (cosign), com SBOM e build reproduzível.
- Tor: C Tor a partir de `deb.torproject.org` com verificação de assinatura, versão fixada. Arti reavaliado na Fase 2 (as notas da 2.5.1 ainda marcam partes dos circuitos onion como experimentais).
- Chave do serviço onion: volume dedicado, permissão `0700`, dono = usuário do Tor. Perder a chave = perder o endereço (todos os convites quebram). Vazar a chave = outra pessoa pode se passar pela instância. Backup cifrado e fora da máquina.
- Logs do relay: sem IP (atrás do Tor, de todo modo é `127.0.0.1`), sem identificadores de caixa por padrão, retenção mínima.

## 8. Em aberto

- Formato exato do convite e do código de segurança mostrado às duas pessoas.
- Política de retenção de blobs não entregues.
- Como a pessoa recupera a identidade ao trocar de dispositivo sem confiar no relay.
- Exceção de NoScript por site (L2): funciona? Reduz o risco de forma relevante?
- As falhas públicas da libolm (AES com tabela vulnerável a cache-timing, base64 com vazamento de tempo, assinaturas Ed25519 maleáveis; CVE-2024-45192) são do código C da libolm, descontinuada em 2024; a recomendação da própria Matrix é migrar para o vodozemac. **Conferido no código do vodozemac 0.11.1 (2026-10-20):** em WASM o crate `aes` 0.9.3 usa o backend de software *fixsliced* (sem tabelas); chaves são decodificadas com `base64ct` (tempo constante); Ed25519 usa `verify_strict`. Resolvido para a versão fixada; reconferir a cada atualização.
