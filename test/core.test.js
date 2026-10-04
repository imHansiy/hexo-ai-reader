'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { annotate, articleKey, cacheHash, stripReader } = require('../lib/source');
const { resolveConfig, assertLiveConfig } = require('../lib/config');
const { validateGuide, generateGuide, synthesize, readSSE, toneWave } = require('../lib/providers');
const { createTimeline, normalize, splitCaptions } = require('../lib/timeline');
const { buildArticle } = require('../lib/build');
const register = require('../lib/plugin');

const sources = [{ id: 'p-one', tag: 'p', text: '你好。' }, { id: 'p-two', tag: 'p', text: '再见。' }];
const rawGuide = { title: '导读', segments: [
  { id: 'guide-1', text: '你好。', sourceIds: ['p-one'] },
  { id: 'guide-2', text: '再见。', sourceIds: ['p-two'] }
] };
const guide = validateGuide(rawGuide, sources, 1800);
const live = () => resolveConfig({ enabled: true, llm: { base_url: 'https://llm.example/v1', api_key: 'test-llm-secret', model: 'demo', stream: false },
  tts: { provider: 'dashscope', api_key: 'test-tts-secret', workspace_id: 'workspace-test', voice: 'voice-test', timestamps: true } });

test('source IDs 对重建及前置段落稳定，去重并跳过摘要，保留标题锚点', () => {
  const html = '<section class="ai-summary-card"><p>摘要</p></section><h2 id="anchor">标题</h2><p>正文</p><p>正文</p><ul><li><p>列表</p></li></ul><pre><code>let a = 1;</code></pre>';
  const original = annotate(html), added = annotate('<p>新段落</p>' + html);
  assert.deepEqual(original.sources.map(s => s.id), added.sources.slice(1).map(s => s.id));
  assert.equal(original.sources.length, 5);
  assert.equal(new Set(original.sources.map(s => s.id)).size, 5);
  assert.match(original.html, /id="anchor"/);
  assert.deepEqual(annotate(original.html).sources, original.sources);
  const cleaned = stripReader('<section class="ai-reader">播放器</section><div data-ai-reader-body>' + original.html + '</div>');
  assert.doesNotMatch(cleaned, /data-ai-source|data-ai-reader-body|播放器/);
});

