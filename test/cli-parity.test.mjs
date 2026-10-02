// 线上字节对齐 command-code@1.73.4：请求头（含顺序与 content-type 合并）、信封与 params 键序、
// CLI 从不发的字段（temperature / tool_choice / parallel_tool_calls）的模拟、工具名重写与回写、
// 上游事件整形（providerExecuted / tool-result / abort / 字符串 error）、思考档位吸附、纯文本模型去图、
// 以及启动请求序列（lifecycle / fingerprint / whoami + billing）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocPort, closeServer, startProxy } from './helpers.mjs';

const KEY = 'user_paritykeyaaaa';
const AUTH = { Authorization: `Bearer ${KEY}` };
const OK = [
  '{"type":"text-delta","text":"ok"}',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2}}',
];

/** 记录 rawHeaders（保留顺序与大小写）的上游；generate 的回包可按调用序编排。 */
async function startWire(script = () => OK) {
  const port = await allocPort();
  const seen = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, rawHeaders: req.rawHeaders, headers: req.headers, raw });
      if (req.url === '/alpha/whoami') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"user":{"id":"u1"},"org":{"id":"org_123"}}'); return; }
      if (req.url !== '/alpha/generate') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      const lines = script(++n, JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const l of lines) res.write(l + '\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    port, seen,
    generates: () => seen.filter(s => s.url === '/alpha/generate'),
    lastBody: () => JSON.parse(seen.filter(s => s.url === '/alpha/generate').pop().raw),
    close: () => closeServer(server),
  };
}

const headerNames = (raw) => raw.filter((_, i) => i % 2 === 0);
const chat = (extra = {}) => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], ...extra });

