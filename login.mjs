#!/usr/bin/env node
/**
 * 账号池登录：用 command-code CLI 同一套登录流程拿到账号的 API key，并写进账号池配置。
 *
 *   npm run login -- --name alice --proxy http://user:pass@host:port
 *
 * 流程逐条对齐 command-code@1.73.4 的 createAuthFlowController / createAuthServer：
 *   1. 在 127.0.0.1 起回调服务（默认随机端口，CLI 的 Zo=0），生成 32 字节 base64url 的 state；
 *   2. 打开 https://commandcode.ai/studio/auth/cli?callback=http://127.0.0.1:<port>/callback&state=…&mode=redirect；
 *   3. 网页登录后把新签发的 key 以表单 POST 回 /callback（apiKey / state / userId / userName / keyName），
 *      校验 state 后 303 到 /callback/complete?state=… 显示成功页；拒绝授权时带 error / error_description；
 *   4. 浏览器打不开时可以直接粘贴 key —— 与 CLI 的手动分支一样用 GET /alpha/whoami 验证（只带 Content-Type 与
 *      Authorization 两个头），但经由该账号的代理发出。
 * 浏览器登录这一步 CLI 自己不发任何上游请求（key 由网页签发、直接回传），所以浏览器走哪个出口由你决定：
 * 想让账号从始至终只出现在一个 IP 上，就用配了同一代理的浏览器打开登录链接。
 *
 * 写配置的方式参照 openai-oauth fork 的 login --pool-config：按账号名更新（否则追加），保留其它账号与设置；
 * 配置文件必须是 600 权限的普通文件；临时文件 + rename 原子替换，期间被别人改过则放弃写入。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createUpstreamFetch, normalizePoolConfig, parseProxyUrl, redactProxyUrl } from './pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI 1.73.4 常量 ──
const STUDIO_BASE = { prod: 'https://commandcode.ai', staging: 'https://staging.commandcode.ai', local: 'http://localhost:3000' };
const CORS_ORIGINS = ['http://localhost:3000', 'https://staging.commandcode.ai', 'https://commandcode.ai'];
const COMPLETE_PATH = '/callback/complete';
const MAX_CALLBACK_BODY = 10000;
const LANDING_GRACE_MS = 10000;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_CONFIG_BYTES = 1024 * 1024;

const usage = `Usage:
  npm run login -- [--name <name>] [--proxy <url> | --proxy-env <VAR>] [options]
  npm run login -- --list
  npm run login -- --remove <name>

Adds (or updates) a Command Code account in the pool config, logging in exactly
like the official CLI: a browser login that hands a fresh API key back to a
local callback. You can also paste a key, pass one with --key, or import the
official CLI's saved login with --from-cli.

Options:
  --name <name>        Account name in the pool (default: derived from the user name)
  --proxy <url>        Account's outbound proxy, http:// or https:// (stored in the config)
  --proxy-env <VAR>    Store a proxyEnv reference instead of the literal proxy URL
  --pool-config <path> Pool config to edit (default: $CC_POOL_CONFIG or ./pool.json)
  --key <user_…>       Skip the browser: validate this key (through the proxy) and save it
  --from-cli [path]    Import the key saved by the official CLI (default ~/.commandcode/auth.json)
  --port <n>           Callback port (default: random; fix it when tunnelling over SSH)
  --no-open            Print the login URL instead of opening a browser
  --timeout-ms <n>     Browser login timeout (default ${DEFAULT_TIMEOUT_MS})
  --env <prod|staging> Command Code environment (default prod)
  --list               List accounts in the pool config (keys are masked)
  --remove <name>      Remove an account from the pool config
  --help               Show this message
`;

// ── 小工具 ──
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const maskKey = (k) => (typeof k === 'string' && k.length > 12 ? `${k.slice(0, 9)}…${k.slice(-4)}` : '(hidden)');
const say = (msg = '') => process.stderr.write(msg + '\n');
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// CLI 的 sanitizeCommandApiKeyInput：去掉括号粘贴标记与控制字符
function sanitizeKeyInput(raw) {
  const esc = String.fromCharCode(27);
  const s = String(raw).replaceAll(esc + '[200~', '').replaceAll(esc + '[201~', '').replaceAll('[200~', '').replaceAll('[201~', '');
  return Array.from(s).filter(ch => { const c = ch.charCodeAt(0); return c > 31 && c !== 127; }).join('').trim();
}

function proxyIdentity(url) {
  try { const p = parseProxyUrl(url); return `${p.host}:${p.port}|${p.auth || ''}`; } catch { return null; }
}

// ── 账号池配置：读（带版本）/ 原子写 ──
async function readPoolSnapshot(file) {
  let st;
  try {
    st = await fs.lstat(file, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { data: null, version: 'missing' };
    throw new Error(`Could not inspect the pool config: ${file}`);
  }
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('Pool config must be a regular file, not a symbolic link.');
  if (process.platform !== 'win32' && (Number(st.mode) & 0o077) !== 0) {
    throw new Error(`Pool config must be private: run chmod 600 ${file}`);
  }
  if (st.size > BigInt(MAX_CONFIG_BYTES)) throw new Error('Pool config exceeds 1 MiB.');
  const buf = await fs.readFile(file);
  let data;
  try { data = JSON.parse(buf.toString('utf8')); } catch { throw new Error('Pool config is not valid JSON.'); }
  if (!isObject(data) || !Array.isArray(data.accounts)) throw new Error('Pool config must contain an accounts array.');
  const version = `${st.ino}:${st.mtimeNs}:${st.size}:${crypto.createHash('sha256').update(buf).digest('hex')}`;
  return { data, version };
}

async function writePoolConfig(file, data, expectedVersion) {
  const current = await readPoolSnapshot(file);
  if (current.version !== expectedVersion) {
    throw new Error('Pool config changed while you were logging in; nothing was written. Run the command again.');
  }
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

function uniqueName(base, accounts, keepName) {
  let name = (base || 'account').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'account';
  const taken = new Set(accounts.map(a => a?.name).filter(n => n !== keepName));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
}

/** 按名字更新或追加账号；返回 { data, account, created }。冲突（key 复用 / 共享代理）直接报错。 */
function upsertAccount(data, { name, apiKey, proxy, proxyEnv, meta }) {
  const next = data ? structuredClone(data) : { accounts: [] };
  const accounts = next.accounts;
  const others = accounts.filter(a => a?.name !== name);
  const reused = others.find(a => a?.apiKey === apiKey);
  if (reused) throw new Error(`That key is already in the pool as "${reused.name}".`);
  if (proxy && next.allowSharedProxy !== true) {
    const id = proxyIdentity(proxy);
    const shared = others.find(a => typeof a?.proxy === 'string' && proxyIdentity(a.proxy) === id);
    if (shared) throw new Error(`"${shared.name}" already uses this proxy (same host, port and login). A shared exit IP links accounts; use another proxy or set allowSharedProxy.`);
  }
  let account = accounts.find(a => a?.name === name);
  const created = !account;
  if (!account) { account = { name }; accounts.push(account); }
  account.apiKey = apiKey;
  delete account.apiKeyEnv;
  if (proxy) { account.proxy = proxy; delete account.proxyEnv; }
  if (proxyEnv) { account.proxyEnv = proxyEnv; delete account.proxy; }
  for (const [k, v] of Object.entries(meta || {})) if (v) account[k] = v;
  return { data: next, account, created };
}

