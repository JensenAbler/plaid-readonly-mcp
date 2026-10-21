import express from 'express';
import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { requireBearerAuth, hostHeaderValidation, originValidation } from '@modelcontextprotocol/express';
import { createAuth } from './auth.js';
import { createStore } from './store.js';
import { createLinkRouter } from './link.js';
import { createPlaidClient, plaidError } from './plaid.js';
import { plaidTools } from './tools.js';
import { OWNER, SCOPE } from './token-verifier.js';

const VERSION = '0.2.0';

export async function createApp(config) {
  const base = new URL(config.baseUrl), prefix = base.pathname.replace(/\/$/, '');
  const resourceUrl = base.origin + prefix + '/mcp', issuer = base.origin + prefix + '/oauth';
  const resourceMetadata = base.origin + '/.well-known/oauth-protected-resource' + prefix + '/mcp';
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const auth = await createAuth({ ...config.auth, issuer, resourceUrl, dataDirectory: join(config.dataDirectory, 'oauth'), allowLoopback: config.allowLoopback ?? false });
  const store = createStore({ dataDirectory: join(config.dataDirectory, 'items'), tokenKey: config.tokenKey });
  const env = config.env ?? process.env;
  let plaidClient;
  const plaid = config.plaid ?? (() => (plaidClient ??= createPlaidClient(env)));
  const tools = plaidTools({ store, plaid });

  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 'loopback');
  const hosts = [base.hostname, ...(config.allowLoopback ? ['localhost', '127.0.0.1'] : [])];
  app.use(hostHeaderValidation(hosts));
  app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
  app.get(prefix + '/healthz', (_req, res) => res.json({ ok: true, name: 'Plaid MCP', version: VERSION, release: config.release || 'development', plaidConfigured: Boolean(plaid()), linkedItems: store.listItems().length }));
  app.get(prefix + '/', (_req, res) => res.type('text').send(`Plaid MCP (read-only). Connect using ${resourceUrl}. Link banks at ${base.origin}${prefix}/link`));
  app.get('/.well-known/oauth-protected-resource' + prefix + '/mcp', (_req, res) => res.json({ resource: resourceUrl, authorization_servers: [issuer], scopes_supported: [SCOPE, 'offline_access'], resource_name: 'Plaid MCP', bearer_methods_supported: ['header'] }));
  app.get(['/.well-known/oauth-authorization-server' + prefix + '/oauth', '/.well-known/openid-configuration' + prefix + '/oauth'], (req, res) => {
    req.url = '/.well-known/openid-configuration'; req.baseUrl = prefix + '/oauth'; req.originalUrl = prefix + '/oauth/.well-known/openid-configuration';
    return auth.provider.callback()(req, res);
  });
  app.use(prefix + '/oauth', auth.router);
  app.use(prefix + '/link', createLinkRouter({ baseUrl: config.baseUrl, prefix, cookieKey: config.auth.cookieKeys[0], checkPassword: auth.checkPassword, store, plaid, env }));

  const handler = createMcpHandler((ctx) => {
    if (ctx.authInfo?.extra?.subject !== OWNER || !ctx.authInfo.scopes.includes(SCOPE)) throw Error('Owner authorization required');
    const server = new McpServer({ name: 'Plaid MCP', version: VERSION }, { instructions: 'Read-only access to Jensen\'s linked bank accounts via Plaid. Start with plaid_list_items to get item_id values. Transaction history depth depends on what each bank provides (up to 730 days). This server cannot move money or change connections; banks are linked and removed only on the owner\'s /plaid/link page.' });
    for (const [name, tool] of Object.entries(tools)) {
      server.registerTool(name, {
        title: tool.title, description: tool.description, inputSchema: tool.schema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: [SCOPE] }] },
      }, async (args) => {
        const requestId = randomUUID();
        let data;
        try { data = { ok: true, requestId, ...(await tool.run(tool.schema.parse(args ?? {}))) }; }
        catch (error) { data = { ok: false, requestId, error: plaidError(error) }; }
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(!data.ok ? { isError: true } : {}) };
      });
    }
    return server;
  }, { legacy: 'stateless', onerror: () => console.error('plaid_mcp_protocol_error') });
  app.use(prefix + '/mcp', originValidation([...hosts, 'chatgpt.com', 'chat.openai.com', 'claude.ai']));
  app.use(prefix + '/mcp', requireBearerAuth({ verifier: { verifyAccessToken: auth.verifyAccessToken }, requiredScopes: [SCOPE], resourceMetadataUrl: resourceMetadata }));
  app.use(prefix + '/mcp', express.json({ limit: '100kb' }));
  app.all(prefix + '/mcp', async (req, res, next) => { try { await toNodeHandler(handler)(req, res, req.body); } catch (e) { next(e); } });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((e, _req, res, _next) => { if (res.headersSent) return res.end(); res.status(e.type === 'entity.too.large' ? 413 : e instanceof SyntaxError ? 400 : 500).json({ error: 'request_failed' }); });
  return { app, auth, store, tools, resourceUrl, close: async () => { await handler.close(); auth.close(); store.close(); } };
}

/** Plaid keys come from an EnvironmentFile; auth secrets from systemd credentials. */
export function configFromEnvironment() {
  const dir = process.env.CREDENTIALS_DIRECTORY || process.env.PLAID_MCP_CREDENTIALS_DIR;
  if (!dir) throw Error('Protected credential directory required');
  const read = (name) => readFileSync(join(dir, name), 'utf8').trim();
  const tokenKey = Buffer.from(read('token-key'), 'base64');
  return {
    baseUrl: process.env.PLAID_MCP_BASE_URL || 'https://mcp.jensenabler.com/plaid',
    dataDirectory: process.env.PLAID_MCP_DATA_DIR || '/var/lib/plaid-mcp',
    release: process.env.PLAID_MCP_RELEASE,
    tokenKey,
    auth: { passwordHash: read('password-hash'), jwks: JSON.parse(read('jwks.json')), cookieKeys: JSON.parse(read('cookie-keys.json')) },
  };
}

let entry = false; try { entry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (entry) {
  const service = await createApp(configFromEnvironment());
  const http = service.app.listen(Number(process.env.PORT || 8805), '127.0.0.1', (error) => { if (error) { console.error('plaid_mcp_listen_failed'); process.exit(1); } console.log('Plaid MCP listening'); });
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (closing) return; closing = true; setTimeout(() => process.exit(1), 10000).unref();
    http.close(async () => { try { await service.close(); process.exit(0); } catch { process.exit(1); } });
  });
}
