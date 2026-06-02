#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  type CountryCode,
  type Products
} from "plaid";

type PlaidEnvironmentName = "sandbox" | "development" | "production";

const server = new McpServer({
  name: "plaid-readonly-mcp",
  version: "0.1.0"
});

const plaidEnvironments: Record<PlaidEnvironmentName, string> = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const accessTokenSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Optional Plaid access token. Defaults to PLAID_ACCESS_TOKEN.");
const accountIdsSchema = z
  .array(z.string().min(1))
  .optional()
  .describe("Optional account IDs to filter the Plaid response.");
const countSchema = z.number().int().min(1).max(500).default(100);
const offsetSchema = z.number().int().min(0).default(0);
const countryCodesSchema = z
  .array(z.string().min(2).max(2))
  .default(["US"])
  .describe("Plaid country codes, such as US or CA.");
const productsSchema = z
  .array(z.string().min(1))
  .optional()
  .describe("Optional Plaid products filter, such as transactions or auth.");
const includeOriginalDescriptionSchema = z
  .boolean()
  .optional()
  .describe("Include the raw unparsed transaction description from the financial institution.");

let plaidClient: PlaidApi | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function plaidEnvironment(): string {
  const env = (process.env.PLAID_ENV ?? "sandbox").toLowerCase();
  if (env !== "sandbox" && env !== "development" && env !== "production") {
    throw new Error("PLAID_ENV must be sandbox, development, or production.");
  }

  return plaidEnvironments[env];
}

function getPlaidClient(): PlaidApi {
  if (!plaidClient) {
    const configuration = new Configuration({
      basePath: plaidEnvironment(),
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": requiredEnv("PLAID_CLIENT_ID"),
          "PLAID-SECRET": requiredEnv("PLAID_SECRET"),
          "Plaid-Version": process.env.PLAID_VERSION ?? "2020-09-14"
        }
      }
    });
    plaidClient = new PlaidApi(configuration);
  }

  return plaidClient;
}

function getAccessToken(accessToken?: string): string {
  return accessToken ?? requiredEnv("PLAID_ACCESS_TOKEN");
}

function countryCodes(codes: string[]): CountryCode[] {
  return codes.map((code) => code.toUpperCase() as CountryCode);
}

function products(values?: string[]): Products[] | undefined {
  return values?.map((product) => product as Products);
}

function dataResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  } satisfies CallToolResult;
}

function errorResult(error: unknown) {
  const candidate = error as {
    response?: {
      status?: number;
      data?: unknown;
    };
    message?: string;
  };

  const payload = candidate.response?.data ?? {
    message: candidate.message ?? "Unknown Plaid MCP server error"
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: candidate.response?.status,
            error: payload
          },
          null,
          2
        )
      }
    ],
    isError: true
  } satisfies CallToolResult;
}

