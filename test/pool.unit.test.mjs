// 账号池纯逻辑：冷却策略、调度（加权 / 平局轮转 / 粘性 / 排队 / 快速失败）、配置校验。
// 直接 import pool.mjs，不起进程、不走网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReplayMap, backoffMs, computeCooldown, createPool, loadPoolConfig, normalizePoolConfig,
  parseProxyUrl, parseRetryAfterMs, redactProxyUrl, TRANSPORT_FAILURE_THRESHOLD,
} from '../pool.mjs';

const KEY_A = 'user_aaaaaaaa';
const KEY_B = 'user_bbbbbbbb';
const KEY_C = 'user_cccccccc';

function makeCfg(over = {}, accounts) {
  return normalizePoolConfig({
    accounts: accounts ?? [
      { name: 'a', apiKey: KEY_A },
      { name: 'b', apiKey: KEY_B },
    ],
    ...over,
  }, {});
}

// clock 传 null = 用真实时钟（排队超时这类依赖时间流逝的用例）
function makePool(cfgOver, accounts, clock = { t: 1_000_000 }) {
  const pool = createPool(makeCfg(cfgOver, accounts), {
    now: clock ? () => clock.t : Date.now,
    createFetch: () => Object.assign(async () => { throw new Error('no network in unit tests'); }, { close() {} }),
  });
  return { pool, clock };
}

// ── 冷却策略 ──

test('computeCooldown：429 优先 Retry-After，否则指数退避封顶 60s', () => {
  assert.equal(computeCooldown({ status: 429, retryAfterMs: 7000 }).ms, 7000);
  assert.equal(computeCooldown({ status: 429, consecutiveFailures: 1 }).ms, 5000);
  assert.equal(computeCooldown({ status: 429, consecutiveFailures: 2 }).ms, 10000);
  assert.equal(computeCooldown({ status: 429, consecutiveFailures: 99 }).ms, 60000);
  assert.equal(backoffMs(5), 60000);
});

test('computeCooldown：额度类（402 / USAGE_EXCEEDED）走长冷却；401/403 隔离；400/5xx 不怪账号', () => {
  const q = computeCooldown({ status: 429, code: 'USAGE_EXCEEDED', quotaCooldownMs: 1800000 });
  assert.equal(q.ms, 1800000);
  assert.match(q.reason, /quota/);
  assert.equal(computeCooldown({ status: 402, quotaCooldownMs: 1000, retryAfterMs: 5000 }).ms, 5000);
  // 流内 error 事件可能只有 code 没有状态码
  assert.equal(computeCooldown({ status: null, code: 'USAGE_EXCEEDED', quotaCooldownMs: 42 }).ms, 42);
  const auth = computeCooldown({ status: 401, quarantineMs: 600000 });
  assert.equal(auth.quarantine, true);
  assert.equal(auth.ms, 600000);
  assert.equal(computeCooldown({ status: 403 }).quarantine, true);
  assert.equal(computeCooldown({ status: 400 }), null);
  assert.equal(computeCooldown({ status: 503 }), null);
  assert.equal(computeCooldown({ status: null, code: null }), null);
});

test('parseRetryAfterMs：秒数 / HTTP 日期 / 垃圾值', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs('1.5'), 1500);
  assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(parseRetryAfterMs('soon'), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
});

test('代理 URL：http/https 支持，其它协议拒绝；脱敏不泄露口令', () => {
  assert.deepEqual(parseProxyUrl('http://u:p%40ss@h:8080'), {
    protocol: 'http:', host: 'h', port: 8080, auth: 'Basic ' + Buffer.from('u:p@ss').toString('base64'),
  });
  assert.equal(parseProxyUrl('https://h').port, 443);
  assert.throws(() => parseProxyUrl('socks5://h:1080'), /only http/);
  assert.throws(() => parseProxyUrl('not a url user:secret'), (e) => !e.message.includes('secret'));
  assert.equal(redactProxyUrl('http://user:secret@h:1'), 'http://h:1');
});

test('ReplayMap：TTL 过期与 LRU 淘汰', () => {
  const clock = { t: 0 };
  const m = new ReplayMap({ ttlMs: 100, maxEntries: 2, now: () => clock.t });
  m.set('x', 1); m.set('y', 2);
  assert.equal(m.get('x'), 1);       // x 变成最近使用
  m.set('z', 3);                      // 淘汰最久未用的 y
  assert.equal(m.get('y'), undefined);
  assert.equal(m.get('x'), 1);
  clock.t = 1000;
  assert.equal(m.get('x'), undefined);
  assert.equal(m.size, 0);
});

// ── 调度 ──

test('加权最少在途：平局轮转，权重高的分到更多', async () => {
  const { pool } = makePool({}, [
    { name: 'a', apiKey: KEY_A },
    { name: 'b', apiKey: KEY_B, weight: 2 },
  ]);
  const leases = [];
  for (let i = 0; i < 6; i++) leases.push(await pool.acquire(null));
  const count = (n) => leases.filter(l => l.account.name === n).length;
  assert.equal(count('a'), 2);
  assert.equal(count('b'), 4);
  for (const l of leases) l.release();

  // 全空闲时平局轮转，不总落在第一个账号
  const l1 = await pool.acquire(null); l1.release();
  const l2 = await pool.acquire(null); l2.release();
  assert.notEqual(l1.account.name, l2.account.name);
  pool.destroy();
});

