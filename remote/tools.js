import { z } from 'zod';
import { plaidError } from './plaid.js';

const obj = (shape) => z.object(shape).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const itemId = z.string().min(1).max(200).describe('Item ID from plaid_list_items.');
const accountIds = z.array(z.string().min(1)).max(100).optional().describe('Optional account IDs to filter.');
// 500 is Plaid's own per-call maximum for transactions/get and transactions/sync.
const count = z.number().int().min(1).max(500).default(500);

/** Read-only tools. Access tokens never cross this boundary; tools address Items by item_id. */
export function plaidTools({ store, plaid }) {
  const client = () => {
    const c = plaid();
    if (!c) throw Object.assign(new Error('Plaid credentials are not installed on the server yet.'), { code: 'PLAID_NOT_CONFIGURED' });
    return c;
  };
  const token = (id) => store.accessToken(id);
  const targets = (id) => {
    const items = id ? [store.getItem(id)].filter(Boolean) : store.listItems();
    if (id && !items.length) throw Object.assign(new Error(`Unknown item_id ${id}. Use plaid_list_items.`), { code: 'UNKNOWN_ITEM' });
    return items;
  };
  const perItem = async (id, fn) => {
    const results = [];
    for (const item of targets(id)) {
      try { results.push({ itemId: item.itemId, institutionName: item.institutionName, ok: true, ...(await fn(item)) }); }
      catch (error) { results.push({ itemId: item.itemId, institutionName: item.institutionName, ok: false, error: plaidError(error) }); }
    }
    return { items: results };
  };

  return {
    plaid_list_items: {
      title: 'List linked banks',
      description: 'List the bank connections (Plaid Items) linked to this server, with institution, requested history length and link date. Start here to get item_id values.',
      schema: obj({}),
      run: async () => ({ items: store.listItems() }),
    },
    plaid_get_item: {
      title: 'Get bank connection status',
      description: 'Read Plaid status for one linked Item: products, consent expiry, errors needing re-authentication, and last successful transaction update.',
      schema: obj({ item_id: itemId }),
      run: async ({ item_id }) => {
        const data = (await client().itemGet({ access_token: token(item_id) })).data;
        return { item: data.item, status: data.status ?? null };
      },
    },
    plaid_get_accounts: {
      title: 'Get accounts',
      description: 'List accounts with Plaid\'s most recently cached balances, for one Item or (if item_id is omitted) every linked Item. Free; use plaid_get_balances only when a real-time balance matters.',
      schema: obj({ item_id: itemId.optional(), account_ids: accountIds }),
      run: async ({ item_id, account_ids }) => perItem(item_id, async (item) => {
        const data = (await client().accountsGet({ access_token: token(item.itemId), options: account_ids ? { account_ids } : undefined })).data;
        return { accounts: data.accounts };
      }),
    },
    plaid_get_balances: {
      title: 'Get real-time balances',
      description: 'Fetch real-time balances directly from the bank, for one Item or all linked Items. Each call may be billed by Plaid; prefer plaid_get_accounts for routine checks.',
      schema: obj({ item_id: itemId.optional(), account_ids: accountIds }),
      run: async ({ item_id, account_ids }) => perItem(item_id, async (item) => {
        const data = (await client().accountsBalanceGet({ access_token: token(item.itemId), options: account_ids ? { account_ids } : undefined })).data;
        return { accounts: data.accounts };
      }),
    },
    plaid_get_transactions: {
      title: 'Get transactions',
      description: 'Read posted and pending transactions for one Item in a date range, newest first. Page with offset until offset reaches total_transactions. Right after linking, Plaid may return PRODUCT_NOT_READY while it pulls history; retry later.',
      schema: obj({ item_id: itemId, start_date: date, end_date: date, account_ids: accountIds, count, offset: z.number().int().min(0).default(0), include_original_description: z.boolean().optional() }),
      run: async ({ item_id, start_date, end_date, account_ids, count, offset, include_original_description }) => {
        const data = (await client().transactionsGet({ access_token: token(item_id), start_date, end_date, options: { account_ids, count, offset, include_original_description } })).data;
        return { total_transactions: data.total_transactions, returned: data.transactions.length, offset, next_offset: offset + data.transactions.length < data.total_transactions ? offset + data.transactions.length : null, accounts: data.accounts, transactions: data.transactions };
      },
    },
    plaid_sync_transactions: {
      title: 'Sync transaction changes',
      description: 'Read added, modified and removed transactions since a cursor for one Item. Omit cursor to start from the beginning of available history; continue with next_cursor while has_more is true.',
      schema: obj({ item_id: itemId, cursor: z.string().min(1).optional(), count, include_original_description: z.boolean().optional() }),
      run: async ({ item_id, cursor, count, include_original_description }) => (await client().transactionsSync({ access_token: token(item_id), cursor, count, options: { include_original_description } })).data,
    },
    plaid_get_institution: {
      title: 'Get institution',
      description: 'Read public metadata for a financial institution by Plaid institution_id.',
      schema: obj({ institution_id: z.string().min(1).max(100) }),
      run: async ({ institution_id }) => ({ institution: (await client().institutionsGetById({ institution_id, country_codes: ['US'], options: { include_optional_metadata: true } })).data.institution }),
    },
  };
}
