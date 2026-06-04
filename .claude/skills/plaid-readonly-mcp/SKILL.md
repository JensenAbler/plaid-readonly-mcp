---
name: plaid-readonly-mcp
description: Use when Claude needs to answer questions with an already-installed read-only Plaid MCP server configured as `plaid`, including Plaid Item metadata, accounts, balances, transactions, transaction sync, identity, auth, or institution metadata. Assumes credentials and bank connection already exist; do not use this skill for installing the codebase, configuring Plaid Link, exchanging tokens, or onboarding a new bank connection.
---

# Plaid Read-Only MCP

## Core Rule

Use the configured Plaid MCP tools directly. Do not install, configure, expose, or run the Plaid Link helper as part of this skill. The MCP server is read-only; token exchange and `.env` writes are outside this skill.

When the MCP server is configured as `plaid`, Claude Code exposes these tools with the `mcp__plaid__` prefix. If the server was configured under a different MCP name, use the same tool names with that server prefix.

## Privacy Defaults

- Default to sanitized summaries: counts, date ranges, categories, product status, and error codes.
- Do not print balances, account names/masks, owner identity data, routing/account numbers, transaction names, transaction amounts, or raw tokens unless the user explicitly asks for those details.
- Never print `access_token`, `PLAID_SECRET`, or other credentials.
- If the user grants permission to show detailed financial data, include only the fields needed to answer the question.

## Tool Selection

- `mcp__plaid__plaid_get_item`: Check the linked Item, institution ID, initialized products, available products, and consented products.
- `mcp__plaid__plaid_get_accounts`: List account metadata. Use this before account-specific queries so you can map user language to `account_id`.
- `mcp__plaid__plaid_get_balances`: Read balances. Treat this as sensitive; summarize unless detailed values are requested.
- `mcp__plaid__plaid_get_transactions`: Query historical transactions for a date range. Use `account_ids` when the user asks about specific accounts.
- `mcp__plaid__plaid_sync_transactions`: Prefer this for complete transaction history or incremental sync. Use `cursor` for follow-up pages and repeat while `has_more` is true.
- `mcp__plaid__plaid_get_identity`: Read owner identity data. Treat as highly sensitive.
- `mcp__plaid__plaid_get_auth`: Read auth/routing-style data. Treat as highly sensitive.
- `mcp__plaid__plaid_get_institution`: Get metadata for a known institution ID.
- `mcp__plaid__plaid_list_institutions`: Search/list institution metadata, optionally filtered by product.

## Transaction Workflow

1. Use `mcp__plaid__plaid_get_accounts` when account context matters.
2. Use `mcp__plaid__plaid_sync_transactions` with `count: 500` for broad history; page with `cursor` until `has_more` is false.
3. Use `mcp__plaid__plaid_get_transactions` for bounded date-range questions.
4. Set `include_original_description: true` when the user asks about raw bank descriptions, memos, comments, Zelle-like notes, or differences between Plaid-normalized and institution-provided text.
5. Interpret Plaid transaction `amount` as positive for money out and negative for money in.
6. Use `transaction_id` as the stable identifier for a transaction.

Relevant transaction fields:

- `name`: Plaid-normalized transaction description.
- `original_description`: Raw institution description when requested.
- `merchant_name`: Plaid merchant extraction, often null for transfers.
- `payment_meta`: Payment details such as `payee`, `payer`, `reason`, `reference_number`, and processor fields; often null.
- `personal_finance_category`: Plaid's primary/detailed category and confidence.
- `counterparties`: Plaid-enriched counterparties when available.
- `pending` and `pending_transaction_id`: Pending/final transaction linkage.

## Error Handling

- `PLAID_ACCESS_TOKEN is required`: The MCP server is available but no Item token is configured. Tell the user that onboarding/token setup is required outside this skill.
- `ADDITIONAL_CONSENT_REQUIRED`: The tool is working, but the Item lacks consent for that Plaid product. Explain which product is missing and suggest update/onboarding outside this skill only if the user asks.
- `PRODUCT_NOT_READY` or similar product-readiness errors: Tell the user Plaid may still be processing the product and suggest retrying later.
- Empty arrays are not necessarily errors. For example, some accounts may have no regular Transactions rows in the requested date range.

## Response Style

Report what was queried, the relevant time window, and whether results came from `transactions/get` or `transactions/sync`. For sensitive outputs, prefer concise summaries first, then quote examples only when the user has allowed specific data to appear.
