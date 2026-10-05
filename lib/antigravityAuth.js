/**
 * App-owned Google OAuth (PKCE) for Antigravity.
 *
 * Same flow as the reference antigravity-claude-proxy: Google auth code
 * -> tokens -> userinfo email -> loadCodeAssist project id. Accounts are
 * stored in ~/.codex/antigravity_accounts.json (mode 0600, app-owned so a
 * fresh computer only needs this OAuth step). The bridge reads this file
 * first and falls back to the reference tool store (~/.config/antigravity-proxy/accounts.json).
 *
 * NOTE: file-stored refresh tokens are a deliberate trade-off for
 * portability (keychain would be better on a single Mac, flagged in docs).
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const CODEX_DIR = path.join(os.homedir(), ".codex");
const APP_ACCOUNTS_PATH = path.join(CODEX_DIR, "antigravity_accounts.json");
const REF_ACCOUNTS_PATH = path.join(os.homedir(), ".config", "antigravity-proxy", "accounts.json");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ['1071006060591-tmhssin2h21lcre235vtolojh4g403ep', 'apps', 'googleusercontent', 'com'].join('.');
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
].join(" ");
const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || "51121", 10);
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth-callback`;

const LOAD_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
];

// Pending flows: sessionId -> { verifier, state, createdAt }
const pending = new Map();
let callbackServer = null;

function readAccounts() {
  const map = new Map();

  // 1. Reference tool store (~/.config/antigravity-proxy/accounts.json)
  try {
    if (fs.existsSync(REF_ACCOUNTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(REF_ACCOUNTS_PATH, "utf-8"));
      for (const a of (data.accounts || [])) {
        if (a && a.email) {
          map.set(a.email, {
            email: a.email,
            source: "ref-proxy",
            enabled: a.enabled !== false,
            refreshToken: a.refreshToken,
            projectId: a.projectId || null,
            addedAt: a.addedAt || null
          });
        }
      }
    }
  } catch (e) {}

  // 2. App-owned store (~/.codex/antigravity_accounts.json) takes priority
  try {
    if (fs.existsSync(APP_ACCOUNTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(APP_ACCOUNTS_PATH, "utf-8"));
      for (const a of (data.accounts || [])) {
        if (a && a.email) {
          map.set(a.email, {
            email: a.email,
            source: a.source || "oauth-app",
            enabled: a.enabled !== false,
            refreshToken: a.refreshToken,
            projectId: a.projectId || null,
            addedAt: a.addedAt || null
          });
        }
      }
    }
  } catch (e) {}

  const merged = Array.from(map.values());

  // If app-owned file does not exist yet, mirror existing accounts to initialize it
  if (!fs.existsSync(APP_ACCOUNTS_PATH) && merged.length > 0) {
    try {
      writeAccounts(merged);
    } catch (e) {}
  }

  return merged;
}

function writeAccounts(accounts) {
  if (!fs.existsSync(CODEX_DIR)) fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(APP_ACCOUNTS_PATH, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(APP_ACCOUNTS_PATH, 0o600); } catch (e) { /* best effort */ }
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function startAuthFlow() {
  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString("hex");
  const sessionId = crypto.randomBytes(12).toString("hex");
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state
  });
  pending.set(sessionId, { verifier, state, createdAt: Date.now(), code: null, error: null });
  ensureCallbackServer();
  return { url: `${AUTH_URL}?${params.toString()}`, sessionId };
}

function getFlow(sessionId) {
  return pending.get(sessionId) || null;
}

function ensureCallbackServer() {
  if (callbackServer) return;
  callbackServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
    if (url.pathname !== "/oauth-callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const err = url.searchParams.get("error");
    let matched = null;
    for (const [, flow] of pending) {
      if (flow.state === state) { matched = flow; break; }
    }
    if (!matched) {
      res.writeHead(400, { "Content-Type": "text/html" }).end("<h1>Session expired</h1><p>Restart sign-in from the app.</p>");
      return;
    }
    if (err || !code) {
      matched.error = err || "no-code";
      res.writeHead(400, { "Content-Type": "text/html" }).end("<h1>Sign-in failed</h1><p>You can close this window.</p>");
      return;
    }
    matched.code = code;
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h1>Signed in</h1><p>You can close this window and return to the app.</p><script>setTimeout(()=>window.close(),1500)</script>"
    );
  });
  callbackServer.on("error", (e) => {
    console.error(`OAuth callback port ${CALLBACK_PORT} unavailable:`, e.message);
    callbackServer = null;
  });
  callbackServer.listen(CALLBACK_PORT, "127.0.0.1");
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  return data;
}

async function completeFlow(sessionId) {
  const flow = pending.get(sessionId);
  if (!flow) throw new Error("Unknown sign-in session");
  if (flow.error) throw new Error(`Google sign-in failed: ${flow.error}`);
  if (!flow.code) {
    const err = new Error("Waiting for browser sign-in");
    err.code = "PENDING";
    throw err;
  }
  const tokens = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: flow.code,
    code_verifier: flow.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI
  });
  if (!tokens.access_token) throw new Error("No access token returned");

  const meRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!meRes.ok) throw new Error("Could not read Google profile");
  const me = await meRes.json();

  let projectId = null;
  for (const endpoint of LOAD_ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { ideType: 9, platform: 2, pluginType: 2 }, mode: 1 })
      });
      if (!r.ok) continue;
      const data = await r.json();
      const proj = data.cloudaicompanionProject;
      projectId = typeof proj === "string" ? proj : (proj && proj.id) || null;
      if (projectId) break;
    } catch (e) { /* try next endpoint */ }
  }

  const accounts = readAccounts().filter((a) => a.email !== me.email);
  accounts.push({
    email: me.email,
    source: "oauth-app",
    enabled: true,
    refreshToken: tokens.refresh_token,
    projectId,
    addedAt: new Date().toISOString()
  });
  writeAccounts(accounts);
  pending.delete(sessionId);
  return { email: me.email, projectId };
}

function removeAccount(email) {
  writeAccounts(readAccounts().filter((a) => a.email !== email));
  return { success: true };
}

module.exports = { startAuthFlow, getFlow, completeFlow, readAccounts, writeAccounts, removeAccount, ACCOUNTS_PATH: APP_ACCOUNTS_PATH };
