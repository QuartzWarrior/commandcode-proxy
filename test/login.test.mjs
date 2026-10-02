// login.mjs：CLI 同款浏览器登录（回调服务 / state 校验 / 303 落地页 / 拒绝授权）、粘贴 key 经代理验证、
// 导入官方 CLI 的登录、以及账号池配置的增改删（保留其它设置、600 权限、冲突拒写）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, allocPort, closeServer } from './helpers.mjs';

const KEY = 'user_loginkeyaaaaaaaa';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-login-'));
  return { dir, pool: join(dir, 'pool.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function writePool(file, data) { writeFileSync(file, JSON.stringify(data)); chmodSync(file, 0o600); }
const readPool = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** 跑 login.mjs；onStderr 可在看到登录链接后驱动「网页」。 */
function runLogin(args, { env = {}, onStderr } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, 'login.mjs'), ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; onStderr?.(err); });
    child.on('exit', (code) => resolve({ code, stderr: err, stdout: out }));
    setTimeout(() => child.kill(), 20000).unref();
  });
}

const loginUrlOf = (text) => /(https?:\/\/\S+\/studio\/auth\/cli\?\S+)/.exec(text)?.[1];

/** 最小 CONNECT 代理：记录经它出去的上游连接本地端口。 */
async function startConnectProxy() {
  const port = await allocPort();
  const localPorts = new Set();
  const server = http.createServer();
  server.on('connect', (req, client, head) => {
    const [host, p] = req.url.split(':');
    const up = net.connect(Number(p), host, () => {
      localPorts.add(up.localPort);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, localPorts, close: () => closeServer(server) };
}

async function startWhoami(status = 200) {
  const port = await allocPort();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, remotePort: req.socket.remotePort });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? '{"user":{"id":"u_1","userName":"pasted-user"},"org":{"id":"o1"}}' : '{"error":{"message":"nope"}}');
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, seen, close: () => closeServer(server) };
}

