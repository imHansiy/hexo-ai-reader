'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const register = require('../lib/plugin');
const { articleKey, guideHash, audioCacheHash } = require('../lib/source');
const { resolveConfig, assertLiveConfig } = require('../lib/config');

test('显式百炼渠道的最简配置保持原参数和缓存版本；显式设置仍优先', () => {
  const previous = process.env.TTS_MODEL;
  process.env.TTS_MODEL = 'qwen-audio-3.0-tts-plus';
  try {
    const minimal = resolveConfig({ enabled: true, default_enabled: false, tts: { provider: 'dashscope' } });
    const explicit = resolveConfig({ enabled: true, auto_generate: true, mode: 'live',
      default_enabled: false, cache_dir: '.cache/hexo-ai-reader', timeout_ms: 240000,
      llm: { stream: true, json_mode: false, max_input_chars: 60000 },
      tts: { provider: 'dashscope', model: 'qwen-audio-3.0-tts-plus', timeout_ms: 90000, timestamps: false,
        sample_rate: 24000, rate: 1,
        instruction: '使用自然亲切的中文聊天语气讲解文章，语速适中，有情感和自然停顿，不要新闻播音腔。' },
      narration: { language: 'zh-CN', max_chars: 800,
        style: '使用自然、亲切、连续的中文讲解方式，像在给朋友介绍文章内容，不要逐段机械复述。' } });
    assert.deepEqual(minimal, explicit);
    const post = { title: '文章' }, sources = [{ id: 'one', text: '正文' }], guide = { text: '导读' };
    assert.equal(guideHash(post, sources, minimal), guideHash(post, sources, explicit));
    assert.equal(audioCacheHash(guide, minimal), audioCacheHash(guide, explicit));
    const override = resolveConfig({ timeout_ms: 120000, llm: { stream: false },
      tts: { model: 'custom-model', timeout_ms: 30000, timestamps: true }, narration: { max_chars: 1000 } });
    assert.equal(override.llm.stream, false);
    assert.equal(override.tts.model, 'custom-model');
    assert.equal(override.tts.timeout, 30000);
    assert.equal(override.tts.timestamps, true);
    assert.equal(override.narration.maxChars, 1000);
  } finally {
    if (previous === undefined) delete process.env.TTS_MODEL;
    else process.env.TTS_MODEL = previous;
  }
});

test('可选人物设定和系统提示词支持多行 YAML，留空及头像变化保留旧文稿版本', () => {
  const yaml = require('js-yaml');
  const raw = yaml.load(`ai_reader:
  narration:
    persona: |-
      你是海灵。
      用我和你陪读，不冒充作者经历。
    system_prompt: |-
      先讲用途，再讲关键步骤。
      保留限制与注意事项。
  player:
    avatar: /images/reader-avatar.webp
`).ai_reader;
  const config = resolveConfig(raw);
  assert.equal(config.narration.persona, '你是海灵。\n用我和你陪读，不冒充作者经历。');
  assert.equal(config.narration.systemPrompt, '先讲用途，再讲关键步骤。\n保留限制与注意事项。');
  assert.equal(config.player.avatar, '/images/reader-avatar.webp');
  const defaults = resolveConfig({});
  const empty = resolveConfig({ narration: { persona: ' \n ', system_prompt: null }, player: raw.player });
  assert.deepEqual(empty.narration, defaults.narration);
  const post = { title: '文章' }, sources = [{ id: 'one', text: '正文' }];
  assert.equal(guideHash(post, sources, empty), guideHash(post, sources, defaults));
  assert.notEqual(guideHash(post, sources, config), guideHash(post, sources, defaults));
  for (const field of ['persona', 'system_prompt']) {
    assert.throws(() => resolveConfig({ narration: { [field]: { invalid: true } } }), new RegExp(`narration.${field} 必须是文本`));
  }
});

