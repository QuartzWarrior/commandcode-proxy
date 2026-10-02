/**
 * 账号池（pool mode）—— 一个代理进程背后挂多个 Command Code 账号。
 *
 * 职责边界：这里只管「调度 + 健康 + 网络路由 + 配置校验」，不懂 CC 协议。
 * 协议相关的每账号状态（设备指纹、会话、模型缓存）由 proxy.mjs 通过 createState 注入。
 *
 * 隔离原则（与 openai-oauth fork 的 @openai-oauth/pool 一致）：
 *   - 每个账号独立的 key、独立的出口（代理）、独立的连接池 / TLS 会话，代理失败绝不回落直连；
 *   - 限流 / 额度 / 鉴权失败只让该账号冷却并把错误交还给下游，**不**把同一请求重放到别的账号；
 *   - 会话粘性：同一会话固定在同一账号上（命中上游 prompt cache，也避免一段对话横跨多个账号）。
 * 这不是多租户鉴权边界：能访问本代理的人就能用池里所有账号。
 *
 * 零依赖：只用 node 内置模块。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { Readable } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';

// ── 代理 URL ────────────────────────────────────────

// 代理 URL 可能带 user:pass —— 任何日志/错误消息都只允许出现 host:port。
export function redactProxyUrl(raw) {
  if (!raw) return '(direct)';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    return '(invalid proxy URL)';
  }
}

/** 支持 http://（明文 CONNECT）与 https://（先与代理建 TLS，再 CONNECT）。 */
export function parseProxyUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    // 不回显原串：里面可能就是口令
    throw new Error('proxy is not a valid URL (expected http://host:port or https://host:port)');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`only http:// and https:// proxies are supported, got ${u.protocol}//`);
  }
  if (!u.hostname) throw new Error('proxy URL has no host');
  const auth = u.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    : null;
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  return {
    protocol: u.protocol,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number.parseInt(u.port || defaultPort, 10),
    auth,
  };
}

// ── 每账号独立的上游 fetch ──────────────────────────

/** Response 的 headers 需要字符串值；node 的 set-cookie 是数组，展开为多行。 */
export function headersToInit(raw) {
  const out = [];
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) { for (const item of v) out.push([k, String(item)]); }
    else if (v !== undefined) out.push([k, String(v)]);
  }
  return out;
}

// SNI 只能是主机名：Node 拒绝把 IP 设为 servername（证书照常按 IP SAN 校验）
const sni = (host) => (net.isIP(host) ? {} : { servername: host });

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

/** 发一个 node http(s) 请求，返回与 fetch 兼容的 Response（.ok/.status/.headers/.text()/.body）。 */
function sendRequest(mod, reqOpts, options) {
  const { signal, body } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    let res = null;
    const onAbort = () => {
      const err = abortError(signal);
      try { req.destroy(err); } catch {}
      try { res?.destroy(err); } catch {}
    };
    const detach = () => signal?.removeEventListener('abort', onAbort);
    const req = mod.request(reqOpts, (incoming) => {
      res = incoming;
      res.once('close', detach);
      // 204/205/304 按规范不允许带 body，Response 构造器会直接抛 —— 必须传 null，同时把连接排空。
      const nullBodyStatus = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
      if (nullBodyStatus) { try { res.resume(); } catch {} }
      resolve(new Response(nullBodyStatus ? null : Readable.toWeb(res), {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: headersToInit(res.headers),
      }));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => { if (!res) detach(); reject(e); });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

/**
 * 经代理打通到 target（host:port）的隧道，返回裸 socket。
 * https:// 代理：与代理之间先建 TLS（证书按代理主机名校验，NODE_EXTRA_CA_CERTS 生效），再在其上 CONNECT。
 */
function openTunnel(proxy, target, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const mod = proxy.protocol === 'https:' ? https : http;
    const connectReq = mod.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      agent: false,
      ...(proxy.protocol === 'https:' ? sni(proxy.host) : {}),
      headers: { Host: target, ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}) },
      timeout: timeoutMs,
    });
    const onAbort = () => { try { connectReq.destroy(abortError(signal)); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);
    connectReq.on('connect', (res, socket) => {
      done();
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${target} failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('proxy CONNECT timeout')));
    connectReq.on('error', (e) => { done(); reject(e); });
    connectReq.end();
  });
}

