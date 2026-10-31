#!/usr/bin/env node
/**
 * Development launcher: starts the provider proxy next to the dev server.
 *
 * The proxy is what lets the web build talk to manga providers — they send
 * no CORS headers, so the browser refuses to read their responses. Native
 * builds don't need it (`CapacitorHttp` bypasses the WebView sandbox), but
 * `ng serve` and the packaged desktop app do.
 *
 * Both children share this process' stdio and are stopped together.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a command to completion, inheriting stdio. */
function run(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} exited with ${code}`))));
  });
}

/** Start a long-running child; resolves when it exits. */
function start(command, args, label) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
  child.on('exit', (code, signal) => {
    process.stdout.write(`[dev] ${label} exited (code=${code ?? 'null'} signal=${signal ?? 'none'})\n`);
    shutdown(code ?? 0);
  });
  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

await run(process.execPath, [resolve(root, 'scripts/gen-preset-books.mjs')]);

children.push(start(process.execPath, [resolve(root, 'scripts/provider-proxy.mjs')], 'provider-proxy'));
children.push(
  start(process.execPath, [resolve(root, 'node_modules/@angular/cli/bin/ng.js'), 'serve'], 'ng serve'),
);