async function fixture(t, args = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-config-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const filters = new Map(), commands = new Map();
  const posts = ['one', 'two'].map(name => ({ title: name, source: `_posts/${name}.md`, slug: name,
    layout: 'post', ai_reader: true, content: '<p>这是一篇用于验证缓存和生成行为的文章。</p>' }));
  const hexo = { base_dir: base, env: { args },
    config: { root: '/', ai_reader: { enabled: true, mode: 'mock', mock_voice: '__no_installed_voice__' } },
    extend: { filter: { register: (name, fn) => filters.set(name, fn) }, generator: { register() {} },
      console: { register: (name, desc, options, fn) => commands.set(name, fn) } },
    model: () => ({ toArray: () => posts }), locals: { get: () => ({}) }, log: { info() {}, warn() {} },
    call: async name => { assert.equal(name, 'generate'); await filters.get('before_generate')(); }
  };
  register(hexo);
  const generate = () => filters.get('before_generate')();
  const command = args => commands.get('ai-reader')(args);
  const ready = async (post = posts[0], cache = '.cache/hexo-ai-reader') => JSON.parse(await fs.readFile(path.join(base, cache, articleKey(post), 'ready-mock.json'), 'utf8'));
  return { base, hexo, posts, generate, command, ready };
}

test('B2 完整 YAML 不读取环境文件，缺少 B2 配置时可从标准 .env 加载', async t => {
  const { base, hexo, posts, generate } = await fixture(t);
  posts.forEach(post => { post.ai_reader = false; });
  hexo.config.ai_reader = { enabled: true, mode: 'live', llm: {
    base_url: 'https://model.example/v1', api_key: 'yaml-key', model: 'model'
  }, storage: { provider: 'b2', b2: {
    key_id: 'id', key: 'key', bucket: 'bucket', bucket_id: 'bucket-id', region: 'us-east-005'
  } } };
  await fs.writeFile(path.join(base, '.env'), "KEY='invalid-quote\n");
  await generate();
  const previous = process.env.READER_B2_TEST_KEY;
  t.after(() => { if (previous === undefined) delete process.env.READER_B2_TEST_KEY; else process.env.READER_B2_TEST_KEY = previous; });
  delete process.env.READER_B2_TEST_KEY;
  hexo.config.ai_reader.storage.b2.key = '${READER_B2_TEST_KEY}';
  await fs.writeFile(path.join(base, '.env'), 'READER_B2_TEST_KEY=from-standard-env\n');
  await generate();
  assert.equal(resolveConfig(hexo.config.ai_reader).storage.b2.key, 'from-standard-env');
  assert.equal(resolveConfig({ storage: { provider: 'b2', b2: { key: 'explicit-key' } } }).storage.b2.key, 'explicit-key');
});

test('编译和手动命令使用 Hexo 已加载的配置及同一缓存目录；不隐式合并本地 YAML', async t => {
  const { base, hexo, generate, command, ready } = await fixture(t);
  hexo.config.ai_reader.auto_generate = false;
  hexo.config.ai_reader.cache_dir = '.cache/custom';
  await fs.writeFile(path.join(base, '_config.local.yml'), 'ai_reader:\n  auto_generate: true\n  cache_dir: .cache/unwanted\n');
  await fs.writeFile(path.join(base, '.env.ai-reader'), "KEY='invalid-quote\n");
  await fs.writeFile(path.join(base, '.env'), "KEY='invalid-quote\n");
  await generate();
  assert.equal(hexo.config.ai_reader.auto_generate, false);
  await assert.rejects(ready(undefined, '.cache/custom'));
  await command({ prepare: true, post: 'one' });
  await ready(undefined, '.cache/custom');
  assert.equal((await fs.readdir(path.join(base, '.cache/custom'))).filter(name => name.endsWith('.lock')).length, 0);
  await assert.rejects(fs.access(path.join(base, '.cache/hexo-ai-reader')));
  await assert.rejects(fs.access(path.join(base, '.cache/unwanted')));
});

test('显式配置优先，不额外应用本地 YAML', async t => {
  const { base, hexo, generate, ready } = await fixture(t, { config: '_config.yml' });
  await fs.writeFile(path.join(base, '_config.local.yml'), 'ai_reader:\n  auto_generate: false\n  cache_dir: .cache/custom\n');
  await generate();
  assert.equal(hexo.config.ai_reader.auto_generate, undefined);
  await ready();
  await assert.rejects(fs.access(path.join(base, '.cache/custom')));
});