// ── 用 Node 内置 undici 的 Agent 当每账号的 dispatcher ──
// 官方 CLI 用的就是 Node 原生 fetch（undici）：它会自带 accept / accept-language / sec-fetch-mode /
// accept-encoding: gzip, deflate 等默认头，并按插入顺序、原样大小写发送。用 node:http 自己发请求，
// 这些默认头全部缺失 —— 在上游看来就是「另一种客户端」。所以池账号同样走原生 fetch，只把 dispatcher 换成
// 该账号专属的 Agent（独立连接池），代理隧道通过 Agent 的 connect 钩子接入，线上字节与 CLI 完全一致。
// 内置 undici 不导出 Agent 类，但全局 dispatcher 就是它的实例；首次 fetch 前它还不存在，用一次 data: URL 触发初始化。
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
let agentClassPromise = null;
function getUndiciAgentClass() {
  if (!agentClassPromise) {
    agentClassPromise = (async () => {
      if (!globalThis[GLOBAL_DISPATCHER]) { try { await fetch('data:,'); } catch {} }
      const d = globalThis[GLOBAL_DISPATCHER];
      const C = d?.constructor;
      return typeof C === 'function' && typeof d.dispatch === 'function' ? C : null;
    })();
  }
  return agentClassPromise;
}

/** undici Agent 的 connect 钩子：先经代理打隧道，再按 undici 自己 buildConnector 的参数做 TLS。 */
function tunnelConnector(proxy, connectTimeoutMs) {
  const sessions = new Map(); // 每账号自己的 TLS 会话缓存（与 undici 默认行为一致，且不跨账号复用）
  return (opts, callback) => {
    const isTls = opts.protocol === 'https:';
    const hostname = opts.hostname;
    const port = Number.parseInt(opts.port || (isTls ? '443' : '80'), 10);
    openTunnel(proxy, `${hostname}:${port}`, undefined, connectTimeoutMs).then((raw) => {
      raw.setNoDelay(true);
      raw.setKeepAlive(true, 60000);
      if (!isTls) { callback(null, raw); return; }
      const servername = opts.servername || (net.isIP(hostname) ? undefined : hostname);
      const key = servername || hostname;
      const socket = tls.connect({
        highWaterMark: 16384,
        ...(servername ? { servername } : {}),
        session: sessions.get(key),
        ALPNProtocols: ['http/1.1'],
        socket: raw,
        port,
        host: hostname,
      });
      socket.on('session', (sess) => {
        sessions.set(key, sess);
        if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
      });
      let settled = false;
      socket.once('secureConnect', () => { settled = true; callback(null, socket); });
      socket.once('error', (e) => { if (!settled) { settled = true; sessions.delete(key); callback(e, null); } });
    }, (e) => callback(e, null));
  };
}

/**
 * 为一个账号创建专属的上游 fetch。
 *   - 首选：原生 fetch + 该账号专属的 undici Agent（直连就是默认 Agent；有代理则 connect 钩子走隧道）；
 *   - 兜底（运行时拿不到 Agent 类时）：node:http(s) 实现，直连用专属 keep-alive Agent，代理每请求一条隧道。
 * 两条路径都：socket / TLS 会话不与其它账号复用；隧道建立失败直接报错，**绝不回落直连**。
 * 返回的函数带 .close()。
 */
export function createUpstreamFetch({ proxy, connectTimeoutMs = 15000 } = {}) {
  const parsed = proxy ? parseProxyUrl(proxy) : null;
  const fallback = createNodeHttpFetch({ parsed, connectTimeoutMs });
  let dispatcher = null;
  const ready = getUndiciAgentClass().then((Agent) => {
    if (!Agent) return;
    dispatcher = parsed ? new Agent({ connect: tunnelConnector(parsed, connectTimeoutMs) }) : new Agent();
  });
  const upstream = async (urlStr, options = {}) => {
    await ready;
    if (!dispatcher) return fallback(urlStr, options);
    return fetch(urlStr, { ...options, dispatcher });
  };
  upstream.close = () => {
    fallback.close();
    ready.then(() => dispatcher?.close().catch(() => {}));
  };
  return upstream;
}

