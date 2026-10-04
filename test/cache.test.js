'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildArticle } = require('../lib/build');
const { resolveConfig } = require('../lib/config');
const { cacheHash, digest } = require('../lib/source');
const { validateGuide, toneWave } = require('../lib/providers');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = [{ id: 'p-one', tag: 'p', text: '你好。' }];
  const guide = validateGuide({ title: '导读', segments: [{ id: 'g-one', text: '你好。', sourceIds: ['p-one'] }] }, sources, 100);
  const calls = { llm: 0, tts: 0 };
  const options = { directory, sources, post: { title: '文章', source: '_posts/test.md' },
    config: resolveConfig({ mode: 'live', llm: { base_url: 'https://model.example/v1', api_key: 'test', model: 'model' },
      tts: { provider: 'dashscope', api_key: 'test', voice: 'voice' } }),
    services: {
      async generateGuide() { calls.llm++; return guide; },
      async synthesize() { calls.tts++; return { audio: toneWave(2), extension: 'wav', sentences: [], mockAudio: null }; }
    }
  };
  const prepare = overrides => buildArticle({ ...options, generate: true, ...overrides });
  return { options, calls, guide, prepare };
}

test('显式仅读取缓存时零 API 调用；生成后的真实缓存无需凭据', async t => {
  const { options, calls, prepare } = await fixture(t);
  await assert.rejects(buildArticle(options), { code: 'AI_READER_CACHE_MISS' });
  assert.deepEqual(calls, { llm: 0, tts: 0 });
  const first = await prepare();
  const offline = await buildArticle({ ...options, config: resolveConfig({ mode: 'live', tts: { provider: 'dashscope' } }) });
  assert.equal(offline.cached, true);
  assert.deepEqual(offline.audio, first.audio);
  assert.deepEqual(calls, { llm: 1, tts: 1 });
});

test('强制生成跳过两阶段缓存，普通生成随后复用强制版本', async t => {
  const { options, calls, prepare } = await fixture(t);
  const first = await prepare();
  const forced = await prepare({ force: true });
  assert.equal(forced.guideCached, false);
  assert.equal(forced.audioCached, false);
  assert.notEqual(first.hash, forced.hash);
  assert.deepEqual(calls, { llm: 2, tts: 2 });
  assert.equal((await prepare()).hash, forced.hash);
  assert.deepEqual(calls, { llm: 2, tts: 2 });
  options.config.tts.voice = 'another-voice';
  assert.equal((await prepare()).guideCached, true);
  assert.deepEqual(calls, { llm: 2, tts: 3 });
});

test('强制生成新稿后 TTS 失败不会覆盖原可用版本', async t => {
  const { options, guide, calls, prepare } = await fixture(t);
  const first = await prepare();
  const pointer = await fs.readFile(path.join(options.directory, 'ready-live.json'), 'utf8');
  options.services.generateGuide = async () => { calls.llm++; return { ...guide, segments: [{ ...guide.segments[0], text: '这是新的导读。' }] }; };
  options.services.synthesize = async () => { calls.tts++; throw new Error('语音失败'); };
  await assert.rejects(prepare({ force: true }), /语音失败/);
  assert.equal(await fs.readFile(path.join(options.directory, 'ready-live.json'), 'utf8'), pointer);
  const offline = await buildArticle(options);
  assert.equal(offline.guide.text, first.guide.text);
  assert.deepEqual(offline.audio, first.audio);
  assert.equal((await prepare()).hash, first.hash);
  assert.deepEqual(calls, { llm: 2, tts: 2 });
});

test('换音色只重做语音；换文本模型且稿件相同则复用音频', async t => {
  const { options, calls, prepare } = await fixture(t);
  const first = await prepare();
  options.config.tts.voice = 'second-voice';
  const voice = await prepare();
  assert.equal(voice.guideCached, true);
  assert.equal(voice.audioCached, false);
  assert.notEqual(voice.hash, first.hash);
  assert.deepEqual(calls, { llm: 1, tts: 2 });
  options.config.llm.model = 'second-model';
  const model = await prepare();
  assert.equal(model.guideCached, false);
  assert.equal(model.audioCached, true);
  assert.deepEqual(calls, { llm: 2, tts: 2 });
});

test('网络超时、流式开关、密钥和 TTS 端点变化不会重复计费', async t => {
  const { options, calls, prepare } = await fixture(t);
  await prepare();
  options.config.timeout += 1000;
  options.config.llm.stream = !options.config.llm.stream;
  options.config.llm.apiKey = 'rotated';
  options.config.tts.apiKey = 'rotated';
  options.config.tts.timeout += 1000;
  options.config.tts.endpoint = 'https://new-endpoint.example/tts';
  options.config.tts.workspaceId = 'rotated-workspace';
  assert.equal((await prepare()).cached, true);
  assert.deepEqual(calls, { llm: 1, tts: 1 });
});

test('整篇正文指纹阻止复用旧导读，即使引用 ID 都仍存在', async t => {
  const { options, calls, prepare } = await fixture(t);
  await prepare();
  options.sources = [...options.sources, { id: 'p-two', tag: 'p', text: '新内容。' }];
  await assert.rejects(buildArticle(options), { code: 'AI_READER_CACHE_MISS' });
  assert.deepEqual(calls, { llm: 1, tts: 1 });
  const next = await prepare();
  assert.equal(next.guideCached, false);
  assert.equal(next.audioCached, true);
});

test('新语音失败保留可用版本和稿件，下次只补语音；正文变化后不使用旧版', async t => {
  const { options, calls, prepare } = await fixture(t);
  const first = await prepare();
  const readyFile = path.join(options.directory, 'ready-live.json');
  const pointer = await fs.readFile(readyFile, 'utf8');
  const speech = options.services.synthesize;
  options.config.tts.voice = 'new-voice';
  options.services.synthesize = async () => { throw new Error('暂时失败'); };
  await assert.rejects(prepare(), /暂时失败/);
  assert.equal(await fs.readFile(readyFile, 'utf8'), pointer);
  assert.equal((await buildArticle(options)).hash, first.hash);
  options.services.synthesize = speech;
  await prepare();
  assert.deepEqual(calls, { llm: 1, tts: 2 });
  options.sources = [...options.sources, { id: 'p-two', tag: 'p', text: '新段落。' }];
  options.config.tts.voice = 'another-voice';
  options.services.synthesize = async () => { throw new Error('暂时失败'); };
  await assert.rejects(prepare(), /暂时失败/);
  await assert.rejects(buildArticle(options), { code: 'AI_READER_CACHE_MISS' });
  options.services.synthesize = speech;
  await prepare();
  assert.deepEqual(calls, { llm: 2, tts: 3 });
});

test('旧缓存按正文和配置精确迁移，音频字节不变且零 API 调用', async t => {
  const { options, calls, guide } = await fixture(t);
  const hash = cacheHash(options.post, options.sources, options.config);
  const legacy = path.join(options.directory, hash);
  const audio = toneWave(2);
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'narration.wav'), audio);
  await fs.writeFile(path.join(legacy, 'result.json'), JSON.stringify({ hash, guide, audioHash: digest(audio),
    duration: 2, extension: 'wav', sentences: [], mockAudio: null }));
  const imported = await buildArticle(options);
  assert.equal(imported.migrated, true);
  assert.deepEqual(imported.audio, audio);
  assert.deepEqual(calls, { llm: 0, tts: 0 });
  await fs.access(path.join(legacy, 'narration.wav'));
  const offline = await buildArticle({ ...options, config: resolveConfig({ mode: 'live', tts: { provider: 'dashscope' } }) });
  assert.deepEqual(offline.audio, audio);
});
