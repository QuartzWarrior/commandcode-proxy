/**
 * Command Code → OpenAI 兼容代理
 * 基于真实 CLI 流量抓包数据构建
 */
import http from 'http';
import https from 'https';
import tls from 'tls';
import { Readable } from 'stream';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createPool, createUpstreamFetch, loadPoolConfig, parseProxyUrl, parseRetryAfterMs, redactProxyUrl,
} from './pool.mjs';

// ── 配置加载 ──────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const defaults = {
    port: 3000,
    host: '0.0.0.0',
    apiBase: 'https://api.commandcode.ai',
    projectSlug: 'cc-proxy',
    logFile: '',
    logLevel: 'info',
    useProviderModels: false,   // CLI 从不调 /provider/v1/models（模型目录内置在 CLI 里）；默认用内置的 1.74.0 目录
    modelRefreshIntervalMs: 5 * 60 * 1000,  // 5 minutes
    zdr: false,
    cliMode: '', // 信封 mode。留空 = 不带（CLI 1.74.0 的 agent 回合就不带）。服务端枚举：agent|learning|custom-agent|custom-agent-create|title-gen|tool-desc|compact|vision
    tasteLearning: false,       // x-taste-learning。CLI 默认 true（会让服务端从对话里学习「口味」写进账号）；这里默认关
    cliSessionMode: 'interactive', // lifecycle metadata 的 mode —— 注意这是另一个枚举：interactive | non-interactive
    fingerprintSalt: '',
    deviceProjectDir: '', // 伪造的项目目录（留空则用内置的 C:\Users\dev\projects\app） // 改这个值 = 让所有账号换一台设备（见设备指纹注释）
    emptySystemPlaceholder: true, // 无 system prompt 时发空格占位，阻止 CC 上游注入 ~7.5K token 默认提示词（issue #17）
    upstreamProxy: '',            // 上游 HTTP 代理，如 http://127.0.0.1:7890（issue #18）
    poolConfig: '',               // 账号池私有配置文件路径（见 README「账号池」）；留空 = 单 key 模式
  };

  const configPath = resolve(__dirname, 'config.json');
  if (existsSync(configPath)) {
    try {
      const user = JSON.parse(readFileSync(configPath, 'utf-8'));
      Object.assign(defaults, user);
    } catch (e) {
      console.error('[config] Failed to parse config.json:', e.message);
    }
  }

  // 环境变量覆写
  if (process.env.PORT) defaults.port = parseInt(process.env.PORT);
  if (process.env.HOST) defaults.host = process.env.HOST;
  if (process.env.CC_API_BASE) defaults.apiBase = process.env.CC_API_BASE;
  if (process.env.PROJECT_SLUG) defaults.projectSlug = process.env.PROJECT_SLUG;
  if (process.env.LOG_FILE) defaults.logFile = process.env.LOG_FILE;
  if (process.env.CC_USE_PROVIDER_MODELS) defaults.useProviderModels = process.env.CC_USE_PROVIDER_MODELS !== 'false';
  if (process.env.CMD_ZDR !== undefined) defaults.zdr = process.env.CMD_ZDR === '1';
  if (process.env.CC_FINGERPRINT_SALT !== undefined) defaults.fingerprintSalt = process.env.CC_FINGERPRINT_SALT;
  if (process.env.CC_DEVICE_PROJECT_DIR) defaults.deviceProjectDir = process.env.CC_DEVICE_PROJECT_DIR;
  if (process.env.CC_CLI_MODE !== undefined) defaults.cliMode = process.env.CC_CLI_MODE;
  if (process.env.CC_TASTE_LEARNING !== undefined) defaults.tasteLearning = process.env.CC_TASTE_LEARNING === 'true';
  if (process.env.CC_CLI_SESSION_MODE) defaults.cliSessionMode = process.env.CC_CLI_SESSION_MODE;
  if (process.env.CC_EMPTY_SYSTEM_PLACEHOLDER) defaults.emptySystemPlaceholder = process.env.CC_EMPTY_SYSTEM_PLACEHOLDER !== 'false';
  if (process.env.CC_UPSTREAM_PROXY) defaults.upstreamProxy = process.env.CC_UPSTREAM_PROXY;
  // 环境变量给的相对路径按当前工作目录解析，config.json 里的按 proxy.mjs 所在目录解析
  if (process.env.CC_POOL_CONFIG) defaults.poolConfig = resolve(process.cwd(), process.env.CC_POOL_CONFIG);
  else if (defaults.poolConfig) defaults.poolConfig = resolve(__dirname, defaults.poolConfig);

  return defaults;
}

const CFG = loadConfig();

// ── 设备指纹（形态与哈希逐字对齐官方 CLI 1.53.1 起未变，1.74.0 复核一致） ──────
// CPU 型号与核心数对应表（仅 Windows x64）
const FINGERPRINT_CPUS = [
  { model: '12th Gen Intel(R) Core(TM) i7-12650H', cores: 10 },   // TEMP-REVERT
  { model: '12th Gen Intel(R) Core(TM) i5-12400F', cores: 6 },
  { model: '12th Gen Intel(R) Core(TM) i9-12900K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i7-13700K', cores: 16 },
  { model: '13th Gen Intel(R) Core(TM) i5-13600K', cores: 14 },
  { model: '13th Gen Intel(R) Core(TM) i9-13900K', cores: 24 },
  { model: 'Intel(R) Core(TM) Ultra 7 155H', cores: 16 },
  { model: 'Intel(R) Core(TM) Ultra 9 285H', cores: 16 },
  { model: 'Intel(R) Core(TM) i9-14900K', cores: 24 },
  { model: 'Intel(R) Core(TM) i7-14700K', cores: 20 },
  { model: 'AMD Ryzen 7 7800X3D', cores: 8 },
  { model: 'AMD Ryzen 9 7950X', cores: 16 },
  { model: 'AMD Ryzen 5 7600', cores: 6 },
  { model: 'AMD Ryzen 9 7900X', cores: 12 },
  { model: 'AMD Ryzen 7 5800X3D', cores: 8 },
];
const FINGERPRINT_MEMS = [8, 16, 24, 32, 48, 64];
const FINGERPRINT_TZS = [
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Hong_Kong',
  'Australia/Sydney', 'Pacific/Auckland',
];
const FINGERPRINT_MAC_COUNT_RANGE = [2, 3, 4, 5]; // 随机 2~5 个 MAC

// CLI 的根盐（buildMachineFingerprint 常量 sb）
const FP_SALT = 'command-code:device-fingerprint:v1';
// 设备档案：指纹 / config.environment / config.workingDir / x-project-slug / lifecycle.os 共用同一份，
// 避免出现「指纹说 win32、环境说 linux」这类自相矛盾，也避免把宿主机真实信息（平台、Node 版本、cwd）交给上游。
const DEVICE_PROFILE = {
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.22631',
  isContainer: false,
  // 伪造的项目目录：与 x-project-slug 同源（真机里 slug = slugify(workingDir)）
  projectDir: CFG.deviceProjectDir || 'C:\\Users\\dev\\projects\\app',
};
const FP_OS_USERS = ['dev', 'user', 'admin', 'coder', 'engineer', 'work'];
const FP_MAIL_DOMAINS = ['gmail.com', 'outlook.com', 'qq.com', '163.com'];

// 伪造信号的派生源。加 CC_FINGERPRINT_SALT 可成批换身份 —— 真实账号的 key 动不了，这是逃生口。
// 注意：哈希阶段用的是 CLI 的固定盐（FP_SALT），salt 只影响「伪造出哪台机器」。
function fpDigest(apiKey, field, salt = CFG.fingerprintSalt) {
  return crypto.createHash('sha256')
    .update(`${salt || ''}\0${apiKey}\0${field}`)
    .digest();
}
// 从候选池确定性地挑一项：打分取最大。以后往池里加候选只影响「新候选恰好胜出」的那部分 key，
// 不会像取模那样因为池长度变化让所有 key 一起换设备。
function fpPickIndex(apiKey, field, items, labelOf, salt = CFG.fingerprintSalt) {
  let bestIdx = 0;
  let bestScore = null;
  for (let i = 0; i < items.length; i++) {
    const score = fpDigest(apiKey, `${field}\0${labelOf(i)}`, salt);
    if (!bestScore || Buffer.compare(score, bestScore) > 0) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}
// CLI 的 hashSignal：sha256(FP_SALT + "\0" + value.toLowerCase())，空值返回 undefined（JSON 里被丢掉）
function fingerprintHash(value) {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  return crypto.createHash('sha256').update(`${FP_SALT}\0${v.toLowerCase()}`).digest('hex');
}

// 与 CLI 的唯一区别是「信号值」：CLI 读真实机器（注册表 / ioreg / machine-id、网卡 MAC、
// os.userInfo、git config），这里按 apiKey 确定性地伪造一组逼真值。
// 为什么必须由 apiKey 派生而不是随机：指纹代表「这个账号对应的那台设备」，重启、内存回收、
// 多实例、月额度用尽停用数周后恢复，上游都应看到同一台设备；换指纹本身就是可疑信号。
function generateFingerprint(apiKey, salt = CFG.fingerprintSalt) {
  const cpuEntry = FINGERPRINT_CPUS[fpPickIndex(apiKey, 'cpu', FINGERPRINT_CPUS, i => `${FINGERPRINT_CPUS[i].model}|${FINGERPRINT_CPUS[i].cores}`, salt)];
  const memGiB = FINGERPRINT_MEMS[fpPickIndex(apiKey, 'mem', FINGERPRINT_MEMS, i => String(FINGERPRINT_MEMS[i]), salt)];
  const tz = FINGERPRINT_TZS[fpPickIndex(apiKey, 'timezone', FINGERPRINT_TZS, i => FINGERPRINT_TZS[i], salt)];
  const macCount = FINGERPRINT_MAC_COUNT_RANGE[fpPickIndex(apiKey, 'macCount', FINGERPRINT_MAC_COUNT_RANGE, i => String(FINGERPRINT_MAC_COUNT_RANGE[i]), salt)];
  const osUser = fpOsUser(apiKey, salt);
  const mailDomain = FP_MAIL_DOMAINS[fpPickIndex(apiKey, 'mailDomain', FP_MAIL_DOMAINS, i => FP_MAIL_DOMAINS[i], salt)];
  const hex = (field, bytes) => fpDigest(apiKey, field, salt).subarray(0, bytes).toString('hex');
  // Windows MachineGuid 形状：8-4-4-4-12
  const mid = hex('machineId', 16);
  const machineId = `${mid.slice(0, 8)}-${mid.slice(8, 12)}-${mid.slice(12, 16)}-${mid.slice(16, 20)}-${mid.slice(20, 32)}`;
  const macs = [];
  for (let i = 0; i < macCount; i++) {
    const b = fpDigest(apiKey, `mac${i}`, salt).subarray(0, 6);
    macs.push([...b].map(x => x.toString(16).padStart(2, '0')).join(':'));
  }
  macs.sort(); // CLI 对 MAC 去重后排序
  const hostname = `DESKTOP-${hex('hostname', 4).toUpperCase()}`;
  const gitEmail = `${osUser}.${hex('gitEmail', 3)}@${mailDomain}`;

  const machineIdHash = fingerprintHash(machineId);
  const macHashes = macs.map(fingerprintHash).filter(Boolean);
  const osUserHash = fingerprintHash(osUser);
  const hostnameHash = fingerprintHash(hostname);
  const gitEmailHash = fingerprintHash(gitEmail);

  // CLI 的 thumbmark：主盐 + "\0machine\0" + join([machineId, macs.join(",")])
  // （machineId 非空时不再拼 hostname/cpuModel）
  const thumbSeed = [machineId.trim(), macs.join(','), machineId.trim() ? '' : hostname, machineId.trim() ? '' : cpuEntry.model].filter(Boolean);
  const thumbmark = crypto.createHash('sha256').update(`${FP_SALT}\0machine\0${thumbSeed.join('|') || 'unknown'}`).digest('hex');

  return {
    thumbmark,
    components: {
      machineIdHash,
      macHashes,
      osUserHash,
      hostnameHash,
      gitEmailHash,
      platform: DEVICE_PROFILE.platform,
      arch: DEVICE_PROFILE.arch,
      osRelease: DEVICE_PROFILE.osRelease,
      cpuModel: cpuEntry.model,
      cpuCount: cpuEntry.cores,
      memGiB,
      isContainer: DEVICE_PROFILE.isContainer,
      timezone: tz,
      runtime: 'cli',
      collectorVersion: 1,
    },
  };
}

function fpOsUser(apiKey, salt = CFG.fingerprintSalt) {
  return FP_OS_USERS[fpPickIndex(apiKey, 'osUser', FP_OS_USERS, i => FP_OS_USERS[i], salt)];
}

// 账号池里每个账号一台「设备」：全局 DEVICE_PROFILE.projectDir 会让所有账号报同一个项目路径 /
// x-project-slug —— 这是跨账号的关联信号。池账号的项目目录按 key 确定性派生（用户名与指纹里的
// osUser 一致），也可在池配置里逐账号覆盖。单 key 模式不走这里，行为不变。
const FP_PROJECT_NAMES = ['app', 'web', 'api', 'backend', 'frontend', 'server', 'client', 'dashboard',
  'website', 'service', 'tools', 'core', 'monorepo', 'playground', 'my-app', 'workspace'];
function deriveDeviceProfile(apiKey, salt, projectDirOverride) {
  if (projectDirOverride) return { ...DEVICE_PROFILE, projectDir: projectDirOverride };
  const project = FP_PROJECT_NAMES[fpPickIndex(apiKey, 'projectDir', FP_PROJECT_NAMES, i => FP_PROJECT_NAMES[i], salt)];
  return { ...DEVICE_PROFILE, projectDir: `C:\\Users\\${fpOsUser(apiKey, salt)}\\projects\\${project}` };
}

// 本代理**实际实现**的 wire 协议版本（对齐 command-code@1.74.0 源码）。
// 真机发的永远是「形状 + 版本号」自洽的组合；如果版本号跟着 npm 走而形状没变，
// 就变成「自称最新版、却说旧方言」—— 这比版本号过期更容易被行为分析挑出来。
// 因此这里报的是协议版本，npm 上更新了只告警、不自动改。
const CC_PROTOCOL_VERSION = '1.74.0';
let CC_VERSION = CC_PROTOCOL_VERSION;
const CC_VERSION_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h — 检查一次是否发生漂移

// ── 协议漂移检测（只告警，不改版本号） ─────────────
// 上游 CLI 更新可能带来协议变化。这里只负责提醒「该重新读包对齐了」，
// 绝不会把 x-command-code-version 改成一个我们并未实现的版本。
async function checkProtocolDrift() {
  try {
    const url = 'https://registry.npmjs.org/command-code/latest';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`npm responded with ${res.status}`);
    const pkg = await res.json();
    const latest = typeof pkg?.version === 'string' ? pkg.version : null;
    if (latest && latest !== CC_PROTOCOL_VERSION) {
      log('warn', 'CC CLI version drift: protocol may have changed, re-align from the npm package', {
        implemented: CC_PROTOCOL_VERSION, latest,
      });
    } else if (latest) {
      log('info', 'CC CLI version in sync', { version: latest });
    }
  } catch (e) {
    log('warn', 'CC version check failed', { error: e.message });
  }
}
checkProtocolDrift(); // 启动时立即检查
setInterval(checkProtocolDrift, CC_VERSION_REFRESH_MS);

// 请求体大小上限：默认 100MB，可用环境变量 CC_MAX_BODY_MB 覆盖（正整数，单位 MB）
// ⚠️ 内存特性（issue #20 实测）：请求体在转发到上游前会同时存在多份副本 ——
//    chunks[] / Buffer.concat / utf8 字符串 / JSON.parse 对象树 / buildCcRequest 重建对象树 / JSON.stringify 序列化体。
//    实测峰值 ≈ body 大小 × 5.1~7.4（7MB→+52MB，20MB→+116MB；而 413 拒绝路径只要 ×1.05）。
//    故 100MB 上限意味着「单个请求」最坏可吃 ~550MB，且该上限是每请求的、不是全局的。
//    公网/多用户部署请在反向代理层同时限制 body 大小与在途请求数（见 README「内存与部署」）。
const MAX_BODY_SIZE = (() => {
  const mb = Number.parseInt(process.env.CC_MAX_BODY_MB ?? '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 100 * 1024 * 1024;
})();
// 上游读空闲超时（issue #19）：只计「reader.read() 的等待」，每收到一个 chunk 重置，
// 不是整个请求的总时长。默认值保持不变（30s / 90s），可用环境变量覆盖 ——
// 官方 CLI 对上游没有任何 idle timeout（反编译 command-code@1.50.0 已验证，
// createApiClient 调用点均未传 timeout），合法的长思考停顿可达数百秒，
// 遇到推理模型被 30s 误杀 / 触发 429 重试放大时，调大这两个值即可。
const STREAM_IDLE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_STREAM_IDLE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 30000;   // 默认 30s — 流式无新数据中断
})();
const NONSTREAM_IDLE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_NONSTREAM_IDLE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 90000;   // 默认 90s — 非流式超时更宽容
})();

// ── 上游闪断透明重试（未吐字前 bounded retry）─────────
// CC 上游在高峰期会中途掐断流，undici 抛 `TypeError: terminated`
// （cause 多为 SocketError: other side closed）。若此刻尚未向下游写出任何字节，
// 这个请求对下游而言从未开始过 —— 代理内部重试即可消化抖动，下游（CPA / 客户端）
// 不必看到 502 再自行退避。
// 只在「未吐字」时重试：一旦写过头或输出过事件，语义就已提交，重试会造成重复文本。
// 默认 2 = 最多重试 2 次（共 3 次尝试）；CC_UPSTREAM_RETRY_MAX=0 可整体关闭。
const UPSTREAM_RETRY_MAX = (() => {
  const n = Number.parseInt(process.env.CC_UPSTREAM_RETRY_MAX ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
const UPSTREAM_RETRY_BASE_MS = (() => {
  const ms = Number.parseInt(process.env.CC_UPSTREAM_RETRY_BASE_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 400;   // 退避 = base × 尝试序号
})();

// 区分「传输层闪断」（可安全重试）与「语义错误」（不可重试）。
// STREAM_IDLE_TIMEOUT 是刻意发给下游的「请减少上下文」信号，绝不重试。
function isRetryableUpstreamError(e) {
  if (!e) return false;
  const blob = [e.message, e.code, e.cause?.message, e.cause?.code].filter(Boolean).join(' | ');
  if (/STREAM_IDLE_TIMEOUT/.test(blob)) return false;
  return /terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|socket hang up|other side closed|fetch failed/i.test(blob);
}

// 仅用于日志：rewinds = 实际重试次数，recovered = 重试后成功交付的次数
const upstreamRetryStats = { rewinds: 0, recovered: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 客户端「僵死」保护：既不读也不断开时，该请求会连带上游连接一直挂着（背压修复后的残留）。
// 实测残留在途成本约 5MB/连接 —— 有界、不泄漏、断开即回收，但连接数本身无上限。
// 默认 0 = 禁用，保持既有行为不变：僵死客户端与「卡在工具执行的合法客户端」在协议层无法
// 区分，而官方 CLI 对上游没有任何 idle timeout（issue #19），贸然加超时会误杀健康请求。
// 在途请求上限（可选，默认关闭）。项目定位是纯反代层，并发控制属于下游（nginx
// limit_conn，per-IP / per-key）；本项仅为「不挂反代裸跑」的场景提供一个可选的
// 进程内全局兜底，不替代下游方案，也不感知客户端身份。
// 内存 = 在途数 × (0.13MB + 5.5 × body_MB)：body 上限只管住单请求量级，乘数由本项封顶。
// 超限返回 503 + Retry-After（SDK 会自行退避重试），而不是放任进程被 OOM 杀掉。
// 默认 0 = 关闭，不限制并发（既有的反代层定位不变，行为零变化）；需要时按需开启：
//   CC_MAX_INFLIGHT=32 npm start
// 注意：body 上限只管住单请求量级，乘数由本项封顶。默认 body 上限 100MB 时，
// N × 最坏 550MB —— 要硬性内存上界需同时下调 CC_MAX_BODY_MB。
const MAX_INFLIGHT = (() => {
  const n = Number.parseInt(process.env.CC_MAX_INFLIGHT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;            // 默认 0 = 不限
})();

let inflightCount = 0;   // 当前在途请求数（不含 /health）

const CLIENT_DRAIN_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_CLIENT_DRAIN_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
})();

// 连续超时计数：连续 3 次超时才提醒压缩上下文，任意成功请求后重置
// 单 key（透传）模式共用一个计数（行为不变）；账号池里每个账号各计各的，互不影响
const globalTimeouts = { count: 0 };
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

// ── 日志 ─────────────────────────────────────────────
function log(level, msg, data) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  if (CFG.logFile) {
    try { appendFileSync(CFG.logFile, line + '\n', 'utf-8'); } catch {}
  }
}

// 把上游错误体摘要成单行，便于日志排查。
// 之前 CC API error 只记 status，不记 body —— 遇到 400 只能靠猜（问题来源见 hk_sji 排查）。
// 截断到 500 字符，避免异常大的 body 刷爆日志；同时压掉换行，保证一条日志一行。
function summarizeUpstreamError(text, limit = 500) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…(' + (flat.length - limit) + ' more)' : flat;
}

// ── 会话管理 ───────────────────────────────────────
// 每个 API Key 独立一个 session，12h 过期 + 1h 随机抖动
// 同一 Key 在同一周期内复用，到期自动换新
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;    // 12h
const SESSION_JITTER_MS  = 60 * 60 * 1000;           // 1h 抖动范围

const sessionStore = new Map(); // apiKey → { sessionId, expiresAt }

function ensureSession(apiKey, store = sessionStore) {
  const now = Date.now();
  const entry = store.get(apiKey);

  if (entry && now < entry.expiresAt) {
    return entry.sessionId;
  }

  // 过期或第一次：生成新 session
  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS);
  const sessionId = randomUUID();
  store.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter });
  log('info', 'Session created', { sessionId: sessionId.slice(0, 8), storeSize: store.size });
  return sessionId;
}