function createNodeHttpFetch({ parsed, connectTimeoutMs }) {
  if (!parsed) {
    const agents = {
      'http:': new http.Agent({ keepAlive: true }),
      'https:': new https.Agent({ keepAlive: true }),
    };
    const directFetch = (urlStr, options = {}) => {
      const u = new URL(urlStr);
      const isTls = u.protocol === 'https:';
      return sendRequest(isTls ? https : http, {
        host: u.hostname,
        port: Number.parseInt(u.port || (isTls ? '443' : '80'), 10),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: agents[u.protocol],
        ...(isTls ? sni(u.hostname) : {}),
      }, options);
    };
    directFetch.close = () => { for (const a of Object.values(agents)) a.destroy(); };
    return directFetch;
  }

  const proxiedFetch = async (urlStr, options = {}) => {
    const u = new URL(urlStr);
    const isTls = u.protocol === 'https:';
    const port = Number.parseInt(u.port || (isTls ? '443' : '80'), 10);
    const { signal } = options;
    const rawSocket = await openTunnel(parsed, `${u.hostname}:${port}`, signal, connectTimeoutMs);

    // 隧道上做 TLS（证书按目标主机名校验，不做任何降级）
    let socket = rawSocket;
    if (isTls) {
      socket = tls.connect({ socket: rawSocket, host: u.hostname, ...sni(u.hostname) });
      await new Promise((resolve, reject) => {
        const onAbort = () => { try { socket.destroy(); } catch {} reject(abortError(signal)); };
        signal?.addEventListener('abort', onAbort, { once: true });
        socket.once('secureConnect', () => { signal?.removeEventListener('abort', onAbort); resolve(); });
        socket.once('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
      });
    }
    return sendRequest(isTls ? https : http, {
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      createConnection: () => socket,
    }, options);
  };
  proxiedFetch.close = () => {};
  return proxiedFetch;
}

// ── TTL + LRU map（会话 → 账号 的粘性映射） ─────────

export class ReplayMap {
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 10000, now = Date.now } = {}) {
    if (!(ttlMs > 0) || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('ReplayMap requires a positive TTL and entry limit');
    }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    // 命中时刷新 LRU 位置
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  delete(key) { this.entries.delete(key); }
  clear() { this.entries.clear(); }

  get size() {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
    return this.entries.size;
  }
}

// ── 冷却策略 ────────────────────────────────────────

const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;
// 连续这么多次传输层失败（代理挂了 / 连不上）才冷却 —— 单次闪断由 proxy.mjs 的透明重试消化
export const TRANSPORT_FAILURE_THRESHOLD = 3;

export function backoffMs(consecutiveFailures) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 4));
}

/** Retry-After：秒数或 HTTP 日期。解析失败返回 undefined。 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null) return undefined;
  const v = String(value).trim();
  if (!v) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(v)) {
    const ms = Math.ceil(Number(v) * 1000);
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const QUOTA_CODE_RE = /USAGE_EXCEEDED|QUOTA|CREDIT|INSUFFICIENT|PAYMENT/i;

/**
 * 一次失败响应让账号歇多久。返回 null 表示「不是账号的问题」（如 400、5xx 上游容量不足 ——
 * 那是全服务级的，冷却这个账号无济于事，反而饿死健康容量）。
 *   - 401/403：隔离（key 被拒，等健康探测恢复或 quarantineMs 到期）
 *   - 402 / USAGE_EXCEEDED 等额度类：quotaCooldownMs（默认 30 分钟），Retry-After 更长则取之
 *   - 429：Retry-After；没有则 5s 起指数退避，封顶 60s
 */