test('完整 YAML 配置无需私有环境文件，且优先于遗留环境变量', async t => {
  const { base, hexo, posts, generate } = await fixture(t);
  const raw = require('js-yaml').load(`ai_reader:
  enabled: true
  mode: live
  llm:
    base_url: https://text.example.com/v1
    api_key: yaml-text-key
    model: yaml-text-model
  tts:
    provider: dashscope
    endpoint: https://speech.example.com/tts
    api_key: yaml-speech-key
    model: yaml-speech-model
    voice: yaml-voice
`).ai_reader;
  hexo.config.ai_reader = raw;
  for (const post of posts) post.ai_reader = false;
  const names = ['AI_READER_MODE', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
    'DASHSCOPE_API_KEY', 'TTS_MODEL', 'TTS_VOICE_ID'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  for (const name of names) process.env[name] = 'stale-environment-value';
  process.env.AI_READER_MODE = 'mock';
  await fs.writeFile(path.join(base, '.env.ai-reader'), "KEY='invalid-quote\n");
  await fs.writeFile(path.join(base, '.env'), "KEY='invalid-quote\n");
  await generate();
  const config = resolveConfig(hexo.config.ai_reader);
  assert.doesNotThrow(() => assertLiveConfig(config));
  assert.equal(config.mode, 'live');
  assert.equal(config.llm.baseUrl, 'https://text.example.com/v1');
  assert.equal(config.llm.apiKey, 'yaml-text-key');
  assert.equal(config.llm.model, 'yaml-text-model');
  assert.equal(config.tts.endpoint, 'https://speech.example.com/tts');
  assert.equal(config.tts.apiKey, 'yaml-speech-key');
  assert.equal(config.tts.model, 'yaml-speech-model');
  assert.equal(config.tts.voice, 'yaml-voice');
  assert.deepEqual(hexo.config.ai_reader, raw);
});

test('指定单篇强制生成不会重新生成其他文章；加密文章不生成', async t => {
  const { posts, generate, command, ready, base } = await fixture(t);
  const protectedPost = { ...posts[0], source: '_posts/private.md', slug: 'private', password: 'example' };
  posts.push(protectedPost);
  await generate();
  const one = await ready(posts[0]), two = await ready(posts[1]);
  await command({ force: true, post: '_posts/one.md' });
  assert.notEqual((await ready(posts[0])).audioKey, one.audioKey);
  assert.deepEqual(await ready(posts[1]), two);
  await assert.rejects(fs.access(path.join(base, '.cache/hexo-ai-reader', articleKey(protectedPost))));
});

test('标准 .env 优先于旧文件，旧文件补缺，进程环境仍优先；无需实际生成', async t => {
  const { base, hexo, posts, generate } = await fixture(t);
  const names = ['READER_TEST_URL', 'READER_TEST_KEY', 'READER_TEST_MODEL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  for (const name of names) delete process.env[name];
  for (const post of posts) post.ai_reader = false;
  hexo.config.ai_reader = { enabled: true, mode: 'live', llm: {
    base_url: '${READER_TEST_URL}', api_key: '${READER_TEST_KEY}', model: '${READER_TEST_MODEL}'
  } };
  await fs.writeFile(path.join(base, '.env'), 'READER_TEST_URL=https://primary.example.com/v1\nREADER_TEST_KEY=primary-key\n');
  await fs.writeFile(path.join(base, '.env.ai-reader'), 'READER_TEST_URL=https://legacy.example.com/v1\nREADER_TEST_KEY=legacy-key\nREADER_TEST_MODEL=legacy-model\n');
  await generate();
  let config = resolveConfig(hexo.config.ai_reader);
  assert.equal(config.llm.baseUrl, 'https://primary.example.com/v1');
  assert.equal(config.llm.apiKey, 'primary-key');
  assert.equal(config.llm.model, 'legacy-model');
  process.env.READER_TEST_KEY = 'ci-key';
  await generate();
  config = resolveConfig(hexo.config.ai_reader);
  assert.equal(config.llm.apiKey, 'ci-key');
});