test('hash 随正文、模型、voice、模式和稿件变化，密钥轮换不重新计费', () => {
  const config = live(), post = { title: '文章', source: '_posts/test.md' };
  const hash = cacheHash(post, sources, config);
  const rotated = structuredClone(config); rotated.llm.apiKey = 'rotated'; rotated.tts.apiKey = 'rotated';
  assert.equal(cacheHash(post, sources, rotated), hash);
  for (const change of [c => c.tts.voice = 'new', c => c.llm.model = 'new', c => c.mode = 'mock', c => c.narration.promptVersion = 'v2']) {
    const next = structuredClone(config); change(next); assert.notEqual(cacheHash(post, sources, next), hash);
  }
  assert.notEqual(cacheHash(post, [...sources, { id: 'new', text: 'new' }], config), hash);
  assert.notEqual(articleKey({ source: '_posts/a.md', slug: '../a' }), articleKey({ source: '_posts/b.md', slug: '../a' }));
  assert.doesNotMatch(articleKey({ source: '../../a', slug: '../a' }), /\//);
});

test('拒绝不存在的引用、空导读、重复 ID 与超长导读', () => {
  assert.throws(() => validateGuide({ segments: [] }, sources, 100));
  assert.throws(() => validateGuide({ segments: [{ text: 'text', sourceIds: ['unknown'] }] }, sources, 100), /不存在/);
  assert.throws(() => validateGuide({ segments: [rawGuide.segments[0], rawGuide.segments[0]] }, sources, 100), /重复/);
  assert.throws(() => validateGuide(rawGuide, sources, 2), /超过/);
});

test('官方字级时间戳优先，按 segment 边界映射毫秒，不靠正文搜索', () => {
  const timeline = createTimeline(guide.segments, 4, [{ index: 0, words: [
    { text: '你', begin_time: 100, end_time: 500 }, { text: '好', begin_time: 500, end_time: 1000 },
    { text: '再', begin_time: 2300, end_time: 2800 }, { text: '见', begin_time: 2800, end_time: 3900 }
  ] }]);
  assert.equal(timeline.alignment.precise, true);
  assert.deepEqual(timeline.segments.map(s => [s.start, s.end]), [[0, 2.3], [2.3, 4]]);
});

test('缺词、时钟回退、无时间戳降级为完整无空隙的估算时间轴', () => {
  for (const words of [[], [{ text: '你', begin_time: 0, end_time: 1 }], [
    { text: '你好', begin_time: 2000, end_time: 3000 }, { text: '再见', begin_time: 0, end_time: 1000 }
  ]]) {
    const timeline = createTimeline(guide.segments, 4, [{ index: 0, words }]);
    assert.equal(timeline.alignment.precise, false);
    assert.equal(timeline.segments[0].start, 0);
    assert.equal(timeline.segments[0].end, timeline.segments[1].start);
    assert.equal(timeline.segments[1].end, 4);
  }
});

test('字幕拆分保留长句、英文和 Unicode 字符，估算时间不跨越导读段', () => {
  const text = '这里是一句很长的中文导读，需要在合适的位置拆开，让手机屏幕也能完整地显示字幕。Next we read this long English sentence without losing any words.🌊';
  const cues = splitCaptions(text);
  assert.ok(cues.length > 3);
  assert.equal(normalize(cues.join('')), normalize(text));
  assert.ok(cues.every(cue => [...cue].length <= 32));
  const timeline = createTimeline([{ id: 'a', text }, { id: 'b', text: '这是第二段。这里继续讲解。' }], 30);
  assert.equal(timeline.captionAlignment.precise, false);
  assert.equal(timeline.captions[0].start, 0);
  for (let i = 0; i < timeline.captions.length; i++) {
    const cue = timeline.captions[i], segment = timeline.segments.find(s => s.id === cue.segmentId);
    assert.ok(cue.end > cue.start && cue.start >= segment.start && cue.end <= segment.end + 1e-9);
    if (i) assert.ok(Math.abs(cue.start - timeline.captions[i - 1].end) < 1e-9);
  }
  assert.equal(timeline.captions.at(-1).end, 30);
});

test('字幕优先采用官方字时间，词内无法区分短句时明确降级', () => {
  const input = [{ id: 'a', text: '你好。再见。' }];
  const precise = createTimeline(input, 5, [{ index: 0, words: [
    { text: '你好', begin_time: 100, end_time: 1000 }, { text: '再见', begin_time: 3500, end_time: 4800 }
  ] }]);
  assert.equal(precise.captionAlignment.precise, true);
  assert.deepEqual(precise.captions.map(c => [c.text, c.start, c.end]), [['你好。', 0, 3.5], ['再见。', 3.5, 5]]);
  const coarse = createTimeline(input, 5, [{ index: 0, words: [{ text: '你好再见', begin_time: 100, end_time: 4800 }] }]);
  assert.equal(coarse.alignment.precise, true);
  assert.equal(coarse.captionAlignment.precise, false);
  assert.equal(coarse.captions.length, 2);
});

test('解析被任意网络块拆开的 SSE、UTF-8、多行 data 和 CRLF', async () => {
  const bytes = new TextEncoder().encode(': ping\r\ndata: {"output":\r\ndata: {"text":"你好"}}\r\n\r\ndata: [DONE]\r\n\r\n');
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  const events = []; await readSSE(response, event => events.push(event));
  assert.deepEqual(events, [{ output: { text: '你好' } }]);
});

test('兼容 API 使用配置地址，校验结构化输出，默认不强制 response_format', async t => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { content: JSON.stringify(rawGuide) } }] });
  });
  await generateGuide({ title: '测试' }, sources, live());
  assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(calls[0].body.response_format, undefined);
});

test('新版百炼只调用一次完整 TTS，正确使用 workspace / instruction / word timestamps', async t => {
  const calls = [];
  const events = [
    { output: { type: 'sentence-end', sentence: { index: 0, words: [{ text: '你好', begin_index: 0, end_index: 2, begin_time: 0, end_time: 1000 }] } } },
    { output: { finish_reason: 'stop', audio: { url: 'https://audio.example/narration.mp3' } } }
  ];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(Uint8Array.of(1, 2, 3));
  });
  const result = await synthesize(guide.text, live());
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(calls[0].url, 'https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'qwen-audio-3.1-tts-flash');
  assert.equal(body.input.text, guide.text);
  assert.equal(body.input.voice, 'voice-test');
  assert.ok(body.input.instruction);
  assert.equal(body.input.instructions, undefined);
  assert.equal(body.input.word_timestamp_enabled, true);
  assert.equal(calls[1].options.headers, undefined, '下载音频不携带 API Key');
  assert.equal(result.sentences[0].words.length, 1);
});

