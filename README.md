# sellat-mcp

[![tests](https://github.com/skanthemore/sellat-mcp/actions/workflows/tests.yml/badge.svg)](https://github.com/skanthemore/sellat-mcp/actions/workflows/tests.yml)

The official [MCP](https://modelcontextprotocol.io) server for [SELLAT](https://sellat.app):
ask Claude, Cursor or any MCP client to protect a file, follow its proof,
add the qualified eIDAS seal or verify a proof, all from the chat.

> "Protect ~/Contracts/draft-v3.pdf with Sellat."
> "Has the proof of my last photo reached Bitcoin yet?"
> "Check this file against the evidence package in my Downloads."

**Your files never leave your machine.** The server runs locally, hashes the
file on your computer and sends SELLAT only its SHA-256 (plus the name and
size shown on the certificate). It is a thin layer over the
[`sellat-cli`](https://github.com/skanthemore/sellat-cli) client and the
[`sellat-verify`](https://github.com/skanthemore/sellat-verify) offline verifier.

## Setup

1. Create a free account at [sellat.app](https://sellat.app) and an API key
   in your dashboard ([API keys](https://sellat.app/dashboard#api-keys)).
   Hashing and verifying work without a key.
2. Add the server to your client.

**Claude Code**

```bash
claude mcp add sellat -e SELLAT_API_TOKEN=sellat_… -- npx -y sellat-mcp
```

**Gemini CLI**

```bash
gemini mcp add -e SELLAT_API_TOKEN=sellat_… sellat npx -y sellat-mcp
```

**Claude Desktop, Cursor and other clients** (`claude_desktop_config.json`,
`.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "sellat": {
      "command": "npx",
      "args": ["-y", "sellat-mcp"],
      "env": { "SELLAT_API_TOKEN": "sellat_…" }
    }
  }
}
```

Requires Node.js 18 or later.

| Variable | Default | |
| --- | --- | --- |
| `SELLAT_API_TOKEN` | — | your API key (`SELLAT_API_KEY` is accepted too) |
| `SELLAT_DOWNLOAD_DIR` | `~/Downloads`, else home | where certificates and packages are saved |
| `SELLAT_API_URL` | `https://sellat.app` | another SELLAT environment |

## Tools

| Tool | What it does | Key | Network |
| --- | --- | --- | --- |
| `sellat_hash` | SHA-256 of a local file | no | none |
| `sellat_stamp` | protect a file: hash locally, create the proof; `qualified: true` adds the FNMT seal | yes | SELLAT (hash only) |
| `sellat_status` | state of a proof: Polygon anchor, Bitcoin, seal, URLs | yes | SELLAT |
| `sellat_list` | the account's proofs, newest first | yes | SELLAT |
| `sellat_seal` | the FNMT-RCM qualified timestamp (eIDAS, RFC 3161) for an existing proof; spends one seal | yes | SELLAT |
| `sellat_account` | plan, seals left, today's proof budget | yes | SELLAT |
| `sellat_download` | save the PDF certificate, the evidence package (ZIP) or the seal's `.tsr`; never overwrites | yes | SELLAT |
| `sellat_verify` | check a file against a `proof.json`, an evidence `.zip` or a proof id: Merkle path recomputed locally, anchor checked on a public Polygon node | no | public RPC (and SELLAT only to fetch a proof by id) |

Stamping the same file twice returns the first proof (the earlier date is the
stronger one), and a retried call never creates a second proof.

## Timing

A proof is anchored on Polygon in a Merkle batch: within minutes on the Pro
account, at the end of a fixed four-hour UTC slot on the free account
(00, 04, 08, 12, 16 and 20 h). Bitcoin, through OpenTimestamps, confirms some
hours later. The qualified seal is issued at once. The server tells the model
this, so it does not promise a blockchain transaction in seconds.

## Payments

Nothing is ever paid through the MCP server. Protecting files is free within
the account's daily budget. The qualified seal spends a seal from the account
(new accounts get a welcome seal); with none left the tool answers with the
link to buy a pack on the website, where the invoice, VAT and withdrawal terms
live. The model is told to give you that link and to request a seal only when
you asked for one.

## What a proof proves

That these exact bytes existed no later than the anchored time, verifiable by
anyone without trusting SELLAT. On its own it does not prove authorship or
ownership. `sellat_verify` checks the file, the Merkle path and the Polygon
anchor; it does not check the qualified seal's `.tsr` (any RFC 3161 tool
does, e.g. `openssl ts -verify`).

## Develop

```bash
npm install
node --test
```

MIT licence.
