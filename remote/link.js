import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { escapeHtml } from './auth.js';
import { daysRequested, plaidError } from './plaid.js';

const SESSION_SECONDS = 30 * 60;
const COOKIE = 'plaidmcp_link';

/**
 * Owner-only Plaid Link setup. This is the only place that creates link tokens, exchanges public tokens,
 * or removes Items; the MCP surface stays read-only.
 */
export function createLinkRouter({ baseUrl, prefix, cookieKey, checkPassword, store, plaid, env = process.env }) {
  const origin = new URL(baseUrl).origin;
  const linkPath = prefix + '/link';
  const secure = origin.startsWith('https:');
  const redirectUri = env.PLAID_REDIRECT_URI || `${origin}${linkPath}/oauth-return`;
  const sign = (value) => createHmac('sha256', cookieKey).update(value).digest('base64url');

  const issueSession = (res) => {
    const value = `${Math.floor(Date.now() / 1000) + SESSION_SECONDS}.${randomBytes(16).toString('base64url')}`;
    res.cookie(COOKIE, `${value}.${sign(value)}`, { httpOnly: true, secure, sameSite: 'lax', path: linkPath, maxAge: SESSION_SECONDS * 1000 });
  };
  const hasSession = (req) => {
    const raw = String(req.headers.cookie ?? '').split(/;\s*/).find((part) => part.startsWith(COOKIE + '='));
    if (!raw) return false;
    const parts = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
    if (parts.length !== 3) return false;
    const value = `${parts[0]}.${parts[1]}`;
    const a = Buffer.from(sign(value)), b = Buffer.from(parts[2]);
    return a.length === b.length && timingSafeEqual(a, b) && Number(parts[0]) > Date.now() / 1000;
  };
  const sameOrigin = (req) => req.get('origin') === origin;
  const requireSession = (req, res, next) => {
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: { code: 'INVALID_ORIGIN' } });
    if (!hasSession(req)) return res.status(401).json({ ok: false, error: { code: 'SIGN_IN_REQUIRED' } });
    if (!plaid()) return res.status(503).json({ ok: false, error: { code: 'PLAID_NOT_CONFIGURED', message: 'Plaid credentials are not installed on the server yet.' } });
    return next();
  };

  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'" });
    next();
  });

  const shell = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plaid MCP — link banks</title>