// 定期清理过期 session 和 key 状态，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      keyStateStore.delete(key); // 同时清理该 key 的指纹状态
      cleaned++;
    }
  }
  if (cleaned > 0) log('info', 'Session cleanup', { cleaned, remaining: sessionStore.size });
}, 60 * 60 * 1000); // 每小时

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientSessionIdOf(incomingHeaders, promptCacheKey) {
  // 优先从客户端传来的 session 类 header 获取
  const candidates = [
    incomingHeaders['x-session-id'],
    incomingHeaders['x-claude-code-session-id'],
    incomingHeaders['session_id'],
    promptCacheKey,
  ];
  for (const id of candidates) {
    if (id && typeof id === 'string' && id.length >= 8) return id;
  }
  return null;
}

// 账号池：客户端给的会话 id 不原样上送 —— 换成「按账号 key 加盐」的 UUID。
// 同一会话在同一账号上稳定（缓存照常命中）；会话被改派到别的账号时上游看到的是另一个 id，
// 两个账号之间不会出现同一个 session/thread id。
function scopedSessionUuid(apiKey, clientId) {
  const b = crypto.createHmac('sha256', apiKey).update(`session\0${clientId}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; // UUID v4 形状
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function getSessionId(incomingHeaders, ctx, promptCacheKey) {
  const clientId = clientSessionIdOf(incomingHeaders, promptCacheKey);
  // CLI 的 session id 永远是 UUID（x-session-id 与 threadId 同值）。透传模式下客户端给的 UUID 原样用；
  // 非 UUID（如 prompt_cache_key 字符串）或池模式 → 派生出一个稳定的 UUID，绝不把非 UUID 形态发上去。
  if (clientId) return !ctx.pooled && UUID_RE.test(clientId) ? clientId : scopedSessionUuid(ctx.key, clientId);
  // 按 API Key 分 session
  return ensureSession(ctx.key, ctx.sessions);
}

// 每个请求独立 thread ID
function newThreadId() { return randomUUID(); }

// ── 每 Key 独立状态（fingerprint + 初始化节流） ──
// 每个 API Key 拥有自己的设备指纹和初始化定时器
const keyStateStore = new Map(); // apiKey → { fingerprint, nextInitAt }

function getOrCreateKeyState(apiKey) {
  let state = keyStateStore.get(apiKey);
  if (!state) {
    state = {
      fingerprint: generateFingerprint(apiKey),
      nextInitAt: 0,
    };
    keyStateStore.set(apiKey, state);
    log('info', 'Fingerprint generated for key', { keyPrefix: apiKey.slice(0, 8) });
  }
  return state;
}

// ── 初始化预请求（fingerprint + lifecycle，首次 + 每 8h+2h 抖动） ────
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;    // 8h
const INIT_JITTER_MS  = 2 * 60 * 60 * 1000;    // 2h 抖动

// 同一账号的并发首请求只发一组预请求（真 CLI 一次启动只报一次；N 个并发请求各报一遍本身就可疑）
async function ensureInitialized(ctx, signal) {
  const state = ctx.initState;
  if (Date.now() < state.nextInitAt) return;
  if (!state.initializing) {
    state.initializing = runInitialization(ctx, state, signal).finally(() => { state.initializing = null; });
  }
  await state.initializing;
}

// CLI 进程启动时的上游请求序列（对齐 command-code@1.74.0）：
//   1. setupTelemetry → POST /alpha/lifecycle-events（cli_session_exists）—— 经 createCommandApiClient，
//      头 = buildCommandApiHeaders：content-type + Content-Type（同样合并成两份）、x-cli-environment、Authorization、
//      User-Agent: cli、x-command-code-version；启动时还没有活动 span，所以没有 traceparent。
//      metadata.sessionId = "sess_" + randomUUID 去横线后的前 16 位（第 13 位因此恒为 UUID 版本号 4）。
//   2. setImmediate → POST /alpha/fingerprint/record —— 头只有 content-type（传输层加的）、Authorization、
//      x-cli-environment、x-command-code-version、User-Agent: cli（每个进程只报一次）。
//   3. 会话开始 → createBilling().prefetch()：GET /alpha/whoami，再并行 GET /alpha/billing/subscriptions?orgId=
//      与 /alpha/billing/credits?orgId=，头与 /alpha/generate 相同（buildCommandAuthHeaders）。
// 代理长期运行，按「每 8h + 2h 抖动重启一次 CLI」来模拟，每个账号/key 各自一套。
async function runInitialization(ctx, state, signal) {
  const upstreamFetch = ctx.fetch;
  const zdr = CFG.zdr ? { 'x-cmd-zdr': '1' } : {};
  const fingerprint = state.fingerprint || {};
  const quiet = (label) => (e) => {
    if (e.name !== 'AbortError') log('warn', `${label} error`, { error: e.message, ...ctx.logTag });
  };
  const drain = (r) => r.body?.cancel().catch(() => {});
  try {
    const lifecycle = upstreamFetch(`${CFG.apiBase}/alpha/lifecycle-events`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'Content-Type': 'application/json',
        'x-cli-environment': 'production',
        'Authorization': `Bearer ${ctx.key}`,
        'User-Agent': 'cli',
        'x-command-code-version': CC_VERSION,
        ...zdr,
      },
      body: JSON.stringify({
        eventType: 'cli_session_exists',
        metadata: {
          sessionId: `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          cliVersion: CC_VERSION,
          mode: CFG.cliSessionMode || 'interactive',
          os: `${fingerprint.components.platform}-${fingerprint.components.arch}`,
        },
      }),
    }).then(r => {
      drain(r);
      if (!r.ok) log('warn', 'Lifecycle event failed', { status: r.status, ...ctx.logTag });
      else log('info', 'Lifecycle event sent', ctx.logTag);
    }).catch(quiet('Lifecycle event'));

    const fingerprintRecord = upstreamFetch(`${CFG.apiBase}/alpha/fingerprint/record`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${ctx.key}`,
        'x-cli-environment': 'production',
        'x-command-code-version': CC_VERSION,
        'User-Agent': 'cli',
        ...zdr,
      },
      body: JSON.stringify({ thumbmark: fingerprint.thumbmark, components: fingerprint.components }),
    }).then(r => {
      drain(r);
      if (!r.ok) log('warn', 'Fingerprint record failed', { status: r.status, ...ctx.logTag });
      else log('info', 'Fingerprint recorded', ctx.logTag);
    }).catch(quiet('Fingerprint record'));

    const billing = (async () => {
      const headers = buildCommandAuthHeaders(ctx, ensureSession(ctx.key, ctx.sessions));
      const get = async (route) => {
        const r = await upstreamFetch(`${CFG.apiBase}${route}`, { method: 'GET', headers, signal });
        const text = await r.text().catch(() => '');
        if (!r.ok) throw new Error(`GET ${route.split('?')[0]} → ${r.status}`);
        try { return JSON.parse(text); } catch { return null; }
      };
      const who = await get('/alpha/whoami');
      const orgId = who?.org?.id ?? null;
      const q = orgId == null ? '' : `?${new URLSearchParams({ orgId })}`;
      await Promise.all([get(`/alpha/billing/subscriptions${q}`), get(`/alpha/billing/credits${q}`)]);
    })().catch(quiet('Billing prefetch'));

    await Promise.all([lifecycle, fingerprintRecord, billing]);

    // 成功：8h + 2h 随机抖动
    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
    log('info', 'Fingerprint/lifecycle next refresh', { nextIn: `${(INIT_REFRESH_MS + jitter) / 3600000}h`, ...ctx.logTag });
  } catch (e) {
    if (e.name !== 'AbortError') log('warn', 'Fingerprint/lifecycle refresh error, will retry next request', { error: e.message });
  }
}

// ── CLI 1.74.0 模型能力表（由 command-code@1.74.0 dist/cli.mjs 的内置常量提取）──
// efforts = getSupportedEfforts 用的表（Ko）：有表 = 支持思考；值 = 该模型接受的 reasoning_effort 档位
// textOnly = isKnownTextOnlyModel 用的表（nr）：命中 = 不支持图片（CLI 会把图片换成占位文字）
// models = 内置模型目录（fL）里未隐藏的条目，作为 /v1/models 的默认列表（CLI 不调 /provider/v1/models）
const CLI_EFFORT_PRESETS = {
  E0: ['low', 'medium', 'high', 'xhigh', 'max'],
  E1: ['low', 'medium', 'high', 'xhigh'],
  E2: ['low', 'medium', 'high'],
  E3: ['off', 'high', 'max'],
  E4: ['low', 'high', 'max'],
  E5: ['off', 'low', 'high', 'max'],
  E6: ['high', 'max'],
  E7: ['low', 'medium', 'high', 'max'],
  E8: ['low', 'medium', 'xhigh'],
  E9: ['high', 'xhigh'],
};
const CLI_MODEL_EFFORTS = new Map(Object.entries({
  'claude-sonnet-5-5': CLI_EFFORT_PRESETS.E0,
  'claude-sonnet-5': CLI_EFFORT_PRESETS.E0,
  'claude-sonnet-4-6': CLI_EFFORT_PRESETS.E0,
  'claude-fable-5-1': CLI_EFFORT_PRESETS.E0,
  'claude-fable-5': CLI_EFFORT_PRESETS.E0,
  'claude-opus-5-5': CLI_EFFORT_PRESETS.E0,
  'claude-opus-5': CLI_EFFORT_PRESETS.E0,
  'claude-opus-4-8': CLI_EFFORT_PRESETS.E0,
  'claude-opus-4-7': CLI_EFFORT_PRESETS.E0,
  'gpt-6-astra': CLI_EFFORT_PRESETS.E0,
  'gpt-6.1-sol': CLI_EFFORT_PRESETS.E0,
  'gpt-6-sol': CLI_EFFORT_PRESETS.E0,
  'gpt-6-luna': CLI_EFFORT_PRESETS.E0,
  'gpt-5.6-sol': CLI_EFFORT_PRESETS.E0,
  'gpt-5.6-terra': CLI_EFFORT_PRESETS.E0,
  'gpt-5.6-luna': CLI_EFFORT_PRESETS.E0,
  'gpt-5.5': CLI_EFFORT_PRESETS.E1,
  'gpt-5.4': CLI_EFFORT_PRESETS.E1,
  'gpt-5.3-codex': CLI_EFFORT_PRESETS.E1,
  'gpt-5.4-mini': CLI_EFFORT_PRESETS.E2,
  'deepseek/deepseek-v4-pro': CLI_EFFORT_PRESETS.E3,
  'deepseek/deepseek-v4-flash': CLI_EFFORT_PRESETS.E3,
  'deepseek/deepseek-v4-flash-vision-exp': CLI_EFFORT_PRESETS.E3,
  'deepseek/deepseek-v4-flash-fast': CLI_EFFORT_PRESETS.E4,
  'deepseek/deepseek-v4.1-flash': CLI_EFFORT_PRESETS.E5,
  'deepseek/deepseek-v4.1-flash-fast': CLI_EFFORT_PRESETS.E5,
  'moonshotai/Kimi-K3': CLI_EFFORT_PRESETS.E4,
  'zai-org/GLM-5.3': CLI_EFFORT_PRESETS.E4,
  'z-ai/glm-5.3-flash': CLI_EFFORT_PRESETS.E4,
  'z-ai/glm-5.3-flashx': CLI_EFFORT_PRESETS.E4,
  'zai-org/GLM-5.2': CLI_EFFORT_PRESETS.E6,
  'google/gemini-3.8-flash': CLI_EFFORT_PRESETS.E2,
  'google/gemini-3.7-flash': CLI_EFFORT_PRESETS.E2,
  'stealth/space-bunny-alpha': CLI_EFFORT_PRESETS.E7,
  'stealth/pixel-canary': CLI_EFFORT_PRESETS.E8,
  'google/gemini-3.6-flash': CLI_EFFORT_PRESETS.E2,
  'google/gemini-3.5-flash': CLI_EFFORT_PRESETS.E2,
  'google/gemini-3.5-flash-lite': CLI_EFFORT_PRESETS.E2,
  'google/gemini-3.1-flash-lite': CLI_EFFORT_PRESETS.E2,
  'tencent/hy4-preview': CLI_EFFORT_PRESETS.E2,
  'inclusionai/ling-3.1-flash:free': CLI_EFFORT_PRESETS.E2,
  'sakana/fugu-ultra': CLI_EFFORT_PRESETS.E9,
  'xai/grok-4.5': CLI_EFFORT_PRESETS.E2,
  'xai/grok-4.6': CLI_EFFORT_PRESETS.E1,
  'xai/grok-4.7': CLI_EFFORT_PRESETS.E1,
  'Qwen/Qwen3.8-Omni-Flash': CLI_EFFORT_PRESETS.E8,
  'Qwen/Qwen3.8-Max-0902': CLI_EFFORT_PRESETS.E8,
  'Qwen/Qwen3.8-Max': CLI_EFFORT_PRESETS.E8,
  'Qwen/Qwen3.8-27B': CLI_EFFORT_PRESETS.E8,
  'Qwen/Qwen3.8-Flash': CLI_EFFORT_PRESETS.E8,
  'meta/muse-spark-1.1': CLI_EFFORT_PRESETS.E1,
  'meta/muse-spark-1.2': CLI_EFFORT_PRESETS.E1,
  'meta/muse-spark-1.2-contributor': CLI_EFFORT_PRESETS.E1,
  'meta/muse-spark-1.3': CLI_EFFORT_PRESETS.E0,
  'meta/muse-spark-1.3-contributor': CLI_EFFORT_PRESETS.E1,
  'stepfun/Step-5-Preview': CLI_EFFORT_PRESETS.E2,
  'MiniMaxAI/MiniMax-M3': CLI_EFFORT_PRESETS.E2,
  'minimax/minimax-m3-free': CLI_EFFORT_PRESETS.E2,
  'MiniMaxAI/MiniMax-M3-Free': CLI_EFFORT_PRESETS.E2,
}));
const CLI_TEXT_ONLY_MODELS = new Set([
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-fast',
  'zai-org/GLM-5.3', 'zai-org/GLM-5.2', 'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.1', 'zai-org/GLM-5', 'MiniMaxAI/MiniMax-M2.7',
  'minimax/minimax-m2.7-free', 'MiniMaxAI/MiniMax-M2.5', 'xiaomi/mimo-v2.5-pro',
  'Qwen/Qwen3.6-Max-Preview', 'Qwen/Qwen3.7-Max', 'meituan/LongCat-2.0',
  'meituan/LongCat-2.0:free', 'stepfun/Step-3.5-Flash', 'tencent/hy4-preview',
  'tencent/Hy3', 'tencent/hy3-paid', 'nvidia/nemotron-3-ultra-550b-a55b',
  'poolside/laguna-s-2.1-free', 'inclusionai/ling-3.0-flash-free', 'inclusionai/ling-3.0-flash-sante:free',
  'inclusionai/ling-3.1-flash:free',
]);
const CLI_MODEL_ALIASES = {
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-opus-4-5-20251101': 'claude-opus-4-7',
  'claude-opus-4-6': 'claude-opus-4-7',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};
const MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', name: 'Claude Fable 5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro (latest)' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash (latest)' },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision (exp)' },
  { id: 'deepseek/deepseek-v4-flash-fast', name: 'DeepSeek V4 Flash Fast' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek/deepseek-v4.1-flash-fast', name: 'DeepSeek V4.1 Flash Fast' },
  { id: 'moonshotai/Kimi-K3', name: 'Kimi K3' },
  { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code' },
  { id: 'moonshotai/Kimi-K2.7-Code-Highspeed', name: 'Kimi K2.7 Code HighSpeed' },
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash' },
  { id: 'z-ai/glm-5.3-flashx', name: 'GLM-5.3 FlashX' },
  { id: 'zai-org/GLM-5.3', name: 'GLM-5.3' },
  { id: 'zai-org/GLM-5.2', name: 'GLM-5.2' },
  { id: 'zai-org/GLM-5.2-Fast', name: 'GLM-5.2 Fast' },
  { id: 'zai-org/GLM-5.1', name: 'GLM-5.1' },
  { id: 'zai-org/GLM-5', name: 'GLM-5' },
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7' },
  { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
  { id: 'xiaomi/mimo-v2.6-pro', name: 'MiMo V2.6 Pro' },
  { id: 'xiaomi/mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed' },
  { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo V2.6 Flash' },
  { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  { id: 'Qwen/Qwen3.8-Omni-Flash', name: 'Qwen 3.8 Omni Flash' },
  { id: 'Qwen/Qwen3.8-Max-0902', name: 'Qwen 3.8 Max 0902' },
  { id: 'Qwen/Qwen3.8-Max', name: 'Qwen 3.8 Max' },
  { id: 'Qwen/Qwen3.8-27B', name: 'Qwen 3.8 27B' },
  { id: 'Qwen/Qwen3.8-Flash', name: 'Qwen 3.8 Flash' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  { id: 'Qwen/Qwen3.7-Plus', name: 'Qwen 3.7 Plus' },
  { id: 'Qwen/Qwen3.7-Flash', name: 'Qwen 3.7 Flash' },
  { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'meituan/LongCat-2.0', name: 'LongCat 2.0' },
  { id: 'stepfun/Step-5-Preview', name: 'Step 5 Preview' },
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash' },
  { id: 'tencent/hy3-paid', name: 'Tencent Hy3' },
  { id: 'tencent/hy4-preview', name: 'Tencent Hy4 Preview' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
  { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
  { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
  { id: 'sakana/fugu-ultra', name: 'Fugu Ultra' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra' },
  { id: 'thinkingmachines/inkling', name: 'Inkling' },
  { id: 'thinkingmachines/inkling-small', name: 'Inkling Small' },
  { id: 'stealth/space-bunny-alpha', name: 'Space Bunny Alpha' },
  { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1' },
  { id: 'inclusionai/ling-3.0-flash-sante:free', name: 'Ling 3.0 Flash Sante' },
  { id: 'inclusionai/ling-3.1-flash:free', name: 'Ling 3.1 Flash' },
  { id: 'meta/muse-spark-1.1', name: 'Muse Spark 1.1' },
  { id: 'meta/muse-spark-1.2', name: 'Muse Spark 1.2' },
  { id: 'meta/muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor' },
  { id: 'meta/muse-spark-1.3', name: 'Muse Spark 1.3' },
  { id: 'meta/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor' },
  { id: 'xai/grok-4.5', name: 'Grok 4.5' },
  { id: 'xai/grok-4.6', name: 'Grok 4.6' },
  { id: 'xai/grok-4.7', name: 'Grok 4.7' },
];

// CLI 的 canonicalizeModelId：别名表 → 大小写不敏感匹配已知 id → 去掉 -YYYYMMDD / @YYYYMMDD 后缀再试一次
const CLI_KNOWN_MODEL_IDS = new Map([...CLI_MODEL_EFFORTS.keys(), ...CLI_TEXT_ONLY_MODELS, ...MODELS.map(m => m.id)]
  .map(id => [id.toLowerCase(), id]));
function cliResolveKnown(model) {
  const lower = String(model).toLowerCase();
  return CLI_KNOWN_MODEL_IDS.get((CLI_MODEL_ALIASES[lower] ?? lower).toLowerCase());
}
function canonicalizeModelId(model) {
  if (!model) return model;
  const direct = cliResolveKnown(model);
  if (direct) return direct;
  const stripped = String(model).replace(/[-@]\d{8}$/, '');
  return stripped === model ? model : (cliResolveKnown(stripped) ?? model);
}
// registry.supportsThinking / getSupportedEfforts：不在表里 = 不支持思考，CLI 不发 reasoning_effort
function cliSupportedEfforts(model) {
  return CLI_MODEL_EFFORTS.get(canonicalizeModelId(model)) ?? null;
}
// registry.supportsVision：只有已知纯文本模型返回 false；未知模型按支持图片处理（与 CLI 一致）
function cliSupportsVision(model) {
  return !CLI_TEXT_ONLY_MODELS.has(canonicalizeModelId(model));
}

// 客户端给的档位不一定是该模型接受的值（OpenAI 的 minimal/none、Anthropic 预算换算出来的 medium……）。
// CLI 只会发模型表里的值，所以这里按强度序吸附到最近的受支持档位（同距取更高档）；不支持思考的模型直接不发。
const EFFORT_SCALE = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_INPUT_ALIASES = { none: 'off', minimal: 'low', disabled: 'off' };
function resolveCliEffort(model, requested) {
  if (requested === undefined || requested === null || requested === '') return undefined;
  const supported = cliSupportedEfforts(model);
  if (!supported) return undefined;
  const want = EFFORT_INPUT_ALIASES[String(requested).toLowerCase()] ?? String(requested).toLowerCase();
  if (supported.includes(want)) return want;
  const rank = EFFORT_SCALE.indexOf(want);
  if (rank === -1) return undefined;
  // 想关思考但模型没有 off 档：不发（CLI 用户没设 effort 时也是不发）
  if (want === 'off') return undefined;
  let best;
  let bestDist = Infinity;
  for (const level of supported) {
    if (level === 'off') continue;
    const dist = Math.abs(EFFORT_SCALE.indexOf(level) - rank);
    if (dist < bestDist || (dist === bestDist && EFFORT_SCALE.indexOf(level) > EFFORT_SCALE.indexOf(best))) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

// ── 工具函数 ───────────────────────────────────────

// CLI 的 slug 规则：对**完整工作目录**做 slugify（@sindresorhus/slugify），空则 "root"，无随机后缀；
// 同一个 slug 也是 CLI 本地会话目录名。所以 slug 与 config.workingDir 同源：slug = slugify(workingDir)。
function slugifyProjectPath(p) {
  const s = String(p || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'root';
}

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}


// ── CC 请求体构建 ─────────────────────────────────

// buildCcRequest 在请求体上挂的旁路信息（Symbol 键：JSON.stringify 不会序列化，对象展开会保留）
const WIRE_TOOL_ALIASES = Symbol('wireToolAliases'); // wire 名 → 客户端原名（响应里要改回去）
const WIRE_TOOL_SCHEMAS = Symbol('wireToolSchemas'); // wire 名 → input_schema（修整 tool-call 输入用）

// CLI 1.74.0 的 toWireToolName：只有一条重写（dv="tool_search" → cv="search_tools"）。
// 1.53.1 时代的 bash_output/task_output → shell_output、read_multiple_files → read_file 已不复存在；
// 而且那两条会把两个不同的客户端工具折成同一个名字。
const TOOL_NAME_ALIASES = { tool_search: 'search_tools' };

// CLI 的 stripImages 用的占位文字（Qk / Yk 原文）
const visionMarker = (n) => `<attached_image index="${n}">\nAn image is attached here. You cannot view it directly. If a vision tool is available, call it with image_index=${n} to read the image; otherwise tell the user you cannot see images.\n</attached_image>`;
const IMAGE_OMITTED_TEXT = '[image omitted: the active model is text-only]';

// CLI 只认三种 user 部件：text / image（tool-result 在单独的 tool 消息里）。其余字段（cache_control 等）CLI 从不发。
function toWireUserParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') { parts.push({ type: 'text', text: part }); continue; }
    if (part.type === 'text' || part.type === 'input_text') {
      parts.push({ type: 'text', text: String(part.text ?? '') });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      // CC CLI 真实格式: { type: "image", image: "data:<mime>;base64,...", mimeType: "<mime>" }
      const url = (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url) || '';
      if (!url) continue;
      const mediaType = /^data:([^;,]+)/.exec(url)?.[1];
      parts.push({ type: 'image', image: url, ...(mediaType ? { mimeType: mediaType } : {}) });
    } else if (part.type === 'image' && typeof part.image === 'string') {
      parts.push({ type: 'image', image: part.image, ...(part.mimeType ? { mimeType: part.mimeType } : {}) });
    }
  }
  return parts;
}

// CLI 的 stripImages：不支持图片的模型 —— 最后一条带图的 user 消息里，每张图换成带序号的 visionMarker；
// 更早的 user 消息直接去掉图片，若因此变空则换成 IMAGE_OMITTED_TEXT。
function stripImagesForTextOnlyModel(messages) {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content.some(p => p.type === 'image')) { last = i; break; }
  }
  if (last === -1) return messages;
  return messages.map((m, i) => {
    if (m.role !== 'user') return m;
    if (i === last) {
      let n = 0;
      return { role: 'user', content: m.content.map(p => (p.type === 'image' ? { type: 'text', text: visionMarker(++n) } : p)) };
    }
    const kept = m.content.filter(p => p.type !== 'image');
    if (kept.length === m.content.length) return m;
    return { role: 'user', content: kept.length ? kept : [{ type: 'text', text: IMAGE_OMITTED_TEXT }] };
  });
}

function clientToolName(t) { return t?.function?.name || t?.name || ''; }

function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, tools, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key } = openaiReq;
  const wireModel = model || 'deepseek/deepseek-v4-flash';

  // 提取系统提示：OpenAI 的 system / developer 都映射为系统提示。
  // 形态对齐 CLI 的 toWireSystem —— **块数组**，非最后一块补 \n，cache_control 逐块保留
  // （CLI 的 systemSections[].cache → cache_control: ephemeral，这是 CLI 唯一会发缓存断点的位置）。
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const systemBlocks = [];
  for (const m of systemMsgs) {
    if (typeof m.content === 'string') {
      if (m.content) systemBlocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        const text = c?.text ?? c?.content ?? '';
        if (text === '' && !c?.cache_control) continue;
        const block = { type: 'text', text: String(text) };
        if (c?.cache_control) block.cache_control = { type: 'ephemeral' };
        systemBlocks.push(block);
      }
    } else if (m.content != null) {
      systemBlocks.push({ type: 'text', text: String(m.content) });
    }
  }
  const chatMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // ── 工具：定义全量透传（name / description / input_schema，与 CLI 的 toWireTools 同形）──
  // tool_choice / parallel_tool_calls 是 CLI 从不上送的字段，改用 CLI 本身就会发的结构来模拟：
  //   none             → tools: []（CLI 没有工具时发的就是空数组）
  //   指定某个函数      → 只下发那一个工具 + 一条系统指令要求调用它
  //   required / any   → 系统指令要求必须调用工具
  //   parallel=false   → 系统指令要求一次最多调一个工具
  // temperature 没有 CLI 能表达的等价物（CLI 的 agent 回合从不发），只能丢弃。
  let toolDefs = Array.isArray(tools) ? tools : [];
  const directives = [];
  const tc = tool_choice;
  const tcType = typeof tc === 'string' ? tc : tc?.type;
  if (tcType === 'none') {
    toolDefs = [];
  } else if (tcType === 'required' || tcType === 'any') {
    if (toolDefs.length) directives.push('You must call at least one of the available tools in your next response.');
  } else if (tcType === 'function' || tcType === 'tool') {
    const name = tc.function?.name ?? tc.name;
    const only = toolDefs.filter(t => clientToolName(t) === name);
    if (name && only.length) {
      toolDefs = only;
      directives.push(`You must call the \`${name}\` tool in your next response.`);
    }
  }
  if (parallel_tool_calls === false && toolDefs.length) directives.push('Call at most one tool per response.');

  // 工具名重写：客户端同时定义了两个名字时不重写（否则会出现重名工具）
  const clientNames = new Set(toolDefs.map(clientToolName));
  const aliases = {};
  for (const [from, to] of Object.entries(TOOL_NAME_ALIASES)) {
    if (clientNames.has(from) && !clientNames.has(to)) aliases[from] = to;
  }
  const wireName = (n) => aliases[n] || n;
  const schemas = new Map();
  const wireTools = toolDefs.map(t => {
    const name = wireName(clientToolName(t));
    const input_schema = t.function?.parameters || t.input_schema || t.parameters || { type: 'object', properties: {} };
    schemas.set(name, input_schema);
    return { name, description: t.function?.description || t.description || '', input_schema };
  });

  // Build tool_call_id → tool_name reverse lookup（CLI：tool-result 的 toolName 取自对应 tool-call 的 wire 名）
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc2 of msg.tool_calls) if (tc2.id) toolNameMap[tc2.id] = wireName(tc2.function?.name || '');
    }
  }

  // ── 消息：逐条对齐 CLI 的 toWireMessages ──
  let ccMessages = [];
  for (const msg of chatMessages) {
    if (msg.role === 'assistant') {
      const parts = [];
      // 思考内容必须回传（CC 在 thinking 模式下校验 reasoning 是否随历史带回）；次序 [reasoning, text, tool-call]
      if (msg.reasoning_content) parts.push({ type: 'reasoning', text: String(msg.reasoning_content) });
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text' || part.type === 'output_text') parts.push({ type: 'text', text: String(part.text ?? '') });
          else if (part.type === 'reasoning' && !msg.reasoning_content) parts.push({ type: 'reasoning', text: String(part.text ?? '') });
        }
      }
      for (const call of msg.tool_calls || []) {
        const args = call.function?.arguments;
        const parsed = typeof args === 'string' ? tryParseJSON(args) : (args || {});
        parts.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: wireName(call.function?.name || ''),
          input: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
        });
      }
      ccMessages.push({ role: 'assistant', content: parts });
    } else if (msg.role === 'tool') {
      const result = {
        type: 'tool-result',
        toolCallId: msg.tool_call_id,
        toolName: toolNameMap[msg.tool_call_id] || wireName(msg.name || '') || 'unknown',
        output: { type: 'text', value: toWireToolOutputValue(msg.content) },
      };
      // CLI 把同一回合的全部工具结果放进**一条** tool 消息
      const prev = ccMessages[ccMessages.length - 1];
      if (prev?.role === 'tool') prev.content.push(result);
      else ccMessages.push({ role: 'tool', content: [result] });
    } else {
      // user（以及未知 role 兜底）
      const parts = toWireUserParts(msg.content);
      if (parts.length) ccMessages.push({ role: 'user', content: parts });
    }
  }
  if (!cliSupportsVision(wireModel)) ccMessages = stripImagesForTextOnlyModel(ccMessages);

  // 缓存断点：若给了 OpenAI 系的 prompt_cache_key 而客户端没在 system 上标断点，落在 system 最后一块
  // （缓存按前缀计算，system 正是最前的那段前缀）。模拟出来的指令块排在断点之后，不影响前缀命中。
  if (prompt_cache_key && systemBlocks.length && !systemBlocks.some(b => b.cache_control)) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }
  if (directives.length) systemBlocks.push({ type: 'text', text: directives.join('\n') });
  for (let i = 0; i < systemBlocks.length - 1; i++) systemBlocks[i].text += '\n';

  let system;
  if (systemBlocks.length) {
    system = systemBlocks;
  } else if (CFG.emptySystemPlaceholder) {
    // CC 上游在 params.system 缺省时会注入自身约 7.5K token 的默认提示词（issue #17）；发一个空格占位即可绕过。
    system = [{ type: 'text', text: ' ' }];
  }

  // 信封键序对齐 CLI：config, memory, taste, skills, permissionMode, threadId, mode, promptCache, params
  // （threadId 在 forwardToCC 里补）。CLI 1.74.0 的 agent 回合**不带 mode**（主循环配置里没有这个字段，
  // JSON 序列化时整键消失）；只有 title-gen / compact 等功能调用才带。cliMode 可显式指定。
  const body = {
    config: {
      // 伪造的项目目录（不再发宿主真实 cwd）；environment 用伪装的平台词，与指纹保持自洽
      workingDir: DEVICE_PROFILE.projectDir,
      date: getDateStr(),
      environment: DEVICE_PROFILE.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,          // CLI 发 null，不是空串
    permissionMode: 'standard',
  };
  if (CFG.cliMode) body.mode = CFG.cliMode;

  // params 键序对齐 CLI：model, messages, tools, system, max_tokens, stream, [temperature], [reasoning_effort]
  const effort = resolveCliEffort(wireModel, reasoning_effort);
  body.params = {
    model: wireModel,
    messages: ccMessages,
    tools: wireTools,       // CLI 总是下发 tools（没有工具时是空数组）
    ...(system ? { system } : {}),
    max_tokens: Math.min(max_tokens || 64000, 200000),
    stream: true,           // CC API 总是 stream
    ...(effort ? { reasoning_effort: effort } : {}),
  };

  body[WIRE_TOOL_SCHEMAS] = schemas;
  const reverse = Object.fromEntries(Object.entries(aliases).map(([from, to]) => [to, from]));
  if (Object.keys(reverse).length) body[WIRE_TOOL_ALIASES] = reverse;
  return body;
}