test('release 幂等，不会把在途数减成负数', async () => {
  const { pool } = makePool();
  const l = await pool.acquire(null);
  l.release(); l.release();
  assert.ok(pool.stats().accounts.every(a => a.inflight === 0));
  pool.destroy();
});

test('会话粘性：同一会话回到同一账号；冷却时改派（strictAffinity 关）', async () => {
  const { pool, clock } = makePool();
  const first = await pool.acquire('conv-1'); first.release();
  for (let i = 0; i < 3; i++) {
    const l = await pool.acquire('conv-1');
    assert.equal(l.account.name, first.account.name);
    l.release();
  }
  first.report({ status: 429, retryAfterMs: 30000 });
  const moved = await pool.acquire('conv-1');
  assert.notEqual(moved.account.name, first.account.name);
  moved.release();
  // 冷却结束后粘在新账号上（改派是持久的，不来回横跳）
  clock.t += 60000;
  const again = await pool.acquire('conv-1');
  assert.equal(again.account.name, moved.account.name);
  again.release();
  pool.destroy();
});

test('strictAffinity：所属账号冷却时直接 429，带剩余冷却秒数', async () => {
  const { pool } = makePool({ strictAffinity: true });
  const l = await pool.acquire('conv-x'); l.release();
  l.report({ status: 429, retryAfterMs: 12000 });
  await assert.rejects(pool.acquire('conv-x'), (e) => e.status === 429 && e.retryAfter === 12);
  pool.destroy();
});

test('冷却的账号不再接新请求；全员冷却超过排队预算 → 立即 429 + retry_after', async () => {
  const { pool } = makePool({ queueTimeoutMs: 1000 });
  const a = await pool.acquire(null); a.release();
  a.report({ status: 429, retryAfterMs: 20000 });
  const b = await pool.acquire(null);
  assert.notEqual(b.account.name, a.account.name);
  b.release();
  b.report({ status: 429, code: 'USAGE_EXCEEDED' });
  await assert.rejects(pool.acquire(null), (e) => e.status === 429 && e.retryAfter === 20);
  const st = pool.stats().accounts;
  assert.ok(st.every(x => !x.healthy));
  assert.match(st.find(x => x.name === b.account.name).reason, /quota/);
  pool.destroy();
});

test('成功不清除并发请求刚触发的冷却，只清零失败计数', async () => {
  const { pool } = makePool({}, [{ name: 'a', apiKey: KEY_A }]);
  const l1 = await pool.acquire(null);
  const l2 = await pool.acquire(null);
  l1.report({ status: 429, retryAfterMs: 5000 });
  l2.reportSuccess();
  const s = pool.stats().accounts[0];
  assert.equal(s.healthy, false);
  assert.equal(s.consecutiveFailures, 0);
  pool.destroy();
});

test('传输层失败：连续达到阈值才冷却（单次闪断交给透明重试）', async () => {
  const { pool } = makePool({}, [{ name: 'a', apiKey: KEY_A }, { name: 'b', apiKey: KEY_B }]);
  const l = await pool.acquire(null);
  for (let i = 1; i < TRANSPORT_FAILURE_THRESHOLD; i++) l.reportTransportError(new Error('ECONNRESET'));
  assert.ok(pool.stats().accounts.find(x => x.name === l.account.name).healthy);
  l.reportTransportError(new Error('ECONNRESET'));
  assert.equal(pool.stats().accounts.find(x => x.name === l.account.name).healthy, false);
  l.release();
  pool.destroy();
});