// ── 回调服务（对齐 CLI 的 createAuthServer）──
const page = (heading, message) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0c;color:#e8e8ea;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{color:#a0a0a8;line-height:1.5}</style></head>
<body><main><h1>${heading}</h1><p>${message}</p></main></body></html>`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createAuthServer(port, state) {
  let resolveCb;
  let rejectCb;
  const waitForCallback = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });
  let pending = null;
  let graceTimer = null;

  const respondHtml = (res, status, html, after) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(html, () => after?.());
  };
  const json = (res, status, body, extra = {}) => { res.writeHead(status, extra); res.end(JSON.stringify(body)); };
  const finish = () => {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    server.closeIdleConnections?.();
    server.close();
  };

  const handleBrowserCallback = (params, res) => {
    const error = params.get('error');
    if (error) {
      if (params.get('state') !== state) {
        respondHtml(res, 403, page('Invalid state token', 'The state token did not match this login attempt. Return to your terminal and restart login.'));
        return;
      }
      const desc = params.get('error_description');
      respondHtml(res, 200, error === 'access_denied'
        ? page('Authorization denied', 'You can close this tab.')
        : page('Authentication failed', escapeHtml(desc || error)), () => {
        rejectCb(new Error(error === 'access_denied' ? (desc || 'Authorization was denied by the user') : (desc || error)));
        finish();
      });
      return;
    }
    const creds = {
      apiKey: params.get('apiKey'), state: params.get('state'), userId: params.get('userId'),
      userName: params.get('userName'), keyName: params.get('keyName'),
    };
    if (!(creds.apiKey && creds.state && creds.userId && creds.userName && creds.keyName)) {
      respondHtml(res, 400, page('Invalid request', 'Required parameters are missing. Return to your terminal and restart login, or paste your API key there manually.'));
      return;
    }
    if (creds.state !== state) {
      respondHtml(res, 403, page('Invalid state token', 'The state token did not match this login attempt. Return to your terminal and restart login.'));
      return;
    }
    pending = creds;
    // 落地页没被访问到也要在宽限期后完成（CLI 的 landingGraceMs）
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!pending) return;
      const c = pending; pending = null;
      resolveCb(c); finish();
    }, LANDING_GRACE_MS);
    graceTimer.unref();
    res.writeHead(303, { Location: `${COMPLETE_PATH}?state=${encodeURIComponent(state)}`, 'Cache-Control': 'no-store', 'Content-Length': '0' });
    res.end();
  };

  const handleLegacyJson = (text, res) => {
    let body;
    try { body = JSON.parse(text); } catch { json(res, 400, { success: false, error: 'Invalid JSON' }); return; }
    if (isObject(body) && 'error' in body) {
      if (body.state !== state) { json(res, 403, { success: false, error: 'Invalid state token' }); return; }
      json(res, 200, { success: true });
      rejectCb(new Error(body.error_description || body.error));
      server.close();
      return;
    }
    const ok = isObject(body) && typeof body.apiKey === 'string' && body.apiKey && typeof body.state === 'string'
      && typeof body.userId === 'string' && typeof body.userName === 'string' && typeof body.keyName === 'string';
    if (!ok) { json(res, 400, { success: false, error: 'Missing required fields' }); return; }
    if (body.state !== state) { json(res, 403, { success: false, error: 'Invalid state token' }); return; }
    json(res, 200, { success: true });
    resolveCb(body);
    server.close();
  };

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { json(res, 400, { success: false, error: 'Bad request' }, { 'Content-Type': 'application/json' }); return; }
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin && CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0]);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') {
      // Chrome 的 Private Network Access 预检
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204); res.end(); return;
    }
    if (req.method === 'GET' && url.pathname === COMPLETE_PATH) {
      if (url.searchParams.get('state') !== state) { respondHtml(res, 403, page('Invalid state token', 'The state token did not match this login attempt. Return to your terminal and restart login.')); return; }
      if (!pending) { respondHtml(res, 404, page('Return to your terminal', 'This page completes login automatically during sign-in. Restart login from your terminal if you reached it directly.')); return; }
      const c = pending; pending = null;
      respondHtml(res, 200, page('Logged in to Command Code', `Signed in as ${escapeHtml(c.userName)}. You can close this tab and return to your terminal.`), () => { resolveCb(c); finish(); });
      return;
    }
    if (url.pathname !== '/callback') { json(res, 404, { success: false, error: 'Not found' }); return; }
    if (req.method === 'GET') {
      res.setHeader('Allow', 'POST, OPTIONS');
      respondHtml(res, 405, page('Return to your terminal', 'This page completes login automatically during sign-in. Restart login from your terminal if you reached it directly.'));
      return;
    }
    if (req.method !== 'POST') { json(res, 405, { success: false, error: 'Method not allowed. Use POST.' }, { Allow: 'POST, OPTIONS' }); return; }
    const ctype = ((req.headers['content-type'] ?? '').split(';')[0] ?? '').trim().toLowerCase();
    if (ctype !== 'application/json' && ctype !== 'application/x-www-form-urlencoded') { json(res, 415, { success: false, error: 'Unsupported content type' }, { Connection: 'close' }); return; }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_CALLBACK_BODY) { json(res, 413, { success: false, error: 'Payload too large' }, { Connection: 'close' }); return; }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_CALLBACK_BODY) { tooBig = true; json(res, 413, { success: false, error: 'Payload too large' }, { Connection: 'close' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (ctype === 'application/x-www-form-urlencoded') handleBrowserCallback(new URLSearchParams(text), res);
      else handleLegacyJson(text, res);
    });
    req.on('error', () => { if (!tooBig) json(res, 500, { success: false, error: 'Request error' }); });
  });

  const listening = new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', rej); res(server.address().port); });
  });
  return { server, listening, waitForCallback };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

/** CLI 的 validateCommandApiKey：GET /alpha/whoami，只带 Content-Type 与 Authorization —— 这里经由账号自己的代理。 */
async function validateKey(apiKey, { apiBase, upstream }) {
  let r;
  try {
    r = await upstream(`${apiBase}/alpha/whoami`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { valid: false, error: 'network_error', message: e.cause?.message || e.message };
  }
  if (r.status === 401) { r.body?.cancel().catch(() => {}); return { valid: false, error: 'invalid_key' }; }
  if (!r.ok) { r.body?.cancel().catch(() => {}); return { valid: false, error: 'server_error', message: `HTTP ${r.status}` }; }
  let who = null;
  try { who = await r.json(); } catch {}
  return { valid: true, who };
}

function metaFromWhoami(who) {
  const user = who?.user ?? who ?? {};
  return {
    userId: typeof user.id === 'string' ? user.id : (typeof user.userId === 'string' ? user.userId : undefined),
    userName: typeof user.userName === 'string' ? user.userName : (typeof user.username === 'string' ? user.username : (typeof user.name === 'string' ? user.name : undefined)),
  };
}

// ── 登录方式 ──
async function browserLogin({ port, open, timeoutMs, env, apiBase, upstream }) {
  const state = crypto.randomBytes(32).toString('base64url');
  const { server, listening, waitForCallback } = createAuthServer(port, state);
  const boundPort = await listening;
  const url = `${STUDIO_BASE[env]}/studio/auth/cli?callback=${encodeURIComponent(`http://127.0.0.1:${boundPort}/callback`)}&state=${encodeURIComponent(state)}&mode=redirect`;

  say('');
  say('Open this link to log in to Command Code:');
  say(`  ${url}`);
  say('');
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform === 'linux') {
    say(`Browser on another machine? Forward the callback port first, then open the link there:`);
    say(`  ssh -L ${boundPort}:127.0.0.1:${boundPort} <user>@<this-server>`);
    say('');
  }
  if (open) {
    const opened = await openBrowser(url);
    if (!opened) say('(Could not open a browser automatically — open the link above.)');
  }

  // 与 CLI 一样提供手动分支：粘贴 key 也行（TTY 时）
  let rl = null;
  const manual = new Promise((resolve) => {
    if (!process.stdin.isTTY) return;
    say('Or paste an API key (user_…) here and press Enter.');
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', async (line) => {
      const key = sanitizeKeyInput(line);
      if (!key) return;
      if (!/^user_[A-Za-z0-9_-]+$/.test(key)) { say('That does not look like a Command Code key (user_…). Try again.'); return; }
      say('Validating API key...');
      const v = await validateKey(key, { apiBase, upstream });
      if (!v.valid) {
        say(v.error === 'invalid_key' ? 'Invalid API key. Paste a valid API key.' : `Could not validate the key (${v.message || v.error}). Try again.`);
        return;
      }
      resolve({ apiKey: key, ...metaFromWhoami(v.who), source: 'manual' });
    });
  });

  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Browser authentication timed out')), timeoutMs); timer.unref(); });
  try {
    const result = await Promise.race([waitForCallback.then(c => ({ ...c, source: 'browser' })), manual, timeout]);
    return result;
  } finally {
    clearTimeout(timer);
    rl?.close();
    server.closeAllConnections?.();
    server.close();
  }
}

async function importCliLogin(file) {
  const target = file || path.join(os.homedir(), '.commandcode', 'auth.json');
  let data;
  try { data = JSON.parse(await fs.readFile(target, 'utf8')); } catch { throw new Error(`Could not read the CLI login at ${target} (run \`cmd login\` there first).`); }
  if (typeof data?.apiKey !== 'string' || !data.apiKey) throw new Error(`No apiKey in ${target}.`);
  return { apiKey: data.apiKey, userId: data.userId, userName: data.userName, keyName: data.keyName, authenticatedAt: data.authenticatedAt, source: 'cli' };
}