function toWireToolName(name) { return TOOL_NAME_ALIASES[name] || name; }

// CLI 的 toWireToolOutput：只取文本块，用 '\n' 拼接
function toWireToolOutputValue(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text ?? '').join('\n');
  }
  return content == null ? '' : String(content);
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── CC NDJSON → OpenAI SSE 转换 ────────────────────

function createSseTranslator(model, completionId, created) {
  // 是否见过终态 finish 事件。CLI 用同一个标志判定「流是不是被截断了」。
  let sawFinish = false;
  let chunkIndex = 0;
  let sentRole = false;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    /** 解析一行 NDJSON，返回 OpenAI chunk 数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start':
        case 'reasoning-start':
        case 'start':
        case 'start-step':
          // 忽略，无用户可见内容
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          sentRole = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          sawFinish = true;
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          sawFinish = true;
          const fr = toOpenAIFinishReason(finishReason || mapFinishReason(event.finishReason || 'stop'));
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = u ? {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          } : undefined;
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          this.upstreamError = mapCcEventError(event);
          // 先映射再记日志，并把上游自带的状态/可重试性一并打出 ——
          // 排查容量/限流类问题时，真正需要的就是这两个字段
          log('warn', 'CC stream error', {
            message: msg,
            upstreamStatus: this.upstreamError.reportedStatus,
            upstreamRetryable: event.error?.isRetryable,
            code: this.upstreamError.code,
            mappedTo: this.upstreamError.status,
          });
          // Don't emit a finish_reason chunk — let the natural stream termination
          // handle it. Otherwise a subsequent finish(tool_calls) would be ignored
          // by downstream agent loops that stop at the first finish_reason.
          break;
        }

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          // Silent - no user-visible content
          break;
        default:
          log('warn', 'Unknown CC event type', { type: event.type });
          break;
      }

      return out.length > 0 ? out : null;
    },

    /** 这次上游流若没有正常走完 finish，返回可读原因；正常则为 null。 */
    incompleteDetail() {
      return incompleteUpstreamDetail(sawFinish, finishReason);
    },

    /** 获取 SSE 结束标记 */
    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// normalize CC usage stats:
// - outputTokens=0 → zero everything (anti false billing)
function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {  // 0, null, undefined, NaN → zero input + cached (anti false billing)
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

// CC 的 inputTokens 是「总数」（含缓存命中部分），而 Anthropic 的 input_tokens 只计
// 非缓存部分 —— 官方 SDK 注释：Total input tokens in a request is the summation of
// `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`。
// 直接把 CC 的 inputTokens 当 input_tokens 转发，会让下游把两者当成互不重叠的两部分，
// 相加后约为真实输入的两倍（issue #25）。
//
// CC 实际已经算好：inputTokenDetails.noCacheTokens（实测 noCacheTokens + cacheReadTokens
// === inputTokens）。优先采用该字段；缺失时回退到减法，保证老版本上游也能得到正确值。
function anthropicInputTokens(usage, noCacheOverride) {
  const u = usage || {};
  if (typeof noCacheOverride === 'number' && noCacheOverride >= 0) return noCacheOverride;
  const noCache = u.inputTokenDetails && u.inputTokenDetails.noCacheTokens;
  if (typeof noCache === 'number' && noCache >= 0) return noCache;
  const cacheRead = u.cachedInputTokens || (u.inputTokenDetails && u.inputTokenDetails.cacheReadTokens) || 0;
  const cacheWrite = (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0;
  return Math.max(0, (u.inputTokens || 0) - cacheRead - cacheWrite);
}

// 上游 finishReason → 本代理内部规范化取值。
// 对齐 CLI 的 normalizeStopReason2 / isNetworkFailureFinish（command-code@1.54.0）：
//   tool_use | tool-calls | tool_calls                    → tool_calls
//   length | max_tokens | max_output_tokens
//          | model_context_window_exceeded                → length
//   /^(network|connection|upstream)[-_\s]?error$/i        → upstream_error
//   pause_turn                                            → pause_turn（原样保留）
// 关键点：'length' 家族**不止 'length' 一个值**。max_output_tokens 与
// model_context_window_exceeded 都是「输出被截断」，折成 stop/end_turn 等于
// 把半截回答谎报成完整回答。未知值一律原样返回，宁可让它露出来也不要静默折成 stop。
function mapFinishReason(reason) {
  const r = String(reason ?? '').trim().toLowerCase();
  if (!r) return 'stop';
  if (r === 'tool-calls' || r === 'tool_calls' || r === 'tool_use') return 'tool_calls';
  if (r === 'length' || r === 'max_tokens'
      || r === 'max_output_tokens' || r === 'model_context_window_exceeded') return 'length';
  if (/^(?:network|connection|upstream)[-_\s]?error$/.test(r)) return 'upstream_error';
  return r;
}

// 上游「没有正常走完」的两种情形，CLI 都当成可重试的 502：
//   · 流里根本没有 finish 事件 —— "Stream ended unexpectedly before completion
//     (no finish event) — response was truncated"
//   · provider 报 network/connection/upstream-error —— isNetworkFailureFinish
// 返回 null 表示这次流是正常结束的。
//
// sawFinish 的口径是「上游给过任何完成信号」：终态 finish，以及本代理一直在处理的
// finish-step。（'finish-step' 在 CLI 的事件集里不存在 —— 见 proxy.mjs 各处注释 ——
// 但既然代理认它，就不能让它变成「没完成」，否则会把原本正常的响应误判成 502。
// 真正要拦的是「一个完成信号都没有就断了」。）
function incompleteUpstreamDetail(sawFinish, finishReason) {
  if (!sawFinish) return 'no finish event';
  if (finishReason === 'upstream_error') return 'provider reported an upstream connection failure';
  return null;
}

function incompleteUpstreamError(detail) {
  return {
    status: 502,
    // retry_after 同时放在 body 里与顶层：sendJSON 只发 body，
    // 而 sendAnthropicError / sendResponsesError 需要单独的形参。
    body: {
      error: {
        message: `Upstream stream ended without a completion finish (${detail}) — response was truncated`,
        type: 'upstream_error',
      },
      retry_after: 10,
    },
    retry_after: 10,
  };
}

// ── 错误映射 ───────────────────────────────────────
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },       // payment required → rate limit
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;
  let code = null;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
      // 上游错误体：{"success":false,"error":{"code":"BAD_REQUEST"|"USAGE_EXCEEDED",...}}
      // code 是上游的机器可读错误分类（BAD_REQUEST / USAGE_EXCEEDED 等），透出来便于下游 SDK 与运维判定
      code = parsed.error?.code || parsed.code || null;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  // CC 429 响应可能带 retry-after
  if (ccStatus === 429) {
    return {
      status: 429,
      code,
      body: {
        error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) },
        retry_after: 30,
      },
    };
  }

  return { status: mapped.status, code, body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

// CLI 的 parseEmbeddedErrorJSON：message 形如 `429 {"error":{"type":"…","message":"…"}}`
function parseEmbeddedErrorJSON(text) {
  const i = String(text).indexOf('{');
  if (i === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(i));
    if (typeof parsed?.error?.message !== 'string') return null;
    const prefix = text.slice(0, i).trim();
    return {
      status: /^\d+$/.test(prefix) ? Number(prefix) : null,
      type: typeof parsed.error.type === 'string' ? parsed.error.type : null,
      message: parsed.error.message,
    };
  } catch {
    return null;
  }
}
// CLI 的 hasTerminalMarker：这几种错误重试也没用（额度 / 套餐），isStreamErrorRetryable 判为不可重试
const CLI_TERMINAL_CREDIT_MARKERS = ['premium_credits_exhausted', 'insufficient credits'];
const CLI_TERMINAL_PLAN_MARKERS = ['model_not_in_plan'];

