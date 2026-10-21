#!/usr/bin/env node
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  type CountryCode,
  type LinkTokenCreateRequest,
  type Products
} from "plaid";

type PlaidEnvironmentName = "sandbox" | "development" | "production";

const plaidEnvironments: Record<PlaidEnvironmentName, string> = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production
};

const host = "127.0.0.1";
const port = Number(process.env.PLAID_LINK_PORT ?? process.env.PORT ?? 3333);
const envPath = join(process.cwd(), ".env");

let plaidClient: PlaidApi | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function plaidEnvironmentName(): PlaidEnvironmentName {
  const env = (process.env.PLAID_ENV ?? "sandbox").toLowerCase();
  if (env !== "sandbox" && env !== "development" && env !== "production") {
    throw new Error("PLAID_ENV must be sandbox, development, or production.");
  }

  return env;
}

function getPlaidClient(): PlaidApi {
  if (!plaidClient) {
    const configuration = new Configuration({
      basePath: plaidEnvironments[plaidEnvironmentName()],
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

function splitEnvList(value: string | undefined, fallback: string[]): string[] {
  const source = value?.trim() ? value : fallback.join(",");
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function productList(name: string, fallback: string[] = []): Products[] | undefined {
  const values = splitEnvList(process.env[name], fallback);
  return values.length ? values.map((value) => value as Products) : undefined;
}

function countryCodes(): CountryCode[] {
  return splitEnvList(process.env.PLAID_COUNTRY_CODES, ["US"]).map(
    (value) => value.toUpperCase() as CountryCode
  );
}

function linkProducts(): Products[] {
  const products = productList("PLAID_PRODUCTS", ["transactions"]) ?? [];
  if (!products.length) {
    throw new Error("PLAID_PRODUCTS must contain at least one product.");
  }

  if (products.includes("balance" as Products)) {
    throw new Error("Do not include balance in PLAID_PRODUCTS; Plaid initializes Balance automatically.");
  }

  return products;
}

// Plaid defaults Items to 90 days of history; 730 is its maximum. It is fixed when the Item is
// created, so an Item linked with less must be removed and re-linked to get more.
function transactionDaysRequested(): number {
  const raw = process.env.PLAID_TRANSACTIONS_DAYS_REQUESTED;
  const value = raw ? Number(raw) : 730;
  if (!Number.isInteger(value) || value < 1 || value > 730) {
    throw new Error("PLAID_TRANSACTIONS_DAYS_REQUESTED must be an integer from 1 to 730.");
  }
  return value;
}

function safeConfig() {
  return {
    environment: plaidEnvironmentName(),
    clientName: process.env.PLAID_CLIENT_NAME ?? "Plaid MCP",
    products: linkProducts(),
    transactionDaysRequested: transactionDaysRequested(),
    optionalProducts: productList("PLAID_OPTIONAL_PRODUCTS"),
    additionalConsentedProducts: productList("PLAID_ADDITIONAL_CONSENTED_PRODUCTS"),
    countryCodes: countryCodes(),
    hasRedirectUri: Boolean(process.env.PLAID_REDIRECT_URI),
    hasAccessToken: Boolean(process.env.PLAID_ACCESS_TOKEN)
  };
}

function errorPayload(error: unknown) {
  const candidate = error as {
    response?: {
      status?: number;
      data?: unknown;
    };
    message?: string;
  };

  return {
    ok: false,
    status: candidate.response?.status,
    error: candidate.response?.data ?? {
      message: candidate.message ?? "Unknown Plaid Link helper error"
    }
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response: ServerResponse) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(pageHtml());
}

function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 20_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function maskedToken(token: string): string {
  if (token.length <= 12) {
    return "*".repeat(token.length);
  }

  return `${token.slice(0, 10)}...${token.slice(-6)}`;
}

async function saveAccessToken(accessToken: string) {
  const nextLine = `PLAID_ACCESS_TOKEN=${accessToken}`;
  const existing = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (/^\s*PLAID_ACCESS_TOKEN\s*=/.test(line)) {
      replaced = true;
      return nextLine;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(nextLine);
  }

  await writeFile(envPath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
  process.env.PLAID_ACCESS_TOKEN = accessToken;
}

async function createLinkToken() {
  const request: LinkTokenCreateRequest = {
    client_name: process.env.PLAID_CLIENT_NAME ?? "Plaid MCP",
    language: process.env.PLAID_LANGUAGE ?? "en",
    country_codes: countryCodes(),
    products: linkProducts(),
    user: {
      client_user_id: process.env.PLAID_CLIENT_USER_ID ?? "plaid-mcp-local-user"
    }
  };

  const optionalProducts = productList("PLAID_OPTIONAL_PRODUCTS");
  const additionalConsentedProducts = productList("PLAID_ADDITIONAL_CONSENTED_PRODUCTS");
  const requiredIfSupportedProducts = productList("PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS");

  if (optionalProducts?.length) {
    request.optional_products = optionalProducts;
  }
  if (additionalConsentedProducts?.length) {
    request.additional_consented_products = additionalConsentedProducts;
  }
  if (linkProducts().includes("transactions" as Products)) {
    request.transactions = { days_requested: transactionDaysRequested() };
  }
  if (requiredIfSupportedProducts?.length) {
    request.required_if_supported_products = requiredIfSupportedProducts;
  }
  if (process.env.PLAID_REDIRECT_URI) {
    request.redirect_uri = process.env.PLAID_REDIRECT_URI;
  }
  if (process.env.PLAID_WEBHOOK_URL) {
    request.webhook = process.env.PLAID_WEBHOOK_URL;
  }

  const response = await getPlaidClient().linkTokenCreate(request);
  return response.data;
}

async function exchangePublicToken(publicToken: string) {
  const response = await getPlaidClient().itemPublicTokenExchange({
    public_token: publicToken
  });

  await saveAccessToken(response.data.access_token);

  return {
    ok: true,
    itemId: response.data.item_id,
    accessTokenSaved: true,
    maskedAccessToken: maskedToken(response.data.access_token),
    requestId: response.data.request_id
  };
}

async function recoverAccessToken(linkToken: string) {
  const response = await getPlaidClient().linkTokenGet({
    link_token: linkToken
  });

  const sessions = response.data.link_sessions ?? [];
  const publicTokens = sessions.flatMap((session) => [
    ...(session.results?.item_add_results ?? []).map((result) => result.public_token),
    ...(session.on_success?.public_token ? [session.on_success.public_token] : [])
  ]);
  const publicToken = publicTokens.find(Boolean);

  if (!publicToken) {
    return {
      ok: false,
      requestId: response.data.request_id,
      linkSessions: sessions.map((session) => ({
        linkSessionId: session.link_session_id,
        startedAt: session.started_at,
        finishedAt: session.finished_at,
        hasResults: Boolean(session.results),
        itemAddResultCount: session.results?.item_add_results?.length ?? 0,
        hasLegacyOnSuccess: Boolean(session.on_success),
        hasExit: Boolean(session.exit)
      })),
      error: {
        message: "Plaid did not return a public_token for this Link token."
      }
    };
  }

  return exchangePublicToken(publicToken);
}

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  try {
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/link-session" || url.pathname === "/oauth-return")
    ) {
      sendHtml(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, { ok: true, ...safeConfig() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/link-token") {
      const data = await createLinkToken();
      sendJson(response, 200, {
        ok: true,
        linkToken: data.link_token,
        expiration: data.expiration,
        requestId: data.request_id
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/exchange-public-token") {
      const body = await readRequestBody(request);
      const publicToken = body.public_token;
      if (typeof publicToken !== "string" || !publicToken) {
        sendJson(response, 400, { ok: false, error: { message: "public_token is required." } });
        return;
      }

      sendJson(response, 200, await exchangePublicToken(publicToken));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/recover-access-token") {
      const body = await readRequestBody(request);
      const linkToken = body.link_token;
      if (typeof linkToken !== "string" || !linkToken) {
        sendJson(response, 400, { ok: false, error: { message: "link_token is required." } });
        return;
      }

      const result = await recoverAccessToken(linkToken);
      sendJson(response, result.ok === false ? 409 : 200, result);
      return;
    }

    sendJson(response, 404, { ok: false, error: { message: "Not found." } });
  } catch (error) {
    sendJson(response, 500, errorPayload(error));
  }
}

function pageHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Plaid Link Setup</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #171b22;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 16px;
    }

    main {
      width: min(760px, 100%);
      display: grid;
      gap: 18px;
    }

    header {
      display: grid;
      gap: 8px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: 0;
    }

    p {
      margin: 0;
      color: #4b5565;
      line-height: 1.5;
    }

    section {
      background: #ffffff;
      border: 1px solid #d9dee7;
      border-radius: 8px;
      padding: 18px;
      display: grid;
      gap: 16px;
      box-shadow: 0 1px 2px rgba(23, 27, 34, 0.05);
    }

    dl {
      margin: 0;
      display: grid;
      grid-template-columns: minmax(130px, 0.4fr) 1fr;
      gap: 10px 16px;
    }

    dt {
      color: #616b7c;
      font-size: 13px;
    }

    dd {
      margin: 0;
      color: #171b22;
      overflow-wrap: anywhere;
    }

    button {
      appearance: none;
      border: 0;
      border-radius: 6px;
      background: #0b6bcb;
      color: #ffffff;
      cursor: pointer;
      font: inherit;
      min-height: 42px;
      padding: 10px 14px;
      justify-self: start;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .secondary {
      background: #eef2f7;
      color: #172033;
      border: 1px solid #cfd6e2;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }

    pre {
      margin: 0;
      overflow-x: auto;
      background: #111827;
      color: #e5e7eb;
      border-radius: 8px;
      padding: 14px;
      min-height: 92px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .warning {
      border-left: 4px solid #b65d00;
      padding-left: 12px;
      color: #4a3318;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Plaid Link Setup</h1>
      <p>Connect one bank Item and save its access token for the local MCP server.</p>
    </header>

    <section>
      <dl id="config">
        <dt>Environment</dt><dd>Loading</dd>
        <dt>Products</dt><dd>Loading</dd>
        <dt>Countries</dt><dd>Loading</dd>
        <dt>Access token</dt><dd>Loading</dd>
      </dl>
      <p class="warning">Production Link may bill for initialized products. This helper defaults to transactions only.</p>
      <div class="actions">
        <button id="connect" type="button" disabled>Connect bank</button>
        <button id="recover" class="secondary" type="button" disabled>Recover completed Link</button>
      </div>
    </section>

    <section>
      <pre id="status">Ready.</pre>
    </section>
  </main>

  <script>
    const button = document.getElementById("connect");
    const recoverButton = document.getElementById("recover");
    const status = document.getElementById("status");
    const config = document.getElementById("config");
    const pageMode = window.location.pathname === "/link-session"
      ? "link-session"
      : window.location.pathname === "/oauth-return"
        ? "oauth-return"
        : "setup";
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("plaid_link_helper") : null;
    let activeHandler;

    function write(message, detail) {
      status.textContent = detail ? message + "\\n\\n" + JSON.stringify(detail, null, 2) : message;
    }

    async function requestJson(path, options) {
      const response = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options && options.headers ? options.headers : {})
        }
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw payload;
      }
      return payload;
    }

    function renderConfig(data) {
      config.innerHTML = [
        ["Environment", data.environment],
        ["Products", (data.products || []).join(", ")],
        ["Countries", (data.countryCodes || []).join(", ")],
        ["Access token", data.hasAccessToken ? "Already saved" : "Not saved yet"]
      ].map(([term, value]) => "<dt>" + term + "</dt><dd>" + value + "</dd>").join("");
    }

    async function refreshStatus() {
      const data = await requestJson("/api/status");
      renderConfig(data);
      button.disabled = false;
      recoverButton.disabled = !storedLinkToken() || data.hasAccessToken;
    }

    function broadcast(message) {
      channel && channel.postMessage(message);
      if (window.opener) {
        window.opener.postMessage({ ...message, source: "plaid-link-helper" }, window.location.origin);
      }
    }

    async function exchange(publicToken, metadata) {
      write("Exchanging public token...");
      const result = await requestJson("/api/exchange-public-token", {
        method: "POST",
        body: JSON.stringify({ public_token: publicToken })
      });
      write("Access token saved to .env.", {
        institution: metadata && metadata.institution ? metadata.institution.name : undefined,
        itemId: result.itemId,
        maskedAccessToken: result.maskedAccessToken,
        requestId: result.requestId
      });
      broadcast({ type: "plaid-success", result });
      await refreshStatus();
    }

    async function recoverCompletedLink() {
      const linkToken = storedLinkToken();
      if (!linkToken) {
        write("No saved Link token found in this browser. Start Connect bank again from this page.");
        return;
      }

      recoverButton.disabled = true;
      write("Checking completed Link session with Plaid...");
      try {
        const result = await requestJson("/api/recover-access-token", {
          method: "POST",
          body: JSON.stringify({ link_token: linkToken })
        });
        write("Access token saved to .env.", {
          itemId: result.itemId,
          maskedAccessToken: result.maskedAccessToken,
          requestId: result.requestId
        });
        broadcast({ type: "plaid-success", result });
        await refreshStatus();
      } catch (error) {
        write("Could not recover a public token yet.", error);
        recoverButton.disabled = false;
      }
    }

    function storedLinkToken() {
      return window.sessionStorage.getItem("plaid_link_token") || window.localStorage.getItem("plaid_link_token");
    }

    function saveLinkToken(token) {
      window.sessionStorage.setItem("plaid_link_token", token);
      window.localStorage.setItem("plaid_link_token", token);
    }

    function saveReceivedRedirectUri(uri) {
      window.localStorage.setItem("plaid_received_redirect_uri", uri);
    }

    async function createHandler(linkToken, receivedRedirectUri) {
      return Plaid.create({
        token: linkToken,
        receivedRedirectUri,
        onSuccess: exchange,
        onExit: (err, metadata) => {
          if (err) {
            write("Plaid Link exited with an error.", err);
          } else {
            write("Plaid Link closed.", metadata);
          }
          button.disabled = false;
        },
        onEvent: (eventName, metadata) => {
          if (eventName === "OPEN") {
            write("Plaid Link is open.");
          } else if (eventName === "OPEN_OAUTH") {
            write("OAuth opened in this tab. Keep the setup tab open; it will finish when OAuth returns.", metadata);
          } else if (eventName === "HANDOFF") {
            write("Plaid handoff complete. Waiting for final success callback...", metadata);
            setTimeout(() => {
              recoverCompletedLink().catch((error) => write("Recovery failed after Plaid handoff.", error));
            }, 1500);
          }
        }
      });
    }

    function decodeBase64Url(value) {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    }

    function decodePlaidOauthHandoff(uri) {
      try {
        const parsed = new URL(uri);
        if (parsed.hostname !== "cdn.plaid.com" || !parsed.pathname.endsWith("/oauth.html")) {
          return uri;
        }

        const state = parsed.searchParams.get("state");
        if (!state) {
          return uri;
        }

        const decoded = JSON.parse(decodeBase64Url(state));
        if (!decoded.oauth_state_id || !decoded.redirect_uri) {
          return uri;
        }

        return decoded.redirect_uri + "?oauth_state_id=" + encodeURIComponent(decoded.oauth_state_id);
      } catch (_error) {
        return uri;
      }
    }

    async function resumeOAuth(receivedRedirectUriOverride) {
      button.disabled = true;
      const params = new URLSearchParams(window.location.search);
      const receivedRedirectUri = decodePlaidOauthHandoff(
        receivedRedirectUriOverride || params.get("received_redirect_uri") || window.location.href
      );
      const linkToken = storedLinkToken();

      if (!linkToken) {
        write("Could not resume OAuth: the original Link token is missing. Start Connect bank again from this page.");
        button.disabled = false;
        return;
      }

      try {
        write("Resuming Plaid OAuth...");
        activeHandler = await createHandler(linkToken, receivedRedirectUri);
        activeHandler.open();
      } catch (error) {
        write("Could not resume Plaid OAuth.", error);
        button.disabled = false;
      }
    }

    async function launchLinkSession() {
      button.disabled = true;
      try {
        const linkToken = storedLinkToken();
        if (!linkToken) {
          write("No Link token found. Return to the setup tab and click Connect bank again.");
          button.disabled = false;
          return;
        }

        write("Opening Plaid Link...");
        activeHandler = await createHandler(linkToken);
        activeHandler.open();
      } catch (error) {
        write("Setup failed.", error);
        button.disabled = false;
      }
    }

    async function openLinkTab() {
      button.disabled = true;
      try {
        write("Creating Link token...");
        const token = await requestJson("/api/link-token", { method: "POST", body: "{}" });
        saveLinkToken(token.linkToken);
        window.localStorage.removeItem("plaid_received_redirect_uri");

        const popup = window.open("/link-session", "plaid_link_session");
        if (!popup) {
          write("Your browser blocked the Link tab. Allow popups for this local page, then click Connect bank again.");
          button.disabled = false;
          return;
        }

        write("Plaid Link opened in a new tab. Keep this setup tab open; OAuth completion will return here.");
        button.disabled = false;
      } catch (error) {
        write("Setup failed.", error);
        button.disabled = false;
      }
    }

    function handleOauthReturn() {
      button.disabled = true;
      const params = new URLSearchParams(window.location.search);
      const receivedRedirectUri = decodePlaidOauthHandoff(params.get("received_redirect_uri") || window.location.href);
      saveReceivedRedirectUri(receivedRedirectUri);
      broadcast({ type: "plaid-oauth-return", receivedRedirectUri });
      write("OAuth returned. Go back to the setup tab; it will finish account linking.", {
        receivedRedirectUri
      });
    }

    function handleCrossTabMessage(message) {
      const data = message && message.data ? message.data : message;
      if (!data || typeof data !== "object") {
        return;
      }

      if (data.type === "plaid-oauth-return" && data.receivedRedirectUri && pageMode === "setup") {
        resumeOAuth(data.receivedRedirectUri);
      } else if (data.type === "plaid-success" && pageMode === "setup") {
        write("Access token saved to .env.", data.result);
        refreshStatus().catch(() => {});
      }
    }

    button.addEventListener("click", () => {
      if (pageMode === "link-session") {
        launchLinkSession();
      } else if (pageMode === "oauth-return") {
        resumeOAuth();
      } else {
        openLinkTab();
      }
    });
    recoverButton.addEventListener("click", () => {
      recoverCompletedLink().catch((error) => write("Recovery failed.", error));
    });

    channel && channel.addEventListener("message", handleCrossTabMessage);
    window.addEventListener("message", (event) => {
      if (event.origin === window.location.origin) {
        handleCrossTabMessage(event);
      }
    });
    window.addEventListener("storage", (event) => {
      if (event.key === "plaid_received_redirect_uri" && event.newValue && pageMode === "setup") {
        resumeOAuth(event.newValue);
      }
    });

    refreshStatus().catch((error) => {
      write("Could not load Plaid Link helper configuration.", error);
    });

    if (pageMode === "link-session") {
      button.textContent = "Open Plaid Link";
      launchLinkSession();
    } else if (pageMode === "oauth-return") {
      button.textContent = "Finish in this tab";
      handleOauthReturn();
    } else {
      const pendingRedirect = window.localStorage.getItem("plaid_received_redirect_uri");
      if (pendingRedirect) {
        resumeOAuth(pendingRedirect);
      } else if (new URLSearchParams(window.location.search).get("recover") === "1") {
        recoverCompletedLink().catch((error) => write("Recovery failed.", error));
      }
    }
  </script>
</body>
</html>`;
}

const server = createServer((request, response) => {
  void route(request, response);
});

server.listen(port, host, () => {
  console.log(`Plaid Link helper running at http://${host}:${port}`);
  console.log(`Using Plaid environment: ${plaidEnvironmentName()}`);
});
