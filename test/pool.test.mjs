// 账号池端到端：真代理进程 + mock 上游 + mock CONNECT 代理（明文 / TLS）。
//
// 守住的边界：
//   ① 负载分摊到多个账号；每个账号的所有上游流量（generate / 指纹 / lifecycle）只走它自己的代理；
//   ② 跨账号无共享标识：x-project-slug / 工作目录 / session id 各不相同，客户端的会话 id 不原样上送；
//   ③ 429 / 额度 / 401 让账号冷却并把错误交还下游 —— 绝不把同一请求重放到别的账号；
//   ④ 代理挂了 → 502，绝不回落直连；
//   ⑤ 非回环地址默认拒绝启动；/pool/stats 默认关闭且不含 key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocPort, closeServer, startProxy } from './helpers.mjs';

const KEY_A = 'user_poolaaaaaaaa';
const KEY_B = 'user_poolbbbbbbbb';
const KEY_OWN = 'user_ownclientkey';
const OK_LINES = [
  '{"type":"text-delta","text":"hi"}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2}}',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 可编排的 CC 上游。behavior(key, nthGenerateForKey) → 'ok' | { status, body, headers } | { streamError }
 * 记录每个请求的来源端口，用来核对它是从哪个 mock 代理出来的。
 */
async function startUpstream(behavior = () => 'ok', { delayMs = 0 } = {}) {
  const port = await allocPort();
  const seen = [];
  const perKey = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const key = (req.headers.authorization || '').replace(/^Bearer /, '');
      seen.push({ url: req.url, key, headers: req.headers, raw, remotePort: req.socket.remotePort });
      if (req.url !== '/alpha/generate') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":[{"id":"m-' + key.slice(-4) + '"}]}');
        return;
      }
      const n = (perKey.get(key) || 0) + 1;
      perKey.set(key, n);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      const action = behavior(key, n);
      if (action !== 'ok' && action.status) {
        res.writeHead(action.status, { 'Content-Type': 'application/json', ...(action.headers || {}) });
        res.end(action.body || '{"error":{"message":"mock error"}}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (action !== 'ok' && action.streamError) {
        res.end(JSON.stringify({ type: 'error', error: action.streamError }) + '\n');
        return;
      }
      for (const line of OK_LINES) res.write(line + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, seen,
    generates: (key) => seen.filter(s => s.url === '/alpha/generate' && (!key || s.key === key)),
    close: () => closeServer(server),
  };
}

/** 最小 CONNECT 代理。tlsOpts 给了就是 https:// 代理。记录自己连上游用的本地端口。 */
async function startConnectProxy(tlsOpts) {
  const port = await allocPort();
  const state = { tunnels: 0, localPorts: new Set() };
  const server = tlsOpts ? https.createServer(tlsOpts) : http.createServer();
  const sockets = new Set();
  server.on('connect', (req, client, head) => {
    state.tunnels++;
    const [host, p] = req.url.split(':');
    const up = net.connect(Number(p), host, () => {
      state.localPorts.add(up.localPort);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    sockets.add(up); sockets.add(client);
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, state,
    url: `${tlsOpts ? 'https' : 'http'}://127.0.0.1:${port}`,
    close: async () => { for (const s of sockets) s.destroy(); await closeServer(server); },
  };
}

/** 写一个 600 权限的池配置，起代理。 */
async function startPooled(upstream, poolCfg, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-pool-e2e-'));
  const cfgPath = join(dir, 'pool.json');
  writeFileSync(cfgPath, JSON.stringify(poolCfg));
  chmodSync(cfgPath, 0o600);
  try {
    const proxy = await startProxy({ upstreamPort: upstream.port, env: { CC_POOL_CONFIG: cfgPath, ...env } });
    const kill = proxy.kill;
    proxy.kill = async () => { await kill(); rmSync(dir, { recursive: true, force: true }); };
    return proxy;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

const chat = (content, extra = {}) => ({ model: 'm', messages: [{ role: 'user', content }], ...extra });

test('负载分摊 + 每个账号的全部上游流量只走自己的代理（指纹/lifecycle 也是），并发首请求只报一次指纹', async () => {
  const upstream = await startUpstream(() => 'ok', { delayMs: 150 });
  const pa = await startConnectProxy();
  const pb = await startConnectProxy();
  const proxy = await startPooled(upstream, {
    accounts: [
      { name: 'a', apiKey: KEY_A, proxy: pa.url },
      { name: 'b', apiKey: KEY_B, proxy: pb.url },
    ],
  });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => proxy.post('/v1/chat/completions', chat(`q${i}`))));
    for (const r of results) assert.equal(r.status, 200, await r.text());
    assert.equal(upstream.generates(KEY_A).length, 3);
    assert.equal(upstream.generates(KEY_B).length, 3);

    for (const s of upstream.seen) {
      const own = s.key === KEY_A ? pa : pb;
      const other = s.key === KEY_A ? pb : pa;
      assert.ok(own.state.localPorts.has(s.remotePort), `${s.url} for ${s.key} did not come through its own proxy`);
      assert.ok(!other.state.localPorts.has(s.remotePort));
    }
    for (const key of [KEY_A, KEY_B]) {
      assert.equal(upstream.seen.filter(s => s.key === key && s.url === '/alpha/fingerprint/record').length, 1);
      assert.equal(upstream.seen.filter(s => s.key === key && s.url === '/alpha/lifecycle-events').length, 1);
    }
  } finally {
    await proxy.kill(); await pa.close(); await pb.close(); await upstream.close();
  }
});

test('跨账号无共享标识：项目路径/slug 各账号不同且自洽；客户端会话 id 不原样上送', async () => {
  const upstream = await startUpstream();
  const proxy = await startPooled(upstream, {
    accounts: [{ name: 'a', apiKey: KEY_A }, { name: 'b', apiKey: KEY_B }],
  });
  try {
    const clientSid = 'client-session-0001';
    for (let i = 0; i < 2; i++) {
      // 不同会话 → 轮转到两个账号
      const r = await proxy.post('/v1/chat/completions', chat('x'), { 'x-session-id': `${clientSid}-${i}` });
      assert.equal(r.status, 200);
    }
    const [ga, gb] = [upstream.generates(KEY_A)[0], upstream.generates(KEY_B)[0]];
    assert.ok(ga && gb, 'both accounts should have served one request');
    const [ba, bb] = [JSON.parse(ga.raw), JSON.parse(gb.raw)];
    assert.notEqual(ga.headers['x-project-slug'], gb.headers['x-project-slug']);
    assert.notEqual(ba.config.workingDir, bb.config.workingDir);
    for (const [g, b] of [[ga, ba], [gb, bb]]) {
      assert.match(b.config.workingDir, /^C:\\Users\\[a-z]+\\projects\\[a-z-]+$/);
      assert.equal(g.headers['x-project-slug'], b.config.workingDir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
      assert.ok(!g.headers['x-session-id'].startsWith(clientSid));
      assert.match(g.headers['x-session-id'], UUID_RE);
      assert.equal(b.threadId, g.headers['x-session-id']);
    }
  } finally {
    await proxy.kill(); await upstream.close();
  }
});

test('会话粘性；429 → 错误交还下游、不重放到别的账号；下一轮改派且换成另一个 session id', async () => {
  let failFor = null;
  const upstream = await startUpstream((key) => (key === failFor
    ? { status: 429, headers: { 'Retry-After': '120' }, body: '{"error":{"message":"slow down"}}' }
    : 'ok'));
  const proxy = await startPooled(upstream, {
    accounts: [{ name: 'a', apiKey: KEY_A }, { name: 'b', apiKey: KEY_B }],
    diagnostics: true,
  });
  try {
    const H = { 'x-claude-code-session-id': 'sticky-conversation-1' };
    for (let i = 0; i < 3; i++) assert.equal((await proxy.post('/v1/chat/completions', chat(`t${i}`), H)).status, 200);
    const owner = upstream.generates(KEY_A).length === 3 ? KEY_A : KEY_B;
    const other = owner === KEY_A ? KEY_B : KEY_A;
    assert.equal(upstream.generates(owner).length, 3);
    assert.equal(upstream.generates(other).length, 0);
    const ownerSid = upstream.generates(owner)[0].headers['x-session-id'];

    failFor = owner;
    const r = await proxy.post('/v1/chat/completions', chat('t3'), H);
    assert.equal(r.status, 429);
    assert.equal(upstream.generates(other).length, 0, 'request must not be replayed on another account');

    const stats = await (await proxy.get('/pool/stats')).json();
    const ownerName = owner === KEY_A ? 'a' : 'b';
    const st = stats.accounts.find(a => a.name === ownerName);
    assert.equal(st.healthy, false);
    assert.ok(st.cooldownRemainingMs > 100000 && st.cooldownRemainingMs <= 120000, String(st.cooldownRemainingMs));
    assert.match(st.reason, /rate limited/);

    const r2 = await proxy.post('/v1/chat/completions', chat('t4'), H);
    assert.equal(r2.status, 200);
    const moved = upstream.generates(other);
    assert.equal(moved.length, 1);
    assert.notEqual(moved[0].headers['x-session-id'], ownerSid);
  } finally {
    await proxy.kill(); await upstream.close();
  }
});

test('额度耗尽（流内 error 事件）→ 长冷却；401 → 隔离；全员不可用 → 429 + retry_after', async () => {
  const upstream = await startUpstream((key) => (key === KEY_A
    ? { streamError: { message: 'Monthly usage exceeded', code: 'USAGE_EXCEEDED', statusCode: 429 } }
    : { status: 401, body: '{"error":{"message":"invalid key"}}' }));
  const proxy = await startPooled(upstream, {
    accounts: [{ name: 'a', apiKey: KEY_A }, { name: 'b', apiKey: KEY_B }],
    diagnostics: true,
    queueTimeoutMs: 2000,
  });
  try {
    const r1 = await proxy.post('/v1/chat/completions', chat('one'));
    const r2 = await proxy.post('/v1/chat/completions', chat('two'));
    assert.deepEqual([r1.status, r2.status].sort(), [401, 429]);
    const stats = await (await proxy.get('/pool/stats')).json();
    const a = stats.accounts.find(x => x.name === 'a');
    const b = stats.accounts.find(x => x.name === 'b');
    assert.match(a.reason, /quota/);
    assert.ok(a.cooldownRemainingMs > 25 * 60 * 1000);
    assert.equal(b.quarantined, true);
    assert.match(b.reason, /auth rejected/);

    const before = upstream.generates().length;
    const r3 = await proxy.post('/v1/chat/completions', chat('three'));
    assert.equal(r3.status, 429);
    const body = await r3.json();
    assert.ok(body.retry_after > 0);
    assert.match(body.error.message, /cooling down/);
    assert.equal(upstream.generates().length, before, 'no upstream call while every account is cooling');

    // Anthropic / Responses 也按各自协议形态回准入错误
    const m = await proxy.post('/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(m.status, 429);
    assert.equal((await m.json()).type, 'error');
    const rs = await proxy.post('/v1/responses', { model: 'm', input: 'x' });
    assert.equal(rs.status, 429);
  } finally {
    await proxy.kill(); await upstream.close();
  }
});

test('代理挂了 → 502，绝不回落直连', async () => {
  const upstream = await startUpstream();
  const deadPort = await allocPort();
  const proxy = await startPooled(upstream, {
    accounts: [{ name: 'a', apiKey: KEY_A, proxy: `http://127.0.0.1:${deadPort}` }],
  }, { CC_UPSTREAM_RETRY_MAX: '0' });
  try {
    const r = await proxy.post('/v1/chat/completions', chat('x'));
    assert.equal(r.status, 502);
    assert.equal(upstream.seen.length, 0, 'nothing may reach upstream directly');
  } finally {
    await proxy.kill(); await upstream.close();
  }
});

test('https:// 代理：与代理之间 TLS（NODE_EXTRA_CA_CERTS 信任测试 CA），流量经它到达上游', async (t) => {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'ccp-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    t.skip('openssl not available');
    return;
  }
  const upstream = await startUpstream();
  const tp = await startConnectProxy({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) });
  const proxy = await startPooled(upstream, {
    accounts: [{ name: 'a', apiKey: KEY_A, proxy: tp.url }],
  }, { NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') });
  try {
    const r = await proxy.post('/v1/chat/completions', chat('x'));
    assert.equal(r.status, 200, await r.text());
    assert.ok(tp.state.tunnels >= 1);
    for (const s of upstream.seen) assert.ok(tp.state.localPorts.has(s.remotePort));
  } finally {
    await proxy.kill(); await tp.close(); await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自带 user_ key 的请求默认透传（不占池）；passthroughClientKeys=false 时忽略客户端 key', async () => {
  const upstream = await startUpstream();
  const p1 = await startPooled(upstream, { accounts: [{ name: 'a', apiKey: KEY_A }] });
  try {
    const r = await p1.post('/v1/chat/completions', chat('x'), { Authorization: `Bearer ${KEY_OWN}` });
    assert.equal(r.status, 200);
    assert.equal(upstream.generates(KEY_OWN).length, 1);
    assert.equal(upstream.generates(KEY_A).length, 0);
  } finally {
    await p1.kill();
  }
  const p2 = await startPooled(upstream, { accounts: [{ name: 'a', apiKey: KEY_A }], passthroughClientKeys: false });
  try {
    const r = await p2.post('/v1/chat/completions', chat('x'), { Authorization: `Bearer ${KEY_OWN}` });
    assert.equal(r.status, 200);
    assert.equal(upstream.generates(KEY_OWN).length, 1);
    assert.equal(upstream.generates(KEY_A).length, 1);
  } finally {
    await p2.kill(); await upstream.close();
  }
});

test('/v1/models 用池账号自己的目录；/pool/stats 默认关闭，开启后不含 key', async () => {
  const upstream = await startUpstream();
  const p1 = await startPooled(upstream, { accounts: [{ name: 'a', apiKey: KEY_A }] },
    { CC_USE_PROVIDER_MODELS: 'true' });
  try {
    const models = await (await p1.get('/v1/models')).json();
    assert.deepEqual(models.data.map(m => m.id), ['m-aaaa']);
    assert.equal((await p1.get('/pool/stats')).status, 404);
  } finally {
    await p1.kill();
  }
  const p2 = await startPooled(upstream, { accounts: [{ name: 'a', apiKey: KEY_A, proxy: 'http://u:hunter2@127.0.0.1:9' }], diagnostics: true });
  try {
    const r = await p2.get('/pool/stats');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const text = await r.text();
    assert.ok(!text.includes(KEY_A) && !text.includes('hunter2'));
    assert.ok(!p2.logs().includes(KEY_A) && !p2.logs().includes('hunter2'), 'secrets must not reach logs');
  } finally {
    await p2.kill(); await upstream.close();
  }
});

test('非回环地址：默认拒绝启动；allowNetwork 放行', async () => {
  const upstream = await startUpstream();
  try {
    await assert.rejects(
      startPooled(upstream, { accounts: [{ name: 'a', apiKey: KEY_A }] }, { HOST: '0.0.0.0' }),
      /Refusing to bind a non-loopback host in pool mode/,
    );
    const p = await startPooled(upstream, { accounts: [{ name: 'a', apiKey: KEY_A }], allowNetwork: true }, { HOST: '0.0.0.0' });
    await p.kill();
    await assert.rejects(
      startPooled(upstream, { accounts: [{ name: 'a', apiKey: 'nope' }] }),
      /Invalid pool config/,
    );
  } finally {
    await upstream.close();
  }
});

test('池账号（node:http 传输）的上游闪断仍走透明重试：流式与非流式都对下游无感，且留在同一账号', async () => {
  const port = await allocPort();
  let calls = 0;
  const seenKeys = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url !== '/alpha/generate') { res.writeHead(200); res.end('{}'); return; }
      seenKeys.push(req.headers.authorization);
      calls++;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.flushHeaders();
      if (calls % 2 === 1) {                               // 每对请求的第一次：吐个内部事件就 RST
        res.write('{"type":"start"}\n');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      for (const line of OK_LINES) res.write(line + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const proxy = await startPooled({ port }, { accounts: [{ name: 'a', apiKey: KEY_A }, { name: 'b', apiKey: KEY_B }] });
  try {
    const s = await proxy.post('/v1/chat/completions', chat('x', { stream: true }), { 'x-session-id': 'retry-session-1' });
    assert.equal(s.status, 200);
    assert.match(await s.text(), /"content":"hi"/);
    const n = await proxy.post('/v1/chat/completions', chat('y'), { 'x-session-id': 'retry-session-1' });
    assert.equal(n.status, 200);
    assert.equal((await n.json()).choices[0].message.content, 'hi');
    assert.equal(calls, 4);
    assert.equal(new Set(seenKeys).size, 1, 'retries stay on the same account');
  } finally {
    await proxy.kill(); await closeServer(server);
  }
});