test('流式文本模型只合并正文，忽略思考和用量事件，完整结束后校验导读', async t => {
  const config = live(); config.llm.stream = true;
  const json = JSON.stringify(rawGuide);
  let requestBody;
  t.mock.method(global, 'fetch', async (url, options) => {
    requestBody = JSON.parse(options.body);
    const events = [
      { choices: [{ index: 0, delta: { reasoning_content: '这不是朗读稿' } }] },
      { choices: [{ index: 0, delta: { content: json.slice(0, 20) } }] },
      { choices: [{ index: 0, delta: { content: json.slice(20) } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { total_tokens: 100 } }
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  assert.deepEqual(await generateGuide({ title: '测试' }, sources, config), guide);
  assert.equal(requestBody.stream, true);
});

test('流式模型截断、输出 Token 耗尽和错误事件均拒绝，错误体不回显', async t => {
  const config = live(); config.llm.stream = true;
  const mock = t.mock.method(global, 'fetch', async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(rawGuide) } }] })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(generateGuide({ title: '测试' }, sources, config), /未完整结束/);
  mock.mock.mockImplementation(async () => new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(generateGuide({ title: '测试' }, sources, config), /Token 上限/);
  mock.mock.mockImplementation(async () => new Response('data: {"error":{"message":"test-llm-secret"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(generateGuide({ title: '测试' }, sources, config), error => /模型流式返回错误/.test(error.message) && !error.message.includes('test-llm-secret'));
});

test('超长导读仅重写一次，复用已有稿件，保留正文映射并严格检查上限', async t => {
  const config = live(); config.narration.maxChars = 20;
  const oversized = { title: '导读', segments: [{ id: 'guide-1', text: '这是模型给出的超长稿件。'.repeat(10), sourceIds: ['p-one'] }] };
  const calls = [];
  const mock = t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(calls.length === 1 ? oversized : rawGuide) } }] });
  });
  const result = await generateGuide({ title: '测试' }, sources, config);
  assert.equal(result.text, guide.text);
  assert.equal(calls.length, 2);
  const retry = JSON.parse(calls[1].messages[1].content);
  assert.deepEqual(retry.draft, oversized);
  assert.equal(retry.sources, undefined);
  calls.length = 0;
  mock.mock.mockImplementation(async (url, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(oversized) } }] });
  });
  await assert.rejects(generateGuide({ title: '测试' }, sources, config), /超过/);
  assert.equal(calls.length, 2);
});

test('HTTP 错误、无效 JSON、截断 TTS 都明确报错且不回显密钥', async t => {
  const mock = t.mock.method(global, 'fetch', async () => new Response('test-llm-secret', { status: 429 }));
  await assert.rejects(generateGuide({ title: '测试' }, sources, live()), /HTTP 429/);
  mock.mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: 'bad-json' } }] }));
  await assert.rejects(generateGuide({ title: '测试' }, sources, live()), /JSON 解析失败/);
  mock.mock.mockImplementation(async () => new Response('data: {"output":{"audio":{"data":"AQID"}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(synthesize(guide.text, live()), /未完整结束/);
});

test('通用百炼端点无需 workspace，3.0 Plus 非流式返回完整音频', async t => {
  const config = live();
  config.tts = resolveConfig({ tts: { provider: 'dashscope', workspace_id: '', model: 'qwen-audio-3.0-tts-plus',
    api_key: 'test-tts-secret', voice: 'voice-test', timestamps: false } }).tts;
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return Response.json({ output: {
      finish_reason: 'stop', audio: { url: 'https://audio.example/narration.mp3' }
    } });
    return new Response(Uint8Array.of(1, 2, 3));
  });
  const result = await synthesize(guide.text, config);
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'qwen-audio-3.0-tts-plus');
  assert.equal(body.input.word_timestamp_enabled, undefined);
  assert.equal(calls[0].options.headers['X-DashScope-SSE'], undefined);
  assert.equal(calls[1].options.headers, undefined);
  assert.deepEqual(result.sentences, []);
  assert.equal(result.mockAudio, null);
});

