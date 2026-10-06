'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveConfig, assertLiveConfig, assertTtsConfig } = require('../lib/config');
const { synthesize, generateGuide, toneWave } = require('../lib/providers');
const { runWorker, inputSignature } = require('../lib/qwen3');
const { buildArticle, audioDuration } = require('../lib/build');
const { guideHash, audioCacheHash } = require('../lib/source');

test('默认渠道内置可加载的纯 JS 模块，旧 Python 环境变量不进入默认配置', async t => {
  const names = ['QWEN3_TTS_MODULE', 'QWEN3_TTS_PY', 'QWEN3_TTS_SCRIPT'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  delete process.env.QWEN3_TTS_MODULE;
  process.env.QWEN3_TTS_PY = 'missing-python';
  process.env.QWEN3_TTS_SCRIPT = 'missing-script.py';
  const config = resolveConfig();
  assert.equal(config.tts.provider, 'qwen3');
  assert.equal(config.tts.qwen3.module, path.resolve(__dirname, '../lib/qwen3-tts.mjs'));
  assert.equal(config.tts.qwen3.python, '');
  assert.equal(config.tts.qwen3.pythonScript, '');
  assert.doesNotThrow(() => assertTtsConfig(config));
  assert.match(await inputSignature(config), /^[a-f0-9]{64}$/);
  const api = (await import(require('node:url').pathToFileURL(config.tts.qwen3.module).href)).default;
  for (const method of ['say', 'voice', 'clone', 'design', 'inspectAudio']) assert.equal(typeof api[method], 'function');
});

async function fixture(t, body = '', cleanup = true, legacy = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-qwen3-'));
  if (cleanup) t.after(() => fs.rm(base, { recursive: true, force: true }));
  const module = path.join(base, 'module with spaces.mjs');
  await fs.writeFile(path.join(base, 'voice.wav'), toneWave(2));
  await fs.writeFile(module, `import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base=path.dirname(fileURLToPath(import.meta.url));
async function call(params, opts) {
  ${body}
  await fs.writeFile(path.join(base,'received.json'),JSON.stringify({params,opts,python:process.env.QWEN3_TTS_PY,
    hostEnv:process.env.QWEN3_TTS_HOST, tokenEnv:process.env.QWEN3_TTS_HF_TOKEN, voiceEnv:process.env.QWEN3_TTS_VOICE_CFG}));
  await fs.copyFile(path.join(base,'voice.wav'),params.output);
  return ${legacy ? "{exitCode:0,data:{ok:true,status:'Success',saved_to:params.output}}" : "{ok:true,status:'Success',saved_to:params.output}"};
}
export default {say:call,clone:call,voice:call,design:call,
  inspectAudio:()=>({valid:true,format:'wav',silent:false,durationSec:2})};`);
  const config = resolveConfig({ mode: 'live', tts: {
    qwen3: { module, ...(legacy ? { python: 'test-python' } : {}) } } }, base);
  return { base, module, config };
}

test('Qwen3 配置不要求百炼凭据；文本和语音参数独立校验', async t => {
  const { config } = await fixture(t);
  assert.doesNotThrow(() => assertTtsConfig(config));
  assert.throws(() => assertLiveConfig(config), /ai_reader.llm.base_url/);
  config.llm = resolveConfig({ llm: { base_url: 'https://text.example/v1', api_key: 'test', model: 'test', stream: false } }).llm;
  assert.doesNotThrow(() => assertLiveConfig(config));
  assert.equal(config.tts.timeout, 600000);
  assert.equal(config.tts.format, 'wav');
  assert.equal(config.tts.provider, 'qwen3');
  assert.equal(config.tts.qwen3.command, 'say');
  assert.equal(config.tts.qwen3.python, '');
  assert.equal(config.tts.qwen3.pythonScript, '');
  config.tts.qwen3.command = 'voice';
  assert.throws(() => assertTtsConfig(config), /voice_config/);
  config.tts.qwen3.command = 'delete';
  assert.throws(() => assertTtsConfig(config), /command/);
  const llmOnly = resolveConfig({ llm: { base_url: 'https://text.example/v1', api_key: 'test', model: 'test', stream: false },
    tts: { api_key: '', voice: '' } });
  t.mock.method(global, 'fetch', async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    segments: [{ text: '导读。', sourceIds: ['p'] }] }) } }] }));
  await generateGuide({ title: '文章' }, [{ id: 'p', text: '正文' }], llmOnly);
});

