# Security — Privatum (self-hosted)

[Português](SECURITY.md) · **English**

## Current state

- The relay, the client and the Tor deployment were tested end to end and have known limits (see below and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), in Portuguese).
- No part of this project has had an external audit, and none is planned.
- There are no versions with guaranteed support; fixes, when there are any, ship only in the latest version.

## What the project aims to guarantee (and what it does not)

The full design, with adversaries and limits, is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Summary:

**Aims to protect:**
- Message content against the relay and the network, with end-to-end encryption (Olm/Double Ratchet via [vodozemac](https://github.com/matrix-org/vodozemac), audited in 2022).
- Past messages if the identity key leaks later (forward secrecy of the Double Ratchet).
- Key swapping by the server: a contact's key is only accepted if it matches the fingerprint received in the invite.
- The IP address of people who chat and the location of whoever hosts, through Tor.

**Does not protect:**
- Against whoever runs the instance serving a tampered client. The web client comes from the relay itself. Use your own instance or one run by someone you trust.
- Metadata: the relay sees who delivers to whom, when, and the approximate size.
- A compromised device (malware, physical access with the app open).
- Censorship: the operator can drop or delay messages.
- Anonymity is not promised. It depends on how you host and use it (see below).

This project does **not** claim to be "100% secure", to have "perfect secrecy" or to be "anonymous".

## Requirements for people who chat

- **Tor Browser at the "Standard" security level.** The client depends on JavaScript and WebAssembly. The "Safest" level turns JavaScript off, and the "Safer" and "Safest" levels block WebAssembly (Tor Browser 15). The "Standard" level exposes more of the browser's attack surface; understand this trade-off before using it.
- **Export the backup before closing Tor Browser.** It deletes site data when it closes; without the backup file, the identity and conversations are lost. The file is protected only by the local passphrase: use a long one.
- **Check the fingerprint.** The invite carries the `.onion` address and the inviter's key fingerprint. Receive it over a channel you trust and compare the safety code with the other person.
- **iPhone and iPad are not supported:** their browsers do not offer WebCrypto on `.onion` addresses.

## Requirements for whoever hosts

- **Anonymity depends on the hosting.** A VPS paid by card, or registered in your name, links the instance to you. Hosting at home, behind Tor, exposes less, but is no proof of anonymity.
- **Onion service key:** it lives in a dedicated volume, with `0700` permissions, owned by the Tor user. Keep an encrypted backup off the machine. Losing the key changes the address and invalidates every invite; leaking the key lets someone else impersonate your instance.
- Keep the images updated and check their signatures (cosign) before starting them.

## Reporting a vulnerability

Write to **contato@privatum.app** with "Security" in the subject (English or Portuguese): what you found, how to reproduce it and the affected version. A reply may take a few days: the project is maintained by one person.

Do not open a public issue with vulnerability details before a fix is published.