test('TTS 自定义端点优先，拒绝明文协议及 URL 认证信息', () => {
  const config = live();
  const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
  config.tts = resolveConfig({ tts: { provider: 'dashscope', endpoint, api_key: 'test', voice: 'test' } }).tts;
  assert.equal(config.tts.endpoint, endpoint);
  assert.doesNotThrow(() => assertLiveConfig(config));
  for (const invalid of ['http://example.com/tts', 'https://user:secret@example.com/tts', `${endpoint}?key=secret`]) {
    config.tts.endpoint = invalid;
    assert.throws(() => assertLiveConfig(config), /HTTPS 地址/);
  }
});

test('长文 LLM 与 TTS 分别采用配置的超时', () => {
  const config = resolveConfig({ timeout_ms: 240000, tts: { timeout_ms: 90000 } });
  assert.equal(config.timeout, 240000);
  assert.equal(config.tts.timeout, 90000);
  assert.equal(resolveConfig({ timeout_ms: 120000 }).tts.timeout, 120000);
});

test('缓存跨构建复用；TTS 失败后保留导读；音频损坏时重新生成', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-reader-test-'));
  let llmCalls = 0, ttsCalls = 0;
  const options = { post: { title: '测试' }, sources, config: live(), directory, generate: true, services: {
    async generateGuide() { llmCalls++; return guide; },
    async synthesize() {
      ttsCalls++; if (ttsCalls === 1) throw new Error('临时 TTS 失败');
      return { audio: toneWave(4), extension: 'wav', sentences: [], mockAudio: null };
    }
  } };
  try {
    await assert.rejects(buildArticle(options), /临时/);
    const first = await buildArticle(options);
    assert.equal(first.cached, false);
    assert.equal(first.duration, 4);
    const second = await buildArticle(options);
    assert.equal(second.cached, true);
    assert.equal(llmCalls, 1); assert.equal(ttsCalls, 2);
    await fs.writeFile(path.join(directory, 'audio', first.hash, 'narration.wav'), 'corrupted');
    await assert.rejects(buildArticle({ ...options, generate: false }), { code: 'AI_READER_CACHE_MISS' });
    await buildArticle(options);
    assert.equal(llmCalls, 1); assert.equal(ttsCalls, 3);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('全局/文章开关与加密文章保护', () => {
  const config = live();
  const post = { layout: 'post', source: '_posts/test.md', ai_reader: true };
  assert.equal(register.eligible(post, config, {}), true);
  assert.equal(register.eligible({ ...post, ai_reader: false }, config, {}), false);
  assert.equal(register.eligible({ ...post, password: 'example' }, config, {}), false);
  assert.equal(register.eligible({ ...post, tags: ['secret'] }, config, { encrypt: { tags: [{ name: 'secret', password: 'example' }] } }), false);
  assert.equal(register.eligible(post, { ...config, enabled: false }, {}), false);
  assert.equal(register.eligible({ ...post, published: false }, config, {}), false);
});

test('文章失败只告警，生成器仍工作，HTML 与 manifest 不注入密钥', async () => {
  const filters = new Map(), generators = new Map(), warnings = [];
  const post = { title: '失败测试', layout: 'post', source: '_posts/test.md', ai_reader: true, content: '<p>正常文章继续显示。</p>' };
  const hexo = {
    base_dir: os.tmpdir(), config: { root: '/blog/', ai_reader: { enabled: true, mode: 'invalid' } },
    extend: { filter: { register: (name, fn) => filters.set(name, fn) }, generator: { register: (name, fn) => generators.set(name, fn) }, console: { register() {} } },
    model: () => ({ toArray: () => [post] }), log: { warn: text => warnings.push(text), info() {} }
  };
  register(hexo);
  await filters.get('before_generate')();
  assert.equal(warnings.length, 1); assert.match(post.content, /正常文章/); assert.doesNotMatch(post.content, /ai-reader/);
  assert.deepEqual(generators.get('ai-reader')().map(route => route.path).sort(), ['ai-reader/avatar.webp', 'ai-reader/reader.css', 'ai-reader/reader.js']);
  const html = filters.get('after_render:html')('<head></head><body></body>');
  assert.match(html, /\/blog\/ai-reader\/reader.js/);
  assert.doesNotMatch(html, /api_key|test-llm-secret/);
});

test('live 配置缺失时明确拒绝，不静默切换成 Mock', () => {
  assert.throws(() => assertLiveConfig(resolveConfig({ llm: { base_url: '', api_key: '', model: '' }, tts: { api_key: '', workspace_id: '', voice: '' } })), /缺少配置/);
});