test('带空格的 ESM 路径通过独立进程调用，完整文本原样传递并输出可读 WAV', async t => {
  const { config, base } = await fixture(t);
  const text = '中文与换行。\n引号 " 和 $() 仅是文本。';
  const result = await synthesize(text, config, base);
  assert.equal(result.extension, 'wav');
  assert.equal(result.mockAudio, null);
  assert.equal(await audioDuration(result.audio, 'wav'), 2);
  const received = JSON.parse(await fs.readFile(path.join(base, 'received.json'), 'utf8'));
  assert.equal(received.params.text, text);
  assert.equal(received.params.speaker, 'Serena');
  assert.equal(received.params.language, 'Chinese');
  assert.equal(received.opts.timeoutSec, 600);
  assert.equal(received.opts.timeout, 600);
  assert.equal(received.opts.quiet, true);
  assert.equal(received.python, process.env.QWEN3_TTS_PY);
  assert.notEqual(process.env.QWEN3_TTS_PY, 'test-python');
});

test('旧 Python 桥接脚本的退出码和包装结果仍兼容，显式 Python 路径仅传给子进程', async t => {
  const { config, base } = await fixture(t, '', true, true);
  await synthesize('旧渠道兼容测试。', config, base);
  const received = JSON.parse(await fs.readFile(path.join(base, 'received.json'), 'utf8'));
  assert.equal(received.python, 'test-python');
  assert.equal(received.opts.timeoutSec, 600);
  assert.notEqual(process.env.QWEN3_TTS_PY, 'test-python');
});

test('退出成功但业务失败或非 Success 状态不发布，底层敏感错误不回显', async t => {
  for (const payload of [{ ok: false, status: 'Success', error: { message: 'private-provider-secret' } },
    { ok: true, status: 'Error: private-provider-secret' }]) {
    const { config, base } = await fixture(t, `return {exitCode:0,data:${JSON.stringify(payload)}};`);
    await assert.rejects(synthesize('测试', config, base), error => /生成失败/.test(error.message) && !error.message.includes('private-provider-secret'));
    const direct = await fixture(t, `return ${JSON.stringify(payload)};`);
    await assert.rejects(synthesize('测试', direct.config, direct.base), /生成失败/);
  }
  const failedExit = await fixture(t, "return {exitCode:1,data:{ok:true,status:'Success'}};");
  await assert.rejects(synthesize('测试', failedExit.config, failedExit.base), /生成失败/);
});

test('空文件、伪 WAV 和静音检查失败时拒绝缓存', async t => {
  const { config, base, module } = await fixture(t);
  await fs.writeFile(path.join(base, 'voice.wav'), 'not audio');
  await assert.rejects(synthesize('测试', config, base), /大小无效/);
  await fs.writeFile(path.join(base, 'voice.wav'), Buffer.alloc(100));
  await assert.rejects(synthesize('测试', config, base), /不是 WAV/);
  await fs.writeFile(path.join(base, 'voice.wav'), toneWave(2));
  await fs.writeFile(module, (await fs.readFile(module, 'utf8')).replace('silent:false', 'silent:true'));
  await assert.rejects(synthesize('测试', config, base), /静音/);
});

test('Qwen3 挂起进程按本地执行上限终止，不自动重试', async t => {
  const { config, base } = await fixture(t, 'await new Promise(()=>{setInterval(()=>{},1000);});');
  await assert.rejects(runWorker({ module: config.tts.qwen3.module, command: 'say',
    params: { text: '测试', output: path.join(base, 'out.wav') }, output: path.join(base, 'out.wav'), timeoutSec: 1
  }, { timeout: 500 }), /本地执行超时/);
});