function mapCcEventError(event) {
  // CLI 的 readStreamErrorEvent：error 可能是裸字符串，也可能是 { message, statusCode, isRetryable }
  const rawMessage = (typeof event.error === 'string' && event.error)
    || event.error?.message || event.message || 'Unknown CC error';
  const embedded = parseEmbeddedErrorJSON(rawMessage);
  const message = embedded ? `${embedded.type ?? 'error'}: ${embedded.message}` : rawMessage;
  let code = event.error?.code || event.code || null;
  const lower = message.toLowerCase();
  const creditMarker = CLI_TERMINAL_CREDIT_MARKERS.some(m => lower.includes(m));
  const planMarker = CLI_TERMINAL_PLAN_MARKERS.some(m => lower.includes(m));
  if (!code && creditMarker) code = 'INSUFFICIENT_CREDITS';
  if (!code && planMarker) code = 'MODEL_NOT_IN_PLAN';
  // 上游 error 事件除了 message 还可能自带 statusCode / isRetryable ——
  // CLI 的 readStreamErrorEvent 读的正是这两个字段，取值链是
  //   parseEmbeddedErrorJSON(message)?.status ?? error.statusCode ?? null
  // 原实现只看 message 里的 "<NNN>" 前缀，statusCode 一律被丢掉，
  // 于是 429 / 503 这类「该退避重试」的信号在代理这一层被抹平成 502「服务端错误」：
  // 客户端不再按限流退避，监控也会把它错误归类成后端故障。
  // 取值链对齐 CLI：parseEmbeddedErrorJSON(message)?.status ?? error.statusCode ?? null；另兼容旧的 "<NNN>" 前缀
  const statusMatch = rawMessage.match(/^<(\d{3})>/);
  let reportedStatus = embedded?.status
    ?? (statusMatch ? Number(statusMatch[1]) : null)
    ?? (Number.isInteger(event.error?.statusCode) ? event.error.statusCode : null);
  // 终态标记没带状态码时给一个不可重试的语义：额度 → 402（下游看到 429 + code，池账号按额度冷却）；套餐不含该模型 → 400
  if (reportedStatus === null && creditMarker) reportedStatus = 402;
  if (reportedStatus === null && planMarker) reportedStatus = 400;
  const ccStatus = reportedStatus ?? 502;
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };

  // 与 mapCcError 保持一致：终态为 429 时带上 retry_after，
  // 否则客户端 SDK 拿不到退避提示（402 也映射成 429，一视同仁）
  if (mapped.status === 429) {
    return {
      status: 429,
      code,
      reportedStatus,
      body: { error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) }, retry_after: 30 },
    };
  }

  return { status: mapped.status, code, reportedStatus,
    body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

// ── HTTP 请求处理 ──────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let settled = false;
    let drained = 0;
    // 413 拒绝后转入排空模式：继续读取并丢弃剩余请求体，保持 keep-alive 连接可复用，
    // 让客户端明确收到 413 而不是 Connection reset（issue #7）。
    // 但若客户端无视 413 持续上传超过 DRAIN_LIMIT，则强制掐断，不无限吞带宽。
    const DRAIN_LIMIT = 32 * 1024 * 1024;
    req.on('data', c => {
      if (settled) {
        drained += c.length;
        if (drained > DRAIN_LIMIT) { try { req.destroy(); } catch {} }
        return;
      }
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        settled = true;
        chunks.length = 0;
        const mb = Math.round(MAX_BODY_SIZE / 1024 / 1024);
        const err = new Error(`Request body exceeds ${mb}MB limit`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', e => { if (!settled) { settled = true; reject(e); } });
  });
}

// 下游背压：res.write() 返回 false 表示 socket 写缓冲已超 highWaterMark（消费者跟不上）。
// 忽略它会让整个上游流在内存中无界堆积 —— 客户端不读时 RSS 随上游流一起增长（issue #20）。
// 必须同时监听 close/error，否则客户端断连会让请求协程永久挂起。
// CLIENT_DRAIN_TIMEOUT_MS > 0 时额外加一道空闲看门狗：超时则 destroy 该响应，
// 由此触发既有的 res 'close' 处理器 → aborted=true → 中止 CC 上游，无需改动各调用点。
function waitDrain(res) {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      res.off('drain', done); res.off('close', done); res.off('error', done);
      if (timer) { clearTimeout(timer); timer = null; }
      resolve();
    };
    res.once('drain', done); res.once('close', done); res.once('error', done);
    if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        log('warn', 'Client stalled on backpressure, dropping connection', {
          path: res.req?.url || '(unknown)',
          timeoutMs: CLIENT_DRAIN_TIMEOUT_MS,
          bufferedBytes: res.writableLength,
        });
        try { res.destroy(); } catch {}
        done();
      }, CLIENT_DRAIN_TIMEOUT_MS);
    }
  });
}

// 上游读空闲看门狗：复用单个定时器，避免「每个 chunk 新建一个 setTimeout 且从不清理」。
// 实测每个待触发定时器滞留约 225B；稳态滞留 = 吞吐 × 超时窗口 × 每响应 chunk 数 × 225B
// （50 rps × 2000 chunk × 30s ≈ 644MB，非流式 90s 窗口约为其三倍）。
// arm() 用 refresh() 把窗口重置为「本轮 read 开始」，与原实现语义一致：超时只计 reader.read() 的等待。
function createIdleWatchdog(timeoutMs) {
  let rejectFn = null;
  const expired = new Promise((_, reject) => { rejectFn = reject; });
  expired.catch(() => {}); // 读循环退出后定时器才触发时，避免 unhandledRejection
  const timer = setTimeout(() => rejectFn(new Error('STREAM_IDLE_TIMEOUT')), timeoutMs);
  return {
    arm() { timer.refresh(); return expired; },
    dispose() { clearTimeout(timer); },
  };
}

