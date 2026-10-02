# Command Code Proxy

> [English Docs](README.md)

将 Command Code API 转换为 OpenAI / Anthropic 兼容接口的反代代理。零外部依赖。

逐条对齐官方 npm 包源码（`command-code@1.73.4`；`dist/cli.mjs` 只是压缩、**没有混淆**）。上游 npm 走到更高版本时代理只打**漂移告警**，不会静默改版本号（见[反检测](#反检测)）。

**完整功能**：OpenAI Chat Completions / **Responses API（`/v1/responses`）** + Anthropic Messages API | 流式/非流式输出 | 工具调用 (tool_use) | 多模态图片输入 | 推理强度 (reasoning_effort) | 动态模型列表 | 缓存命中指标 | 设备指纹伪装（per-key 绑定、自动刷新）| `x-api-key` 鉴权（Anthropic SDK）| 客户端断连检测（上游中止）| 零输出 → 429 自动重试 | 连续超时 → 429 自动重试 | 隐私保护日志 | **多账号池**（每账号独立代理、负载均衡、相互隔离）

**社区**: [Linux.do](https://linux.do) — 一个友好的中文技术社区。

## 快速开始

```bash
npm start        # 启动（仓库自带 config.json，监听 http://0.0.0.0:3050）
npm run dev      # watch 模式（文件修改自动重启）
```

API Key 通过 `Authorization` 请求头（Anthropic SDK 可用 `x-api-key`）传入，**无需配置到文件中**。Key 必须以 `user_` 开头（自动匹配任意前缀，如 `Bearer token_user_xxx`）：

```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 文件结构

```
commandcode/
├── config.json           # 端口 / 日志路径等
├── LICENSE               # MIT License
├── package.json          # npm start / npm run dev
├── proxy.mjs             # 核心代理（协议转换、各接口处理）
├── pool.mjs              # 账号池：调度、健康、每账号出口、配置校验
├── login.mjs             # `npm run login`：CLI 同款浏览器登录，把账号加进账号池
├── pool.example.json     # 账号池配置模板（复制为 pool.json 并 chmod 600）
├── Dockerfile            # 容器构建文件（node:22-alpine）
├── docker-compose.yml    # 容器编排
├── .dockerignore         # 构建上下文排除规则
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # release 分支 / v* tag → GHCR 多架构（latest + release）
├── captured-requests/    # CLI 抓包数据（协议逆向参考）
├── README.md             # 英文文档
└── README_zh.md          # 本文档（中文）
```

## 配置

### config.json

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `3000` | 监听端口（仓库自带 config.json 为 3050） |
| `host` | `0.0.0.0` | 监听地址 |
| `apiBase` | `https://api.commandcode.ai` | CC API 地址 |
| `projectSlug` | `cc-proxy` | `x-project-slug` header |
| `apiKey` | `""` | 可选兜底 API Key（请求也可通过 header 传入） |
| `logFile` | `""` | 日志文件路径（空=仅控制台） |
| `logLevel` | `info` | 日志级别 |
| `useProviderModels` | `false` | 从 `/provider/v1/models` 拉模型列表。默认关：真 CLI 从不调这个端点（目录内置），`/v1/models` 返回 CLI 1.73.4 的内置目录 |
| `modelRefreshIntervalMs` | `300000` | 模型列表缓存刷新间隔（5min） |
| `zdr` | `false` | 请求 Command Code 使用 ZDR-only 路由 |
| `cliMode` | `""`（不带）| 信封 `mode`。CLI 1.73.4 的 agent 回合**不带** `mode` 键；只有想模仿功能调用时才设。上游枚举：`agent` / `learning` / `custom-agent` / `custom-agent-create` / `title-gen` / `tool-desc` / `compact` / `vision` |
| `tasteLearning` | `false` | `x-taste-learning` 头。CLI 默认 `true`（服务端会从账号的对话里学习「口味」档案），这里默认关 |
| `cliSessionMode` | `interactive` | lifecycle 元数据里的 `mode`（**另一个枚举**：`interactive` / `non-interactive`）|
| `fingerprintSalt` | `""` | 设备指纹的盐。**成批换设备身份**就用它（同一个 key 永远报同一台设备）|
| `deviceProjectDir` | `""` | 伪装的项目目录（空则用内置 `C:\Users\dev\projects\app`）；改了 = 所有账号换一台设备 |
| `emptySystemPlaceholder` | `true` | 无 system prompt 时发空格占位，阻止上游注入约 7.5K token 默认提示词（[#17](https://github.com/MAXeaglet/commandcode-proxy/issues/17)）|
| `poolConfig` | `""` | 私有账号池配置文件路径（相对 `proxy.mjs`）；设置即开启账号池模式，见[账号池](#账号池poolconfig--cc_pool_config) |

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3000`（自带 config.json 为 `3050`）| 监听端口 → `port` |
| `HOST` | `0.0.0.0` | 监听地址 → `host` |
| `CC_API_BASE` | `https://api.commandcode.ai` | 上游地址 → `apiBase` |
| `CC_UPSTREAM_PROXY` | 空 | 让**发往 CC 上游**的请求走 `http://`（CONNECT）或 `https://` 代理，见下文「上游代理」→ `upstreamProxy` |
| `CC_POOL_CONFIG` | 空 | 账号池配置路径（相对当前工作目录）→ `poolConfig` |
| `CC_POOL_ALLOW_NETWORK` | 空 | `1` 允许账号池模式绑定非回环地址（没有客户端鉴权！）|
| `PROJECT_SLUG` | `cc-proxy` | `x-project-slug` → `projectSlug` |
| `LOG_FILE` | 空 | 日志文件 → `logFile`（**同步写**，见[其它注意事项](#其它注意事项)）|
| `CC_USE_PROVIDER_MODELS` | `false` | `true` = 从 `/provider/v1/models` 拉模型列表 → `useProviderModels` |
| `CMD_ZDR` | 关 | `1` 开启 ZDR-only 路由 → `zdr` |
| `CC_CLI_MODE` | 空（不带）| 信封 `mode` → `cliMode` |
| `CC_TASTE_LEARNING` | `false` | `true` = 发 `x-taste-learning: true` → `tasteLearning` |
| `CC_CLI_SESSION_MODE` | `interactive` | lifecycle 元数据的 `mode` → `cliSessionMode` |
| `CC_FINGERPRINT_SALT` | 空 | 设备指纹盐 → `fingerprintSalt` |
| `CC_DEVICE_PROJECT_DIR` | 空 | 伪装的项目目录 → `deviceProjectDir` |
| `CC_EMPTY_SYSTEM_PLACEHOLDER` | `true` | 无 system prompt 时发空格占位；`false` 关掉 → `emptySystemPlaceholder` |
| `CC_MAX_BODY_MB` | `100` | 请求体上限（MB），超限返回 `413` |
| `CC_MAX_TOOL_IMAGE_MB` | `6` | 单请求内工具截图（base64）总预算，超预算的老图换成占位；`0` 关闭，见[工具截图预算](#工具截图预算) |
| `CC_STREAM_IDLE_MS` | `30000` | 流式上游读空闲超时，见[上游空闲超时](#上游空闲超时) |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式上游读空闲超时（同上）|
| `CC_UPSTREAM_RETRY_MAX` | `2` | 上游「未吐字前闪断」的内部重试次数；`0` = 关闭，见[上游闪断重试](#上游闪断重试) |
| `CC_UPSTREAM_RETRY_BASE_MS` | `400` | 重试退避基数（毫秒），实际退避 = base × 尝试序号 |
| `CC_MAX_INFLIGHT` | `0`（不限）| 进程内在途请求上限，超限 `503`，见[在途上限](#在途请求上限可选) |
| `CC_CLIENT_DRAIN_TIMEOUT_MS` | 空（禁用）| 下游背压阻塞超过该毫秒数就断开该客户端，见[僵死连接](#僵死连接既不读也不断开) |
| `CC_KEEPALIVE_TIMEOUT_MS` | `65000` | 后端 keep-alive 时长（`headersTimeout` 自动 +1s）。**必须大于反代侧的 keepalive_timeout**，见 [keep-alive 时序](#nginx-反代建议) |

开启后，代理会在 Command Code 生成请求以及 fingerprint/lifecycle 初始化请求中附加
`x-cmd-zdr: 1`。npm 版本检查和代理自己的 `/provider/v1/models` 模型目录请求不会附加该
header。该开关只是请求 Command Code 使用 ZDR-only 路由，实际数据留存和上游可用性仍由上游服务决定。

**请求体上限**：独立于 `config.json` —— 超过 **100MB** 的请求会被拒绝并返回 `HTTP 413`（连接保持可排空，不会直接 reset）。可用 `CC_MAX_BODY_MB`（正整数，单位 MB）覆盖。

> ⚠️ **内存放大**：请求体在转发到上游前会存在多份副本，实测峰值 ≈ body 大小 × **5.1~7.4**（7MB→+52MB、20MB→+116MB；被 `413` 拒绝的请求只要 ×1.05）。因此默认 `CC_MAX_BODY_MB=100` 意味着**单个请求**最坏可吃 ~550MB，且该上限是每请求的、不是全局的。详见[内存与部署](#内存与部署)。

### 工具截图预算

工具结果里的图片会**单独**作为 `image` 块发给上游（`function_call_output.output` 里的 `input_image`
不再被 `JSON.stringify` 进 tool-result 文本）。原因是 base64 一旦被上游按**文本**分词就极其昂贵 ——
真机实测 Codex Desktop 单张 2.76MB 截图 ≈ **1.92M token**，直接撞穿模型的 1M 窗口：

```
400 This model's maximum context length is 1048576 tokens. However, you requested
    1986800 tokens (1922800 in the messages, 64000 in the completion)
```

但图片仍会随每一轮请求**全量重传**：真机实测一个会话里 11 张截图 ≈5.5MB base64，配合上面的内存放大
×5.1~7.4，在 1GB 的机器上足以把代理顶到 `anon-rss 532MB` 并触发 **global OOM**（内核杀掉 node，
整机假死）。`CC_MAX_TOOL_IMAGE_MB`（默认 `6`）按**从新到旧**保留到预算之内（至少保一张），被裁掉的
替换成 `[older tool screenshot omitted: image budget exceeded]` —— 模型知道有图被丢，不会以为历史里
本来就没图。只作用于工具截图，用户自己贴的图不受影响。

> 想让模型看到全部截图就调大预算，但请按 `预算 × 并发 × 5~7` 估内存（并发见[在途上限](#在途请求上限可选)）。

### 上游代理（`upstreamProxy` / `CC_UPSTREAM_PROXY`）

让代理**发往 Command Code 的请求**走本地 HTTP 代理 —— 用于出口地区调整，或排查风控 `403` 时做 IP 维度对照。

```json
{ "upstreamProxy": "http://127.0.0.1:7890" }
```

```bash
CC_UPSTREAM_PROXY=http://127.0.0.1:7890 npm start
```

- 作用于全部上游请求：`/alpha/generate`、`/alpha/fingerprint/record`、`/alpha/lifecycle-events`、`/alpha/whoami`、`/alpha/billing/*`，以及（开启时的）`/provider/v1/models`。
- **不影响**本地监听、`/health` 与 npm 版本检查。
- 支持 `http://`（CONNECT）与 `https://`（先与代理建 TLS 再 CONNECT）代理。实现方式是自建 CONNECT 隧道 + `node:https` 复用同一 socket，**不新增任何依赖**，Node 18+ 即可用。
- 每个上游请求各自建立一条隧道连接。TLS 为端到端：证书按**目标主机名**校验，绝不针对代理降级。
- **指纹/lifecycle 预请求也走代理**是刻意的：若它们直连而上游生成走代理，同一账号会从两个不同 IP 注册 —— 正是你想避免的那种矛盾。
- 代理地址里带账号密码（`http://user:pass@host:port`）时，日志只保留 `host:port`，**不打印口令**。

> Node 原生 `fetch` **不读** `HTTPS_PROXY`/`HTTP_PROXY`。官方环境变量路线需要 Node ≥ 22.21 / 24.5 且设 `NODE_USE_ENV_PROXY=1`；本选项两者都不需要。

### 账号池（`poolConfig` / `CC_POOL_CONFIG`）

**一个端点背后挂多个 Command Code 账号**：每个账号独立的 key、独立的出口代理、独立的设备身份，账号之间相互隔离；请求在健康账号之间负载均衡，同一会话固定在同一账号上。设计移植自 [openai-oauth fork](https://github.com/QuartzWarrior/openai-oauth) 的账号池。

```bash
cp pool.example.json pool.json && chmod 600 pool.json   # 里面有 key：不能对他人可读
export CC_KEY_ALICE=user_xxx CC_PROXY_ALICE=http://user:pass@proxy-a.example:8080
export CC_KEY_BOB=user_yyy   CC_PROXY_BOB=https://proxy-b.example:443
HOST=127.0.0.1 CC_POOL_CONFIG=./pool.json npm start
```

**添加账号：`npm run login`** —— 与官方 CLI 同一套登录流程，结果直接写进账号池配置：

```bash
npm run login -- --name alice --proxy http://user:pass@proxy-a.example:8080
npm run login -- --name bob   --proxy https://user:pass@proxy-b.example:443
npm run login -- --list                 # key 打码、代理脱敏
npm run login -- --remove bob
```

- **浏览器登录**：与 `cmd login` 一样，在 `127.0.0.1` 起回调服务，打印并打开 `https://commandcode.ai/studio/auth/cli?…`，网页把新签发的 API key 回传给回调（校验 state）。无图形界面的服务器上，先转发打印出的端口（`ssh -L <端口>:127.0.0.1:<端口> …`），或用 `--port` 固定端口。
- **其它方式**：在提示处粘贴 key，或 `--key user_…`（用 `GET /alpha/whoami` **经该账号的代理**验证，与 CLI 的手动输入分支一致），或 `--from-cli` 导入官方 CLI 保存在 `~/.commandcode/auth.json` 的 key。
- **写入方式**：按名字更新账号，没有则追加，其它账号与设置保留。`pool.json` 不存在时以 600 权限新建。期间被并发修改则放弃写入。key 复用或代理共享会在写入前被拒绝。`--proxy-env VAR` 存 `proxyEnv` 引用而不是代理 URL 原文。
- **IP 一致性**：浏览器登录期间 CLI 自己不发任何上游请求，key 由网页签发，所以登录时看到的是你浏览器的 IP。想让账号只出现在一个 IP 上，就用配了同一代理的浏览器打开登录链接。
- **生效方式**：增删账号后需重启代理。

之后客户端调用代理时**不带** API key（或带任意非 `user_` 的 token），由代理挑账号。

> ⚠️ **账号池模式没有客户端鉴权**：能连上端口的人就能用池里所有账号。因此在非回环地址上**默认拒绝启动**，除非设置 `"allowNetwork": true` 或 `CC_POOL_ALLOW_NETWORK=1`。只在可信网络、或前面自加鉴权 / TLS 时这样做（Docker 需要，因为容器绑 `0.0.0.0`）。账号池不是多租户隔离边界。

**账号字段**

| 字段 | 说明 |
|------|------|
| `name` | 必填、唯一。用于日志与 `/pool/stats`（key 永不入日志）|
| `apiKey` / `apiKeyEnv` | `user_…` key，直接写或从环境变量读（二选一）。重复的 key 拒绝启动 |
| `proxy` / `proxyEnv` | 可选的该账号出口：`http://`（CONNECT）或 `https://`（先与代理建 TLS 再 CONNECT）。两个账号用同一代理 host:port **且**口令相同会被拒绝，除非 `allowSharedProxy` |
| `weight` | 负载权重（默认 `1`）|
| `maxInflight` | 该账号并发上限（默认 `maxInflightPerAccount`）|
| `deviceProjectDir` | 覆盖该账号派生出的伪装项目目录 |
| `fingerprintSalt` | 该账号的指纹盐（默认用全局 `fingerprintSalt`）|
| `enabled` | `false` 暂时跳过该账号而不删配置 |

**池字段**

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `maxInflightPerAccount` | `32` | 每账号在途请求数（覆盖整个流的生命周期）|
| `maxQueuedRequests` | `256` | 等待空闲账号的请求数上限；超出 → `503` |
| `queueTimeoutMs` | `60000` | 最长排队时间 → `503` |
| `affinityTtlMs` | `3600000` | 会话最后一次请求后与账号保持绑定的时长 |
| `quotaCooldownMs` | `1800000` | `402` / `USAGE_EXCEEDED` 后的冷却 |
| `quarantineMs` | `600000` | `401` / `403` 后的冷却（健康探测成功会提前解除）|
| `healthRefreshMs` | 关 | `true` = 每 60 秒，或正整数间隔。经**各账号自己的路由**探测 `GET /alpha/whoami` —— CLI 每次开会话都会调的同一个请求（不耗推理额度）|
| `strictAffinity` | `false` | 会话所属账号冷却中：`false` 改派到别的账号；`true` 回 `429` 并带剩余冷却时间 |
| `passthroughClientKeys` | `true` | 自带 `user_` key 的请求绕过账号池（即原来的单 key 行为）；`false` 忽略客户端 key |
| `diagnostics` | `false` | 开启 `GET /pool/stats` |
| `allowNetwork` | `false` | 允许绑定非回环地址（见上方警告）|
| `allowSharedProxy` | `false` | 允许多个账号共用同一代理出口 |

**每个账号独立的东西**

- **出口**：generate、指纹、lifecycle、models 请求全部走该账号自己的代理。代理挂了回 `502`，**绝不回落直连**。没配代理的账号各自有专属的 keep-alive Agent，账号之间不会共用 socket 或 TLS 会话。
- **设备身份**：每个账号有自己的指纹，项目目录也按账号派生（`C:\Users\<用户名>\projects\<名字>`，用户名与指纹里的 OS 用户一致），所以各账号的 `x-project-slug` / `workingDir` 都不同。池模式下忽略全局 `deviceProjectDir`。
- **会话 id**：客户端的 `x-session-id` / `prompt_cache_key` 不原样上送，每个账号看到的是以该账号为密钥的 HMAC。即使会话被改派，两个账号也不会出现同一个 session/thread id。
- **状态**：指纹 / lifecycle 刷新计时、会话、模型目录缓存、超时计数都按账号独立。同一账号的并发首请求只发**一组**指纹 / lifecycle 预请求。

**调度与健康**

- 按加权最少在途挑账号，平局轮转。会话粘性的键依次取：客户端会话 header → `prompt_cache_key` → `user` / Anthropic `metadata.user_id` → 模型 + system + 首条用户消息的哈希。粘性也能保住上游 prompt cache 命中。
- `429`：冷却 `Retry-After` 指定的时长，没有则 5 秒起翻倍、封顶 60 秒。`402` / `USAGE_EXCEEDED`（HTTP 状态码或流内 error 事件）：冷却 `quotaCooldownMs`。`401` / `403`：隔离。`400` 与上游 `5xx`（全服务级容量问题）不冷却账号。传输层错误连续 3 次才冷却。
- **不跨账号重放**：失败请求的错误交还给客户端，绝不换个账号重试，免得同一段对话内容同时发往两个账号。客户端自己重试时会落到健康账号上。上游闪断的透明重试（[见下文](#上游闪断重试)）留在同一账号。
- 所有账号都在冷却、且最早恢复时间超出排队预算时，直接回 `429`，`retry_after` = 最早恢复时间，不白等。

**`GET /pool/stats`**（仅 `"diagnostics": true` 时开启，`Cache-Control: no-store`）返回每个账号的 `healthy`、`inflight`、`cooldownRemainingMs`、`reason`、`quarantined`、计数器与脱敏后的代理地址。不含 key，但会暴露账号名与健康状况，请放在与 API 相同的访问控制之后。

`/v1/models` 使用某一个健康账号的模型目录（绝不把多个账号的目录合并）。

> 改配置需重启生效。以上隔离只覆盖本代理能控制的部分（标识、出口、连接），不是「不可检测」的保证：账号的使用行为、时间规律和内容仍可能把账号关联起来。

## API 接口

### `POST /v1/chat/completions`

OpenAI Chat Completions 兼容。支持流式和非流式、工具调用、多模态图片输入、推理强度。

**请求体参数：**

| 参数 | 必填 | 说明 |
|------|------|------|
| `model` | 是 | 模型 ID（见模型列表） |
| `messages` | 是 | 对话消息，支持 `system/user/assistant/tool` 角色 |
| `max_tokens` | 否 | 最大生成 token（默认 64000） |
| `stream` | 否 | 是否 SSE 流式（默认 false） |
| `temperature` | 否 | 接受但**不上送** —— CLI 的 agent 回合从不发（见 [CLI 对齐](#cli-对齐command-code1734)）|
| `reasoning_effort` | 否 | 按 CLI 能力表吸附到该模型受支持的档位；不支持思考的模型不发 |
| `tools` | 否 | 工具定义（OpenAI function calling 格式）|
| `tool_choice` | 否 | 模拟实现（从不上送）：`none` → `tools: []`；指定函数 → 只发该工具 + 系统指令；`required` → 系统指令 |
| `parallel_tool_calls` | 否 | 模拟实现（从不上送）：`false` → 系统指令「一次只调一个工具」|

**简单请求：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "hello" }],
  "stream": true
}
```

**多模态图片输入（需 vision 模型）：**
```json
{
  "model": "xiaomi/mimo-v2.5",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]
  }]
}
```

**工具调用：**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "tools": [{
    "type": "function",
    "function": { "name": "get_weather", "description": "...", "parameters": {...} }
  }],
  "tool_choice": "auto"
}
```

**流式响应（SSE）：**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考过程"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":8}}}

data: [DONE]
```

**非流式响应（含缓存命中）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "deepseek/deepseek-v4-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello!",
      "reasoning_content": "The user said hello, I should respond."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 7558,
    "completion_tokens": 42,
    "total_tokens": 7600,
    "prompt_tokens_details": { "cached_tokens": 7552 }
  }
}
```

### `POST /v1/messages`

Anthropic Messages API 兼容端点。支持流式和非流式、工具调用。

**请求体：**
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "你是一个有用的助手。",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

**Anthropic 协议差异（自动转换）：**

| 概念 | Anthropic 原始格式 | 转换说明 |
|------|-------------------|----------|
| System prompt | 顶层 `system` 字段 | 自动转为 OpenAI `system` message |
| 消息内容 | `content` 数组（text/tool_use/tool_result） | 自动映射为对应角色 |
| 工具结果 | `user` 消息中的 `tool_result` 块 | 自动转为 `role: "tool"` |
| 工具定义 | `input_schema` | 自动映射为 `parameters` |
| `tool_choice` | `{type:"auto"/"any"/"tool"}` | `any`→`required`，`tool`→function 对象 |
| 推理强度 | `thinking.budget_tokens` | 自动映射为 `reasoning_effort`（≥10000→high, ≥5000→medium, ≥2000→low） |
| 停止原因 | `end_turn`/`max_tokens`/`tool_use` | 自动映射为 `stop`/`length`/`tool_calls` |
| Token 用量 | `input_tokens`/`output_tokens` + 缓存 | 透传，缓存字段映射为 Anthropic 格式 |

**流式响应（SSE，Anthropic 格式）：**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"...","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10,"cache_read_input_tokens":0,"input_tokens":100}}

event: message_stop
data: {"type":"message_stop"}
```

**非流式响应：**
```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "deepseek/deepseek-v4-flash",
  "content": [{ "type": "text", "text": "Hello!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 7558,
    "output_tokens": 42,
    "cache_read_input_tokens": 7552,
    "cache_creation_input_tokens": null
  }
}
```

### `POST /v1/responses`

OpenAI **Responses API**（Codex、以及新版 OpenAI SDK 用的那套）。

请求侧做转译：`input`（消息数组，item 可省略 `type`）、`instructions`、`max_output_tokens`、`temperature`、`top_p`、`reasoning`、`tools`、`tool_choice` 都会映射进 CC 信封；响应按 Responses 形状返回（`object: "response"`、`output` 数组、`usage`、`status`）。流式为 SSE：
`response.created` / `response.in_progress` / `response.output_item.added|done` / `response.content_part.added|done` / `response.output_text.delta|done` / `response.reasoning_summary_text.delta|done` / `response.function_call_arguments.delta|done`，收尾是 `response.completed`（被 `max_output_tokens` 截断时为 `response.incomplete`，出错为 `response.failed`）。

- **无状态**：`previous_response_id` 不支持，传了直接 `400` —— 每轮把完整 `input` 发过来即可（代理不存会话历史）。
- 错误体是 Responses 风格：`{"error":{"message":...,"type":...}}`。
- 与 `/v1/chat/completions` 共用同一套上游调用、缓存断点与空闲看门狗。
- **首字静默与保活**：拿到上游 `200` 后**立刻**下发 `response.created` / `response.in_progress`，此后等待期间每 5s 发一条 SSE 注释行 `: keepalive`。reasoning 模型 + 大 prompt 的首字实测 15~40s，这段静默期此前**零字节出网**，会被中间层（实测 EdgeOne 源站空闲超时约 15s）或客户端首字节超时掐断 —— 现象是 nginx 侧 `499`、`body_bytes_sent=0`、客户端每 15 秒重试一次。注释行按 SSE 规范必须被客户端忽略（`/v1/messages` 用的是 `event: ping`，Responses 没有 ping 事件，塞未知 event 类型有被严格解析器判错的风险）。

```bash
curl http://127.0.0.1:3050/v1/responses \
  -H "Authorization: Bearer user_xxxxxxxxx" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","input":[{"role":"user","content":[{"type":"input_text","text":"hi"}]}]}'
```

### `GET /v1/models`

返回可用模型列表。优先从 Provider API 动态拉取（5min 缓存），失败回退硬编码列表。

### `GET /health`

健康检查。返回 `OK`。

### `GET /pool/stats`

账号池诊断；仅在账号池模式且 `"diagnostics": true` 时开启。见[账号池](#账号池poolconfig--cc_pool_config)。

## 错误码

代理自己产生的：

| HTTP | 场景 |
|------|------|
| `400` | 请求体不是合法 JSON、`input` 为空、用了不支持的 `previous_response_id` |
| `401` | 缺 API Key / 格式不对（Key 必须以 `user_` 开头；通过 `Authorization: Bearer` 或 `x-api-key` 传入）|
| `404` | 路径不存在 |
| `413` | 请求体超过 `CC_MAX_BODY_MB`（连接保持可排空，不会直接 reset）|
| `429` | 零输出 token、流空闲超时（30s 流式 / 90s 非流式）、或上游限流映射 —— 都带 `Retry-After`，SDK 自动退避重试；连续 3 次超时后提示压缩上下文 |
| `502` | CC 上游错误（`fetch failed` 这类连接层失败也走这里）|
| `503` | 开了 `CC_MAX_INFLIGHT` 且超过在途上限（`type: server_busy`）|

上游 CC 状态码的映射（`CC_STATUS_MAP`，未列出的按 `502 upstream_error`）：

| 上游 | 下游 |
|------|------|
| `400` → `400 invalid_request_error` | `401` → `401 authentication_error` |
| `402` → `429 rate_limit_error`（付费失败按限流处理）| `403` → `401 authentication_error` |
| `404` → `404 not_found` | `422` → `400 invalid_request_error` |
| `429` → `429 rate_limit_error`（带 `retry_after: 30`）| `500` / `502` → `502 upstream_error` |
| `503` → `503 temporarily_unavailable` | 其它 → `502 upstream_error` |

上游错误体里的机器可读分类（`error.code`，如 `BAD_REQUEST` / `USAGE_EXCEEDED`）会透传到下游错误体的 `error.code`。

## 模型列表

代理访问 `GET /v1/models` 会返回实时模型列表。以下为常见模型参考，完整列表以实际接口返回为准——各模型套餐可参考 [Command Code Pricing](https://commandcode.ai/docs/resources/pricing-limits)。

### 常用模型

| 模型 ID | 提供商 |
|---------|--------|
| `claude-sonnet-4-6` / `claude-opus-4-8` / `claude-opus-4-7` / `claude-haiku-4-5-20251001` | Anthropic |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` | OpenAI |
| `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash` | DeepSeek |
| `moonshotai/Kimi-K2.6` / `moonshotai/Kimi-K2.5` | Kimi |
| `zai-org/GLM-5.1` / `zai-org/GLM-5` | GLM |
| `MiniMaxAI/MiniMax-M3` / `MiniMaxAI/MiniMax-M2.7` / `MiniMaxAI/MiniMax-M2.5` | MiniMax |
| `Qwen/Qwen3.7-Max` / `Qwen/Qwen3.6-Max-Preview` / `Qwen/Qwen3.6-Plus` | Qwen |
| `stepfun/Step-3.7-Flash` / `stepfun/Step-3.5-Flash` | Step |
| `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5` | Xiaomi（**支持图片输入**） |
| `google/gemini-3.5-flash` / `google/gemini-3.1-flash-lite` | Gemini |

> ⚠️ 部分模型（如 `deepseek-v4-flash`、`claude-sonnet-4-6`）不支持图片输入。如需多模态请用 `xiaomi/mimo-v2.5`、`Kimi-K2.5` 等 vision 模型。

## 接入示例

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050/v1",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL
```bash
curl http://127.0.0.1:3050/v1/chat/completions \
  -H "Authorization: Bearer user_xxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

### Cursor
在 Cursor 设置中添加 Custom Provider：
- **API Base URL**: `http://127.0.0.1:3050/v1`
- **API Key**: `user_xxxxxxxxx`
- **Model**: 从模型列表中选择

### Anthropic (Python SDK)
```python
import anthropic

client = anthropic.Anthropic(
    api_key="user_xxxxxxxxx",
    base_url="http://127.0.0.1:3050",
)
message = client.messages.create(
    model="deepseek/deepseek-v4-flash",
    max_tokens=1000,
    system="You are helpful.",
    messages=[{"role": "user", "content": "hello"}],
)
print(message.content[0].text)
```

Anthropic SDK 通过 `x-api-key` 头鉴权——代理已原生支持（无需 `Authorization` 头）。

### OpenCode
```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3050/v1",
  "apiKey": "user_xxxxxxxxx"
}
```

## 反检测

基于对官方 CLI 网络流量的分析（版本号从 npm registry 动态拉取），实现了以下兼容适配：

| 机制 | 实现 |
|------|------|
| **设备指纹** | 每个 Key 首次请求前发送 `POST /alpha/fingerprint/record`；信号值（Windows MachineGuid 形状、真实形状的 MAC、`DESKTOP-xxxxxx` 主机名）由 API key **确定性派生**，并按 CLI 的算法哈希 —— 同一个 key 永远报告同一台设备：重启、内存回收、多实例都一致（用 `CC_FINGERPRINT_SALT` 成批换身份）|
| **生命周期声明** | Key 初始化时与指纹并行发送 `POST /alpha/lifecycle-events`（`cli_session_exists`，metadata `{sessionId, cliVersion, mode, os}`，`sessionId` = `sess_` + UUIDv4 去横线前 16 位）|
| **会话开始** | `GET /alpha/whoami`，再 `GET /alpha/billing/subscriptions?orgId=` + `/alpha/billing/credits?orgId=` —— CLI 的 billing 预取，头与 generate 相同 |
| **按 Key 分 Session** | 每个 API Key 独立 session，12h 过期 + 1h 随机抖动 |
| **协议版本号** | `x-command-code-version` 报**实际实现的协议版本**（当前 `1.73.4`）；npm 上有新版本只打**漂移告警**，不会静默改版本号 |
| **CLI 信封格式** | 键序 `config / memory / taste / skills / permissionMode / threadId / mode / promptCache / params`；agent 回合不带 `mode` 与 `promptCache` |
| **OpenTelemetry** | `traceparent` (W3C Trace Context) |
| **请求头** | 键、顺序、大小写与 CLI 一致，包括它的怪癖 `content-type: application/json, application/json`（传输层与鉴权头各设一次）；generate / 指纹 / lifecycle 都带 `User-Agent: cli`；`x-taste-learning: "false"`（可配）|
| **传输** | 与 CLI 一样全程用原生 `fetch`（undici）—— 池账号也是，各用自己的 undici `Agent` —— 默认头（`accept`、`accept-encoding`、`sec-fetch-mode` …）一致 |
| **Project Slug** | `x-project-slug` = `slugify(DEVICE_PROFILE.projectDir)`，与 `config.workingDir` 同源（默认 `C:\Users\dev\projects\app`，用 `CC_DEVICE_PROJECT_DIR` 改）|
| **设备档案单一真源** | 指纹 / `config.environment` / `config.workingDir` / `x-project-slug` / lifecycle 的 `os` 共用同一份 `DEVICE_PROFILE`（`win32` / `x64`）—— 既不会自相矛盾（"指纹说 win32、环境说 linux"），也不把宿主真实平台、Node 版本、cwd 交给上游 |
| **思考强度** | 按 CLI 1.73.4 能力表：只对支持思考的模型发送，并吸附到受支持的档位 |
| **API Key 格式验证** | 对 `Authorization: Bearer` 或 `x-api-key` 用正则 `user_[a-zA-Z0-9_-]+` 提取，自动清理多余路径/前缀，`sk-xxx` 等非 `user_` 格式拒 |
| **流式超时保护** | 流式 30s、非流式 90s → 429 + SDK 自动重试 |
| **连续超时阈值** | 连续 3 次超时后才提示压缩上下文 |
| **零输出防护** | outputTokens=0 → 429 `rate_limit_error`（SDK 自动重试，反异常计费） |
| **上游中止** | 客户端断连 + 全部错误路径 `AbortController` 打断 CC |
| **隐私保护日志** | 日志不含 API Key 片段、错误 body、stack trace |

## 协议细节

### CC API 请求体结构

```json
{
  "config": {
    "workingDir": "C:\\project",
    "date": "2026-06-07",
    "environment": "win32",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "threadId": "8c0e…-uuid",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "tools": [],
    "system": [{ "type": "text", "text": "…" }],
    "max_tokens": 64000,
    "stream": true,
    "reasoning_effort": "max"
  }
}
```

`config.environment` / `config.workingDir` 都取自 `DEVICE_PROFILE`（不是宿主真实值），`skills` 发 `null`（不是空串）。

`params` 键序与 CLI 一致。`tools` 总是存在（没有工具时为 `[]`）。`reasoning_effort` 只在模型支持思考时发送。`temperature`、`tool_choice`、`parallel_tool_calls` 从不发送。给了 `prompt_cache_key` 时，缓存断点落在 system 最后一块 —— 这也是 CLI 唯一会发 `cache_control` 的位置。

### CLI 对齐（`command-code@1.73.4`）

**上行**（发往 `/alpha/generate` 的内容），对齐 `createModelClient` / `toWireMessages`：

- **消息**：user 部件只有 `{type:"text"}` / `{type:"image", image, mimeType}`，客户端附带的消息级 `cache_control` 等字段会被丢掉。同一回合的全部工具结果合成**一条** `role:"tool"` 消息，工具输出取文本块并用 `\n` 拼接。assistant 部件为 `reasoning`、`text`、`tool-call`。
- **工具名**：`tool_search` 上送为 `search_tools`（CLI 唯一的重写），工具定义与历史都改，响应里再改回 `tool_search`。客户端两个名字都定义了时不重写。
- **CLI 从不发的客户端控制项**，用 CLI 本身会发的结构模拟：
  - `tool_choice: "none"` → `tools: []`
  - 强制某函数 → 只发该工具 + 系统指令
  - `required` → 系统指令
  - `parallel_tool_calls: false` → 系统指令
  - `temperature` 在 CLI 里没有等价物，直接丢弃。
- **能力**：`reasoning_effort` 按 CLI 内置能力表处理。例如 DeepSeek V4 接受 `off/high/max`，Claude 接受 `low…max`，Kimi K2.6 不接受。OpenAI 的 `minimal`/`none` 映射为 `low`/`off`。CLI 不认识的模型不发档位。纯文本模型（DeepSeek V4、GLM-5.x 等）的图片按 CLI 的 `stripImages` 处理：最后一条带图消息里的图换成带序号的 `<attached_image>` 标记，更早的图去掉。

**下行**（流事件的整形），对齐 `consumeStream`：

- 服务端执行的工具调用（`providerExecuted: true`）与 `tool-result` 事件不会当作客户端工具调用转出。
- `abort` 视为正常结束，`cache-write-tokens` 忽略。
- 工具调用输入按 CLI 的 `coerceToolInput` 修整：单元素数组解包、JSON 字符串解析、裸字符串包进唯一的必填字段。
- 流内 `error` 事件兼容裸字符串，以及 CLI 的内嵌形态 `429 {"error":{…}}`。
- `premium_credits_exhausted` / `insufficient credits` 视为不可重试的额度错误（`429`，`code: INSUFFICIENT_CREDITS`；池账号会冷却）。`model_not_in_plan` 视为 `400`。

**有意不照搬**：

- CLI 会自己重试 408/429/5xx（最多 10 次），输出中途断流也会重启。代理只在首字节之前重试传输层失败，其余交给客户端与账号池。
- CLI 遇到 `pause_turn` 会重发请求（最多 5 次），代理按「不完整」上报。
- `config.structure` 发 `[]`（空项目目录），而不是真实的目录列表。

### CC API 图片消息格式

CLI 发送图片的格式：

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "data:image/jpeg;base64,..." },
    { "type": "text", "text": "图里写了什么" }
  ]
}
```

代理收到 OpenAI `image_url` 格式后自动转为上述 CC 格式透传。

## Docker 部署

### 从 GHCR 拉取

GitHub Actions 会把多架构镜像（`linux/amd64` + `linux/arm64`）推到 GitHub Container Registry：

| 标签 | 来源 | 说明 |
|------|------|------|
| `:release` | `release` 分支 | 跟随发布分支 |
| `:latest` | `release` 分支 或 `v*` tag | 与 `:release` 同一个 digest。**"只在打 tag 时更新"是已修掉的旧行为** —— 它曾让用 `:latest` 的人长期停在旧版本、新端点表现为 404（[#28](https://github.com/MAXeaglet/commandcode-proxy/issues/28)）|

```bash
docker pull ghcr.io/maxeaglet/commandcode-proxy:release
docker run -d --name cc-proxy -p 3050:3050 -e PORT=3050 ghcr.io/maxeaglet/commandcode-proxy:release
```

镜像为公共可见，拉取无需登录。升级后请确认 digest 真的变了（`docker inspect --format '{{index .RepoDigests 0}}'`），别假设本地缓存就是新版本。

### 快速启动 (docker compose)

```bash
docker compose up -d
```

代理将在 `http://0.0.0.0:3050` 监听。通过 `PROXY_PORT` 自定义主机端口：

```bash
PROXY_PORT=13050 docker compose up -d
```

### 从源码构建

```bash
docker build -t commandcode-proxy:latest .
docker run -d -p 3050:3050 -e PORT=3050 commandcode-proxy:latest
```

### 多架构构建

```bash
npm run docker:build:multi
```

### 环境变量

容器相关的只有两个，其余全部见上面的[环境变量](#环境变量)总表：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3050` | 容器内监听端口 |
| `PROXY_PORT` | `3050` | 主机映射端口（仅 compose） |

## 在途请求上限（可选）

**默认关闭**（`CC_MAX_INFLIGHT` 未设置 = 不限制并发），既有行为不变。

本项目定位是**纯反代层**，并发控制属于下游 —— 按 IP / 按 key 的限流请用反向代理（见[内存与部署](#内存与部署)里的 `limit_conn`）。
本项**不是**那套方案的替代品，只为「不挂反代裸跑」（Dockerfile 与 `npm start` 都支持这种用法）提供一个**进程内、仅全局**的兜底：

```bash
CC_MAX_INFLIGHT=32 npm start    # 最多同时处理 32 个请求
```

超限时快速返回 `503` + `Retry-After: 5` + `type: server_busy` —— OpenAI / Anthropic 官方 SDK 认得这个组合会自动退避重试，而不是拿到连接被重置。`/health` 与 `/` 不计入、也不受限制，避免探活与编排器因业务繁忙收到 503。

**为什么需要它**：内存 = `在途数 × (0.13MB + 5.5 × body_MB)`。`CC_MAX_BODY_MB` 只管住**单请求**量级，乘数无人管 —— 默认 100MB 时 N 个并发最坏可达 N × 550MB。

> ⚠️ 开启本项**不等于**内存安全：32 × 550MB 仍远超小机器容量。要拿到硬性上界，需**同时**下调 `CC_MAX_BODY_MB`。

## 上游空闲超时

两个上游读空闲看门狗，超时后返回 `429`（带 `retry_after`）让 SDK 自动重试：

| 环境变量 | 默认 | 作用于 |
|---|---|---|
| `CC_STREAM_IDLE_MS` | `30000` | 流式请求 |
| `CC_NONSTREAM_IDLE_MS` | `90000` | 非流式请求 |

**语义**：只计「`reader.read()` 的等待时间」，每收到一个 chunk 就重置 —— **不是整个请求的总时长**。
只要上游在持续吐流就不会触发，哪怕单个请求已经跑了几十分钟。

**默认值与官方 CLI 不一致，这是已知取舍**（[#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)）：
官方 CLI 对上游**没有任何** idle timeout —— 反编译 `command-code@1.50.0` 可见所有 `createApiClient({ baseUrl })` 调用点都未传 `timeout`，实测 700+ 秒的停顿可正常完成。
本代理保留 30s 是为了兜住真正死掉的连接；代价是**推理模型的长思考停顿可能被误杀**。

若遇到「`429 Response timeout`」「`zero output tokens`」且日志里 `elapsedMs ≈ 30000`、`bytesReceived = 0`，
说明是看门狗误杀了 prefill / 首 token 阶段的正常停顿 —— 调大即可：

```bash
CC_STREAM_IDLE_MS=300000 npm start      # 5 分钟
```

> ⚠️ 误杀的成本不止一次失败：被 abort 后返回 `429 + retry_after`，SDK 会自动重试，
> 而重试等于**完整重发整个上下文**，长会话下每次误杀都要重付一次全量 prefill。

## 上游闪断重试

CC 上游在高峰期会中途掐断连接（对端 RST/FIN），undici 抛 `TypeError: terminated`；改动前这类闪断会原样回给下游
`502 {"error":{"message":"Upstream error: terminated","type":"proxy_error"}}`。

只要**此刻尚未向下游写出任何字节**，这个请求对下游而言从未开始过 —— 代理内部重试即可消化掉抖动，
下游（CPA / 客户端）不必先吃一个 502 再自己重试（那等于完整重发整个上下文）。

- **重试条件（需同时满足）**：① 上游没走完 —— 传输层闪断（`terminated` / `ECONNRESET` / `ECONNREFUSED` /
  `EPIPE` / `ETIMEDOUT` / `UND_ERR_SOCKET` / `socket hang up` / `other side closed` / `fetch failed`），
  或对端**干净收尾但整条流里没有 finish 事件**（FIN 截断，与 RST 同类）；
  ② 尚未向下游写出任何字节（流式看是否已写出 header / 事件，非流式看 `headersSent`）；
  ③ 客户端没断连；④ 未达重试上限。
- 一旦已经向下游写过头或事件，**绝不重试**：语义已提交，重试只会让下游看到重复文本。
- `STREAM_IDLE_TIMEOUT`（`429`「请减少上下文」）是刻意传给下游的信号，**不重试**。
- 已解析到上游 `error` 事件（`429` / `503` 等）时**不重试**：连接随后再断，也优先把这条语义错误透出，
  而不是用传输层错误覆盖成 `502`（把「上游容量不足」说成「代理挂了」是误导）。
- 退避期间客户端断连 → 放弃重试（下游已经走了，再打一次上游只是白烧额度）。
- 重试对下游完全透明：下游只看到一次 200（内容来自重试成功的那一次）。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CC_UPSTREAM_RETRY_MAX` | `2` | 最大重试次数（共 3 次尝试）；`0` = 关闭本行为 |
| `CC_UPSTREAM_RETRY_BASE_MS` | `400` | 退避基数（毫秒），实际退避 = base × 尝试序号 |

日志里可复盘：`Upstream stream terminated before first byte - retrying` / `Upstream error before first byte - retrying` /
`Upstream stream ended incomplete before first byte - retrying`（发生了一次重试，`attempt` / `maxAttempts` / `cause`
或 `reason` 都在结构体里）、`Upstream retry recovered`（重试后**确实**交付了正常响应）、
`Upstream retry abandoned (client disconnected during backoff)`（退避期间客户端走了，放弃重试）；
启动横幅的 `upstreamRetry` 字段可直接确认生效值。

```bash
CC_UPSTREAM_RETRY_MAX=0 npm start        # 关闭重试，行为退回改动前
CC_UPSTREAM_RETRY_BASE_MS=800 npm start  # 退避拉长（默认 400ms）
```

> **覆盖范围**：目前 `/v1/chat/completions` 的流式与非流式两条路径都接了重试循环；
> `/v1/messages` 与 `/v1/responses` 结构不同，未在本次改动中覆盖（闪断仍按原样报错）。

## 内存与部署

> 数据来自 [issue #20](https://github.com/MAXeaglet/commandcode-proxy/issues/20) 的实测复现（Node v24，loopback mock 上游）。

单请求内存开销的经验公式：

```
RSS ≈ 70 MB + 在途请求数 × (0.13 MB + 5.5 × body_MB)
```

### 流式响应已做背压

`res.write()` 返回 `false`（socket 写缓冲超过 `highWaterMark`）时会暂停读取上游，响应不再在内存中无界堆积：

| 场景（200MB 上游流，客户端发完请求即停止读取） | 峰值 RSS 增量 |
|---|---|
| 修复前 | **+586 MB**（66 → 652 MB）|
| 修复后 | **+4 MB**（背压一路传回上游，上游只吐出 ~8MB 即停住）|

这不只是恶意客户端问题 —— 弱网/移动端、客户端卡在工具执行、客户端已放弃但 TCP 还没发 RST，都会触发。

### 请求体放大 ~5.5×

body 在转发到上游前同时存在多份副本：`chunks[]` / `Buffer.concat` / utf8 字符串 / `JSON.parse` 对象树 / `buildCcRequest` 重建对象树 / `JSON.stringify` 序列化体。

| body | 上限 | 峰值增量 | 结果 |
|---|---|---|---|
| 7 MB | 100 MB | +52 MB（7.4×）| 200 |
| 20 MB | 100 MB | +116 MB（5.8×）| 200 |
| 20 MB | 8 MB | +21 MB（1.05×）| **413** |

启动时若隐含最坏峰值 ≥ 500MB，日志会输出 `warn` 提示。上限是**按请求**的，proxy 自身没有在途限流 —— 公网部署必须在反向代理层补上。

### nginx 反代建议

`client_max_body_size` 在 nginx 拒绝时，body 根本不会进入 Node 进程：

```nginx
map $http_authorization $cc_key { default $http_authorization; "" $http_x_api_key; }
map "" $cc_global_key { default "global"; }

limit_conn_zone $binary_remote_addr zone=cc_ip:10m;
limit_conn_zone $cc_key             zone=cc_key:10m;
limit_conn_zone $cc_global_key      zone=cc_global:10m;

location /v1/ {
    client_max_body_size 4m;   # 需 <= CC_MAX_BODY_MB
    limit_conn cc_ip     8;
    limit_conn cc_key    4;
    limit_conn cc_global 32;   # 这一项就是内存天花板
    limit_conn_status 429;
    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;   # 需大于 30s 的流空闲超时
}
```

> ⚠️ **keep-alive 时序**：上面 `proxy_set_header Connection ""` 让 nginx 与后端保持长连接，此时反代侧的
> `upstream { keepalive_timeout ...; }` 必须**小于**后端的 `CC_KEEPALIVE_TIMEOUT_MS`（默认 65s）。反了的话，
> 反代会复用一条后端已经 FIN 掉的连接去写 POST 请求体，吃 `EPIPE`（nginx 日志里是 `sendfile() failed (32: Broken pipe)`）；
> 而 POST 非幂等、nginx 默认不重试 —— 客户端直接拿到 502。

### 僵死连接（既不读也不断开）

背压生效后，客户端**既不读也不断开**时该请求会连带上游连接一直挂着。实测残留在途成本：

| 僵死连接数 | RSS 增量 | 上游连接持有 |
|---|---|---|
| 1 | +5 MB | 1 |
| 10 | +45 MB | 10 |
| 50 | +248 MB | 50（**永久持有**）|

特性是**有界、不泄漏、客户端断开即回收**（RSS 曲线完全持平），但**连接数本身无上限**。

默认**不处理**，因为僵死客户端与「卡在工具执行的合法客户端」在协议层无法区分；且官方 CLI 对上游没有任何 idle timeout（见 [#19](https://github.com/MAXeaglet/commandcode-proxy/issues/19)），贸然加超时会重蹈「误杀健康请求」。

需要封顶时启用（opt-in）：

```bash
# 下游持续阻塞超过 60s 才断开，正常客户端只要在推进 drain 就不会触发
CC_CLIENT_DRAIN_TIMEOUT_MS=60000 npm start
```

启用后实测（50 个僵死连接）：上游连接持有数由 **50（永久）→ 0**，且丢弃后**不会**继续抽干上游。

更稳妥的封顶仍在反向代理层（`limit_conn`），因为只有它知道该部署能承受多少并发。

### 其它注意事项

- **`logFile` 是同步写**（`appendFileSync`），公网负载下会阻塞事件循环 —— 建议保持留空，从 stdout 收集。
- **systemd 兜底**：配 `MemoryMax=` 与 `NODE_OPTIONS=--max-old-space-size=`，让超限杀掉 proxy 而不是 `sshd`/`nginx`。
- **多账号 + 多实例**：`sessionStore` / `keyStateStore` 是进程内 `Map`。同一个 API key 打到两个实例会得到两个不同 session 与**两个不同设备指纹**，上游会看到「一个账号在多台机器上」。横向扩展请按 API key 做一致性哈希（`hash $cc_key consistent`），不要轮询。

## 免责声明

本项目仅供**学习和研究**使用。

- **非官方**：本项目与 Command Code 无任何关联，非官方产品。
- **个人使用**：使用者应自行承担所有责任。请遵守 [Command Code 服务条款](https://commandcode.ai/tos)。
- **API Key**：本项目不会收集、上传或泄露你的 API Key。Key 通过每次请求的 `Authorization: Bearer <key>` 或 `x-api-key` 头传入，日志中不记录；`config.json` 中的可选 `apiKey` 字段仅作本地兜底，不会离开你的机器。
- **合规性**：协议基于对本地 CLI 网络流量的被动观察，未对服务端进行任何未授权访问、破解或篡改。
- **账号风险**：建议和正常 CLI 使用频率保持一致，超高并发调用可能触发风控。

---

[Linux.do](https://linux.do)

## 开发

```bash
# 带 watch 模式启动（文件修改自动重启）
npm run dev
```