test('切换渠道只补语音，缓存命中跳过外部进程，强制失败保留旧版', async t => {
  const { config, base } = await fixture(t);
  const sources = [{ id: 'p', text: '正文' }], post = { title: '文章' };
  let guides = 0, speech = 0;
  const options = { directory: path.join(base, 'cache'), config: resolveConfig({ mode: 'live', tts: { provider: 'dashscope' } }), sources, post, generate: true,
    services: { generateGuide: async () => { guides++; return { segments: [{ text: '导读。', sourceIds: ['p'] }] }; },
      synthesize: async () => { speech++; return { audio: toneWave(2), extension: 'wav', sentences: [], mockAudio: null }; } } };
  await buildArticle(options);
  const dashConfig = options.config;
  options.config = config;
  assert.equal(guideHash(post, sources, dashConfig), guideHash(post, sources, config));
  assert.notEqual(audioCacheHash({ text: '导读。' }, dashConfig), audioCacheHash({ text: '导读。' }, config));
  options.services.synthesize = async (...args) => { speech++; return synthesize(...args); };
  const qwen = await buildArticle(options);
  assert.equal(qwen.guideCached, true);
  assert.equal(qwen.extension, 'wav');
  assert.deepEqual([guides, speech], [1, 2]);
  assert.equal((await buildArticle(options)).cached, true);
  assert.deepEqual([guides, speech], [1, 2]);
  options.config = dashConfig;
  assert.equal((await buildArticle(options)).cached, true);
  assert.deepEqual([guides, speech], [1, 2]);
  options.config = config;
  assert.equal((await buildArticle(options)).cached, true);
  assert.deepEqual([guides, speech], [1, 2]);
  options.config.tts.qwen3.speaker = 'Vivian';
  await buildArticle(options);
  assert.deepEqual([guides, speech], [1, 3]);
  const pointer = await fs.readFile(path.join(options.directory, 'ready-live.json'), 'utf8');
  options.services.synthesize = async () => { throw new Error('forced failure'); };
  await assert.rejects(buildArticle({ ...options, force: true }), /forced failure/);
  assert.equal(await fs.readFile(path.join(options.directory, 'ready-live.json'), 'utf8'), pointer);
  assert.equal((await buildArticle(options)).cached, true);
});

test('模块及参考音频内容变化影响 Qwen3 音频缓存，超时和 Python 路径不影响', async t => {
  const { config, base, module } = await fixture(t);
  config.tts.qwen3.command = 'clone';
  config.tts.qwen3.refAudio = path.join(base, 'voice.wav');
  const signature = await inputSignature(config);
  config.tts.timeout += 1000;
  config.tts.qwen3.python = 'another-python';
  assert.equal(await inputSignature(config), signature);
  await fs.appendFile(module, '\n// updated');
  const updated = await inputSignature(config);
  assert.notEqual(updated, signature);
  await fs.writeFile(path.join(base, 'voice.wav'), toneWave(3));
  assert.notEqual(await inputSignature(config), updated);
});

test('默认音色 JSON 按克隆模式核对参考文件，参考文本变化使音频版本更新', async t => {
  const { config, base } = await fixture(t);
  const voice = path.join(base, 'default.json');
  config.tts.qwen3.command = 'voice';
  config.tts.qwen3.voiceConfig = voice;
  const data = { ref_audio_short: path.join(base, 'voice.wav'), ref_text_short: '参考文本',
    ref_audio_full: path.join(base, 'missing.wav'), ref_text_full: '完整参考文本' };
  await fs.writeFile(voice, JSON.stringify(data));
  const signature = await inputSignature(config);
  data.ref_text_short = '新的参考文本';
  await fs.writeFile(voice, JSON.stringify(data));
  assert.notEqual(await inputSignature(config), signature);
  config.tts.qwen3.mode = 'icl';
  await assert.rejects(inputSignature(config), /参考音频/);
});