export function computeCooldown({ status, code, retryAfterMs, consecutiveFailures = 1, quotaCooldownMs = 30 * 60 * 1000, quarantineMs = 10 * 60 * 1000 }) {
  if (status === 401 || status === 403) {
    return { ms: quarantineMs, reason: `auth rejected (HTTP ${status}${code ? ', ' + code : ''})`, quarantine: true };
  }
  if (status === 402 || (code && QUOTA_CODE_RE.test(code))) {
    return {
      ms: Math.max(quotaCooldownMs, retryAfterMs ?? 0),
      reason: `quota exhausted (${status ? 'HTTP ' + status : 'stream error'}${code ? ', ' + code : ''})`,
      quarantine: false,
    };
  }
  if (status === 429) {
    return {
      ms: retryAfterMs ?? backoffMs(consecutiveFailures),
      reason: `rate limited (HTTP 429${code ? ', ' + code : ''})`,
      quarantine: false,
    };
  }
  return null;
}

// ── 配置 ────────────────────────────────────────────

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_RE = /^user_[A-Za-z0-9_-]+$/;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function readOptString(obj, field, label) {
  const v = obj[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${label}.${field} must be a string`);
  return v;
}
function readOptBool(obj, field, label) {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${label}.${field} must be true or false`);
  return v;
}
function readOptPositiveInt(obj, field, label) {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${label}.${field} must be a positive integer`);
  return v;
}
function readEnvRef(obj, direct, envField, label, env, { required }) {
  const value = readOptString(obj, direct, label);
  const envName = readOptString(obj, envField, label);
  if (value && envName) throw new Error(`${label} may set ${direct} or ${envField}, not both`);
  if (envName) {
    if (!ENV_NAME_RE.test(envName)) throw new Error(`${label}.${envField} is not a valid environment variable name`);
    const fromEnv = env[envName];
    if (!fromEnv) throw new Error(`${label} requires the ${envName} environment variable`);
    return fromEnv;
  }
  if (!value && required) throw new Error(`${label} requires ${direct} or ${envField}`);
  return value;
}

/**
 * 读取私有的账号池配置文件。文件里有 key（和可能的代理口令），因此：
 *   - 必须是普通文件，且（非 Windows）权限不得对 group/other 开放（chmod 600）；
 *   - JSON 解析错误不回显内容（解析器的报错可能引用到私密内容）。
 */
export function loadPoolConfig(path, env = process.env, { platform = process.platform } = {}) {
  let st;
  try { st = statSync(path); } catch { throw new Error(`pool config was not found: ${path}`); }
  if (!st.isFile()) throw new Error(`pool config must be a regular file: ${path}`);
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`refusing to read pool config readable by others: run chmod 600 ${path}`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('pool config is not valid JSON'); }
  return normalizePoolConfig(raw, env);
}

export function normalizePoolConfig(raw, env = process.env) {
  if (!isObject(raw)) throw new Error('pool config root must be an object');
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) throw new Error('pool config accounts must be a non-empty array');

  const warnings = [];
  const accounts = [];
  const names = new Set();
  const keys = new Set();
  const proxies = new Map();
  for (const [i, a] of raw.accounts.entries()) {
    if (!isObject(a)) throw new Error(`accounts[${i}] must be an object`);
    const name = readOptString(a, 'name', `accounts[${i}]`);
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new Error(`accounts[${i}].name is required (1-64 chars of A-Z a-z 0-9 _ . -)`);
    }
    const label = `accounts[${name}]`;
    if (names.has(name)) throw new Error(`account names must be unique; ${name} appears more than once`);
    names.add(name);
    if (readOptBool(a, 'enabled', label) === false) continue;

    const key = readEnvRef(a, 'apiKey', 'apiKeyEnv', label, env, { required: true });
    // 不回显 key 本身
    if (!KEY_RE.test(key)) throw new Error(`${label} key must look like user_…`);
    if (keys.has(key)) throw new Error(`${label} reuses a key already used by another account`);
    keys.add(key);

    const proxy = readEnvRef(a, 'proxy', 'proxyEnv', label, env, { required: false });
    if (proxy) {
      let p;
      try { p = parseProxyUrl(proxy); } catch (e) { throw new Error(`${label}.proxy: ${e.message}`); }
      const egress = `${p.host}:${p.port}|${p.auth || ''}`;
      if (proxies.has(egress) && raw.allowSharedProxy !== true) {
        throw new Error(`${label} uses the same proxy as accounts[${proxies.get(egress)}] (shared egress links accounts; set allowSharedProxy to permit)`);
      }
      proxies.set(egress, name);
    }

    const weight = a.weight === undefined ? 1 : a.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) throw new Error(`${label}.weight must be a positive number`);

    accounts.push({
      name,
      key,
      proxy: proxy || '',
      weight,
      maxInflight: readOptPositiveInt(a, 'maxInflight', label),
      deviceProjectDir: readOptString(a, 'deviceProjectDir', label),
      fingerprintSalt: readOptString(a, 'fingerprintSalt', label),
    });
  }
  if (accounts.length === 0) throw new Error('pool config has no enabled accounts');
  const withProxy = accounts.filter(a => a.proxy).length;
  if (withProxy > 0 && withProxy < accounts.length) {
    warnings.push(`${accounts.length - withProxy} account(s) have no proxy and share this host's egress IP`);
  }

  let healthRefreshMs = 0;
  if (raw.healthRefreshMs === true) healthRefreshMs = 60000;
  else if (raw.healthRefreshMs !== undefined && raw.healthRefreshMs !== false) {
    healthRefreshMs = readOptPositiveInt(raw, 'healthRefreshMs', 'pool');
  }

  return {
    accounts,
    warnings,
    maxInflightPerAccount: readOptPositiveInt(raw, 'maxInflightPerAccount', 'pool') ?? 32,
    maxQueuedRequests: readOptPositiveInt(raw, 'maxQueuedRequests', 'pool') ?? 256,
    queueTimeoutMs: readOptPositiveInt(raw, 'queueTimeoutMs', 'pool') ?? 60000,
    affinityTtlMs: readOptPositiveInt(raw, 'affinityTtlMs', 'pool') ?? 60 * 60 * 1000,
    affinityMaxEntries: readOptPositiveInt(raw, 'affinityMaxEntries', 'pool') ?? 10000,
    quotaCooldownMs: readOptPositiveInt(raw, 'quotaCooldownMs', 'pool') ?? 30 * 60 * 1000,
    quarantineMs: readOptPositiveInt(raw, 'quarantineMs', 'pool') ?? 10 * 60 * 1000,
    healthRefreshMs,
    strictAffinity: readOptBool(raw, 'strictAffinity', 'pool') ?? false,
    allowNetwork: readOptBool(raw, 'allowNetwork', 'pool') ?? false,
    allowSharedProxy: readOptBool(raw, 'allowSharedProxy', 'pool') ?? false,
    diagnostics: readOptBool(raw, 'diagnostics', 'pool') ?? false,
    passthroughClientKeys: readOptBool(raw, 'passthroughClientKeys', 'pool') ?? true,
  };
}

