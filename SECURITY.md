# Segurança — Privatum autohospedado

## Estado atual

**Pré-alfa. Não use para nada sensível.**

- O relay, o cliente e a implantação com Tor existem e foram testados ponta a ponta, mas o projeto ainda é jovem e tem limites conhecidos (veja abaixo).
- Nenhuma parte deste projeto passou por auditoria externa. A auditoria é pré-requisito do lançamento público.
- Não há versões suportadas.

## O que o projeto pretende garantir (e o que não)

O desenho completo, com adversários e limites, está em [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Resumo:

**Pretende proteger:**
- Conteúdo das mensagens contra o relay e contra a rede, com criptografia de ponta a ponta (Olm/Double Ratchet via [vodozemac](https://github.com/matrix-org/vodozemac), auditado em 2022).
- Mensagens antigas se a chave de identidade vazar depois (sigilo futuro do Double Ratchet).
- Troca de chave pelo servidor: a chave do contato só é aceita se bater com a impressão digital recebida no convite.
- O IP de quem usa e a localização de quem hospeda, via Tor.

**Não protege:**
- Contra quem opera a instância servir um cliente adulterado. Na Fase 1 o cliente web vem do próprio relay. Use uma instância sua ou de quem você confia.
- Metadados: o relay vê quem entrega para quem, quando e o tamanho aproximado.
- Dispositivo comprometido (malware, acesso físico com o app aberto).
- Censura: o operador pode descartar ou atrasar mensagens.
- Anonimato não é prometido. Ele depende de como você hospeda e usa (veja abaixo).

Este projeto **não** afirma ser "100% seguro", ter "sigilo perfeito" ou ser "anônimo".

## Requisitos para quem usa

- **Tor Browser no nível de segurança "Padrão" (Standard).** O cliente depende de JavaScript e WebAssembly. O nível "Safest" desliga JavaScript, e os níveis "Safer" e "Safest" bloqueiam WebAssembly (Tor Browser 15). O nível "Padrão" expõe mais superfície de ataque do navegador; entenda essa troca antes de usar.
- **Confira a impressão digital.** O convite traz o endereço `.onion` e a impressão digital da chave de quem convida. Receba-o por um canal em que você confia e compare o código de segurança com a outra pessoa.

## Requisitos para quem hospeda

- **Anonimato depende da hospedagem.** Um VPS pago com cartão, ou com cadastro em seu nome, liga a instância a você. Hospedar em casa, atrás do Tor, expõe menos, mas não é prova de anonimato.
- **Chave do serviço onion:** fica num volume dedicado, com permissão `0700` e dono = usuário do Tor. Faça backup cifrado fora da máquina. Perder a chave muda o endereço e invalida todos os convites; vazar a chave permite que outra pessoa se passe pela sua instância.
- Mantenha as imagens atualizadas e confira as assinaturas (cosign) antes de subir.

## Como relatar uma vulnerabilidade

Canal de contato: **a definir** antes da abertura do repositório.

Até lá, não abra issue pública com detalhes de vulnerabilidade.
