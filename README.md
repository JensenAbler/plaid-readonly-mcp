# Plaid Read-Only MCP Server

Two ways to run it:

- **Remote (`remote/`)** — an OAuth-protected Streamable HTTP MCP server for Claude/ChatGPT connectors,
  holding any number of bank connections (Items). Deployed at `https://mcp.jensenabler.com/plaid/mcp`.
- **Local stdio (`src/`)** — the original single-token server, described further below.

## History length

Plaid defaults new Items to 90 days of transactions. Both Link flows here request
`transactions.days_requested = 730`, Plaid's maximum (override with
`PLAID_TRANSACTIONS_DAYS_REQUESTED`). The value is fixed when an Item is created: an Item linked
with less history must be removed and re-linked. Institutions may still return less than two years.

## Remote server

- `GET /plaid/link` — owner-only page (password sign-in) to link banks with Plaid Link and remove them.
  Register `https://mcp.jensenabler.com/plaid/link/oauth-return` as an allowed redirect URI in the
  Plaid Dashboard for OAuth institutions.
- `/plaid/mcp` — read-only tools: `plaid_list_items`, `plaid_get_item`, `plaid_get_accounts`,
  `plaid_get_balances`, `plaid_get_transactions`, `plaid_sync_transactions`, `plaid_get_institution`.
  Tools address Items by `item_id`; access tokens never leave the server and are AES-256-GCM sealed at rest.
- Secrets: Plaid keys in `/etc/plaid-mcp/plaid.env` (`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`);
  OAuth/encryption keys loaded as systemd credentials. See `deploy/`.
- `npm test` runs the remote server tests against a fake Plaid client.

## Local stdio server

This is a local stdio MCP server that exposes read-only Plaid data retrieval tools.
It does not expose Link token creation, token exchange, sandbox mutation, transfer,
payment, processor, or item mutation endpoints.

## Setup

```powershell
npm install
npm run build
```

Create a `.env` file from `env.example`, or provide these variables through your
MCP client:

```text
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox
PLAID_ACCESS_TOKEN=...
PLAID_VERSION=2020-09-14
```

`PLAID_ACCESS_TOKEN` is optional at process startup because each tool also accepts
an `access_token` argument. If neither is supplied, access-token tools return a
clear configuration error.

## MCP Client Configuration

Use the built server with a stdio MCP client:

```json
{
  "mcpServers": {
    "plaid-readonly-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\plaid-readonly-mcp\\dist\\index.js"],
      "env": {
        "PLAID_CLIENT_ID": "your-client-id",
        "PLAID_SECRET": "your-secret",
        "PLAID_ENV": "sandbox",
        "PLAID_ACCESS_TOKEN": "optional-default-access-token"
      }
    }
  }
}
```

## Tools

- `plaid_get_item`
- `plaid_get_accounts`
- `plaid_get_balances`
- `plaid_get_transactions`
- `plaid_sync_transactions`
- `plaid_get_identity`
- `plaid_get_auth`
- `plaid_get_institution`
- `plaid_list_institutions`

All Plaid responses are returned as formatted JSON text.

## Claude Skill

A Claude Code project skill is included at:

```text
.claude/skills/plaid-readonly-mcp/SKILL.md
```

The skill assumes the MCP server is already installed and available to Claude as
`plaid-readonly-mcp`. It contains usage and privacy guidance only; it does not
install the server, run Plaid Link, exchange tokens, or onboard a bank
connection.

## Connect A Bank With Plaid Link

The MCP server itself is read-only. The Plaid Link helper is not part of the MCP
server; it performs Plaid token exchange during setup and writes
`PLAID_ACCESS_TOKEN` to `.env`. Do not expose the helper publicly except
temporarily during onboarding.

To connect a bank and obtain the `PLAID_ACCESS_TOKEN` the MCP server will read
from, run the separate local Link helper:

```powershell
npm run link
```

Open the printed URL, click **Connect bank**, complete Plaid Link, and the
helper will exchange the temporary `public_token` and save the resulting
`PLAID_ACCESS_TOKEN` into `.env`.

By default, the helper requests only the `transactions` product:

```text
PLAID_PRODUCTS=transactions
```

You can override products with comma-separated env vars:

```text
PLAID_PRODUCTS=transactions
PLAID_OPTIONAL_PRODUCTS=identity
PLAID_COUNTRY_CODES=US
```

For production OAuth institutions, Plaid requires an HTTPS redirect URI that has
been added to your Plaid Dashboard. If you use a tunnel, open the helper through
the tunnel URL and set the matching callback:

```text
PLAID_REDIRECT_URI=https://your-tunnel-or-domain.example/oauth-return
```

To configure the redirect URI in Plaid, go here:

[Plaid Dashboard -> Developers -> API](https://dashboard.plaid.com/developers/api)

Then look for:

```text
Allowed redirect URIs
```

Click **Configure**, add the exact URI from `PLAID_REDIRECT_URI`, then save:

```text
https://your-tunnel-or-domain.example/oauth-return
```

Path in the dashboard:

```text
Team settings -> API -> Allowed redirect URIs -> Configure
```

Plaid docs confirm this location and requirement: [OAuth troubleshooting](https://plaid.com/docs/link/troubleshooting/) and [OAuth guide](https://plaid.com/docs/link/oauth/).

The helper uses a two-tab OAuth flow: the setup tab stays open, Plaid Link opens
in a separate tab, and the `/oauth-return` callback notifies the setup tab to
resume Link with Plaid's `receivedRedirectUri`.