<style>:root{color-scheme:light dark}body{font:17px system-ui;max-width:34rem;margin:2rem auto;padding:1rem;line-height:1.5}input,button{font:inherit;padding:.7rem;box-sizing:border-box;width:100%;margin:.4rem 0}
li{margin:.6rem 0}li button{width:auto;padding:.3rem .7rem;margin-left:.5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#8881;padding:.8rem;border-radius:6px}.muted{opacity:.7;font-size:.9em}</style>${body}</html>`;

  const loginPage = (error = '') => shell(`<h1>Plaid MCP</h1><p>Sign in to link or remove bank connections.</p>
${error ? `<p style="color:#c33">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${linkPath}/login"><label>Owner password<input name="password" type="password" required maxlength="1024" autocomplete="current-password" autofocus></label><button>Sign in</button></form>`);

  const appPage = () => {
    const items = store.listItems();
    const list = items.length
      ? `<ul>${items.map((item) => `<li><b>${escapeHtml(item.institutionName ?? item.institutionId ?? 'Unknown institution')}</b> <span class="muted">${escapeHtml(item.daysRequested ? `${item.daysRequested} days requested` : 'history length unknown')} · linked ${escapeHtml(item.linkedAt.slice(0, 10))}</span><button data-remove="${escapeHtml(item.itemId)}" data-name="${escapeHtml(item.institutionName ?? 'this bank')}">Remove</button></li>`).join('')}</ul>`
      : '<p class="muted">No banks linked yet.</p>';
    return shell(`<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<h1>Plaid MCP</h1><p>New links request ${daysRequested(env)} days of transaction history (Plaid's maximum is 730; banks may provide less).</p>
<h2>Linked banks</h2>${list}
<button id="connect">Link a bank</button><pre id="status">Ready.</pre>
<script>
const base=${JSON.stringify(linkPath)};const status=document.getElementById('status');
const say=(m,d)=>{status.textContent=d?m+'\\n\\n'+JSON.stringify(d,null,2):m};
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});const j=await r.json();if(!r.ok||j.ok===false)throw j;return j;}
async function finish(publicToken){say('Saving connection…');const r=await post('/api/exchange',{public_token:publicToken});localStorage.removeItem('plaidmcp_link_token');say('Linked '+(r.institutionName||'bank')+'. Plaid is now pulling history in the background.');setTimeout(()=>location.replace(base),1500);}
function open(token,received){const h=Plaid.create({token,receivedRedirectUri:received,onSuccess:t=>finish(t).catch(e=>say('Could not save the connection.',e)),onExit:(e)=>{if(e)say('Plaid Link exited with an error.',e);else say('Plaid Link closed.');}});h.open();}
document.getElementById('connect').onclick=async()=>{try{say('Starting Plaid Link…');const r=await post('/api/link-token');localStorage.setItem('plaidmcp_link_token',r.linkToken);open(r.linkToken);}catch(e){say('Could not start Plaid Link.',e);}};
for(const b of document.querySelectorAll('[data-remove]'))b.onclick=async()=>{if(!confirm('Remove '+b.dataset.name+'? This revokes the Plaid connection.'))return;try{await post('/api/remove',{item_id:b.dataset.remove});location.replace(base);}catch(e){say('Could not remove.',e);}};
if(location.pathname.endsWith('/oauth-return')){const t=localStorage.getItem('plaidmcp_link_token');if(t){say('Finishing bank sign-in…');open(t,location.href);}else say('The Link session was lost. Tap Link a bank to start again.');}
</script>`);
  };

  const page = (req, res) => res.type('html').send(hasSession(req) ? appPage() : loginPage());
  router.get(['/', '/oauth-return'], page);
  router.post('/login', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).send('Invalid form origin');
    let ok = false;
    try { ok = await checkPassword(req.body.password, req.ip); } catch { return res.status(429).type('html').send(loginPage('Too many attempts. Try again later.')); }
    if (!ok) return res.status(401).type('html').send(loginPage('Incorrect password.'));
    issueSession(res);
    return res.redirect(303, linkPath);
  });
  router.use('/api', express.json({ limit: '16kb' }), requireSession);
  router.post('/api/link-token', async (_req, res) => {
    try {
      const response = await plaid().linkTokenCreate({
        client_name: env.PLAID_CLIENT_NAME ?? 'Jensen Plaid MCP', language: 'en', country_codes: ['US'],
        products: ['transactions'], transactions: { days_requested: daysRequested(env) },
        user: { client_user_id: 'jensen' }, redirect_uri: redirectUri,
      });
      res.json({ ok: true, linkToken: response.data.link_token, expiration: response.data.expiration });
    } catch (error) { res.status(502).json({ ok: false, error: plaidError(error) }); }
  });
  router.post('/api/exchange', async (req, res) => {
    const publicToken = req.body?.public_token;
    if (typeof publicToken !== 'string' || !publicToken) return res.status(400).json({ ok: false, error: { code: 'PUBLIC_TOKEN_REQUIRED' } });
    try {
      const exchanged = await plaid().itemPublicTokenExchange({ public_token: publicToken });
      const { access_token: accessToken, item_id: itemId } = exchanged.data;
      let institutionId = null, institutionName = null;
      try {
        institutionId = (await plaid().itemGet({ access_token: accessToken })).data.item.institution_id ?? null;
        if (institutionId) institutionName = (await plaid().institutionsGetById({ institution_id: institutionId, country_codes: ['US'] })).data.institution.name;
      } catch { /* the connection is still valid without display metadata */ }
      store.upsertItem({ itemId, accessToken, institutionId, institutionName, daysRequested: daysRequested(env) });
      res.json({ ok: true, itemId, institutionName });
    } catch (error) { res.status(502).json({ ok: false, error: plaidError(error) }); }
  });
  router.post('/api/remove', async (req, res) => {
    const itemId = req.body?.item_id;
    if (typeof itemId !== 'string' || !store.getItem(itemId)) return res.status(404).json({ ok: false, error: { code: 'UNKNOWN_ITEM' } });
    try {
      await plaid().itemRemove({ access_token: store.accessToken(itemId) });
    } catch (error) {
      const detail = plaidError(error);
      if (!['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(detail.code)) return res.status(502).json({ ok: false, error: detail });
    }
    store.deleteItem(itemId);
    res.json({ ok: true });
  });
  return router;
}