function registerReadTool(
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
  },
  handler: (args: Record<string, any>) => Promise<unknown>
) {
  server.registerTool(name, config, async (args) => {
    try {
      return dataResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  });
}

registerReadTool(
  "plaid_get_item",
  {
    title: "Get Plaid Item",
    description: "Read metadata for the Plaid Item associated with an access token.",
    inputSchema: {
      access_token: accessTokenSchema
    }
  },
  async ({ access_token }) => {
    const response = await getPlaidClient().itemGet({
      access_token: getAccessToken(access_token)
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_accounts",
  {
    title: "Get Plaid Accounts",
    description: "Read account metadata for a Plaid Item.",
    inputSchema: {
      access_token: accessTokenSchema,
      account_ids: accountIdsSchema
    }
  },
  async ({ access_token, account_ids }) => {
    const response = await getPlaidClient().accountsGet({
      access_token: getAccessToken(access_token),
      options: account_ids ? { account_ids } : undefined
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_balances",
  {
    title: "Get Plaid Balances",
    description: "Read current balance data for accounts on a Plaid Item.",
    inputSchema: {
      access_token: accessTokenSchema,
      account_ids: accountIdsSchema
    }
  },
  async ({ access_token, account_ids }) => {
    const response = await getPlaidClient().accountsBalanceGet({
      access_token: getAccessToken(access_token),
      options: account_ids ? { account_ids } : undefined
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_transactions",
  {
    title: "Get Plaid Transactions",
    description: "Read historical transactions for a Plaid Item in a date range.",
    inputSchema: {
      access_token: accessTokenSchema,
      start_date: dateSchema,
      end_date: dateSchema,
      account_ids: accountIdsSchema,
      count: countSchema,
      offset: offsetSchema,
      include_original_description: includeOriginalDescriptionSchema
    }
  },
  async ({
    access_token,
    start_date,
    end_date,
    account_ids,
    count,
    offset,
    include_original_description
  }) => {
    const response = await getPlaidClient().transactionsGet({
      access_token: getAccessToken(access_token),
      start_date,
      end_date,
      options: {
        account_ids,
        count,
        offset,
        include_original_description
      }
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_sync_transactions",
  {
    title: "Sync Plaid Transactions",
    description: "Read transaction changes from Plaid's sync cursor endpoint.",
    inputSchema: {
      access_token: accessTokenSchema,
      cursor: z.string().min(1).optional(),
      count: countSchema,
      include_original_description: includeOriginalDescriptionSchema
    }
  },
  async ({ access_token, cursor, count, include_original_description }) => {
    const response = await getPlaidClient().transactionsSync({
      access_token: getAccessToken(access_token),
      cursor,
      count,
      options: {
        include_original_description
      }
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_identity",
  {
    title: "Get Plaid Identity",
    description: "Read account holder identity data for a Plaid Item.",
    inputSchema: {
      access_token: accessTokenSchema,
      account_ids: accountIdsSchema
    }
  },
  async ({ access_token, account_ids }) => {
    const response = await getPlaidClient().identityGet({
      access_token: getAccessToken(access_token),
      options: account_ids ? { account_ids } : undefined
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_auth",
  {
    title: "Get Plaid Auth",
    description: "Read ACH/EFT account and routing data for a Plaid Item.",
    inputSchema: {
      access_token: accessTokenSchema,
      account_ids: accountIdsSchema
    }
  },
  async ({ access_token, account_ids }) => {
    const response = await getPlaidClient().authGet({
      access_token: getAccessToken(access_token),
      options: account_ids ? { account_ids } : undefined
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_liabilities",
  {
    title: "Get Plaid Liabilities",
    description: "Read liability data for credit, mortgage, and student loan accounts.",
    inputSchema: {
      access_token: accessTokenSchema,
      account_ids: accountIdsSchema
    }
  },
  async ({ access_token, account_ids }) => {
    const response = await getPlaidClient().liabilitiesGet({
      access_token: getAccessToken(access_token),
      options: account_ids ? { account_ids } : undefined
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_investment_holdings",
  {
    title: "Get Plaid Investment Holdings",
    description: "Read investment holdings and security metadata for a Plaid Item.",
    inputSchema: {
      access_token: accessTokenSchema,
      account_ids: accountIdsSchema
    }
  },
  async ({ access_token, account_ids }) => {
    const response = await getPlaidClient().investmentsHoldingsGet({
      access_token: getAccessToken(access_token),
      options: account_ids ? { account_ids } : undefined
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_investment_transactions",
  {
    title: "Get Plaid Investment Transactions",
    description: "Read investment transactions for a Plaid Item in a date range.",
    inputSchema: {
      access_token: accessTokenSchema,
      start_date: dateSchema,
      end_date: dateSchema,
      account_ids: accountIdsSchema,
      count: countSchema,
      offset: offsetSchema
    }
  },
  async ({ access_token, start_date, end_date, account_ids, count, offset }) => {
    const response = await getPlaidClient().investmentsTransactionsGet({
      access_token: getAccessToken(access_token),
      start_date,
      end_date,
      options: {
        account_ids,
        count,
        offset
      }
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_get_institution",
  {
    title: "Get Plaid Institution",
    description: "Read public institution metadata by institution ID.",
    inputSchema: {
      institution_id: z.string().min(1),
      country_codes: countryCodesSchema,
      include_optional_metadata: z.boolean().default(false),
      include_status: z.boolean().default(false),
      include_auth_metadata: z.boolean().default(false),
      include_payment_initiation_metadata: z.boolean().default(false)
    }
  },
  async ({
    institution_id,
    country_codes,
    include_optional_metadata,
    include_status,
    include_auth_metadata,
    include_payment_initiation_metadata
  }) => {
    const response = await getPlaidClient().institutionsGetById({
      institution_id,
      country_codes: countryCodes(country_codes),
      options: {
        include_optional_metadata,
        include_status,
        include_auth_metadata,
        include_payment_initiation_metadata
      }
    });
    return response.data;
  }
);

registerReadTool(
  "plaid_list_institutions",
  {
    title: "List Plaid Institutions",
    description: "Read a page of public institution metadata.",
    inputSchema: {
      count: countSchema,
      offset: offsetSchema,
      country_codes: countryCodesSchema,
      products: productsSchema
    }
  },
  async ({ count, offset, country_codes, products: requestedProducts }) => {
    const response = await getPlaidClient().institutionsGet({
      count,
      offset,
      country_codes: countryCodes(country_codes),
      options: {
        products: products(requestedProducts)
      }
    });
    return response.data;
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