// ── 入口 ──
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' }, proxy: { type: 'string' }, 'proxy-env': { type: 'string' },
      'pool-config': { type: 'string' }, key: { type: 'string' }, 'from-cli': { type: 'boolean' },
      port: { type: 'string' }, 'no-open': { type: 'boolean' }, 'timeout-ms': { type: 'string' },
      env: { type: 'string' }, list: { type: 'boolean' }, remove: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { process.stdout.write(usage); return; }

  const poolPath = path.resolve(values['pool-config'] || process.env.CC_POOL_CONFIG || path.join(__dirname, 'pool.json'));
  const snapshot = await readPoolSnapshot(poolPath);

  if (values.list) {
    const accounts = snapshot.data?.accounts ?? [];
    if (!accounts.length) { say(`No accounts in ${poolPath}.`); return; }
    for (const a of accounts) {
      const key = a.apiKey ? maskKey(a.apiKey) : a.apiKeyEnv ? `$${a.apiKeyEnv}` : '(no key)';
      const proxy = a.proxy ? redactProxyUrl(a.proxy) : a.proxyEnv ? `$${a.proxyEnv}` : '(direct)';
      say(`${a.name}${a.enabled === false ? ' [disabled]' : ''}  ${key}  via ${proxy}${a.userName ? `  (${a.userName})` : ''}`);
    }
    return;
  }

  if (values.remove) {
    const accounts = snapshot.data?.accounts ?? [];
    if (!accounts.some(a => a?.name === values.remove)) throw new Error(`No account named "${values.remove}" in ${poolPath}.`);
    const next = structuredClone(snapshot.data);
    next.accounts = accounts.filter(a => a?.name !== values.remove);
    await writePoolConfig(poolPath, next, snapshot.version);
    say(`Removed "${values.remove}" from ${poolPath}. Restart the proxy to apply.`);
    return;
  }

  if (values.name && !NAME_RE.test(values.name)) throw new Error('--name must be 1-64 characters of A-Z a-z 0-9 _ . -');
  if (values.proxy && values['proxy-env']) throw new Error('Use --proxy or --proxy-env, not both.');
  let proxyUrl = values.proxy;
  if (values['proxy-env']) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['proxy-env'])) throw new Error('--proxy-env must be an environment variable name.');
    proxyUrl = process.env[values['proxy-env']];
    if (!proxyUrl) throw new Error(`Set ${values['proxy-env']} in this shell too — login uses it to validate keys through the proxy.`);
  }
  if (proxyUrl) {
    try { parseProxyUrl(proxyUrl); } catch (e) { throw new Error(`--proxy: ${e.message}`); }
  }
  const env = values.env || 'prod';
  if (!STUDIO_BASE[env]) throw new Error('--env must be prod or staging.');
  const apiBase = process.env.CC_API_BASE || 'https://api.commandcode.ai';
  const port = values.port ? Number.parseInt(values.port, 10) : 0;
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new Error('--port must be 0-65535.');
  const timeoutMs = values['timeout-ms'] ? Number.parseInt(values['timeout-ms'], 10) : DEFAULT_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new Error('--timeout-ms must be a positive integer.');

  // 预检：在登录之前就把会导致写入失败的冲突挑出来（名字合法、代理不共享）
  const existing = snapshot.data?.accounts ?? [];
  upsertAccount(snapshot.data, { name: values.name || '\0preflight', apiKey: 'user_preflight_' + crypto.randomBytes(8).toString('hex'), proxy: values.proxy });

  const upstream = createUpstreamFetch({ proxy: proxyUrl || '' });
  say(proxyUrl
    ? `Account egress: ${redactProxyUrl(proxyUrl)}. Key validation and all proxy traffic for this account go through it.`
    : 'No proxy given: this account will use this machine\'s own IP.');

  let creds;
  try {
    if (values['from-cli']) {
      creds = await importCliLogin(positionals[0]);
    } else if (values.key) {
      const key = sanitizeKeyInput(values.key);
      say('Validating API key...');
      const v = await validateKey(key, { apiBase, upstream });
      if (!v.valid) throw new Error(v.error === 'invalid_key' ? 'Invalid API key.' : `Could not validate the key: ${v.message || v.error}`);
      creds = { apiKey: key, ...metaFromWhoami(v.who), source: 'manual' };
    } else {
      if (proxyUrl) {
        say('Note: the browser login itself is not routed through this proxy (the CLI makes no request during it).');
        say('      For a single-IP account history, open the link in a browser that uses the same proxy.');
      }
      creds = await browserLogin({ port, open: !values['no-open'], timeoutMs, env, apiBase, upstream });
    }
  } finally {
    upstream.close();
  }

  if (!/^user_[A-Za-z0-9_-]+$/.test(creds.apiKey)) throw new Error('Login returned an unexpected key format.');
  const name = values.name || uniqueName(creds.userName || creds.keyName, existing);
  const { data, created } = upsertAccount(snapshot.data, {
    name,
    apiKey: creds.apiKey,
    proxy: values.proxy,
    proxyEnv: values['proxy-env'],
    meta: {
      userId: creds.userId,
      userName: creds.userName,
      keyName: creds.keyName,
      authenticatedAt: creds.authenticatedAt || new Date().toISOString(),
    },
  });
  await writePoolConfig(poolPath, data, snapshot.version);

  try { normalizePoolConfig(data, process.env); } catch (e) { say(`Warning: the pool config does not load cleanly yet: ${e.message}`); }
  say('');
  say(`${created ? 'Added' : 'Updated'} account "${name}"${creds.userName ? ` (${creds.userName})` : ''}, key ${maskKey(creds.apiKey)}, via ${proxyUrl ? redactProxyUrl(proxyUrl) : 'direct'}.`);
  say(`Saved to ${poolPath} (mode 600). Restart the proxy to load it:`);
  say(`  HOST=127.0.0.1 CC_POOL_CONFIG=${poolPath} npm start`);
}

main().then(() => process.exit(0), (e) => {
  say(`Login failed: ${e?.message || e}`);
  process.exit(1);
});