function sendJSON(res, status, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (data && data.retry_after !== undefined) {
    headers['Retry-After'] = String(data.retry_after);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function getApiKey(headers) {
  // Try Authorization: Bearer header (OpenAI SDK style)
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const match = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  // Fall back to x-api-key header (Anthropic SDK style)
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const match = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

// ── 上游 HTTP(S) 代理（issue #18）────────────────────
// 仅作用于发往 CC 上游的请求（/alpha/generate、/provider/v1/models）。
// 本地监听、/health 与 npm registry 版本检查都不经过代理。
//
// 零依赖实现：自己建立 CONNECT 隧道，再用 node:https 复用同一个 socket，
// 因此不需要 undici / https-proxy-agent，engines >=18 也能用。
// 注意 Node 原生 fetch 不读 HTTPS_PROXY/HTTP_PROXY；官方的环境变量方案需要
// Node >= 22.21 / 24.5 并设 NODE_USE_ENV_PROXY=1（README 有说明）。
const UPSTREAM_PROXY = CFG.upstreamProxy || '';
const PROXY_CONNECT_TIMEOUT_MS = 15000;

// 代理 URL 的解析 / 脱敏在 pool.mjs（账号池的每账号代理与这里共用同一套实现，也支持 https:// 代理）。

// 启动即校验：写错的代理地址应当立刻拒绝启动，而不是每个请求各 502 一次。
if (UPSTREAM_PROXY) {
  try {
    parseProxyUrl(UPSTREAM_PROXY);
  } catch (e) {
    log('error', 'Invalid upstreamProxy, refusing to start', {
      error: e.message, value: redactProxyUrl(UPSTREAM_PROXY),
    });
    process.exit(1);
  }
  log('info', 'Upstream requests will go through the configured proxy', {
    proxy: redactProxyUrl(UPSTREAM_PROXY),
  });
}

/** 配了代理走隧道（实现见 pool.mjs 的 createUpstreamFetch），否则用原生 fetch（默认路径行为完全不变）。 */
const proxyFetch = UPSTREAM_PROXY ? createUpstreamFetch({ proxy: UPSTREAM_PROXY, connectTimeoutMs: PROXY_CONNECT_TIMEOUT_MS }) : null;
function upstreamFetch(urlStr, options) {
  return proxyFetch ? proxyFetch(urlStr, options) : fetch(urlStr, options);
}

// ── 账号上下文 ──────────────────────────────────────
// 每个请求解析出一个「账号上下文」，上游调用（generate / 指纹 / lifecycle / models）全部经它走：
//   - 透传：客户端自带 user_ key —— 与以前完全一样（全局 upstreamFetch、全局 session / 指纹表）；
//   - 账号池：从池里租一个账号 —— 该账号自己的 key、出口、设备档案、会话、模型缓存、超时计数。

const globalModelsCache = { models: null, at: 0 };

function passthroughContext(apiKey) {
  return {
    pooled: false,
    key: apiKey,
    fetch: upstreamFetch,
    deviceProfile: DEVICE_PROFILE,
    get initState() { return getOrCreateKeyState(apiKey); },
    sessions: sessionStore,
    modelsCache: globalModelsCache,
    timeouts: globalTimeouts,
    logTag: undefined,
    lease: null,
  };
}

function accountContext(account, lease = null) {
  const st = account.state;
  return {
    pooled: true,
    key: account.key,
    fetch: account.fetch,
    deviceProfile: st.deviceProfile,
    initState: st.init,
    sessions: st.sessions,
    modelsCache: st.models,
    timeouts: st.timeouts,
    logTag: { account: account.name },
    lease,
  };
}

/** 池账号的协议层状态（pool.mjs 的 createState 回调）。 */
function createAccountProtocolState(account) {
  const salt = account.config.fingerprintSalt ?? CFG.fingerprintSalt;
  const state = {
    deviceProfile: deriveDeviceProfile(account.key, salt, account.config.deviceProjectDir),
    init: { fingerprint: generateFingerprint(account.key, salt), nextInitAt: 0, initializing: null },
    sessions: new Map(),
    models: { models: null, at: 0 },
    timeouts: { count: 0 },
  };
  log('info', 'Fingerprint generated for pooled account', { account: account.name });
  return state;
}

/** 池模式下的会话粘性键：客户端会话 id > prompt_cache_key > user > 首轮内容哈希。 */
function conversationKeyOf(headers, openaiReq) {
  if (!POOL) return null;
  const sid = clientSessionIdOf(headers, null);
  if (sid) return `s:${sid}`;
  if (typeof openaiReq?.prompt_cache_key === 'string' && openaiReq.prompt_cache_key) return `p:${openaiReq.prompt_cache_key}`;
  if (typeof openaiReq?.user === 'string' && openaiReq.user) return `u:${openaiReq.user}`;
  const msgs = Array.isArray(openaiReq?.messages) ? openaiReq.messages : [];
  const sys = msgs.find(m => m?.role === 'system' || m?.role === 'developer');
  const firstUser = msgs.find(m => m?.role === 'user');
  if (!firstUser) return null;
  try {
    return 'h:' + crypto.createHash('sha256')
      .update(JSON.stringify([openaiReq.model || '', sys?.content ?? null, firstUser.content ?? null]))
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * 为请求解析账号：
 *   { kind: 'ok', ctx }              可以开始了
 *   { kind: 'missing' }              既没有客户端 key、也没开账号池 → 由调用方回原来的 401
 *   { kind: 'error', status, ... }   账号池准入失败（排队满 / 超时 / 全员冷却）
 *   { kind: 'gone' }                 排队期间客户端断开了
 * 租约在响应 finish/close 时释放（覆盖流的整个生命周期），幂等。
 */
async function resolveAccount(req, res, conversationKey) {
  const clientKey = getApiKey(req.headers);
  if (clientKey && (!POOL || POOL_CFG.passthroughClientKeys)) return { kind: 'ok', ctx: passthroughContext(clientKey) };
  if (!POOL) return { kind: 'missing' };

  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.once('close', onClose);
  let lease;
  try {
    lease = await POOL.acquire(conversationKey, { signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return { kind: 'gone' };
    log('warn', 'Account pool admission failed', { message: e.message, status: e.status });
    return { kind: 'error', status: e.status || 503, type: e.type || 'server_busy', message: e.message, retryAfter: e.retryAfter ?? 5 };
  } finally {
    res.off('close', onClose);
  }
  const release = () => lease.release();
  if (res.destroyed || res.writableEnded) { release(); return { kind: 'gone' }; }
  res.once('finish', release);
  res.once('close', release);
  return { kind: 'ok', ctx: accountContext(lease.account, lease) };
}

/**
 * 给池账号的上游响应体挂一个旁路：只看 error / finish 事件来给账号记健康，字节原样透传。
 * 只解析可能是 error/finish 的短行；超长行（大 tool-call 等）直接跳过，不额外缓存。
 */
const HEALTH_TAP_MAX_LINE = 64 * 1024;
function tapUpstreamHealth(response, lease, signal) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let skipping = false;
  let settled = false;
  const scan = (line) => {
    if (settled || line.length > HEALTH_TAP_MAX_LINE) return;
    if (!line.includes('"error"') && !line.includes('"finish"')) return;
    let ev;
    try { ev = JSON.parse(line.trim()); } catch { return; }
    if (ev?.type === 'error') {
      settled = true;
      const mapped = mapCcEventError(ev);
      lease.report({ status: mapped.reportedStatus, code: mapped.code });
    } else if (ev?.type === 'finish') {
      settled = true;
      lease.reportSuccess();
    }
  };
  const body = new ReadableStream({
    async pull(controller) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        if (!signal?.aborted && e?.message !== 'STREAM_IDLE_TIMEOUT') lease.reportTransportError(e);
        controller.error(e);
        return;
      }
      if (r.done) {
        if (!skipping && tail) scan(tail);
        controller.close();
        return;
      }
      if (!settled) {
        const text = decoder.decode(r.value, { stream: true });
        let from = 0;
        let nl;
        while ((nl = text.indexOf('\n', from)) !== -1) {
          if (!skipping) scan(tail + text.slice(from, nl));
          tail = '';
          skipping = false;
          from = nl + 1;
        }
        if (!skipping) {
          tail += text.slice(from);
          if (tail.length > HEALTH_TAP_MAX_LINE) { tail = ''; skipping = true; }
        }
      }
      controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// ── 流式转发 ────────────────────────────────────────

// ── 请求头（逐键对齐 CLI 1.74.0）─────────────────────
// createNodeTransport 先放小写的 "content-type"，buildCommandAuthHeaders 再放 "Content-Type" —— 两个键大小写不同，
// fetch 的 Headers 会把它们合并成一行 `content-type: application/json, application/json`，真机线上就是这样。
// 键的插入顺序 = undici 的发送顺序，也照搬。
function buildCommandAuthHeaders(ctx, sessionId, { zdr = CFG.zdr } = {}) {
  return {
    'content-type': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'x-command-code-version': CC_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': slugifyProjectPath(ctx.deviceProfile.projectDir),
    'x-taste-learning': String(CFG.tasteLearning === true),
    'x-session-id': sessionId,
    'Authorization': `Bearer ${ctx.key}`,
    ...(zdr ? { 'x-cmd-zdr': '1' } : {}),
  };
}

/**
 * 上游 NDJSON 的统一整形（所有上下文都过这一层，各协议的翻译器因此不必各改一遍）。对齐 CLI 的 consumeStream：
 *   - providerExecuted 的 tool-call（服务端自己执行的工具，如联网搜索）与 tool-result 事件：CLI 不执行、
 *     也不回放进历史 → 丢弃，绝不能当成要客户端执行的工具调用转出去；
 *   - abort：CLI 视为正常结束（不报截断）→ 改写成 finish；
 *   - cache-write-tokens：纯计量事件 → 丢弃；
 *   - error 的 error 字段可能是裸字符串 → 规整成 { message }；
 *   - tool-call：工具名改回客户端原名（TOOL_NAME_ALIASES 的反向），输入按 CLI 的 coerceToolInput 修整；
 *   - finish：totalUsage 缺 cachedInputTokens 时用 inputTokenDetails.cacheReadTokens 补上（CLI 读的是后者）。
 * 只有可能需要改写的行才缓存到换行再解析；text-delta 等在行首认出类型后立即原样透传（不额外延迟、不攒长行）。
 */
const NORMALIZE_TYPES = new Set(['tool-call', 'tool-result', 'abort', 'cache-write-tokens', 'error', 'finish', 'tool-input-start']);
const LINE_TYPE_RE = /^\s*\{\s*"type"\s*:\s*"([^"]*)"/;

function coerceToolInput(raw, schema) {
  let value = raw;
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    let text = value;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      if (typeof parsed !== 'string') return {};
      text = parsed;
    } catch {}
    // wrapBareStringRoot：schema 恰好只有一个必填字段时，把裸字符串包进去
    const required = schema?.required;
    if (Array.isArray(required) && required.length === 1 && typeof required[0] === 'string') {
      const prop = schema.properties?.[required[0]];
      return { [required[0]]: prop && prop.type === 'array' ? [text] : text };
    }
  }
  return {};
}

function normalizeEventLine(line, { toolAliases, toolSchemas }) {
  let ev;
  try { ev = JSON.parse(line); } catch { return line; }
  if (!ev || typeof ev !== 'object') return line;
  switch (ev.type) {
    case 'tool-result':
    case 'cache-write-tokens':
      return null;
    case 'tool-input-start':
      if (ev.providerExecuted === true) return null;
      if (toolAliases?.[ev.toolName]) { ev.toolName = toolAliases[ev.toolName]; return JSON.stringify(ev); }
      return line;
    case 'tool-call': {
      if (ev.providerExecuted === true) return null;
      const wire = ev.toolName ?? '';
      const input = coerceToolInput(ev.input ?? ev.args, toolSchemas?.get(wire));
      ev.toolName = toolAliases?.[wire] ?? wire;
      ev.input = input;
      delete ev.args;
      return JSON.stringify(ev);
    }
    case 'abort':
      return JSON.stringify({ type: 'finish', finishReason: 'stop' });
    case 'error':
      if (typeof ev.error === 'string') { ev.error = { message: ev.error }; return JSON.stringify(ev); }
      return line;
    case 'finish': {
      const u = ev.totalUsage;
      const cacheRead = u?.inputTokenDetails?.cacheReadTokens;
      if (u && u.cachedInputTokens === undefined && typeof cacheRead === 'number') {
        u.cachedInputTokens = cacheRead;
        return JSON.stringify(ev);
      }
      return line;
    }
    default:
      return line;
  }
}

function normalizeUpstreamStream(response, opts) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';          // 当前行已收到、尚未输出的部分
  let mode = 'undecided'; // undecided | pass（原样透传到行尾）| hold（攒到行尾再整形）
  const decide = () => {
    const m = LINE_TYPE_RE.exec(buf);
    if (m) mode = NORMALIZE_TYPES.has(m[1]) ? 'hold' : 'pass';
    else if (buf.length >= 128 || /^\s*[^\s{]/.test(buf)) mode = 'hold'; // type 不在首键 / 非 JSON：保守地整行处理
  };
  const flushLine = (line, out) => {
    if (mode === 'pass') { out.push(line); return; }
    const fixed = line.trim() ? normalizeEventLine(line, opts) : line;
    if (fixed !== null) out.push(fixed);
  };
  const transform = (text) => {
    const out = [];
    let from = 0;
    for (;;) {
      const nl = text.indexOf('\n', from);
      const seg = nl === -1 ? text.slice(from) : text.slice(from, nl);
      if (mode === 'pass') {
        out.push(seg);
      } else {
        buf += seg;
        if (mode === 'undecided') {
          decide();
          if (mode === 'pass') { out.push(buf); buf = ''; }
        }
      }
      if (nl === -1) break;
      if (mode !== 'pass') {
        const line = buf;
        buf = '';
        const keep = [];
        flushLine(line, keep);
        if (keep.length) out.push(keep[0] + '\n');
      } else {
        out.push('\n');
      }
      mode = 'undecided';
      from = nl + 1;
    }
    return out.join('');
  };
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        let r;
        try {
          r = await reader.read();
        } catch (e) {
          controller.error(e);
          return;
        }
        if (r.done) {
          let rest = transform(decoder.decode());
          if (buf) { const keep = []; flushLine(buf, keep); rest += keep.join(''); buf = ''; }
          if (rest) controller.enqueue(encoder.encode(rest));
          controller.close();
          return;
        }
        const out = transform(decoder.decode(r.value, { stream: true }));
        if (out) { controller.enqueue(encoder.encode(out)); return; }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function forwardToCC(body, ctx, incomingHeaders = {}, signal, promptCacheKey) {
  // 先取旁路信息：下面按 CLI 键序重排信封时会换成新对象
  const toolAliases = body[WIRE_TOOL_ALIASES];
  const toolSchemas = body[WIRE_TOOL_SCHEMAS];
  const url = `${CFG.apiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = getSessionId(incomingHeaders, ctx, promptCacheKey);
  // 池账号：工作目录换成该账号自己的设备档案（buildCcRequest 时还不知道是哪个账号）
  if (ctx.pooled) body = { ...body, config: { ...body.config, workingDir: ctx.deviceProfile.projectDir } };
  // CLI 的 toWireThreadId：只有合法 UUID 才放进信封，否则整个键省略。
  // 同时按 CLI 的键顺序重排：config, memory, taste, skills, permissionMode, threadId, mode, params
  if (UUID_RE.test(String(sessionId))) {
    const ordered = {};
    for (const k of ['config', 'memory', 'taste', 'skills', 'permissionMode']) ordered[k] = body[k];
    ordered.threadId = sessionId;
    for (const k of ['mode', 'promptCache', 'params']) if (k in body) ordered[k] = body[k];
    body = ordered;
  }

  const headers = {
    ...buildCommandAuthHeaders(ctx, sessionId, { zdr: CFG.zdr || incomingHeaders['x-cmd-zdr'] === '1' }),
    // createModelClient 追加的请求级头：x-cmd-zdr（与上面同名同值，展开后只剩一个）+ OTel 的 traceparent
    'traceparent': traceparent,
  };
  let response;
  try {
    response = await ctx.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (!signal?.aborted) ctx.lease?.reportTransportError(e);
    throw e;
  }
  if (response.ok) response = normalizeUpstreamStream(response, { toolAliases, toolSchemas });
  if (!ctx.lease) return response;

  // 池账号：在这里统一给账号记健康（HTTP 错误码 + 流内 error/finish 事件），各 handler 不必关心
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const mapped = mapCcError(response.status, text);
    ctx.lease.report({
      status: response.status,
      code: mapped.code,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    });
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return tapUpstreamHealth(response, ctx.lease, signal);
}

// ── 路由 ────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try {
    openaiReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendJSON(res, 413, { error: { message: e.message, type: 'invalid_request_error' } });
      return;
    }
    sendJSON(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }

  const acct = await resolveAccount(req, res, conversationKeyOf(req.headers, openaiReq));
  if (acct.kind === 'missing') {
    sendJSON(res, 401, { error: { message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header', type: 'auth_error' } });
    return;
  }
  if (acct.kind === 'gone') return;
  if (acct.kind === 'error') {
    res.setHeader('Retry-After', String(acct.retryAfter));
    sendJSON(res, acct.status, { error: { message: acct.message, type: acct.type }, retry_after: acct.retryAfter });
    return;
  }
  const ctx = acct.ctx;

  const stream = openaiReq.stream === true;
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = nowUnix();

  // 构建 CC 请求体
  const ccBody = buildCcRequest(openaiReq);

  // AbortController 用于客户端断连时真正打断 CC 上游（pi-commandcode-provider 模式）
  // 每次尝试都换一个新的（已 abort 的 signal 不可复用）
  let abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let bytesReceived = 0; let lastCcEvent = ''; let keepaliveCount = 0; let fullText = '';
  let reader = null;
  let translator = null;
  let attempt = 0;
  let upstreamError = null;   // 非流式路径解析出的上游语义错误（error 事件）
  let delivered = false;      // 本次尝试是否真的把正常响应交付给了下游（用于重试后的日志/计数）

  // 发起下一次尝试前，把本次尝试的上游连接收干净并记账。
  // 只在「下游尚未收到任何字节」时调用 —— 下游没有开始过，重试才是无损的。
  const rewindAttempt = async (message, fields) => {
    try { reader?.cancel().catch(() => {}); } catch {}
    try { abortController.abort(); } catch {}
    upstreamRetryStats.rewinds++;
    log('warn', message, {
      path: '/v1/chat/completions',
      model,
      attempt,
      maxAttempts: UPSTREAM_RETRY_MAX + 1,
      elapsedMs: Date.now() - startTime,
      ...fields,
    });
    await sleep(UPSTREAM_RETRY_BASE_MS * attempt);
  };

  // 上游闪断重试循环：只在「传输层闪断」且「尚未向下游写出任何字节」时
  // 才再来一遍；正常路径第一轮即 break。循环体沿用原有缩进、未做重排，只为把 diff 控到最小。
  attemptLoop: for (attempt = 1; attempt <= UPSTREAM_RETRY_MAX + 1; attempt++) {
  // 退避期间客户端断开了：下游已经走了，再打一次上游只是白烧额度
  if (attempt > 1 && aborted) {
    log('info', 'Upstream retry abandoned (client disconnected during backoff)', {
      path: '/v1/chat/completions', model, attempt, elapsedMs: Date.now() - startTime,
    });
    return;
  }
  // 每次尝试开始：重置本次请求的状态（上一次可能已被中断 / 半途失败）
  abortController = new AbortController();
  bytesReceived = 0; lastCcEvent = ''; keepaliveCount = 0; fullText = '';
  reader = null; translator = null; upstreamError = null; delivered = false;

  try {
    // 首次初始化（fingerprint + lifecycle）
    await ensureInitialized(ctx, abortController.signal);
    // 转发到 CC API（传入客户端 headers，用于提取 session ID）
    const ccResponse = await forwardToCC(ccBody, ctx, req.headers, abortController.signal, openaiReq.prompt_cache_key);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error', { status: ccResponse.status, code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendJSON(res, mapped.status, mapped.body);
      return;
    }

    // 下游断连检测：打断 CC 上游 + 记录日志（只在首次尝试注册，重试不重复挂载监听器）
    if (attempt === 1) res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      const reason = lastCcEvent?.startsWith('tool-input') ? 'tool-input-silent-timeout'
        : lastCcEvent?.includes('delta') ? 'streaming-active-disconnect'
        : 'client-hangup';
      abortController.signal.aborted || log('warn', 'Client disconnected', {
        path: '/v1/chat/completions',
        model, completionId, reason,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
        bytesSent: bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        keepaliveCount,
        inputTokens: translator?.inputTokens ?? 0,
        outputTokens: translator?.outputTokens ?? 0,
        cachedInputTokens: translator?.cachedInputTokens ?? 0,
      });
      if (!abortController.signal.aborted) {
        // 断连前抢发 usage=0 终止 chunk，避免下游自行估算 token
        try {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch {}
        try { abortController.abort(); } catch {}
      }
    });

    if (stream) {
      // ── 流式响应 ──
      translator = createSseTranslator(model, completionId, created);
      let buffer = '';
      let started = false; // 延迟写 200 header，超时/output=0 时返回 JSON 429/502 让 SDK 自动重试
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();

      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const { done, value } = result;
          if (done) break;
          if (aborted) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          // 仅在新到数据含换行时才切分：buffer 中永不残留 '\n'，故无换行即无完整行。
          // 避免对增长中的超长单行（大 tool-call / tool_result）反复做全量 split —— O(n²) → O(n)。
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          let hadOutput = false;
          for (const line of lines) {
            const events = translator.parseLine(line);
            if (events) {
              if (!started) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                  'X-Accel-Buffering': 'no',
                });
                started = true;
              }
              for (const evt of events) res.write(evt);
              await waitDrain(res);
              hadOutput = true;
            }
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
          // silent events 期间发 keepalive，防止客户端超时断开
          if (started && !hadOutput) {
            try { res.write(': keepalive\n\n'); keepaliveCount++; } catch {}
            await waitDrain(res);
          }
        }

        if (!aborted) {
          // 成功完成一次请求，重置连续超时计数
          ctx.timeouts.count = 0;
          // 处理剩余 buffer
          if (buffer.trim()) {
            const events = translator.parseLine(buffer);
            if (events) {
              if (!started) started = true;
              for (const evt of events) res.write(evt);
              await waitDrain(res);
            }
          }
          if (translator.upstreamError) {
            if (!started) {
              sendJSON(res, translator.upstreamError.status, translator.upstreamError.body);
              return;
            }
            try { res.write(`data: ${JSON.stringify(translator.upstreamError.body)}\n\n`); } catch {}
          // 上游没有正常走完 finish（无 finish 事件 / provider 报连接失败）：
          // 不能补一个 finish_reason 就 [DONE] —— 那等于把截断谎报成完整回答。
          // 对齐 CLI：这一族一律按可重试的 502 处理。
          // 必须排在零输出判定之前 —— 上游压根没发 finish 时，「no finish event」才是根因，
          // 零输出只是它的表象（此时按 429 报会掩盖真实原因）。
          } else if (translator.incompleteDetail()) {
            const detail = translator.incompleteDetail();
            // 对端 FIN（干净收尾、没有 finish 事件）与 RST 是同一类闪断：既然还没向下游吐过
            // 字节，就先内部重试，而不是直接把 502 交给下游去自行重发整个上下文。
            if (!started && !aborted && attempt <= UPSTREAM_RETRY_MAX) {
              await rewindAttempt('Upstream stream ended incomplete before first byte - retrying', { reason: detail });
              continue attemptLoop;
            }
            log('warn', 'Upstream stream incomplete', { path: '/v1/chat/completions', reason: detail });
            const err = incompleteUpstreamError(detail);
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) { sendJSON(res, err.status, err.body); return; }
            try { res.write(`data: ${JSON.stringify(err.body)}\n\n`); } catch {}
          // 输出 token 为 0 时记为错误，避免下游异常计费
          } else if (translator.outputTokens === 0) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
            if (!started) {
              sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              return;
            }
            try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
          } else {
            if (!started) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              started = true;
            }
            res.write(translator.getDoneEvent());
            delivered = true;
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
          // cancel() 返回 promise：不接住的话，连接已被对端掐断时会抛 UnhandledPromiseRejection
          try { reader.cancel().catch(() => {}); } catch {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/chat/completions',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: completionId,
            bytesReceived,
            lastCcEvent: lastCcEvent || '(none)',
            inputTokens: translator.inputTokens,
            outputTokens: translator.outputTokens,
            cachedInputTokens: translator.cachedInputTokens,
          });
          try { reader.cancel().catch(() => {}); } catch {}
          try { abortController.abort(); } catch {} // 打断 CC 上游，避免浪费 token
          ctx.timeouts.count++;
          const timeoutMsg = ctx.timeouts.count >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) {
            sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
            return;
          }
          if (!res.writableEnded) {
            // 必须 end() 而不是 destroy()：res.write 是异步的，紧接着 destroy 会把尚未
            // 刷出的缓冲丢掉并发 RST。反向代理看到上游连接被重置，要么回 502，要么让
            // 客户端看到 connection error —— 这正是"吐字慢 + 间歇性 502"的成因之一。
            // end() 会把错误事件正常送进 SSE 流再发 FIN，客户端 SDK 能按可重试错误处理。
            // 下游若已僵死（不读也不断），由 CLIENT_DRAIN_TIMEOUT_MS 那条路径负责兜底。
            try { res.end(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
          }
        // 已经解析出上游语义错误（429/503 等）时不重试：那是有意传下来的信号，重试会把它吞掉
        } else if (!started && !aborted && !translator?.upstreamError
                   && attempt <= UPSTREAM_RETRY_MAX && isRetryableUpstreamError(e)) {
          // 传输层闪断且尚未向下游写过任何字节 → 代理内部静默重试（下游全程无感）
          await rewindAttempt('Upstream stream terminated before first byte - retrying', {
            message: e.message,
            cause: e.cause?.code || e.cause?.message || '(none)',
          });
          continue attemptLoop;
        } else {
          // 传输层错误不要覆盖已经解析到的语义错误：把「上游容量不足」说成「代理挂了」是误导
          if (translator?.upstreamError && !started) {
            log('warn', 'Upstream terminated after a parsed semantic error', { message: e.message });
            try { abortController.abort(); } catch {}
            sendJSON(res, translator.upstreamError.status, translator.upstreamError.body);
            return;
          }
          log('error', 'Stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
            return;
          }
          if (!res.writableEnded) {
            try { res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'proxy_error' } })}\n\n`); } catch {}
          }
        }
      } finally {
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式响应（缓冲完整 NDJSON）──
      let reasoningContent = '';
      let finishReason = 'stop';
      let sawFinish = false;
      let usage = null;
      let toolCalls = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; reasoningContent += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                toolCalls = toolCalls || [];
                toolCalls.push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish-step':
              case 'finish':
                lastCcEvent = event.type;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage) usage = event.totalUsage;
                break;
              case 'error':
                lastCcEvent = event.type;
                upstreamError = mapCcEventError(event);
                log('warn', 'CC stream error (non-stream)', {
                  message: event.error?.message || event.message,
                  upstreamStatus: upstreamError.reportedStatus,
                  upstreamRetryable: event.error?.isRetryable,
                  code: upstreamError.code,
                  mappedTo: upstreamError.status,
                });
                break;
              // 无内容的事件：与流式翻译器的静默列表保持一致。
              // text-start / start / start-step / reasoning-start 原先只在流式路径被识别，
              // 非流式路径会掉进 default 打成 'Unknown CC event type' —— 上游每个响应都会发，
              // 于是线上刷屏。它们本身不携带内容（内容在 text-delta），纯粹是噪音。
              case 'text-start': case 'text-end': case 'start': case 'start-step':
              case 'reasoning-start': case 'reasoning-end': case 'finish-step':
              case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
              case 'tool-error':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      // 读循环抛错（闪断）时也必须释放看门狗：否则每次失败尝试都会留下一个 armed 的定时器，
      // 重试期间累积（流式路径的 finally 已覆盖同一件事）
      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const { done, value } = result;
          if (done) break;
          bytesReceived += value.length;
          const chunkText = decoder.decode(value, { stream: true });
          buf += chunkText;
          // 无换行则不可能产生完整行，跳过全量 split（见 handleChatCompletions 流式段同处说明）
          if (chunkText.indexOf('\n') !== -1) processLines();
        }
      } finally {
        idle.dispose();
      }
      processLines();

      if (upstreamError) {
        sendJSON(res, upstreamError.status, upstreamError.body);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
      if (incomplete) {
        // 尚未向下游写过任何字节（非流式此时 headers 还没发）→ 与传输层闪断同等对待，先重试
        if (!aborted && !upstreamError && attempt <= UPSTREAM_RETRY_MAX) {
          await rewindAttempt('Upstream stream ended incomplete before first byte - retrying', { reason: incomplete });
          continue attemptLoop;
        }
        log('warn', 'Upstream stream incomplete', { path: '/v1/chat/completions', reason: incomplete });
        const err = incompleteUpstreamError(incomplete);
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, err.status, err.body);
        return;
      }

      // 输出 token 为 0 时记为错误，避免下游异常计费
      if ((usage?.outputTokens ?? 0) === 0) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendJSON(res, 429, { error: { message: 'Empty response from upstream (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
        return;
      }

      ctx.timeouts.count = 0;
      sendJSON(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: Object.assign(
            { role: 'assistant', content: fullText || null },
            toolCalls ? { tool_calls: toolCalls } : {},
            reasoningContent ? { reasoning_content: reasoningContent } : {},
          ),
          finish_reason: toOpenAIFinishReason(finishReason),
        }],
    usage: (() => {
      if (!usage) usage = {};
      normalizeUsage(usage);
      return {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
      };
    })(),
      });
      delivered = true;
    }
    // 只有本次尝试真的交付了正常响应才算「重试救回来了」；
    // 已向下游报错的尝试（502/429）不能记成 recovered
    if (attempt > 1 && delivered) {
      upstreamRetryStats.recovered++;
      log('info', 'Upstream retry recovered', {
        path: '/v1/chat/completions', model, attempt, elapsedMs: Date.now() - startTime,
      });
    }
    break attemptLoop;   // 本次尝试已完整处理（成功或已按语义返回错误）
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/chat/completions',
        model,
        completionId,
      });
      return; // 下游已断连：不再重试（res 已关闭）
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/chat/completions',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: completionId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel().catch(() => {}); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      ctx.timeouts.count++;
      const timeoutMsg = ctx.timeouts.count >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendJSON(res, 429, { error: { message: timeoutMsg, type: 'rate_limit_error', input_tokens: 0 }, retry_after: 5 });
      return; // 超时已按语义回给下游（由下游决定是否重试），本代理不重试
    // 已解析出上游语义错误（429/503 等）时不重试：那是有意传下来的信号，重试会把它吞掉
    } else if (!res.headersSent && !aborted && !upstreamError && !translator?.upstreamError
               && attempt <= UPSTREAM_RETRY_MAX && isRetryableUpstreamError(e)) {
      // 传输层闪断且尚未向下游写出任何字节 → 代理内部静默重试（下游全程无感）
      await rewindAttempt('Upstream error before first byte - retrying', {
        message: e.message,
        cause: e.cause?.code || e.cause?.message || '(none)',
      });
      continue attemptLoop;
    } else {
      // 传输层错误不要覆盖已经解析到的语义错误：把「上游容量不足」说成「代理挂了」是误导
      const semantic = upstreamError || translator?.upstreamError;
      if (semantic && !res.headersSent) {
        log('warn', 'Upstream terminated after a parsed semantic error', { message: e.message });
        try { abortController.abort(); } catch {}
        sendJSON(res, semantic.status, semantic.body);
        return;
      }
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendJSON(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error', input_tokens: 0 }, retry_after: 10 });
      return;
    }
  }
  }   // ← end of attemptLoop
}

// ── Anthropic /v1/messages 协议转换 ─────────────────

function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    // Anthropic 的原生枚举，必须原样透出：它表示「这一轮被暂停，后面还有内容」。
    // 折成 end_turn 会让下游把半截回答当成写完了（CLI 是靠自动续写把它吸收掉的，
    // 代理不自动续写，就必须如实上报，不能吞掉）。
    case 'pause_turn': return 'pause_turn';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}

// OpenAI 的 finish_reason 只有 stop | length | tool_calls | content_filter | function_call。
// pause_turn 没有对应值：折成 'stop' 是谎报完成（正是要修的问题），
// 折成 'length' 至少如实表达了「输出不完整」，下游的截断处理会做对的事。
function toOpenAIFinishReason(finishReason) {
  return finishReason === 'pause_turn' ? 'length' : finishReason;
}

// Generate a Claude-format fake signature for thinking blocks.
// Anthropic validates thinking signatures cryptographically; third-party
// proxies cannot mint valid ones. Claude Code's shallow check only requires
// base64 starting with 'E' (single-layer) / 'R' (double-layer) with payload
// first byte 0x12 — this satisfies that, letting CC display thinking.
// The payload is derived from the thinking text so each block's signature
// differs (closer to spec, avoids identical-signature quirks).
function fakeThinkingSignature(thinkingText) {
  const seed = crypto.createHash('sha256').update(thinkingText || 'dsh-proxy-thinking').digest().subarray(0, 64);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText) {
  const content = [];
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) });
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: (() => {
      normalizeUsage(usage || {});
      // CC 未回报 usage 时按内容长度估算输出 token，避免客户端展示/记账为 0
      const estOut = Math.max(1,
        Math.ceil(((fullText || '').length + (thinkingText || '').length) / 4) + (toolCalls ? toolCalls.length * 20 : 0));
      return {
        // input_tokens 只计非缓存部分（Anthropic 语义），与 cache_* 相加才等于总输入
        input_tokens: anthropicInputTokens(usage),
        output_tokens: usage?.outputTokens || estOut,
        cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
      };
    })(),
  };
}

function convertAnthropicToOpenAI(anthropicReq) {
  // 1. Extract system prompt (top-level, not in messages array)
  let systemPrompt = '';
  let systemBlocks = null;
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      // 保留 cache_control：buildCcRequest 需要块数组才能把断点下发（CLI 的 params.system 就是块数组）
      systemBlocks = anthropicReq.system
        .filter(b => b && b.type === 'text')
        .map(b => {
          const blk = { type: 'text', text: b.text ?? '' };
          if (b.cache_control) blk.cache_control = b.cache_control;
          return blk;
        });
      systemPrompt = systemBlocks.map(b => b.text).join('\n');
    }
  }

  // 2. Build tool name map + convert messages
  const toolNameFromId = {};
  const openaiMessages = [];

  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemBlocks && systemBlocks.length ? systemBlocks : systemPrompt });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = '';
      // Anthropic 的 thinking block 承载思考内容，需转成 reasoning_content
      // 交给 buildCcRequest 回传，否则 CC 会因缺少 reasoning 而拒绝
      let thinkingContent = '';
      const textParts = [];
      let textHasCache = false;
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
          const part = { type: 'text', text: block.text || '' };
          if (block.cache_control) { part.cache_control = block.cache_control; textHasCache = true; }
          textParts.push(part);
        } else if (block.type === 'thinking') {
          thinkingContent += block.thinking || '';
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }
      const assistantMsg = { role: 'assistant', content: (textParts.length > 1 || textHasCache) ? textParts : (textContent || null) };
      if (thinkingContent) assistantMsg.reasoning_content = thinkingContent;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    } else if (msg.role === 'user') {
      let textContent = '';
      // parts 保持原始顺序（text / image_url），与 CLI 的 toWireMessages 一致
      const parts = [];
      let textHasCache = false;
      const toolResults = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
            const part = { type: 'text', text: block.text || '' };
            if (block.cache_control) { part.cache_control = block.cache_control; textHasCache = true; }
            parts.push(part);
          } else if (block.type === 'image') {
            // Anthropic 图片块：{ type:'image', source:{ type:'base64', media_type, data } } 或 source.url
            const s = block.source || {};
            const url = s.type === 'base64' && s.data
              ? `data:${s.media_type || 'image/png'};base64,${s.data}`
              : (s.url || '');
            if (url) parts.push({ type: 'image_url', image_url: { url } });
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }
      }
      if (textContent) {
        // 暂存，tool_result 优先入队：OpenAI 语义要求 tool 消息紧跟 assistant 的
        // tool_calls，同一条 user 消息里的文本要排在 tool 结果之后
      }
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n')
          : String(tr.content || '');
        // OpenAI 语义里 tool 消息的 name 是可选的；会话恢复等场景下 tool_use_id 可能
        // 找不到对应 assistant tool_use（历史被客户端裁剪），此时不硬塞空 name，
        // 避免 CC 上游报 "Tool result is missing"（issue #15）
        const toolMsg = { role: 'tool', tool_call_id: tr.tool_use_id, content: toolContent };
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id];
        openaiMessages.push(toolMsg);
      }
      if (parts.length || textContent) {
        // 单块纯文本仍用字符串（线格不变）；多块 / 带断点 / 含图片时用块数组（CLI 的形态）。
        // 注意：content 为字符串时 parts 为空，必须用 textContent 判空（否则整条消息会丢）
        const singleText = parts.length <= 1 && (parts.length === 0 || parts[0].type === 'text') && !textHasCache;
        openaiMessages.push({ role: 'user', content: singleText ? textContent : parts });
      }
    }
  }

  // 3. Build OpenAI request
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. Map tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // 5. Map tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) {
      openaiReq.tool_choice = 'auto';
    } else if (tc.type === 'any') {
      openaiReq.tool_choice = 'required';
    } else if (tc.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else if (tc.type === 'none') {
      openaiReq.tool_choice = 'none';
    }
  }
  if (anthropicReq.tool_choice?.disable_parallel_tool_use === true) openaiReq.parallel_tool_calls = false;

  // 6. Optional params
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort（LiteLLM 标准映射）
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // 不发送 reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else if (t.budget_tokens >= 2000) openaiReq.reasoning_effort = 'low';
      else openaiReq.reasoning_effort = 'low'; // <2000 → low
    }
  }

  return openaiReq;
}