test('generate：请求头逐键对齐 CLI（顺序、content-type 合并成两份、taste=false、undici 默认头），信封无 mode', async () => {
  const up = await startWire();
  const proxy = await startProxy({ upstreamPort: up.port });
  try {
    const r = await proxy.post('/v1/chat/completions', chat({ temperature: 0.2 }), AUTH);
    assert.equal(r.status, 200);
    const g = up.generates()[0];
    const names = headerNames(g.rawHeaders);
    const order = ['content-type', 'User-Agent', 'x-command-code-version', 'x-cli-environment', 'x-project-slug',
      'x-taste-learning', 'x-session-id', 'Authorization', 'traceparent'];
    const idx = order.map(n => names.indexOf(n));
    assert.ok(idx.every(i => i >= 0), `missing headers: ${names.join(',')}`);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, `header order: ${names.join(',')}`);
    assert.equal(g.headers['content-type'], 'application/json, application/json');
    assert.equal(g.headers['user-agent'], 'cli');
    assert.equal(g.headers['x-command-code-version'], '1.73.4');
    assert.equal(g.headers['x-taste-learning'], 'false');
    for (const h of ['accept', 'accept-language', 'sec-fetch-mode', 'accept-encoding']) assert.ok(g.headers[h], `undici default ${h}`);
    assert.match(g.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const body = JSON.parse(g.raw);
    assert.deepEqual(Object.keys(body), ['config', 'memory', 'taste', 'skills', 'permissionMode', 'threadId', 'params']);
    assert.equal(body.threadId, g.headers['x-session-id']);
    assert.deepEqual(Object.keys(body.params), ['model', 'messages', 'tools', 'system', 'max_tokens', 'stream']);
    assert.deepEqual(body.params.tools, []);
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('tool_choice / parallel_tool_calls / temperature 从不上送：none → tools []，指定函数 → 只发该工具 + 指令，required / 并行关 → 指令', async () => {
  const up = await startWire();
  const proxy = await startProxy({ upstreamPort: up.port });
  const tools = [
    { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } } },
  ];
  try {
    const send = async (extra) => {
      assert.equal((await proxy.post('/v1/chat/completions', chat({ tools, temperature: 0, ...extra }), AUTH)).status, 200);
      const p = up.lastBody().params;
      for (const k of ['temperature', 'tool_choice', 'parallel_tool_calls']) assert.ok(!(k in p), `${k} must not be sent`);
      return p;
    };
    let p = await send({ tool_choice: 'none' });
    assert.deepEqual(p.tools, []);

    p = await send({ tool_choice: { type: 'function', function: { name: 'b' } } });
    assert.deepEqual(p.tools.map(t => t.name), ['b']);
    assert.match(p.system.at(-1).text, /must call the `b` tool/);

    p = await send({ tool_choice: 'required', parallel_tool_calls: false });
    assert.deepEqual(p.tools.map(t => t.name), ['a', 'b']);
    assert.deepEqual(Object.keys(p.tools[0]), ['name', 'description', 'input_schema']);
    assert.match(p.system.at(-1).text, /must call at least one/);
    assert.match(p.system.at(-1).text, /at most one tool/);

    p = await send({});
    assert.equal(p.system[0].text, ' ', 'no directive and no client system → placeholder only');
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('消息形态：同一回合的工具结果合成一条 tool 消息；tool_search ↔ search_tools 双向重写；user 部件只留 CLI 认的字段', async () => {
  const up = await startWire(() => [
    '{"type":"tool-call","toolCallId":"c9","toolName":"search_tools","input":"{\\"query\\":\\"x\\"}"}',
    '{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":5,"outputTokens":2}}',
  ]);
  const proxy = await startProxy({ upstreamPort: up.port });
  try {
    const r = await proxy.post('/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      tools: [{ type: 'function', function: { name: 'tool_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'tool_search', arguments: '{"query":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'other', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'r2' }, { type: 'text', text: 'r3' }] },
        { role: 'user', content: 'next' },
      ],
    }, AUTH);
    const out = await r.json();
    assert.equal(r.status, 200, JSON.stringify(out));
    const call = out.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'tool_search', 'wire alias must be mapped back to the client name');
    assert.deepEqual(JSON.parse(call.function.arguments), { query: 'x' });

    const p = up.lastBody().params;
    assert.deepEqual(p.tools.map(t => t.name), ['search_tools']);
    assert.deepEqual(p.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
    assert.deepEqual(p.messages[0].content, [{ type: 'text', text: 'go' }]);
    assert.equal(p.messages[1].content[0].toolName, 'search_tools');
    assert.deepEqual(p.messages[2].content.map(c => [c.toolCallId, c.toolName, c.output.value]),
      [['c1', 'search_tools', 'r1'], ['c2', 'other', 'r2\nr3']]);
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('上游事件整形：服务端执行的工具调用与 tool-result 不外泄；abort 视为正常结束；字符串 error 与内嵌状态码', async () => {
  let mode = 'server-tool';
  const up = await startWire(() => {
    if (mode === 'server-tool') return [
      '{"type":"tool-call","toolCallId":"s1","toolName":"web_search","input":{"q":"x"},"providerExecuted":true}',
      '{"type":"tool-result","toolCallId":"s1","toolName":"web_search","output":"results","providerExecuted":true}',
      '{"type":"text-delta","text":"answer"}',
      '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":2,"inputTokenDetails":{"cacheReadTokens":4}}}',
    ];
    if (mode === 'abort') return ['{"type":"text-delta","text":"partial"}', '{"type":"abort"}'];
    if (mode === 'string-error') return ['{"type":"error","error":"premium_credits_exhausted: out of credits"}'];
    return ['{"type":"error","error":{"message":"429 {\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"slow down\\"}}"}}'];
  });
  const proxy = await startProxy({ upstreamPort: up.port });
  try {
    let r = await proxy.post('/v1/chat/completions', chat(), AUTH);
    let out = await r.json();
    assert.equal(r.status, 200);
    assert.equal(out.choices[0].message.content, 'answer');
    assert.equal(out.choices[0].message.tool_calls, undefined);
    assert.equal(out.usage.prompt_tokens_details.cached_tokens, 4);

    mode = 'abort';
    r = await proxy.post('/v1/chat/completions', chat({ stream: true }), AUTH);
    const sse = await r.text();
    assert.match(sse, /"content":"partial"/);
    assert.doesNotMatch(sse, /no finish event/);

    mode = 'string-error';
    r = await proxy.post('/v1/chat/completions', chat(), AUTH);
    out = await r.json();
    assert.equal(r.status, 429);
    assert.match(out.error.message, /premium_credits_exhausted/);
    assert.equal(out.error.code, 'INSUFFICIENT_CREDITS');

    mode = 'embedded';
    r = await proxy.post('/v1/chat/completions', chat(), AUTH);
    out = await r.json();
    assert.equal(r.status, 429);
    assert.equal(out.error.message, 'rate_limit_error: slow down');
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('reasoning_effort 按 CLI 能力表：吸附到模型受支持档位；不支持思考 / 未知模型不发', async () => {
  const up = await startWire();
  const proxy = await startProxy({ upstreamPort: up.port });
  const effortFor = async (model, reasoning_effort) => {
    assert.equal((await proxy.post('/v1/chat/completions', chat({ model, reasoning_effort }), AUTH)).status, 200);
    return up.lastBody().params.reasoning_effort;
  };
  try {
    assert.equal(await effortFor('claude-sonnet-4-6', 'high'), 'high');
    assert.equal(await effortFor('claude-sonnet-4-6', 'minimal'), 'low');
    assert.equal(await effortFor('deepseek/deepseek-v4-flash', 'medium'), 'high');
    assert.equal(await effortFor('deepseek/deepseek-v4-flash', 'none'), 'off');
    assert.equal(await effortFor('gpt-5.4-mini', 'max'), 'high');
    assert.equal(await effortFor('moonshotai/Kimi-K2.6', 'high'), undefined);
    assert.equal(await effortFor('some/unknown-model', 'high'), undefined);
    // 别名 / 日期后缀照 CLI 的 canonicalizeModelId 归一
    assert.equal(await effortFor('claude-opus-4-6', 'xhigh'), 'xhigh');
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('纯文本模型：最后一条带图消息的图换成 CLI 的 visionMarker，更早的图去掉；视觉模型原样保留', async () => {
  const up = await startWire();
  const proxy = await startProxy({ upstreamPort: up.port });
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
  const messages = [
    { role: 'user', content: [img] },
    { role: 'assistant', content: 'seen' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, img, img] },
  ];
  try {
    assert.equal((await proxy.post('/v1/chat/completions', { model: 'deepseek/deepseek-v4-flash', messages }, AUTH)).status, 200);
    let m = up.lastBody().params.messages;
    assert.deepEqual(m[0].content, [{ type: 'text', text: '[image omitted: the active model is text-only]' }]);
    assert.equal(m[2].content[0].text, 'look');
    assert.match(m[2].content[1].text, /^<attached_image index="1">/);
    assert.match(m[2].content[2].text, /^<attached_image index="2">/);

    assert.equal((await proxy.post('/v1/chat/completions', { model: 'claude-sonnet-4-6', messages }, AUTH)).status, 200);
    m = up.lastBody().params.messages;
    assert.deepEqual(m[0].content, [{ type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }]);
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('启动序列：lifecycle（content-type ×2、UA cli、sess_ 形态）、fingerprint（UA cli）、whoami → billing（带 orgId，头同 generate）', async () => {
  const up = await startWire();
  const proxy = await startProxy({ upstreamPort: up.port });
  try {
    assert.equal((await proxy.post('/v1/chat/completions', chat(), AUTH)).status, 200);
    const by = (u) => up.seen.find(s => s.url === u);
    const lc = by('/alpha/lifecycle-events');
    assert.equal(lc.headers['content-type'], 'application/json, application/json');
    assert.equal(lc.headers['user-agent'], 'cli');
    assert.equal(lc.headers.traceparent, undefined);
    const meta = JSON.parse(lc.raw).metadata;
    assert.match(meta.sessionId, /^sess_[0-9a-f]{12}4[0-9a-f]{3}$/);
    assert.equal(meta.cliVersion, '1.73.4');

    const fp = by('/alpha/fingerprint/record');
    assert.equal(fp.headers['content-type'], 'application/json');
    assert.equal(fp.headers['user-agent'], 'cli');
    assert.deepEqual(Object.keys(JSON.parse(fp.raw)), ['thumbmark', 'components']);

    const who = by('/alpha/whoami');
    assert.equal(who.method, 'GET');
    assert.equal(who.headers['x-session-id'], up.generates()[0].headers['x-session-id']);
    assert.ok(by('/alpha/billing/subscriptions?orgId=org_123'));
    assert.ok(by('/alpha/billing/credits?orgId=org_123'));
    assert.ok(!up.seen.some(s => s.url.startsWith('/provider/')), 'CLI never calls /provider/v1/models');
  } finally {
    await proxy.kill(); await up.close();
  }
});

test('账号池走同一套 undici 传输：池账号的 generate 头与透传完全同形', async () => {
  const up = await startWire();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-parity-'));
  const cfg = join(dir, 'pool.json');
  writeFileSync(cfg, JSON.stringify({ accounts: [{ name: 'a', apiKey: 'user_poolparityaa' }] }));
  chmodSync(cfg, 0o600);
  const proxy = await startProxy({ upstreamPort: up.port, env: { CC_POOL_CONFIG: cfg } });
  try {
    assert.equal((await proxy.post('/v1/chat/completions', chat())).status, 200);
    assert.equal((await proxy.post('/v1/chat/completions', chat(), AUTH)).status, 200);
    const [pooled, passthrough] = up.generates();
    const strip = (names) => names.filter(n => n !== 'host' && n !== 'content-length');
    assert.deepEqual(strip(headerNames(pooled.rawHeaders)), strip(headerNames(passthrough.rawHeaders)));
    assert.equal(pooled.headers['content-type'], 'application/json, application/json');
  } finally {
    await proxy.kill(); await up.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