test('真实 Hexo 通过 Qwen3 渠道输出 WAV 和播放器，第二次编译不调用文本或语音', async t => {
  const { base, module } = await fixture(t, '', false);
  const Hexo = require('hexo');
  const register = require('../lib/plugin');
  const hexo = new Hexo(base, { safe: true, silent: true });
  t.after(async () => { try { await hexo.exit(); } finally { await fs.rm(base, { recursive: true, force: true }); } });
  await fs.mkdir(path.join(base, 'source/_posts'), { recursive: true });
  await fs.mkdir(path.join(base, 'themes/test/layout'), { recursive: true });
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'qwen-reader-test', hexo: { version: '8.1.2' } }));
  await fs.writeFile(path.join(base, '_config.yml'), require('js-yaml').dump({ theme: 'test',
    url: 'https://example.com', permalink: ':title/', ai_reader: { enabled: true,
      llm: { base_url: 'https://text.example/v1', api_key: 'test-key', model: 'test', stream: false },
      tts: { qwen3: { module } } } }));
  await fs.writeFile(path.join(base, '.env.ai-reader'), "KEY='invalid-quote\n");
  await fs.writeFile(path.join(base, 'themes/test/_config.yml'), '');
  await fs.writeFile(path.join(base, 'themes/test/layout/post.ejs'), '<html><head></head><body><%- page.content %></body></html>');
  await fs.writeFile(path.join(base, 'source/_posts/test.md'), '---\ntitle: test\nai_reader: true\n---\n这是一篇用于验证语音渠道编译流程的公开文章。');
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      segments: [{ text: '这是语音渠道集成测试。', sourceIds: [input.sources[0].id] }] }) } }] });
  });
  await hexo.init();
  await hexo.loadPlugin(require.resolve('hexo-renderer-marked'));
  await hexo.loadPlugin(require.resolve('hexo-renderer-ejs'));
  register(hexo);
  await hexo.call('generate', {});
  const html = await fs.readFile(path.join(base, 'public/test/index.html'), 'utf8');
  assert.match(html, /data-ai-reader-manifest/);
  const key = (await fs.readdir(path.join(base, 'public/ai-reader'))).find(name => !name.includes('.'));
  const manifest = JSON.parse(await fs.readFile(path.join(base, 'public/ai-reader', key, 'manifest.json'), 'utf8'));
  assert.match(manifest.audio, /narration\.wav/);
  assert.equal(manifest.mode, 'live');
  assert.equal(manifest.mockAudio, null);
  assert.equal(manifest.duration, 2);
  assert.doesNotMatch(JSON.stringify(manifest), /test-key|module with spaces|pythonScript|qwen3/);
  const received = path.join(base, 'received.json');
  const time = (await fs.stat(received)).mtimeMs;
  await hexo.call('generate', {});
  assert.equal(calls, 1);
  assert.equal((await fs.stat(received)).mtimeMs, time);
});

test('Qwen3 子进程只接受 YAML 参数，旧的进程变量不影响主机、Token、音色或 Python', async t => {
  const names = ['QWEN3_TTS_HOST', 'QWEN3_TTS_HF_TOKEN', 'QWEN3_TTS_VOICE_CFG', 'QWEN3_TTS_PY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  } });
  for (const name of names) process.env[name] = 'stale-env';
  const { config, base } = await fixture(t);
  config.tts.qwen3.host = 'space.example.com';
  config.tts.qwen3.hfToken = 'yaml-token';
  await synthesize('测试。', config, base);
  const received = JSON.parse(await fs.readFile(path.join(base, 'received.json'), 'utf8'));
  assert.equal(received.opts.host, 'space.example.com');
  assert.equal(received.opts.hfToken, 'yaml-token');
  for (const name of ['python', 'hostEnv', 'tokenEnv', 'voiceEnv']) assert.equal(received[name], undefined);
});