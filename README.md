# Plaid Read-Only MCP Server

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
    "plaid": {
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
- `plaid_get_liabilities`
- `plaid_get_investment_holdings`
- `plaid_get_investment_transactions`
- `plaid_get_institution`
- `plaid_list_institutions`

All Plaid responses are returned as formatted JSON text.

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
PLAID_OPTIONAL_PRODUCTS=identity,liabilities,investments
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