/**
 * Async generator that reads CC NDJSON response body and yields
 * Anthropic SSE events for streaming.
 */
async function* createAnthropicSseTranslator(response, model, messageId, ctx) {
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let noCacheTokens = -1;   // -1 = 上游未提供该字段，改用减法兜底
  let stopReason = null;
  // 归一化后的 finishReason（mapAnthropicStopReason 之前的值），用于判定「是否正常结束」
  let finishNorm = null;
  // 是否见过终态 finish 事件。CLI 用同一个标志判定流是否被截断 —— 它只认 'finish'，
  // 'finish-step' 不在 CLI 的事件集里，故这里同样只认 'finish'。
  let sawFinish = false;
  let hasError = false;
  let currentThinkingText = ''; // accumulated thinking text for the open block

  // Close the current block (text or thinking) if one is active.
  // For thinking blocks, emit a signature_delta (Anthropic standard) before stop.
  function closeBlock() {
    if (blockStarted) {
      const idx = currentBlockIndex;
      const type = currentBlockType;
      let out = '';
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } })}\n\n`;
        currentThinkingText = '';
      }
      blockStarted = false;
      currentBlockType = null;
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }
    return '';
  }
  const closeTextBlock = closeBlock;

  // Open a new block of the given type (closing any previous block first)
  function startBlock(type, contentBlock) {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = type;
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock })}\n\n`;
    }
    return '';
  }

  // Open a new text block (closing any previous block first)
  function startTextBlock() {
    return startBlock('text', { type: 'text', text: '' });
  }

  // Open a new thinking block (closing any previous block first)
  function startThinkingBlock() {
    return startBlock('thinking', { type: 'thinking', thinking: '' });
  }

  // Emit message_start (always the first event)
  yield `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
  })}\n\n`;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);

  try {
    while (true) {
      const result = await Promise.race([reader.read(), idle.arm()]);
      const { done, value } = result;
      if (done) break;
      ctx.bytesReceived += value.length;
      const chunkText = decoder.decode(value, { stream: true });
      buffer += chunkText;
      // 同 handleChatCompletions：无换行即无完整行，跳过全量 split
      let lines = [];
      if (chunkText.indexOf('\n') !== -1) {
        lines = buffer.split('\n');
        buffer = lines.pop() || '';
      }

      let hadOutput = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === '[DONE]') continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        if (!event.type) continue;
        ctx.lastCcEvent = event.type;

        switch (event.type) {
          case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
            // Signal events, no user-visible data
            break;

          case 'reasoning-delta': {
            // CC reasoning → Anthropic thinking block (Claude Code shows this as thinking)
            const text = event.text || '';
            if (!text) break;
            const startBlock = startThinkingBlock();
            currentThinkingText += text;
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: text } })}\n\n`;
            hadOutput = true;
            break;
          }

          case 'text-delta': {
            const text = event.text || '';
            const startBlock = startTextBlock();
            yield startBlock + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`;
            outputTokens += 1;
            hadOutput = true;
            break;
          }

          case 'tool-call': {
            // Close any pending text block
            const closeBlock = closeTextBlock();
            if (closeBlock) yield closeBlock;

            const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
            const name = event.toolName || '';
            const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});

            const tcIndex = nextBlockIndex++;
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tcIndex, content_block: { type: 'tool_use', id, name, input: {} } })}\n\n`;
            yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tcIndex, delta: { type: 'input_json_delta', partial_json: input } })}\n\n`;
            yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: tcIndex })}\n\n`;
            outputTokens += 20;
            break;
          }

          case 'finish-step':
          case 'finish': {
            // 上游的 finishReason 是 'tool-calls'（连字符），必须先过 mapFinishReason 规范化成
            // 'tool_calls'，否则会掉进 mapAnthropicStopReason 的 default 变成 end_turn。
            // 真机实测踩到过：工具调用成功但 stop_reason 报 end_turn。
            sawFinish = true;   // finish-step 与 finish 都算完成信号
            if (event.finishReason) {
              finishNorm = mapFinishReason(event.finishReason);
              stopReason = mapAnthropicStopReason(finishNorm);
            }
            const u = event.totalUsage || event.usage;
            if (u) {
              normalizeUsage(u);
              inputTokens = u.inputTokens ?? inputTokens;
              outputTokens = u.outputTokens ?? outputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
              cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
              if (typeof u.inputTokenDetails?.noCacheTokens === 'number') {
                noCacheTokens = u.inputTokenDetails.noCacheTokens;
              }
              ctx.inputTokens = inputTokens;
              ctx.outputTokens = outputTokens;
              ctx.cachedInputTokens = cachedInputTokens;
            }
            // 上游未回报 usage 时保留本地按 delta 计数的估算值——清零会把有内容的
            // 响应误判成零输出（触发 429）。未知字段保持原值即可。
            break;
          }

          case 'error': {
            hasError = true;
            const upstreamError = mapCcEventError(event);
            ctx.upstreamError = upstreamError;
            yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamError.body.error })}\n\n`;
            break;
          }

          case 'reasoning-end': case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
            // Silent - no user-visible content
            break;
          default:
            log('warn', 'Unknown CC event type', { type: event.type });
            break;
        }
      }
    }

    // 无论上游是否回报 usage，都把本地计数同步进 ctx（零输出判定与超时日志依赖它）。
    // 注意：ctx.inputTokens 保存的是上游原始总数，仅供日志排查；
    // message_delta 的 input_tokens 走 anthropicInputTokens / noCacheTokens 换算，不读它。
    ctx.inputTokens = inputTokens;
    ctx.outputTokens = outputTokens;
    ctx.cachedInputTokens = cachedInputTokens;
    ctx.cacheWriteTokens = cacheWriteTokens;

    // Finalize — close pending text block, emit message_delta + message_stop
    if (!hasError) {
      const closeBlock = closeTextBlock();
      if (closeBlock) yield closeBlock;

      // 上游没有正常走完 finish（无 finish 事件 / provider 报连接失败）：
      // 绝不能补一个 end_turn 就 message_stop —— 那等于把截断谎报成完整回答。
      // 对齐 CLI：这一族一律按可重试错误处理。
      const incomplete = incompleteUpstreamDetail(sawFinish, finishNorm);
      if (incomplete) {
        log('warn', 'Upstream stream incomplete', { path: '/v1/messages', reason: incomplete });
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: incompleteUpstreamError(incomplete).body.error })}\n\n`;
      // 输出 token 为 0 时记为错误，避免下游异常计费
      } else if (outputTokens === 0) {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`;
      } else {
        yield `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cachedInputTokens,
            cache_creation_input_tokens: cacheWriteTokens || 0,
            // 只计非缓存部分；否则下游把 input 与 cache_read 相加会得到约两倍（issue #25）
            input_tokens: noCacheTokens >= 0
              ? noCacheTokens
              : Math.max(0, inputTokens - cachedInputTokens - (cacheWriteTokens || 0)),
          },
        })}\n\n`;

        yield `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
      }
    }
  } finally {
    // 确保流中断时通知上游
    idle.dispose();
    try { reader.cancel().catch(() => {}); } catch {}
  }
}

function sendAnthropicError(res, status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleMessages(req, res) {
  let anthropicReq;
  try {
    anthropicReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) {
      sendAnthropicError(res, 413, 'invalid_request_error', e.message);
      return;
    }
    sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  const stream = anthropicReq.stream === true;
  const model = anthropicReq.model || 'claude-sonnet-4-6';

  // Convert Anthropic → OpenAI → CC
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);

  const acct = await resolveAccount(req, res, conversationKeyOf(req.headers, openaiReq));
  if (acct.kind === 'missing') {
    sendJSON(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Missing API key. Send in Authorization: Bearer <key> or x-api-key header' } });
    return;
  }
  if (acct.kind === 'gone') return;
  if (acct.kind === 'error') {
    sendAnthropicError(res, acct.status, acct.type === 'rate_limit_error' ? 'rate_limit_error' : 'overloaded_error', acct.message, acct.retryAfter);
    return;
  }
  const ctx = acct.ctx;

  const abortController = new AbortController();
  let aborted = false;
  // 提前初始化，断连回调/超时 catch 安全引用（避免块级作用域 ReferenceError）
  const startTime = Date.now();
  let messageId = '';
  let reader = null;
  let bytesReceived = 0; let lastCcEvent = ''; let fullText = '';

  try {
    // 首次初始化（fingerprint + lifecycle）
    await ensureInitialized(ctx, abortController.signal);
    const ccResponse = await forwardToCC(ccBody, ctx, req.headers, abortController.signal);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error (Anthropic)', { status: ccResponse.status, code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
      return;
    }

    // 下游断连检测：打断 CC 上游 + 记录日志
    res.on('close', () => {
      if (res.writableEnded) return; // Normal completion, not a disconnect
      aborted = true;
      if (!abortController.signal.aborted) {
        // 断连前抢发 usage=0 终止事件，避免下游自行估算 token
        try {
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
          })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        } catch {}
        try { abortController.abort(); } catch {}
      }
      log('warn', 'Client disconnected', {
        path: '/v1/messages',
        model,
        messageId,
        streaming: stream,
        elapsedMs: Date.now() - startTime,
      });
    });

    if (stream) {
      // ── 流式 Anthropic SSE ──
      // 行为与 /v1/chat/completions 对齐：首个上游事件（thinking/text/tool_use）到达即
      // 发 header——之前扣到 text_delta 才发，推理模型 thinking 阶段客户端收不到任何
      // 字节，触发下游 60s 首字节超时（context canceled）。message_start 仍缓冲：
      // 完全无输出时还能回 JSON 429/502 让 SDK 自动重试（同 chat 端点）。
      let started = false;
      const buf = [];
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const flushBuf = async () => {
        if (!started) {
          res.writeHead(200, SSE_HEADERS);
          started = true;
        }
        for (const ev of buf) { try { res.write(ev); } catch {} }
        buf.length = 0;
        await waitDrain(res);
      };

      // 心跳：等价于 chat 端点的 ': keepalive'——chat 在每轮读到静默事件时发注释行，
      // Anthropic 翻译器会吞掉 signal 事件，这里改用空闲计时发 ping（Anthropic 标准
      // 事件，官方 SDK 会忽略），覆盖上游排队/长 thinking 的静默窗口
      let lastSentAt = Date.now();
      const heartbeat = setInterval(() => {
        // 不向已积压的下游继续塞数据：定时器回调是同步的，无法 await waitDrain，
        // 因此用 writableNeedDrain 直接跳过本轮心跳（背压场景下少发一个 ping 无副作用）
        if (started && !aborted && !res.writableEnded && !res.writableNeedDrain && Date.now() - lastSentAt > 15000) {
          try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); lastSentAt = Date.now(); } catch {}
        }
      }, 5000);

      let ctx;
      try {
        messageId = 'msg_' + randomUUID().slice(0, 12);
        ctx = { bytesReceived: 0, lastCcEvent: '', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, upstreamError: null };
        const generator = createAnthropicSseTranslator(ccResponse, model, messageId, ctx);
        for await (const event of generator) {
          if (aborted) break;
          if (!started && !event.startsWith('event: message_start')) {
            await flushBuf();
          }
          if (started) {
            try { res.write(event); } catch {}
            lastSentAt = Date.now();
            await waitDrain(res);
          } else {
            buf.push(event);
          }
        }

        if (!aborted) {
          ctx.timeouts.count = 0;
          if (ctx.upstreamError) {
            if (!started) {
              sendAnthropicError(
                res,
                ctx.upstreamError.status,
                ctx.upstreamError.body.error.type,
                ctx.upstreamError.body.error.message,
              );
            }
            // started 时 error 事件已在循环中经 SSE 下发，按规范 error 事件即终结
          } else if (ctx.outputTokens === 0) {
            try { abortController.abort(); } catch {}
            if (!started) {
              sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
              return;
            }
            await flushBuf();
          } else {
            await flushBuf();
          }
        }
      } catch (e) {
        if (aborted) {
          // 客户端已断连，只清理（close handler 已调用 abortController.abort()）
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/messages',
            model,
            streaming: true,
            timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime,
            id: messageId,
            bytesReceived: ctx.bytesReceived,
            lastCcEvent: ctx.lastCcEvent || '(none)',
            inputTokens: ctx.inputTokens,
            outputTokens: ctx.outputTokens,
            cachedInputTokens: ctx.cachedInputTokens,
          });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            ctx.timeouts.count++;
            const timeoutMsg = ctx.timeouts.count >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
            return;
          }
          if (!res.writableEnded) {
            ctx.timeouts.count++;
            const timeoutMsg = ctx.timeouts.count >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            // end() 而不是 destroy()：理由见 handleChatCompletions 流式超时分支
            try { res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`); } catch {}
          }
        } else {
          log('error', 'Anthropic stream error', { message: e.message });
          try { abortController.abort(); } catch {} // 打断 CC 上游
          if (!started) {
            sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
            return;
          }
          if (!res.writableEnded) {
            try {
              res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`);
            } catch {}
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式 Anthropic JSON ──
      const messageId = 'msg_' + randomUUID().slice(0, 12);
      let finishReason = 'stop';
      let sawFinish = false;
      let usage = null;
      let toolCalls = null;
      let thinkingText = ''; // CC reasoning → Anthropic thinking block
      let upstreamError = null;

      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]') continue;
          try {
            const event = JSON.parse(trimmed);
            switch (event.type) {
              case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
              case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
              case 'tool-call':
                lastCcEvent = event.type;
                (toolCalls = toolCalls || []).push({
                  id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                  type: 'function',
                  function: {
                    name: event.toolName || '',
                    arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                  },
                });
                break;
              case 'finish-step':
              case 'finish':
                lastCcEvent = event.type;
                sawFinish = true;
                finishReason = mapFinishReason(event.finishReason || 'stop');
                if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
                break;
              case 'error':
                lastCcEvent = event.type;
                upstreamError = mapCcEventError(event);
                log('warn', 'CC error (Anthropic non-stream)', {
                  message: event.error?.message || event.message,
                  upstreamStatus: upstreamError.reportedStatus,
                  upstreamRetryable: event.error?.isRetryable,
                  code: upstreamError.code,
                  mappedTo: upstreamError.status,
                });
                break;
              // 无内容的事件：与流式翻译器的静默列表保持一致。
              // text-start / start / start-step / reasoning-start 原先只在流式路径被识别，
              // 非流式路径会掉进 default 打成 'Unknown CC event type' —— 上游每个响应都会发，
              // 于是线上刷屏。它们本身不携带内容（内容在 text-delta），纯粹是噪音。
              case 'text-start': case 'text-end': case 'start': case 'start-step':
              case 'reasoning-start': case 'reasoning-end': case 'finish-step':
              case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
              case 'tool-error':
                // Silent - no user-visible content
                break;
              default:
                log('warn', 'Unknown CC event type', { type: event.type });
                break;
            }
          } catch {}
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const { done, value } = result;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        // 无换行则不可能产生完整行，跳过全量 split
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendAnthropicError(res, upstreamError.status, upstreamError.body.error.type, upstreamError.body.error.message);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      {
        const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
        if (incomplete) {
          log('warn', 'Upstream stream incomplete', { path: '/v1/messages', reason: incomplete });
          const err = incompleteUpstreamError(incomplete);
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          sendAnthropicError(res, err.status, err.body.error.type, err.body.error.message, err.retry_after);
          return;
        }
      }

      // 零输出判定改为按实际内容：上游偶发不回 totalUsage 时，旧逻辑（usage?.outputTokens ?? 0 === 0）
      // 会把有完整文本的响应误杀成 429
      if (!fullText && !thinkingText && !toolCalls) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
        sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      ctx.timeouts.count = 0;
      sendJSON(res, 200, buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText));
    }
  } catch (e) {
    if (abortController.signal.aborted) {
      log('warn', 'Request cancelled (client disconnected before CC response)', {
        path: '/v1/messages',
        model,
        messageId,
      });
    } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
      log('warn', 'Stream idle timeout', {
        path: '/v1/messages',
        model,
        streaming: false,
        timeoutMs: NONSTREAM_IDLE_TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
        id: messageId,
        bytesReceived,
        lastCcEvent: lastCcEvent || '(none)',
        partialLen: fullText ? fullText.length : 0,
      });
      try { reader?.cancel().catch(() => {}); } catch {}
      try { abortController.abort(); } catch {} // 打断 CC 上游
      ctx.timeouts.count++;
      const timeoutMsg = ctx.timeouts.count >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
        ? 'Response timeout - try reducing context length (summarize earlier messages)'
        : 'Response timeout - request timed out';
      res.setHeader('Retry-After', '5');
      sendAnthropicError(res, 429, 'rate_limit_error', timeoutMsg);
    } else {
      log('error', 'Upstream error', { message: e.message });
      try { abortController.abort(); } catch {} // 打断 CC 上游
      sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
    }
  }
}

// ── 动态模型列表 ────────────────────────────────────

// 缓存按上下文分开：透传模式共用一份（行为不变），池账号各用各的 —— 不把一个账号的目录发给另一个账号的请求。
function modelsRequestHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': CC_VERSION,
  };
}

function cacheProviderModels(cache, data) {
  if (!Array.isArray(data?.data)) return false;
  cache.models = data.data.map(m => ({ id: m.id, name: m.id }));
  cache.at = Date.now();
  return true;
}

async function fetchModels(ctx) {
  const cache = ctx?.modelsCache ?? globalModelsCache;
  if (cache.models && (Date.now() - cache.at) < CFG.modelRefreshIntervalMs) {
    return cache.models;
  }

  try {
    if (!ctx?.key || !CFG.useProviderModels) throw new Error('Provider models disabled');

    const response = await ctx.fetch(`${CFG.apiBase}/provider/v1/models`, {
      headers: modelsRequestHeaders(ctx.key),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      if (cacheProviderModels(cache, await response.json())) {
        log('info', 'Fetched models from Provider API', { count: cache.models.length, ...ctx.logTag });
        return cache.models;
      }
    } else {
      response.body?.cancel().catch(() => {});
    }
    log('warn', 'Provider models fetch failed, using hardcoded list', { status: response.status, ...ctx.logTag });
  } catch (e) {
    log('warn', 'Provider models fetch error, using hardcoded list', { error: e.message, ...ctx?.logTag });
  }

  // Fallback to hardcoded MODELS
  return MODELS;
}

/** 账号池健康探测：经该账号自己的路由打 GET /alpha/whoami —— CLI 每次开会话都会调（billing 预取的第一步），
 *  认证、不耗推理额度；头与 /alpha/generate 相同。（/provider/v1/models 是 CLI 从不调用的端点，不拿来探测。） */
async function probePooledAccount(account) {
  const ctx = accountContext(account);
  const response = await account.fetch(`${CFG.apiBase}/alpha/whoami`, {
    method: 'GET',
    headers: buildCommandAuthHeaders(ctx, ensureSession(ctx.key, ctx.sessions)),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text().catch(() => '');
  if (response.ok) return { ok: true };
  const mapped = mapCcError(response.status, text);
  return {
    ok: false,
    status: response.status,
    code: mapped.code,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
  };
}

// ── OpenAI Responses API（/v1/responses）──────────────
// 供 Codex 等使用 Responses 协议的客户端接入。代理仍是无状态转换层：
// 把 input 翻译成内部 Chat 格式，复用同一套 CC 转发管线。
// 不支持 previous_response_id / store（需要服务端保存会话，与无状态定位冲突），
// 收到直接 400，避免静默降级成错误答案。

function responsesTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p && typeof p === 'object' ? (p.text || '') : '')).join('');
}

// data URL 图片：一段文本里超过这个长度的 data URL 就当成"图"，提出来单独发；小图留在文本里
const INLINE_IMAGE_MIN = 256 * 1024;
// 单张 data URL 上限：再大就不要了，只留一句占位说明（既撑爆上游窗口，也撑爆内存）
const MAX_TOOL_IMAGE_URL = 12 * 1024 * 1024;
const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

// 从一段文本里捞出体积可观的 data URL 图片，原地替换成 [image] 占位。
// 必要性：base64 一旦被上游按**文本**分词就极其昂贵 —— 真机实测单张 2.76MB 截图 ≈ 1.92M token。
function extractInlineImages(text) {
  const images = [];
  const stripped = String(text).replace(DATA_URL_RE, (url) => {
    if (url.length < INLINE_IMAGE_MIN) return url;          // 小图留文本，别把工具输出切碎
    if (url.length > MAX_TOOL_IMAGE_URL) return '[image omitted: too large]';
    images.push(url);
    return '[image]';
  });
  return { text: stripped, images };
}

// Responses 的 function_call_output.output 可能是字符串，也可能是内容块数组；后者能带图。
// Codex Desktop 的截图工具就是 [{type:'input_image', image_url:'data:image/png;base64,...'}]。
// 返回 { text, images }，images 为 data URL 字符串数组。
function splitToolOutput(output) {
  if (output === undefined || output === null) return { text: '', images: [] };
  const texts = [];
  const images = [];
  const pushText = (raw) => {
    const r = extractInlineImages(raw);
    if (r.text) texts.push(r.text);
    images.push(...r.images);
  };
  if (typeof output === 'string') {
    pushText(output);
  } else if (Array.isArray(output)) {
    for (const part of output) {
      if (!part) continue;
      if (part.type === 'input_image' || part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : (part.image_url && part.image_url.url) || '';
        if (url.startsWith('data:')) {
          if (url.length <= MAX_TOOL_IMAGE_URL) images.push(url);
          else texts.push('[image omitted: too large]');
        } else if (url) {
          texts.push(`[image: ${url}]`);      // 外链图上游不认，只能留个说明
        }
      } else if (typeof part.text === 'string') {
        pushText(part.text);
      } else {
        pushText(JSON.stringify(part));       // 未知块保持原样，与旧行为一致
      }
    }
  } else {
    pushText(JSON.stringify(output));
  }
  return { text: texts.filter(Boolean).join('\n'), images };
}
// 单条请求内"工具截图"的总字节预算。工具截图会随每一轮请求全量重传，是内存与首字延迟的
// 头号杀手：真机实测一个 Codex 会话里 11 张截图 ≈5.5MB base64，配合 README 记录的内存放大
// ×5.1~7.4，把 1GB 的机器打到 global OOM（node anon-rss 532MB，内核把整机拖死）。
// 策略：从**最新**往回保留，预算内照发，超预算的老图替换成占位说明 —— 让模型知道有图被丢，
// 而不是以为历史里本来就没图。CC_MAX_TOOL_IMAGE_MB=0 关闭该行为。
const MAX_TOOL_IMAGE_BYTES = (() => {
  const mb = Number.parseFloat(process.env.CC_MAX_TOOL_IMAGE_MB ?? '6');
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
})();

function trimToolImages(messages) {
  if (!MAX_TOOL_IMAGE_BYTES) return;
  const refs = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) if (part && part._toolImage) refs.push({ m, part });
  }
  if (!refs.length) return;
  const keep = new Set();
  let used = 0;
  for (let i = refs.length - 1; i >= 0; i--) {           // 从最新往回挑，至少保一张
    const len = (refs[i].part.image_url && refs[i].part.image_url.url || '').length;
    if (keep.size === 0 || used + len <= MAX_TOOL_IMAGE_BYTES) { keep.add(i); used += len; }
  }
  if (keep.size === refs.length) return;                 // 没超预算，原样不动
  let droppedBytes = 0;
  for (let i = 0; i < refs.length; i++) {
    if (keep.has(i)) continue;
    const idx = refs[i].m.content.indexOf(refs[i].part);
    if (idx === -1) continue;
    droppedBytes += (refs[i].part.image_url && refs[i].part.image_url.url || '').length;
    refs[i].m.content[idx] = { type: 'text', text: '[older tool screenshot omitted: image budget exceeded]' };
  }
  log('warn', 'Tool images trimmed to budget', {
    total: refs.length, kept: keep.size, dropped: refs.length - keep.size,
    keptBytes: used, droppedBytes, budgetBytes: MAX_TOOL_IMAGE_BYTES,
  });
}


function responsesReasoningOf(item) {
  if (!item) return '';
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.map(p => (p && p.text) || '').join('');
  if (Array.isArray(item.content) && item.content.length) return item.content.map(p => (p && p.text) || '').join('');
  return typeof item.text === 'string' ? item.text : '';
}

function newResponsesId(prefix) {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 24);
}

function convertResponsesToChat(respReq) {
  const messages = [];

  if (respReq.instructions !== undefined && respReq.instructions !== null) {
    const sys = responsesTextOf(respReq.instructions);
    if (sys) messages.push({ role: 'system', content: sys });
  }

  // Responses 把 reasoning / message / function_call 拆成并列 item，
  // Chat 要求它们挂在同一条 assistant 消息上，故先累积再冲刷。
  let pending = null;
  const ensurePending = () => (pending = pending || { role: 'assistant', content: null, tool_calls: [] });
  const flushPending = () => {
    if (!pending) return;
    if (!pending.tool_calls.length) delete pending.tool_calls;
    if (!pending.reasoning_content) delete pending.reasoning_content;
    if (pending.content === null && !pending.tool_calls) { pending = null; return; }
    messages.push(pending);
    pending = null;
  };

  const input = respReq.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      // OpenAI 规范里 input 数组的联合类型第一个成员是 EasyInputMessage，它的
      // required 只有 role 与 content —— type 是可选的（官方文档与 SDK 示例普遍写作
      // { role: 'user', content: 'hi' }）。item.type 为 undefined 但有 role 时按
      // message 处理，否则这类 item 会落进 default 被丢弃：全部省略时只剩
      // "input is required" 的误导性报错；混合形态时更糟 —— 校验能过，用户在
      // HTTP 200 下静默丢消息。这里只在 type 缺失时兜底，带 type 的 item 判定不变。
      switch (item.type ?? (item.role ? 'message' : undefined)) {
        case 'reasoning': {
          const t = responsesReasoningOf(item);
          if (t) ensurePending().reasoning_content = t;
          break;
        }
        case 'message': {
          const text = responsesTextOf(item.content);
          if (item.role === 'assistant') {
            if (text) ensurePending().content = text;
          } else if (item.role === 'system' || item.role === 'developer') {
            flushPending();
            messages.push({ role: 'system', content: text });
          } else {
            flushPending();
            messages.push({ role: 'user', content: text });
          }
          break;
        }
        case 'function_call': {
          ensurePending().tool_calls.push({
            id: item.call_id || item.id || ('call_' + randomUUID().slice(0, 8)),
            type: 'function',
            function: { name: item.name || '', arguments: item.arguments || '{}' },
          });
          break;
        }
        case 'function_call_output': {
          flushPending();
          // 工具结果里可能带图（Codex Desktop 截图工具即 output=[{type:'input_image', image_url:'data:image/png;base64,...'}]）。
          // 绝不能 JSON.stringify 成文本送上游：base64 会按文本分词，真机实测单张 2.76MB 截图 ≈ 1.92M token，
          // 直接撞穿模型 1M 窗口（"maximum context length is 1048576 tokens ... 1922800 in the messages"）。
          // 官方 CLI 的排布是：tool-result 只放文本，图片提出来放进紧跟其后的一条 user 消息
          // （见 command-code@1.66.0 dist/cli.mjs 的 convertUserMessage / tool_result 分支）。
          const { text, images } = splitToolOutput(item.output);
          messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: text });
          if (images.length) {
            log('info', 'Hoisted tool-output images to user message', {
              count: images.length, bytes: images.reduce((a, u) => a + u.length, 0),
            });
            // content 走 image_url 形态，交给 buildCcRequest 里已验证的 user 图片分支转成 CC 的 {type:'image',image,mimeType}
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: '[image returned by tool call]' },
                ...images.map(url => ({ type: 'image_url', image_url: { url }, _toolImage: true })),
              ],
            });
          }
          break;
        }
        default: {
          log('warn', 'Unknown Responses input item type', { type: item.type });
          break;
        }
      }
    }
  }
  flushPending();

  // 统一裁剪工具截图（此时所有 item 都已转成 chat 形态，按顺序处理最直观）
  trimToolImages(messages);

  let tools;
  if (Array.isArray(respReq.tools) && respReq.tools.length) {
    tools = respReq.tools.filter(t => t && (t.type === 'function' || t.name)).map(t => ({
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
    if (!tools.length) tools = undefined;
  }

  let toolChoice;
  const tc = respReq.tool_choice;
  if (typeof tc === 'string') toolChoice = tc;
  else if (tc && typeof tc === 'object' && tc.name) toolChoice = { type: 'function', function: { name: tc.name } };

  const out = { model: respReq.model, messages, stream: respReq.stream === true };
  if (tools) out.tools = tools;
  if (toolChoice) out.tool_choice = toolChoice;
  if (respReq.parallel_tool_calls === false) out.parallel_tool_calls = false;
  if (respReq.max_output_tokens !== undefined) out.max_tokens = respReq.max_output_tokens;
  if (respReq.temperature !== undefined) out.temperature = respReq.temperature;
  if (respReq.top_p !== undefined) out.top_p = respReq.top_p;
  if (respReq.parallel_tool_calls !== undefined) out.parallel_tool_calls = respReq.parallel_tool_calls;
  const eff = respReq.reasoning && typeof respReq.reasoning === 'object' ? respReq.reasoning.effort : undefined;
  if (eff) out.reasoning_effort = eff;
  return out;
}

// Responses 的 input_tokens 是总数，cached / cache_write 均为其子集 ——
// 与 Anthropic 相反（那里 cache_read 是独立增量，必须做减法，见 issue #25）。
// 本代理上游 CC 的 inputTokens 同样已含缓存，故此处直接沿用、不做减法。
// 实测：total_tokens === input_tokens + output_tokens（即使 cached 占绝大多数）。
function buildResponsesUsage(usage, fallbackOutputTokens) {
  const u = usage || {};
  normalizeUsage(u);
  const inTok = u.inputTokens || 0;
  const outTok = u.outputTokens || fallbackOutputTokens || 0;
  return {
    input_tokens: inTok,
    // 规范里 cached_tokens 与 cache_write_tokens 都是 required
    input_tokens_details: {
      cached_tokens: u.cachedInputTokens || 0,
      cache_write_tokens: (u.inputTokenDetails && u.inputTokenDetails.cacheWriteTokens) || 0,
    },
    output_tokens: outTok,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inTok + outTok,
  };
}

function buildResponsesOutput(fullText, thinkingText, toolCalls) {
  const output = [];
  if (thinkingText) {
    output.push({ type: 'reasoning', id: newResponsesId('rs_'), summary: [{ type: 'summary_text', text: thinkingText }] });
  }
  if (fullText) {
    output.push({
      type: 'message', id: newResponsesId('msg_'), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    });
  }
  for (const tc of (toolCalls || [])) {
    const rawArgs = tc.function ? tc.function.arguments : '{}';
    output.push({
      type: 'function_call', id: newResponsesId('fc_'), call_id: tc.id,
      name: tc.function ? (tc.function.name || '') : '',
      arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {}),
      status: 'completed',
    });
  }
  return output;
}

function buildResponsesObject(responseId, model, created, fullText, thinkingText, toolCalls, usage, opts) {
  const o = opts || {};
  const truncated = o.finishReason === 'length';
  const paused = o.finishReason === 'pause_turn';
  return {
    id: responseId,
    object: 'response',
    created_at: created,
    status: (truncated || paused) ? 'incomplete' : 'completed',
    completed_at: nowUnix(),
    error: null,
    incomplete_details: truncated ? { reason: 'max_output_tokens' }
      : paused ? { reason: 'pause_turn' } : null,
    input: o.input || [],
    instructions: o.instructions === undefined ? null : o.instructions,
    max_output_tokens: o.max_output_tokens === undefined ? null : o.max_output_tokens,
    model,
    output: buildResponsesOutput(fullText, thinkingText, toolCalls),
    output_text: fullText || '',
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: o.reasoning || null,
    store: false,
    temperature: o.temperature === undefined ? 1 : o.temperature,
    text: { format: { type: 'text' } },
    tool_choice: o.tool_choice || 'auto',
    tools: o.tools || [],
    top_p: o.top_p === undefined ? 1 : o.top_p,
    truncation: 'disabled',
    usage: buildResponsesUsage(usage, 0),
    user: null,
    metadata: {},
  };
}

function sendResponsesError(res, status, type, message, retryAfter) {
  const body = { error: { message, type, code: null, param: null } };
  if (retryAfter !== undefined) body.retry_after = retryAfter;
  sendJSON(res, status, body);
}

// CC NDJSON → Responses 具名 SSE 事件（每个事件都必需的 sequence_number 递增发送）
function createResponsesSseTranslator(model, responseId, created) {
  let seq = 0;
  const sse = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type, sequence_number: seq++ }, data)) + '\n\n';
  let createdSent = false;
  let current = null;
  let outputIndex = 0;
  const doneItems = [];
  let usage = null;
  let textAcc = '';
  let finishReason = null;
  // 是否见过完成信号（见 incompleteUpstreamDetail 的口径说明）
  let sawFinish = false;

  const baseResponse = (status, output) => ({
    id: responseId, object: 'response', created_at: created, status,
    output: output || [], output_text: '', model, error: null, incomplete_details: null,
    parallel_tool_calls: true, previous_response_id: null, store: false, tools: [], metadata: {},
  });

  function startResponse() {
    createdSent = true;
    return [
      sse('response.created', { response: baseResponse('in_progress') }),
      sse('response.in_progress', { response: baseResponse('in_progress') }),
    ];
  }

  function closeItem() {
    if (!current) return [];
    const out = [];
    const item = current.item;
    const idx = current.index;
    if (current.kind === 'message') {
      out.push(sse('response.output_text.done', { item_id: item.id, output_index: idx, content_index: 0, text: current.textBuf, logprobs: [] }));
      out.push(sse('response.content_part.done', {
        item_id: item.id, output_index: idx, content_index: 0,
        part: { type: 'output_text', text: current.textBuf, annotations: [] },
      }));
      item.content = [{ type: 'output_text', text: current.textBuf, annotations: [] }];
      item.status = 'completed';
    } else if (current.kind === 'function_call') {
      out.push(sse('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: item.arguments }));
      item.status = 'completed';
    } else if (current.kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_text.done', { item_id: item.id, output_index: idx, summary_index: 0, text: current.textBuf }));
      out.push(sse('response.reasoning_summary_part.done', {
        item_id: item.id, output_index: idx, summary_index: 0,
        part: { type: 'summary_text', text: current.textBuf },
      }));
      item.summary = [{ type: 'summary_text', text: current.textBuf }];
      item.status = 'completed';
    }
    out.push(sse('response.output_item.done', { output_index: idx, item }));
    doneItems.push(item);
    current = null;
    return out;
  }

  function openItem(kind, item) {
    const out = closeItem();
    current = { kind, index: outputIndex++, item, textBuf: '' };
    out.push(sse('response.output_item.added', { output_index: current.index, item }));
    if (kind === 'message') {
      out.push(sse('response.content_part.added', {
        item_id: item.id, output_index: current.index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
    } else if (kind === 'reasoning') {
      out.push(sse('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: current.index, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
    }
    return out;
  }

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    // 提前发 created/in_progress（不带内容）：上游是 reasoning 模型，大 prompt 首字可能要十几秒，
    // 这期间一个字节都不出网就会被中间层（实测 EdgeOne 源站 ~15s）或客户端首字节超时掐掉
    start: startResponse,
    get started() { return createdSent; },
    get stopReason() { return finishReason; },
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;
      const out = [];

      switch (event.type) {
        case 'text-start': case 'reasoning-start': case 'start': case 'start-step':
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'message') {
            out.push.apply(out, openItem('message', { type: 'message', id: newResponsesId('msg_'), status: 'in_progress', role: 'assistant', content: [] }));
          }
          current.textBuf += text;
          textAcc += text;
          out.push(sse('response.output_text.delta', { item_id: current.item.id, output_index: current.index, content_index: 0, delta: text, logprobs: [] }));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          if (!createdSent) out.push.apply(out, startResponse());
          if (!current || current.kind !== 'reasoning') {
            out.push.apply(out, openItem('reasoning', { type: 'reasoning', id: newResponsesId('rs_'), summary: [], status: 'in_progress' }));
          }
          current.textBuf += text;
          out.push(sse('response.reasoning_summary_text.delta', {
            item_id: current.item.id, output_index: current.index, summary_index: 0, delta: text,
          }));
          break;
        }

        case 'tool-call': {
          if (!createdSent) out.push.apply(out, startResponse());
          const callId = event.toolCallId || newResponsesId('call_');
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          out.push.apply(out, openItem('function_call', {
            type: 'function_call', id: newResponsesId('fc_'), call_id: callId,
            name: event.toolName || '', arguments: '', status: 'in_progress',
          }));
          current.item.arguments = args;
          out.push(sse('response.function_call_arguments.delta', { item_id: current.item.id, output_index: current.index, delta: args }));
          break;
        }

        case 'finish': {
          sawFinish = true;
          // 必须归一化：截断类不止 'length'（还有 max_output_tokens /
          // model_context_window_exceeded），原来直接比对原始值会漏判成 completed。
          finishReason = event.finishReason ? mapFinishReason(event.finishReason) : null;
          const u = event.totalUsage || event.usage || null;
          if (u) {
            normalizeUsage(u);
            usage = u;
            this.inputTokens = u.inputTokens || 0;
            this.outputTokens = u.outputTokens || 0;
            this.cachedInputTokens = u.cachedInputTokens || 0;
          }
          break;
        }

        case 'error': {
          this.upstreamError = mapCcEventError(event);
          // 上游在 HTTP 200 之后于**流内**报错时，这里以前只赋值不打日志：客户端收到 400，
          // 而 journalctl 里一片安静（本次排障就是靠 nginx 的 body_bytes_sent=0 反推的）。
          // 对齐 /v1/chat/completions 路径的 CC stream error。
          log('warn', 'CC stream error', {
            path: '/v1/responses',
            message: event.error?.message || event.message || 'Unknown error',
            upstreamStatus: this.upstreamError.reportedStatus,
            code: this.upstreamError.code,
            mappedTo: this.upstreamError.status,
          });
          break;
        }

        default: break;
      }
      return out.length ? out : null;
    },
    finish() {
      if (!createdSent) return [];
      const out = closeItem();
      // 上游没有正常走完 finish —— 不能报 response.completed（那是把截断谎报成完整）。
      // 对齐 CLI：按可重试的 upstream_error 处理。
      const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
      if (incomplete) {
        log('warn', 'Upstream stream incomplete', { path: '/v1/responses', reason: incomplete });
        out.push(sse('response.failed', {
          response: Object.assign(baseResponse('failed'), {
            error: { code: 'upstream_error', message: incompleteUpstreamError(incomplete).body.error.message },
          }),
        }));
        return out;
      }
      // 'length' 表示被截断（max_output_tokens / model_context_window_exceeded 都归一到这里）；
      // 'pause_turn' 同样是「后面还有内容没发完」，规范要求 status=incomplete。
      const truncated = finishReason === 'length';
      const paused = finishReason === 'pause_turn';
      out.push(sse(truncated || paused ? 'response.incomplete' : 'response.completed', {
        response: Object.assign(baseResponse(truncated || paused ? 'incomplete' : 'completed', doneItems.slice()), {
          output_text: textAcc,
          incomplete_details: truncated ? { reason: 'max_output_tokens' }
            : paused ? { reason: 'pause_turn' } : null,
          usage: buildResponsesUsage(usage, this.outputTokens),
        }),
      }));
      return out;
    },
    fail(message) {
      if (!createdSent) return [];
      return [sse('response.failed', {
        response: Object.assign(baseResponse('failed'), {
          error: { code: 'upstream_error', message: message || 'Upstream error' },
        }),
      })];
    },
    errorEvent(message) {
      return sse('error', { code: null, message: message || 'Upstream error', param: null });
    },
  };
}

async function handleResponses(req, res) {
  let respReq;
  try {
    respReq = await readBody(req);
  } catch (e) {
    if (e.statusCode === 413) { sendResponsesError(res, 413, 'invalid_request_error', e.message); return; }
    sendResponsesError(res, 400, 'invalid_request_error', 'Invalid JSON body');
    return;
  }

  if (respReq.previous_response_id) {
    sendResponsesError(res, 400, 'invalid_request_error',
      'previous_response_id is not supported (this proxy is stateless); send the full input each turn');
    return;
  }

  let chatReq = convertResponsesToChat(respReq);
  if (!chatReq.messages.length) {
    sendResponsesError(res, 400, 'invalid_request_error', 'input is required');
    return;
  }

  const acct = await resolveAccount(req, res, conversationKeyOf(req.headers, chatReq));
  if (acct.kind === 'missing') {
    sendResponsesError(res, 401, 'authentication_error',
      'Missing API key. Send in Authorization: Bearer <key> or x-api-key header');
    return;
  }
  if (acct.kind === 'gone') return;
  if (acct.kind === 'error') {
    res.setHeader('Retry-After', String(acct.retryAfter));
    sendResponsesError(res, acct.status, acct.type, acct.message, acct.retryAfter);
    return;
  }
  const ctx = acct.ctx;

  const stream = chatReq.stream === true;
  const model = chatReq.model || 'deepseek/deepseek-v4-flash';
  const responseId = newResponsesId('resp_');
  const created = nowUnix();
  const echoOpts = {
    instructions: respReq.instructions === undefined ? null : respReq.instructions,
    max_output_tokens: respReq.max_output_tokens === undefined ? null : respReq.max_output_tokens,
    temperature: respReq.temperature,
    top_p: respReq.top_p,
    reasoning: respReq.reasoning || null,
    tool_choice: typeof respReq.tool_choice === 'string' ? respReq.tool_choice : 'auto',
    tools: respReq.tools || [],
  };
  const ccBody = buildCcRequest(chatReq);
  const promptCacheKey = chatReq.prompt_cache_key;
  chatReq = null;

  const abortController = new AbortController();
  let aborted = false;
  const startTime = Date.now();
  let bytesReceived = 0;
  let lastCcEvent = '';
  let reader = null;
  let translator = null;

  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    log('warn', 'Client disconnected', {
      path: '/v1/responses', model, responseId, elapsedMs: Date.now() - startTime,
      bytesSent: bytesReceived, lastCcEvent: lastCcEvent || '(none)',
    });
    if (!abortController.signal.aborted) { try { abortController.abort(); } catch (e2) {} }
  });

  try {
    await ensureInitialized(ctx, abortController.signal);
    const ccResponse = await forwardToCC(ccBody, ctx, req.headers, abortController.signal, promptCacheKey);

    if (!ccResponse.ok) {
      const errorText = await ccResponse.text().catch(() => '');
      const mapped = mapCcError(ccResponse.status, errorText);
      log('error', 'CC API error', { status: ccResponse.status, path: '/v1/responses', code: mapped.code, body: summarizeUpstreamError(errorText) });
      sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
      return;
    }

    if (stream) {
      translator = createResponsesSseTranslator(model, responseId, created);
      let buffer = '';
      let started = false;
      const decoder = new TextDecoder();
      reader = ccResponse.body.getReader();
      const idle = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS);
      const SSE_HEADERS = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      };
      const writeEvents = async (evts) => {
        if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
        for (const e2 of evts) res.write(e2);
        await waitDrain(res);
      };

      // 上游已 200：立刻把响应头 + response.created / response.in_progress 推下去。
      // 不能等首个内容事件 —— Codex 实测 reasoning_effort=max + 大 prompt，首字要 15s+，
      // 这段时间此前**零字节出网**，于是 nginx access.log 全是 `499 0`（body_bytes_sent=0）、
      // 中间 CDN（EdgeOne）按源站超时掐掉连接、客户端只能每 15 秒重试一次。
      // created 是不带内容的协议首事件，先发符合 Responses 语义；上游随后失败会走 response.failed。
      await writeEvents(translator.start());

      // SSE 保活：对齐 /v1/messages 的心跳思路，但这里发**注释行**。
      // Responses 协议没有 ping 事件，塞未知 event 类型有被严格解析器判错的风险；
      // 注释行（以 ':' 开头）按 SSE 规范必须被忽略 —— chat 端点在静默事件时也是这么发的。
      // 为什么必须发：首字前的静默期实测 15~40s，中间层的"源站空闲"超时（EdgeOne 实测约 15s）
      // 会把连接掐掉 —— 现象是客户端 ~16s 断连、代理侧 Client disconnected、nginx 只记到很少字节。
      const heartbeat = setInterval(() => {
        // 回调是同步的，无法 await waitDrain，所以用 writableNeedDrain 直接跳过（背压时少一条注释无副作用）
        if (aborted || !started || res.writableEnded || res.writableNeedDrain) return;
        try { res.write(': keepalive\n\n'); } catch (e2) {}
      }, 5000);

      try {
        while (true) {
          const result = await Promise.race([reader.read(), idle.arm()]);
          const done = result.done;
          const value = result.value;
          if (done) break;
          if (aborted || res.destroyed) break;
          bytesReceived += value.length;

          const chunkText = decoder.decode(value, { stream: true });
          buffer += chunkText;
          let lines = [];
          if (chunkText.indexOf('\n') !== -1) {
            lines = buffer.split('\n');
            buffer = lines.pop() || '';
          }

          for (const line of lines) {
            const evts = translator.parseLine(line);
            if (evts) await writeEvents(evts);
            if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
          }
        }

        if (!aborted) {
          if (buffer.trim()) {
            const evts = translator.parseLine(buffer);
            if (evts) await writeEvents(evts);
          }
          if (translator.upstreamError) {
            if (!started) {
              sendResponsesError(res, translator.upstreamError.status,
                translator.upstreamError.body.error.type, translator.upstreamError.body.error.message,
                translator.upstreamError.body.retry_after);
              return;
            }
            const failed = translator.fail(translator.upstreamError.body.error.message);
            if (failed.length) await writeEvents(failed);
          } else if (translator.outputTokens === 0 && !translator.started) {
            try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
            sendResponsesError(res, 429, 'rate_limit_error',
              'Empty response from upstream (zero output tokens)', 10);
            return;
          } else {
            if (!started) { res.writeHead(200, SSE_HEADERS); started = true; }
            for (const e2 of translator.finish()) res.write(e2);
          }
          ctx.timeouts.count = 0;
        }
      } catch (e) {
        if (aborted) {
          try { reader.cancel().catch(() => {}); } catch (e2) {}
        } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
          log('warn', 'Stream idle timeout', {
            path: '/v1/responses', model, streaming: true, timeoutMs: STREAM_IDLE_TIMEOUT_MS,
            elapsedMs: Date.now() - startTime, bytesReceived, lastCcEvent: lastCcEvent || '(none)',
          });
          ctx.timeouts.count++;
          const timeoutMsg = ctx.timeouts.count >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
            ? 'Response timeout - try reducing context length (summarize earlier messages)'
            : 'Response timeout - request timed out';
          if (!started) { sendResponsesError(res, 429, 'rate_limit_error', timeoutMsg, 5); return; }
          if (!res.writableEnded) {
            // end() 而不是 destroy()：理由见 handleChatCompletions 流式超时分支
            try { res.end(translator.errorEvent(timeoutMsg)); } catch (e2) {}
          }
        } else {
          log('error', 'Stream error', { message: e.message, path: '/v1/responses' });
          try { abortController.abort(); } catch (e2) {}
          if (!started) {
            sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
            return;
          }
          if (!res.writableEnded) {
            try { res.write(translator.errorEvent(e.message)); } catch (e2) {}
          }
        }
      } finally {
        clearInterval(heartbeat);
        idle.dispose();
      }

      if (!res.writableEnded) res.end();
    } else {
      // ── 非流式：缓冲完整 NDJSON 后一次性构造 Responses 对象 ──
      let fullText = '';
      let thinkingText = '';
      let usage = null;
      let finishReason = 'stop';
      let sawFinish = false;
      let upstreamError = null;
      const toolCalls = [];
      reader = ccResponse.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const processLines = () => {
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
          let event;
          try { event = JSON.parse(trimmed); } catch (e2) { continue; }
          switch (event.type) {
            case 'text-delta': lastCcEvent = event.type; fullText += event.text || ''; break;
            case 'reasoning-delta': lastCcEvent = event.type; thinkingText += event.text || ''; break;
            case 'tool-call': {
              lastCcEvent = event.type;
              toolCalls.push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: {
                  name: event.toolName || '',
                  arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}),
                },
              });
              break;
            }
            case 'finish-step':
            case 'finish':
              lastCcEvent = event.type;
              sawFinish = true;
              finishReason = mapFinishReason(event.finishReason || 'stop');
              if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
              break;
            case 'error':
              lastCcEvent = event.type;
              upstreamError = mapCcEventError(event);
              log('warn', 'CC stream error (non-stream)', {
                message: event.error ? event.error.message : event.message,
                upstreamStatus: upstreamError.reportedStatus,
                upstreamRetryable: event.error?.isRetryable,
                code: upstreamError.code,
                mappedTo: upstreamError.status,
              });
              break;
            // 无内容的事件：与流式翻译器以及另两条非流式路径保持一致。
            // 这条路径原先**没有静默列表**，于是上游每个响应都会发的一串无内容事件
            //（text-start / text-end / start / start-step / reasoning-start / reasoning-end /
            //  provider-metadata / tool-input-* / tool-error）全部掉进 default 打成
            // 'Unknown CC event type'，线上刷屏、把真正的错误淹掉。
            case 'text-start': case 'text-end': case 'start': case 'start-step':
            case 'reasoning-start': case 'reasoning-end': case 'finish-step':
            case 'provider-metadata': case 'tool-input-start': case 'tool-input-delta': case 'tool-input-end':
            case 'tool-error':
              // Silent - no user-visible content
              break;
            default:
              log('warn', 'Unknown CC event type', { type: event.type });
              break;
          }
        }
      };

      const idle = createIdleWatchdog(NONSTREAM_IDLE_TIMEOUT_MS);
      while (true) {
        const result = await Promise.race([reader.read(), idle.arm()]);
        const done = result.done;
        const value = result.value;
        if (done) break;
        bytesReceived += value.length;
        const chunkText = decoder.decode(value, { stream: true });
        buf += chunkText;
        if (chunkText.indexOf('\n') !== -1) processLines();
      }
      idle.dispose();
      processLines();

      if (upstreamError) {
        sendResponsesError(res, upstreamError.status, upstreamError.body.error.type,
          upstreamError.body.error.message, upstreamError.body.retry_after);
        return;
      }

      // 上游没有正常走完 finish —— 对齐 CLI 按可重试 502 处理，不谎报成功
      {
        const incomplete = incompleteUpstreamDetail(sawFinish, finishReason);
        if (incomplete) {
          log('warn', 'Upstream stream incomplete', { path: '/v1/responses', reason: incomplete });
          const err = incompleteUpstreamError(incomplete);
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          sendResponsesError(res, err.status, err.body.error.type, err.body.error.message, err.retry_after);
          return;
        }
      }

      if (!fullText && !thinkingText && !toolCalls.length) {
        try { if (!abortController.signal.aborted) abortController.abort(); } catch (e2) {}
        sendResponsesError(res, 429, 'rate_limit_error',
          'Empty response from upstream (zero output tokens)', 10);
        return;
      }

      ctx.timeouts.count = 0;
      echoOpts.finishReason = finishReason;
      sendJSON(res, 200, buildResponsesObject(
        responseId, model, created, fullText, thinkingText, toolCalls, usage, echoOpts));
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return;
    log('error', 'Responses handler error', { message: e.message });
    if (!res.headersSent) {
      sendResponsesError(res, 502, 'proxy_error', 'Upstream error: ' + e.message, 10);
    } else if (!res.writableEnded) {
      try { res.write(translator ? translator.errorEvent(e.message) : ''); } catch (e2) {}
      try { res.end(); } catch (e2) {}
    }
  }
}

async function handleModels(req, res) {
  const apiKey = getApiKey(req.headers);
  // 池模式：用当前最空闲的健康账号的目录（不占槽位，也绝不把多个账号的目录并集）
  const ctx = apiKey && (!POOL || POOL_CFG.passthroughClientKeys) ? passthroughContext(apiKey)
    : POOL ? accountContext(POOL.peek())
    : null;
  const models = await fetchModels(ctx);
  const now = nowUnix();
  sendJSON(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'command-code',
    })),
  });
}

function handlePoolStats(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  sendJSON(res, 200, POOL.stats());
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

// ── 账号池启动 ──────────────────────────────────────
// 配置错误一律拒绝启动（与 upstreamProxy 同理：写错应当立刻暴露，而不是每个请求各错一次）。
let POOL = null;
let POOL_CFG = null;
const isLoopbackHost = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost' || /^127\./.test(h);
if (CFG.poolConfig) {
  try {
    POOL_CFG = loadPoolConfig(CFG.poolConfig);
  } catch (e) {
    log('error', 'Invalid pool config, refusing to start', { error: e.message });
    process.exit(1);
  }
  // 账号池模式不做客户端鉴权（与 openai-oauth fork 的 pool:serve 一致）：能连上就能用池里所有账号。
  // 因此默认只许绑回环地址；要对外监听必须显式放行，并自行在前面加鉴权 / TLS。
  const allowNetwork = POOL_CFG.allowNetwork || process.env.CC_POOL_ALLOW_NETWORK === '1';
  if (!isLoopbackHost(CFG.host) && !allowNetwork) {
    log('error', 'Refusing to bind a non-loopback host in pool mode', {
      host: CFG.host,
      hint: 'set HOST=127.0.0.1, or set "allowNetwork": true in the pool config / CC_POOL_ALLOW_NETWORK=1 and put your own auth in front',
    });
    process.exit(1);
  }
  for (const w of POOL_CFG.warnings) log('warn', 'Pool config warning', { warning: w });
  POOL = createPool(POOL_CFG, {
    log,
    createState: createAccountProtocolState,
    probe: probePooledAccount,
  });
}

// ── 服务器 ──────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);

  // 在途上限准入。/health 与 / 例外：探活与编排器不该因业务繁忙而收 503。
  const isPoolStats = POOL && POOL_CFG.diagnostics && url.pathname === '/pool/stats' && req.method === 'GET';
  const isLiveness = url.pathname === '/health' || url.pathname === '/' || isPoolStats;
  if (!isLiveness && MAX_INFLIGHT > 0) {
    if (inflightCount >= MAX_INFLIGHT) {
      log('warn', 'In-flight limit reached, rejecting request', {
        maxInflight: MAX_INFLIGHT, inflight: inflightCount, path: url.pathname,
      });
      sendJSON(res, 503, {
        error: { message: `Too many concurrent requests (limit ${MAX_INFLIGHT}), retry shortly`, type: 'server_busy' },
        retry_after: 5,
      });
      return;
    }
    inflightCount++;
    // 释放时机：响应写完（finish）或连接终止（close）—— 取先到者，且幂等，
    // 保证任何退出路径（成功/出错/客户端断连/超时）都不会泄漏槽位。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (inflightCount > 0) inflightCount--;
    };
    res.once('finish', release);
    res.once('close', release);
  }

  try {
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleChatCompletions(req, res);
    } else if (url.pathname === '/v1/messages' && req.method === 'POST') {
      await handleMessages(req, res);
    } else if (url.pathname === '/v1/responses' && req.method === 'POST') {
      await handleResponses(req, res);
    } else if (url.pathname === '/v1/models' && req.method === 'GET') {
      await handleModels(req, res);
    } else if (isPoolStats) {
      handlePoolStats(req, res);
    } else if (url.pathname === '/health' || url.pathname === '/') {
      handleHealth(req, res);
    } else {
      sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    }
  } catch (e) {
    sendJSON(res, 500, { error: { message: e.message, type: 'internal_error' } });
  }
});

// 全局兜底：abort 触发的异步 rejection 不会让进程崩溃
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'AbortError' || reason?.code === 'ABORT_ERR') {
    // 客户端断连触发的 abort — 预期行为，静默处理
    log('info', 'Aborted request cleaned up');
  } else if (isRetryableUpstreamError(reason)) {
    // 上游传输层闪断造成的异步 rejection（如 socket terminated），已被重试机制或上层吸收
    log('info', 'Upstream socket terminated asynchronously (handled)');
  } else {
    log('error', 'Unhandled rejection', { message: reason?.message || String(reason), stack: reason?.stack?.split('\n')[0] });
  }
});

// ── keep-alive 时序（放在反向代理后面时是必调项） ──────────────
// 反代（nginx/OpenResty）的 upstream keepalive_timeout 必须**小于**这里的值，
// 否则反代会复用一条后端已经关掉的连接：它把请求体写过去，后端早已 FIN，
// 写这一侧就是 EPIPE —— nginx 侧表现为
//   sendfile() failed (32: Broken pipe) while sending request to upstream
// 而这条请求是 POST（非幂等），nginx 默认不会重试 → 客户端直接吃 502。
//
// Node 默认 keepAliveTimeout=5s。反代若用常见的 4s，余量只有 1 秒；一旦反代的
// 空闲判定基准与后端差一点（大响应体读完的时刻 vs 后端写完的时刻），就会踩上。
// 这里显式抬到 65s，让「谁先关」不再取决于一两秒的抖动 —— 与 Node 官方在
// 反向代理后部署的建议一致（keepAliveTimeout > 前端 idle timeout）。
// 反代侧仍建议设 keepalive_timeout 60s 以内。
const KEEPALIVE_TIMEOUT_MS = (() => {
  const ms = Number.parseInt(process.env.CC_KEEPALIVE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 65000;
})();
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = KEEPALIVE_TIMEOUT_MS + 1000;   // Node 要求 headersTimeout > keepAliveTimeout

server.listen(CFG.port, CFG.host, () => {
  log('info', 'CC Proxy started', {
    url: `http://${CFG.host}:${CFG.port}`,
    api: CFG.apiBase,
    models: MODELS.length,
    session: '12h + 1h jitter, per API key',
    zdr: CFG.zdr ? 'enabled (x-cmd-zdr: 1 on generation/init requests)' : 'off (CMD_ZDR=1 or per-request x-cmd-zdr: 1 to enable)',
    emptySystemPlaceholder: CFG.emptySystemPlaceholder ? 'on (space placeholder for requests without system prompt, issue #17)' : 'off',
    logFile: CFG.logFile || '(console only)',
    clientDrainTimeout: CLIENT_DRAIN_TIMEOUT_MS > 0 ? `${CLIENT_DRAIN_TIMEOUT_MS}ms` : 'disabled',
    keepAliveTimeout: `${KEEPALIVE_TIMEOUT_MS}ms (反代侧 keepalive_timeout 必须小于它)`,
    idleTimeouts: `stream ${STREAM_IDLE_TIMEOUT_MS}ms / nonstream ${NONSTREAM_IDLE_TIMEOUT_MS}ms`,
    maxInflight: MAX_INFLIGHT > 0 ? `${MAX_INFLIGHT} (global, /health exempt)` : 'unlimited (CC_MAX_INFLIGHT=0)',
    upstreamProxy: redactProxyUrl(UPSTREAM_PROXY),
    pool: POOL ? {
      accounts: POOL.accounts.map(a => `${a.name} via ${a.proxyLabel}`),
      maxInflightPerAccount: POOL_CFG.maxInflightPerAccount,
      healthRefresh: POOL_CFG.healthRefreshMs > 0 ? `${POOL_CFG.healthRefreshMs}ms` : 'off',
      clientKeys: POOL_CFG.passthroughClientKeys ? 'passthrough (requests with their own user_ key bypass the pool)' : 'ignored',
      diagnostics: POOL_CFG.diagnostics ? 'GET /pool/stats' : 'off',
    } : 'off (single-key mode)',
    upstreamRetry: UPSTREAM_RETRY_MAX > 0
      ? `${UPSTREAM_RETRY_MAX} retries, base ${UPSTREAM_RETRY_BASE_MS}ms (only before first byte)`
      : 'disabled (CC_UPSTREAM_RETRY_MAX=0)',
  });
  if (CLIENT_DRAIN_TIMEOUT_MS > 0) {
    log('info', 'Client drain timeout enabled', { timeoutMs: CLIENT_DRAIN_TIMEOUT_MS });
  }
  // 内存提示：body 上限隐含的最坏内存 = 上限 × 实测放大系数（见 MAX_BODY_SIZE 注释 / issue #20）
  const bodyCapMB = Math.round(MAX_BODY_SIZE / 1048576);
  const worstCaseMB = Math.round(bodyCapMB * 5.5);
  if (worstCaseMB >= 500) {
    log('warn', 'Request body limit implies high per-request worst-case memory', {
      maxBodyMB: bodyCapMB,
      worstCaseRSSPerRequestMB: worstCaseMB,
      hint: 'lower CC_MAX_BODY_MB, set CC_MAX_INFLIGHT, and/or cap in-flight requests at the reverse proxy (see README)',
    });
  }
  if (!CFG.apiKey && !POOL) {
    log('info', 'No API key in config. API key must be sent in Authorization: Bearer <key> header per request.');
  }
});