test('满载排队：释放后唤醒；超时 → 503；队列满 → 503；客户端放弃 → 不再占队', async () => {
  const { pool } = makePool({ maxInflightPerAccount: 1, queueTimeoutMs: 200, maxQueuedRequests: 1 }, [{ name: 'a', apiKey: KEY_A }], null);
  const holder = await pool.acquire(null);
  const waiting = pool.acquire(null);
  // 队列已满（1 个在等）
  await assert.rejects(pool.acquire(null), (e) => e.status === 503 && /queue is full/.test(e.message));
  setTimeout(() => holder.release(), 20);
  const got = await waiting;
  assert.equal(got.account.name, 'a');

  // 一直不释放 → 超时 503（用真实时钟）
  await assert.rejects(pool.acquire(null), (e) => e.status === 503 && /Timed out/.test(e.message));

  const ac = new AbortController();
  const p = pool.acquire(null, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(pool.stats().queued, 0);
  got.release();
  pool.destroy();
});

test('健康探测：成功清除冷却与隔离；失败按同一冷却策略记账', async () => {
  let answer = { ok: false, status: 401 };
  const cfg = makeCfg({}, [{ name: 'a', apiKey: KEY_A }]);
  const pool = createPool(cfg, {
    probe: async () => answer,
    createFetch: () => Object.assign(async () => {}, { close() {} }),
  });
  await pool.refreshHealth();
  let s = pool.stats().accounts[0];
  assert.equal(s.healthy, false);
  assert.equal(s.quarantined, true);
  answer = { ok: true };
  await pool.refreshHealth();
  s = pool.stats().accounts[0];
  assert.equal(s.healthy, true);
  assert.equal(s.quarantined, false);
  pool.destroy();
});

test('stats 不含 key 与代理口令', async () => {
  const cfg = normalizePoolConfig({ accounts: [{ name: 'a', apiKey: KEY_A, proxy: 'http://u:hunter2@p:1' }] }, {});
  const pool = createPool(cfg, { createFetch: () => Object.assign(async () => {}, { close() {} }) });
  const text = JSON.stringify(pool.stats());
  assert.ok(!text.includes(KEY_A));
  assert.ok(!text.includes('hunter2'));
  assert.ok(text.includes('http://p:1'));
  pool.destroy();
});

// ── 配置校验 ──

test('配置：key / 代理可从环境变量取；名字与 key 必须唯一；共享代理默认拒绝', () => {
  const cfg = normalizePoolConfig({
    accounts: [
      { name: 'a', apiKeyEnv: 'K_A', proxyEnv: 'P_A' },
      { name: 'b', apiKey: KEY_B, enabled: false },
      { name: 'c', apiKey: KEY_C },
    ],
  }, { K_A: KEY_A, P_A: 'http://p:1' });
  assert.deepEqual(cfg.accounts.map(a => a.name), ['a', 'c']);
  assert.equal(cfg.accounts[0].key, KEY_A);
  assert.equal(cfg.accounts[0].proxy, 'http://p:1');
  assert.match(cfg.warnings.join(), /no proxy/);
  assert.equal(cfg.passthroughClientKeys, true);
  assert.equal(cfg.allowNetwork, false);

  const bad = (accounts, env = {}, extra = {}) => () => normalizePoolConfig({ accounts, ...extra }, env);
  assert.throws(bad([]), /non-empty/);
  assert.throws(bad([{ name: 'a', apiKey: KEY_A }, { name: 'a', apiKey: KEY_B }]), /unique/);
  assert.throws(bad([{ name: 'a', apiKey: KEY_A }, { name: 'b', apiKey: KEY_A }]), /reuses a key/);
  assert.throws(bad([{ name: 'a', apiKey: 'sk-nope' }]), (e) => /user_/.test(e.message) && !e.message.includes('sk-nope'));
  assert.throws(bad([{ name: 'a', apiKeyEnv: 'MISSING' }]), /MISSING environment variable/);
  assert.throws(bad([{ name: 'a', apiKey: KEY_A, apiKeyEnv: 'X' }]), /not both/);
  assert.throws(bad([{ name: 'a', apiKey: KEY_A, proxy: 'socks5://h:1' }]), /only http/);
  assert.throws(bad([
    { name: 'a', apiKey: KEY_A, proxy: 'http://p:1' },
    { name: 'b', apiKey: KEY_B, proxy: 'http://p:1' },
  ]), /same proxy/);
  assert.doesNotThrow(bad([
    { name: 'a', apiKey: KEY_A, proxy: 'http://p:1' },
    { name: 'b', apiKey: KEY_B, proxy: 'http://p:1' },
  ], {}, { allowSharedProxy: true }));
  // 同一代理主机、不同口令（常见于按会话分 IP 的住宅代理）不算共享
  assert.doesNotThrow(bad([
    { name: 'a', apiKey: KEY_A, proxy: 'http://s1:x@p:1' },
    { name: 'b', apiKey: KEY_B, proxy: 'http://s2:x@p:1' },
  ]));
  assert.throws(bad([{ name: 'a', apiKey: KEY_A, enabled: false }]), /no enabled accounts/);
  assert.throws(bad([{ name: 'a', apiKey: KEY_A, weight: 0 }]), /weight/);
  assert.equal(normalizePoolConfig({ accounts: [{ name: 'a', apiKey: KEY_A }], healthRefreshMs: true }, {}).healthRefreshMs, 60000);
});

test('配置文件：权限对他人开放时拒绝读取；JSON 错误不回显内容', () => {
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'ccp-pool-'));
  try {
    const p = join(dir, 'pool.json');
    writeFileSync(p, JSON.stringify({ accounts: [{ name: 'a', apiKey: KEY_A }] }));
    chmodSync(p, 0o644);
    assert.throws(() => loadPoolConfig(p, {}), /chmod 600/);
    chmodSync(p, 0o600);
    assert.equal(loadPoolConfig(p, {}).accounts[0].name, 'a');
    writeFileSync(p, '{"accounts": [user_secretsecret');
    assert.throws(() => loadPoolConfig(p, {}), (e) => !e.message.includes('secret'));
    assert.throws(() => loadPoolConfig(join(dir, 'nope.json'), {}), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