test('浏览器登录：链接形态对齐 CLI；state 不符 403；表单回调 303 → 落地页 → 写入账号（名字取自用户名，带代理，600 权限）', async () => {
  const t = tmp();
  writePool(t.pool, { maxInflightPerAccount: 8, accounts: [{ name: 'existing', apiKey: 'user_existingkeyyyyy' }] });
  let driven = false;
  const steps = {};
  try {
    const result = await runLogin(['--no-open', '--pool-config', t.pool, '--proxy', 'http://u:secret@10.9.8.7:3128'], {
      onStderr: async (text) => {
        const link = loginUrlOf(text);
        if (!link || driven) return;
        driven = true;
        const u = new URL(link);
        steps.link = u;
        const callback = u.searchParams.get('callback');
        const state = u.searchParams.get('state');
        const post = (body) => fetch(callback, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://commandcode.ai' }, body: new URLSearchParams(body) });
        const pre = await fetch(callback, { method: 'OPTIONS', headers: { Origin: 'https://commandcode.ai', 'Access-Control-Request-Private-Network': 'true' } });
        steps.preflight = { status: pre.status, pna: pre.headers.get('access-control-allow-private-network'), origin: pre.headers.get('access-control-allow-origin') };
        steps.bad = (await post({ apiKey: KEY, state: 'wrong', userId: 'u1', userName: 'Alice Smith', keyName: 'cli' })).status;
        const ok = await post({ apiKey: KEY, state, userId: 'u1', userName: 'Alice Smith', keyName: 'cli' });
        steps.okStatus = ok.status;
        steps.location = ok.headers.get('location');
        const landing = await fetch(new URL(steps.location, callback));
        steps.landing = landing.status;
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(steps.link.origin + steps.link.pathname, 'https://commandcode.ai/studio/auth/cli');
    assert.match(steps.link.searchParams.get('callback'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.match(steps.link.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(steps.link.searchParams.get('mode'), 'redirect');
    assert.deepEqual(steps.preflight, { status: 204, pna: 'true', origin: 'https://commandcode.ai' });
    assert.equal(steps.bad, 403);
    assert.equal(steps.okStatus, 303);
    assert.match(steps.location, /^\/callback\/complete\?state=/);
    assert.equal(steps.landing, 200);
    assert.ok(!result.stderr.includes(KEY), 'full key must not be printed');
    assert.ok(!result.stderr.includes('secret'), 'proxy password must not be printed');

    const pool = readPool(t.pool);
    assert.equal(pool.maxInflightPerAccount, 8, 'unrelated settings preserved');
    assert.equal(pool.accounts[0].name, 'existing');
    const added = pool.accounts[1];
    assert.equal(added.name, 'Alice-Smith');
    assert.equal(added.apiKey, KEY);
    assert.equal(added.proxy, 'http://u:secret@10.9.8.7:3128');
    assert.equal(added.userName, 'Alice Smith');
    assert.equal(statSync(t.pool).mode & 0o777, 0o600);
  } finally {
    t.cleanup();
  }
});

test('浏览器登录：拒绝授权 → 失败退出且不写配置', async () => {
  const t = tmp();
  let driven = false;
  try {
    const result = await runLogin(['--no-open', '--pool-config', t.pool], {
      onStderr: async (text) => {
        const link = loginUrlOf(text);
        if (!link || driven) return;
        driven = true;
        const u = new URL(link);
        await fetch(u.searchParams.get('callback'), {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ error: 'access_denied', state: u.searchParams.get('state') }),
        });
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /denied/i);
    assert.throws(() => statSync(t.pool), /ENOENT/);
  } finally {
    t.cleanup();
  }
});

test('--key：经账号代理验证（CLI 的 validateCommandApiKey 头形态），新建 600 配置；401 拒绝', async () => {
  const t = tmp();
  const proxy = await startConnectProxy();
  const who = await startWhoami();
  try {
    const result = await runLogin(['--key', KEY, '--name', 'bob', '--proxy', proxy.url, '--pool-config', t.pool], { env: { CC_API_BASE: who.base } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(who.seen.length, 1);
    const req = who.seen[0];
    assert.equal(req.url, '/alpha/whoami');
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.ok(proxy.localPorts.has(req.remotePort), 'validation must go through the account proxy');
    const pool = readPool(t.pool);
    assert.deepEqual(pool.accounts.map(a => [a.name, a.apiKey, a.proxy, a.userName]), [['bob', KEY, proxy.url, 'pasted-user']]);
    assert.equal(statSync(t.pool).mode & 0o777, 0o600);
  } finally {
    await proxy.close(); await who.close(); t.cleanup();
  }
  const t2 = tmp();
  const bad = await startWhoami(401);
  try {
    const result = await runLogin(['--key', KEY, '--pool-config', t2.pool], { env: { CC_API_BASE: bad.base } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid API key/);
  } finally {
    await bad.close(); t2.cleanup();
  }
});

test('--from-cli：导入官方 CLI 保存的登录；同名账号更新 key 与代理（去掉旧的 *Env 引用）', async () => {
  const t = tmp();
  const home = join(t.dir, 'home');
  mkdirSync(join(home, '.commandcode'), { recursive: true });
  writeFileSync(join(home, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: KEY, userId: 'u9', userName: 'cli-user', keyName: 'laptop', authenticatedAt: '2026-09-01T00:00:00.000Z' }));
  writePool(t.pool, { diagnostics: true, accounts: [{ name: 'carol', apiKeyEnv: 'OLD_KEY', proxyEnv: 'OLD_PROXY', weight: 2 }] });
  try {
    const result = await runLogin(['--from-cli', '--name', 'carol', '--proxy', 'https://p.example:443', '--pool-config', t.pool], { env: { HOME: home } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Updated account "carol"/);
    const pool = readPool(t.pool);
    assert.equal(pool.diagnostics, true);
    assert.deepEqual(pool.accounts, [{
      name: 'carol', weight: 2, apiKey: KEY, proxy: 'https://p.example:443',
      userId: 'u9', userName: 'cli-user', keyName: 'laptop', authenticatedAt: '2026-09-01T00:00:00.000Z',
    }]);
  } finally {
    t.cleanup();
  }
});

test('冲突与安全：key 复用 / 共享代理 / 配置对他人可读 → 拒绝且不改文件；--list 打码；--remove', async () => {
  const t = tmp();
  const home = join(t.dir, 'home');
  mkdirSync(join(home, '.commandcode'), { recursive: true });
  writeFileSync(join(home, '.commandcode', 'auth.json'), JSON.stringify({ apiKey: KEY }));
  const base = { accounts: [{ name: 'a', apiKey: KEY, proxy: 'http://u:p@1.1.1.1:8080' }, { name: 'b', apiKey: 'user_bbbbbbbbbbbbbb' }] };
  writePool(t.pool, base);
  const before = readFileSync(t.pool, 'utf8');
  try {
    let r = await runLogin(['--from-cli', '--name', 'z', '--pool-config', t.pool], { env: { HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in the pool as "a"/);

    r = await runLogin(['--from-cli', '--name', 'b', '--proxy', 'http://u:p@1.1.1.1:8080', '--pool-config', t.pool], { env: { HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already uses this proxy/);
    assert.equal(readFileSync(t.pool, 'utf8'), before);

    r = await runLogin(['--list', '--pool-config', t.pool]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /a {2}user_logi…aaaa {2}via http:\/\/1\.1\.1\.1:8080/);
    assert.ok(!r.stderr.includes(KEY) && !r.stderr.includes('u:p@'));

    r = await runLogin(['--remove', 'b', '--pool-config', t.pool]);
    assert.equal(r.code, 0);
    assert.deepEqual(readPool(t.pool).accounts.map(a => a.name), ['a']);

    chmodSync(t.pool, 0o644);
    r = await runLogin(['--list', '--pool-config', t.pool]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /chmod 600/);
  } finally {
    t.cleanup();
  }
});