// ── 调度器 ──────────────────────────────────────────

/** 池级准入失败（排队满 / 超时 / 全员冷却），不归咎于任何单个账号。 */
export class PoolAdmissionError extends Error {
  constructor(message, { status, type, retryAfter }) {
    super(message);
    this.name = 'PoolAdmissionError';
    this.status = status;
    this.type = type;
    this.retryAfter = retryAfter;
  }
}

/**
 * @param cfg   normalizePoolConfig 的结果
 * @param opts.createState(account)  为账号挂协议层状态（指纹、会话……），存到 account.state
 * @param opts.probe(account)        健康探测：返回 { ok, status?, code?, retryAfterMs? }，抛错视为传输失败
 * @param opts.createFetch           测试注入用；默认 createUpstreamFetch
 */
export function createPool(cfg, { log = () => {}, now = Date.now, createState, probe, createFetch = createUpstreamFetch } = {}) {
  const accounts = cfg.accounts.map((a) => ({
    name: a.name,
    key: a.key,
    weight: a.weight,
    maxInflight: a.maxInflight ?? cfg.maxInflightPerAccount,
    proxyLabel: redactProxyUrl(a.proxy),
    config: a,
    fetch: createFetch({ proxy: a.proxy }),
    inflight: 0,
    health: { until: 0, reason: null, failures: 0, transportFailures: 0, quarantined: false },
    counters: { requests: 0, successes: 0, errors: 0, cooldowns: 0 },
    lastUsedAt: 0,
    state: null,
  }));
  const byName = new Map(accounts.map(a => [a.name, a]));
  for (const a of accounts) a.state = createState ? createState(a) : {};

  const affinity = new ReplayMap({ ttlMs: cfg.affinityTtlMs, maxEntries: cfg.affinityMaxEntries, now });
  const waiters = new Set();
  let rr = 0;
  let closed = false;
  const notify = () => { for (const wake of [...waiters]) wake(); };

  const cooling = (a, t = now()) => a.health.until > t;
  const available = (a, t = now()) => !cooling(a, t) && a.inflight < a.maxInflight;

  // 加权最少在途；平局轮转，避免总落在第一个账号
  const pick = () => {
    const t = now();
    let best = null;
    let bestLoad = Infinity;
    let bestIdx = -1;
    for (let k = 0; k < accounts.length; k++) {
      const idx = (rr + k) % accounts.length;
      const a = accounts[idx];
      if (!available(a, t)) continue;
      const load = a.inflight / a.weight;
      if (load < bestLoad) { best = a; bestLoad = load; bestIdx = idx; }
    }
    if (best) rr = (bestIdx + 1) % accounts.length;
    return best;
  };

  const applyCooldown = (a, result) => {
    const t = now();
    a.health.failures++;
    a.health.until = Math.max(a.health.until, t + result.ms);
    a.health.reason = result.reason;
    if (result.quarantine) a.health.quarantined = true;
    a.counters.cooldowns++;
    log('warn', 'Pooled account cooling down', {
      account: a.name, reason: result.reason, cooldownMs: Math.max(0, a.health.until - t),
    });
  };

  const reportFailure = (a, { status, code, retryAfterMs }) => {
    const result = computeCooldown({
      status, code, retryAfterMs,
      consecutiveFailures: a.health.failures + 1,
      quotaCooldownMs: cfg.quotaCooldownMs,
      quarantineMs: cfg.quarantineMs,
    });
    if (result) applyCooldown(a, result);
    return result;
  };

  const reportTransport = (a, err) => {
    a.health.transportFailures++;
    if (a.health.transportFailures >= TRANSPORT_FAILURE_THRESHOLD) {
      applyCooldown(a, {
        ms: backoffMs(a.health.transportFailures - TRANSPORT_FAILURE_THRESHOLD + 1),
        reason: `transport errors (${a.health.transportFailures} consecutive: ${String(err?.code || err?.message || err).slice(0, 80)})`,
        quarantine: false,
      });
    }
  };

  // 成功只清零失败计数，不清除冷却：并发的另一个请求可能刚撞上 429，不能被这次成功抹掉
  const reportOk = (a) => {
    a.health.failures = 0;
    a.health.transportFailures = 0;
  };

  const makeLease = (a, conversationKey) => {
    let released = false;
    let errored = false;
    a.inflight++;
    a.counters.requests++;
    a.lastUsedAt = now();
    return {
      account: a,
      conversationKey,
      release() {
        if (released) return;
        released = true;
        a.inflight = Math.max(0, a.inflight - 1);
        notify();
      },
      report(info) {
        if (!errored) { errored = true; a.counters.errors++; }
        return reportFailure(a, info);
      },
      reportTransportError(err) {
        if (!errored) { errored = true; a.counters.errors++; }
        reportTransport(a, err);
      },
      reportSuccess() {
        a.counters.successes++;
        reportOk(a);
      },
    };
  };

  async function acquire(conversationKey, { signal } = {}) {
    const started = now();
    for (;;) {
      if (closed) throw new PoolAdmissionError('Account pool is shutting down', { status: 503, type: 'server_busy', retryAfter: 5 });
      if (signal?.aborted) throw abortError(signal);
      const t = now();

      let account = null;
      const owner = conversationKey ? byName.get(affinity.get(conversationKey)) : undefined;
      if (owner && available(owner, t)) {
        account = owner;
      } else if (owner && cooling(owner, t) && cfg.strictAffinity) {
        throw new PoolAdmissionError(`Account for this conversation is cooling down (${owner.health.reason})`, {
          status: 429, type: 'rate_limit_error', retryAfter: Math.max(1, Math.ceil((owner.health.until - t) / 1000)),
        });
      } else {
        account = pick();
      }
      if (account) {
        if (conversationKey) {
          if (owner && owner !== account) {
            log('info', 'Conversation rebound to another pooled account', { from: owner.name, to: account.name, reason: owner.health.reason || 'owner at capacity' });
          }
          affinity.set(conversationKey, account.name);
        }
        return makeLease(account, conversationKey);
      }

      if (waiters.size >= cfg.maxQueuedRequests) {
        throw new PoolAdmissionError('Account pool admission queue is full', { status: 503, type: 'server_busy', retryAfter: 5 });
      }
      const remaining = cfg.queueTimeoutMs - (now() - started);
      if (remaining <= 0) {
        throw new PoolAdmissionError('Timed out waiting for a free pooled account', { status: 503, type: 'server_busy', retryAfter: 5 });
      }
      // 有账号只是满载（没冷却）→ 等释放即可；全员冷却且最早恢复也超出排队预算 → 立刻 429，不白等
      const anyWarm = accounts.some(a => !cooling(a, t));
      const earliest = Math.min(...accounts.map(a => Math.max(0, a.health.until - t)));
      if (!anyWarm && earliest > remaining) {
        throw new PoolAdmissionError('All pooled accounts are cooling down', {
          status: 429, type: 'rate_limit_error', retryAfter: Math.max(1, Math.ceil(earliest / 1000)),
        });
      }
      await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); waiters.delete(wake); signal?.removeEventListener('abort', onAbort); };
        const wake = () => { cleanup(); resolve(); };
        const onAbort = () => { cleanup(); reject(abortError(signal)); };
        const delay = Math.max(1, Math.min(remaining, anyWarm ? remaining : earliest));
        timer = setTimeout(wake, delay);
        waiters.add(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /** 不占用槽位地挑一个健康账号（只读用途，如 /v1/models）。 */
  function peek() {
    const t = now();
    let best = null;
    for (const a of accounts) {
      if (cooling(a, t)) continue;
      if (!best || a.inflight / a.weight < best.inflight / best.weight) best = a;
    }
    return best || accounts[0];
  }

  // 可选的健康探测：经各账号自己的路由打一个不耗推理额度的认证端点
  let healthTimer = null;
  async function refreshHealth() {
    await Promise.all(accounts.map(async (a) => {
      if (closed || !probe) return;
      try {
        const r = await probe(a);
        if (closed) return;
        if (r.ok) {
          const wasDown = cooling(a) || a.health.quarantined;
          a.health = { until: 0, reason: null, failures: 0, transportFailures: 0, quarantined: false };
          if (wasDown) { log('info', 'Pooled account recovered (health probe)', { account: a.name }); notify(); }
        } else {
          reportFailure(a, r);
        }
      } catch (e) {
        if (!closed) reportTransport(a, e);
      }
    }));
  }
  if (cfg.healthRefreshMs > 0 && probe) {
    healthTimer = setInterval(() => { refreshHealth().catch(() => {}); }, cfg.healthRefreshMs);
    healthTimer.unref?.();
  }

  function stats() {
    const t = now();
    return {
      accounts: accounts.map(a => ({
        name: a.name,
        proxy: a.proxyLabel,
        weight: a.weight,
        healthy: !cooling(a, t),
        inflight: a.inflight,
        maxInflight: a.maxInflight,
        cooldownRemainingMs: Math.max(0, a.health.until - t),
        reason: cooling(a, t) ? a.health.reason : null,
        quarantined: cooling(a, t) && a.health.quarantined,
        consecutiveFailures: a.health.failures,
        requests: a.counters.requests,
        successes: a.counters.successes,
        errors: a.counters.errors,
        cooldowns: a.counters.cooldowns,
        lastUsedAt: a.lastUsedAt || null,
      })),
      queued: waiters.size,
      affinityEntries: affinity.size,
    };
  }

  function destroy() {
    closed = true;
    if (healthTimer) clearInterval(healthTimer);
    notify();
    for (const a of accounts) { try { a.fetch.close?.(); } catch {} }
  }

  return { accounts, acquire, peek, stats, refreshHealth, destroy };
}
