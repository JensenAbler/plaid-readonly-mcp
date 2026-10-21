import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../remote/server.js';
import { createStore } from '../remote/store.js';
import { daysRequested } from '../remote/plaid.js';

const PASSWORD = 'correct horse battery staple';
function credentials() {
  const salt = randomBytes(16);
  const hash = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' };
  return { passwordHash: `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`, jwks: { keys: [jwk] }, cookieKeys: [randomBytes(32).toString('base64url')] };
}

function fakePlaid(calls) {
  return {
    linkTokenCreate: async (req) => { calls.push(['linkTokenCreate', req]); return { data: { link_token: 'link-x', expiration: 'later' } }; },
    itemPublicTokenExchange: async () => ({ data: { access_token: 'access-secret-1', item_id: 'item-1' } }),
    itemGet: async () => ({ data: { item: { institution_id: 'ins_1' } } }),
    institutionsGetById: async () => ({ data: { institution: { name: 'Test Bank' } } }),
    accountsGet: async (req) => { calls.push(['accountsGet', req]); return { data: { accounts: [{ account_id: 'a1' }] } }; },
    transactionsGet: async (req) => { calls.push(['transactionsGet', req]); return { data: { total_transactions: 3, transactions: [{}, {}], accounts: [] } }; },
  };
}

async function start(calls) {
  const dir = mkdtempSync(join(tmpdir(), 'plaidmcp-'));
  const plaid = fakePlaid(calls);
  const service = await createApp({ baseUrl: 'http://127.0.0.1:47805/plaid', dataDirectory: dir, allowLoopback: true, tokenKey: randomBytes(32), auth: credentials(), plaid: () => plaid, env: {} });
  const http = await new Promise((resolve) => { const s = service.app.listen(47805, '127.0.0.1', () => resolve(s)); });
  return { service, close: async () => { http.close(); await service.close(); } };
}

test('730 days is the default and the ceiling', () => {
  assert.equal(daysRequested({}), 730);
  assert.equal(daysRequested({ PLAID_TRANSACTIONS_DAYS_REQUESTED: '365' }), 365);
  assert.throws(() => daysRequested({ PLAID_TRANSACTIONS_DAYS_REQUESTED: '731' }));
});

test('store seals access tokens at rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plaidstore-'));
  const store = createStore({ dataDirectory: dir, tokenKey: randomBytes(32) });
  store.upsertItem({ itemId: 'i', accessToken: 'access-plain', institutionName: 'Bank', daysRequested: 730 });
  assert.equal(store.accessToken('i'), 'access-plain');
  assert.equal(JSON.stringify(store.listItems()).includes('access-plain'), false);
  store.close();
});

test('MCP requires a bearer token; link API requires sign-in and same origin', async () => {
  const calls = [];
  const { service, close } = await start(calls);
  try {
    const base = 'http://127.0.0.1:47805/plaid';
    const mcp = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get('www-authenticate') ?? '', /resource_metadata/);
    const meta = await (await fetch('http://127.0.0.1:47805/.well-known/oauth-protected-resource/plaid/mcp')).json();
    assert.equal(meta.resource, base + '/mcp');
    const asMeta = await fetch('http://127.0.0.1:47805/.well-known/oauth-authorization-server/plaid/oauth');
    assert.equal(asMeta.status, 200);

    const page = await (await fetch(base + '/link/')).text();
    assert.match(page, /Owner password/);
    const noSession = await fetch(base + '/link/api/link-token', { method: 'POST', headers: { origin: 'http://127.0.0.1:47805', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noSession.status, 401);
    const bad = await fetch(base + '/link/login', { method: 'POST', redirect: 'manual', headers: { origin: 'http://127.0.0.1:47805', 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nope' });
    assert.equal(bad.status, 401);
    const good = await fetch(base + '/link/login', { method: 'POST', redirect: 'manual', headers: { origin: 'http://127.0.0.1:47805', 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASSWORD) });
    assert.equal(good.status, 303);
    const cookie = good.headers.get('set-cookie').split(';')[0];
    const crossOrigin = await fetch(base + '/link/api/link-token', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const token = await (await fetch(base + '/link/api/link-token', { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:47805', 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(token.linkToken, 'link-x');
    const req = calls.find(([n]) => n === 'linkTokenCreate')[1];
    assert.deepEqual(req.transactions, { days_requested: 730 });
    assert.deepEqual(req.products, ['transactions']);
    const exchanged = await (await fetch(base + '/link/api/exchange', { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:47805', 'content-type': 'application/json' }, body: JSON.stringify({ public_token: 'public-x' }) })).json();
    assert.equal(exchanged.institutionName, 'Test Bank');

    const listed = await service.tools.plaid_list_items.run({});
    assert.equal(listed.items[0].itemId, 'item-1');
    assert.equal(JSON.stringify(listed).includes('access-secret'), false);
    const accounts = await service.tools.plaid_get_accounts.run({});
    assert.equal(accounts.items[0].accounts[0].account_id, 'a1');
    const tx = await service.tools.plaid_get_transactions.run(service.tools.plaid_get_transactions.schema.parse({ item_id: 'item-1', start_date: '2024-10-21', end_date: '2026-10-21' }));
    assert.equal(tx.next_offset, 2);
    assert.equal(calls.find(([n]) => n === 'transactionsGet')[1].options.count, 500);
  } finally { await close(); }
});
