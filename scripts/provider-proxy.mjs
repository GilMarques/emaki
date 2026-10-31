#!/usr/bin/env node
/**
 * Provider proxy for web builds.
 *
 * Manga providers do not send `Access-Control-Allow-Origin`, so a browser
 * cannot `fetch()` them directly — the request dies with "blocked by CORS
 * policy" before it ever leaves the page. Native builds (Capacitor) don't
 * have this problem because `CapacitorHttp` runs outside the WebView
 * sandbox.
 *
 * This server is the web counterpart: it fetches the target on the app's
 * behalf and hands the bytes back with permissive CORS headers, so the
 * browser can read them.
 *
 * The upstream request is made with `curl` when it is available. That is not
 * a preference: several providers (ComicK) sit behind a bot check that
 * fingerprints the TLS handshake, and Node's own TLS stack trips it while a
 * regular browser/curl client passes. When `curl` is missing the proxy falls
 * back to Node's `https`, which works for every provider that does not run
 * that check.
 *
 * Usage:
 *   node scripts/provider-proxy.mjs [--port 4300]
 *
 * Endpoints:
 *   GET /?url=<encoded absolute url>   fetch the target, stream it back
 *   GET /health                        liveness probe
 *
 * The proxy is a development/verification aid: it binds to loopback only and
 * is never bundled into the app.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 4300;

/** Browser-ish UA: providers block obvious bots more often than browsers. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

/** Headers that must not be copied from the client request to the target. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'origin',
  'referer',
  'cookie',
  'content-length',
]);

/** Is a usable `curl` on the PATH? */
function hasCurl() {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CURL_AVAILABLE = hasCurl();

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      args.port = Number(argv[++i]);
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    args.port = DEFAULT_PORT;
  }
  return args;
}

/**
 * Fetch through `curl`.
 *
 * `curl` handles redirects and decompression, and its TLS handshake looks
 * like a browser's, which matters for the providers behind a bot check.
 * The response headers are dumped to a temp file so the body can go to
 * stdout untouched.
 */
function fetchWithCurl(url, headers) {
  return new Promise((resolve, reject) => {
    const headerFile = join(mkdtempSync(join(tmpdir(), 'emaki-proxy-')), 'headers.txt');
    const meta = [];
    const args = [
      '-sS',
      '-L',
      '--max-redirs',
      '5',
      '--compressed',
      '--dump-header',
      headerFile,
      '--output',
      '-',
      '--write-out',
      '%{stderr}__EMAKI_META__%{http_code}\t%{content_type}\n',
      '--user-agent',
      headers['user-agent'] ?? DEFAULT_USER_AGENT,
    ];
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'user-agent') continue;
      args.push('--header', `${name}: ${value}`);
    }
    args.push(url);

    execFile(
      'curl',
      args,
      { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        let raw = '';
        try {
          raw = readFileSync(headerFile, 'utf8');
        } catch {
          /* ignore */
        }
        try {
          rmSync(headerFile, { force: true });
        } catch {
          /* ignore */
        }
        if (err) {
          reject(new Error(`curl failed: ${stderr.toString().trim() || err.message}`));
          return;
        }
        const text = stderr.toString();
        const at = text.lastIndexOf('__EMAKI_META__');
        const [status, contentType] =
          at >= 0 ? text.slice(at + '__EMAKI_META__'.length).trim().split('\t') : ['0', ''];
        resolve({
          status: Number(status) || 0,
          headers: parseHeaderDump(raw),
          contentType: contentType ?? '',
          body: stdout,
        });
      },
    );
  });
}

/** Parse a `curl --dump-header` file: the last block is the final response. */
function parseHeaderDump(raw) {
  const blocks = raw.split(/\r?\n\r?\n/).filter((block) => block.trim().length > 0);
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : '';
  const headers = {};
  for (const line of last.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * Fetch through Node's `https`.
 *
 * Follows redirects up to `maxHops` times. Providers move their APIs
 * around, so a redirect to a new host has to keep working.
 */
function fetchWithNode(url, headers, hops = 5) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid target URL: ${url}`));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol: ${target.protocol}`));
      return;
    }

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'GET',
        headers: { ...headers, host: target.host, 'accept-encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (hops <= 0) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          const next = new URL(res.headers.location, target).href;
          fetchWithNode(next, headers, hops - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const out = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') out[name.toLowerCase()] = value;
          }
          resolve({ status, headers: out, contentType: out['content-type'] ?? '', body });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.end();
  });
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (requestUrl.pathname === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, curl: CURL_AVAILABLE }));
    return;
  }

  if (req.method === 'OPTIONS') {
    // Echo the headers the browser asks about: the wildcard in
    // `Access-Control-Allow-Headers` is not honoured everywhere.
    const requested = req.headers['access-control-request-headers'];
    res.writeHead(204, {
      ...CORS_HEADERS,
      ...(typeof requested === 'string' && requested.length > 0
        ? { 'access-control-allow-headers': requested }
        : {}),
    });
    res.end();
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { ...CORS_HEADERS, 'content-type': 'text/plain' });
    res.end('Missing "url" query parameter');
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && typeof value === 'string') {
      headers[name] = value;
    }
  }
  // The browser forbids setting `user-agent` from script, so the proxy
  // supplies the one providers expect to see.
  headers['user-agent'] = DEFAULT_USER_AGENT;
  // `x-referer` is the only referer a browser can still set (the real one
  // is a forbidden header name); the transport maps it back to `Referer`.
  const referer = headers['x-referer'];
  delete headers['x-referer'];
  if (referer) {
    headers['referer'] = referer;
  }

  const run = CURL_AVAILABLE ? fetchWithCurl : fetchWithNode;
  run(target, headers).then(
    (upstream) => {
      const outHeaders = { ...CORS_HEADERS };
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (HOP_BY_HOP.has(name) || name === 'content-encoding') continue;
        outHeaders[name] = value;
      }
      if (!outHeaders['content-type'] && upstream.contentType) {
        outHeaders['content-type'] = upstream.contentType;
      }
      res.writeHead(upstream.status || 502, outHeaders);
      res.end(upstream.body);
    },
    (err) => {
      res.writeHead(502, { ...CORS_HEADERS, 'content-type': 'text/plain' });
      res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
});

const { port } = parseArgs(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[provider-proxy] listening on http://127.0.0.1:${port}\n`);
  if (!CURL_AVAILABLE) {
    process.stdout.write(
      '[provider-proxy] curl not found — falling back to the Node TLS stack. ' +
        'Providers behind a bot check (ComicK) will fail.\n',
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
