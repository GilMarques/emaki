#!/usr/bin/env node
/**
 * Mint a GitHub App installation token and resolve the bot's git identity.
 *
 * OpenCode has no identity of its own on GitHub — the credential does. To
 * make PRs and commits show up as a bot instead of a human, authenticate as
 * a GitHub App: the installation token authorises the API calls, and the
 * bot's `name[bot]` + noreply email author the commits.
 *
 * Setup (once, in the browser):
 *   1. github.com/settings/apps/new → create an app, e.g. "OpenCode"
 *   2. Permissions: Contents R/W, Pull requests R/W, Metadata R
 *   3. Install it on this repo only
 *   4. Generate a private key and save it outside the repo
 *
 * Then write ~/.config/opencode/github-app.json:
 *   {
 *     "appId": "123456",
 *     "installationId": "987654",
 *     "appSlug": "opencode",
 *     "privateKeyPath": "~/.config/opencode/github-app.pem"
 *   }
 *
 * Every field can also come from the environment:
 *   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_SLUG,
 *   GITHUB_APP_PRIVATE_KEY
 *
 * Usage:
 *   github-app-token.mjs            # prints the token
 *   github-app-token.mjs --json     # token + bot name/email
 *   github-app-token.mjs --identity # bot name and email only
 */
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const API = process.env.GITHUB_API_BASE ?? 'https://api.github.com';
const CONFIG_PATH = join(homedir(), '.config', 'opencode', 'github-app.json');
const CACHE_PATH = join(homedir(), '.cache', 'opencode', 'github-app-token.json');
/** Mint a new token this long before the current one expires. */
const RENEW_WINDOW_MS = 5 * 60 * 1000;

function fail(message) {
  console.error(`github-app-token: ${message}`);
  process.exit(1);
}

/** Read the config file, if it exists. Missing file is not an error here. */
function readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    fail(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
  }
}

/** Config: environment wins over the file, file wins over the defaults. */
function loadConfig() {
  const file = readConfigFile();
  const config = {
    appId: process.env.GITHUB_APP_ID ?? file.appId,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID ?? file.installationId,
    appSlug: process.env.GITHUB_APP_SLUG ?? file.appSlug,
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY ?? file.privateKeyPath,
  };
  if (!config.appId) fail(`no app id (set GITHUB_APP_ID or add "appId" to ${CONFIG_PATH})`);
  if (!config.installationId)
    fail(`no installation id (set GITHUB_APP_INSTALLATION_ID or add "installationId" to ${CONFIG_PATH})`);
  if (!config.privateKeyPath)
    fail(`no private key path (set GITHUB_APP_PRIVATE_KEY or add "privateKeyPath" to ${CONFIG_PATH})`);
  config.privateKeyPath = resolve(config.privateKeyPath.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(config.privateKeyPath)) fail(`private key not found at ${config.privateKeyPath}`);
  return config;
}

function base64url(input) {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');
}

/**
 * Build the JWT that authenticates as the App itself (not the installation).
 * GitHub rejects a lifetime over 10 minutes, so this is short on purpose —
 * it only has to live for the token request.
 */
function appJwt(config) {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url({ alg: 'RS256', typ: 'JWT' });
  // `iat` is backdated to absorb clock skew, and `exp` is kept nine minutes
  // out so the token is valid for under ten minutes however it is measured.
  const body = base64url({ iat: now - 60, exp: now + 540, iss: String(config.appId) });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  const signature = signer.sign(readFileSync(config.privateKeyPath), 'base64url');
  return `${head}.${body}.${signature}`;
}

async function api(path, token, method = 'GET') {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'emaki-opencode-bot',
    'x-github-api-version': '2022-11-28',
  };
  // The bot's user record is public, so it needs no credential — sending a
  // bogus one would only make GitHub reject the request.
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { method, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.message ?? response.statusText;
    fail(`${response.status} ${detail} (${path})`);
  }
  return body;
}

/** Ask GitHub for the app's slug, so the bot login can be derived. */
async function resolveSlug(config, jwt) {
  if (config.appSlug) return config.appSlug;
  const app = await api('/app', jwt);
  return app.slug;
}

/**
 * The bot's git identity. GitHub links a commit to a bot account when the
 * author email is the bot's numeric user id plus its login — the App id is
 * a different number and silently produces an unlinked commit.
 */
async function resolveIdentity(slug) {
  const login = `${slug}[bot]`;
  const user = await api(`/users/${encodeURIComponent(login)}`, null);
  return {
    botName: login,
    botEmail: `${user.id}+${login}@users.noreply.github.com`,
    botUserId: user.id,
  };
}

/** Cached token, if one is still fresh enough to use. */
function readCache() {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (cached.expiresAt && Date.parse(cached.expiresAt) - Date.now() > RENEW_WINDOW_MS) return cached;
  } catch {
    // A broken cache is not worth failing over; mint a fresh token.
  }
  return null;
}

function writeCache(entry) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
}

async function mintToken(config) {
  const jwt = appJwt(config);
  const slug = await resolveSlug(config, jwt);
  const identity = await resolveIdentity(slug);
  const issued = await api(
    `/app/installations/${config.installationId}/access_tokens`,
    jwt,
    'POST',
  );
  const entry = {
    token: issued.token,
    expiresAt: issued.expires_at,
    ...identity,
    slug,
  };
  writeCache(entry);
  return entry;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const cached = readCache();
  const entry = cached ?? (await mintToken(loadConfig()));

  if (args.has('--identity')) {
    console.log(`${entry.botName} <${entry.botEmail}>`);
    return;
  }
  if (args.has('--json')) {
    console.log(
      JSON.stringify(
        {
          token: entry.token,
          expiresAt: entry.expiresAt,
          botName: entry.botName,
          botEmail: entry.botEmail,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(entry.token);
}

await main();
