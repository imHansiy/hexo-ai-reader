'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressStore, loadManifest } = require('../assets/reader');

function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
const manifest = { article: 'post-one', audio: '/ai-reader/post-one/narration.mp3?v=abc', duration: 87 };

test('进度按文章和音频版本隔离，结束或从头播放后不恢复', () => {
  const memory = storage(), progress = createProgressStore(() => memory, manifest);
  assert.equal(progress.read(), 0);
  progress.save(23.5);
  assert.equal(createProgressStore(() => memory, manifest).read(), 23.5);
  assert.equal(createProgressStore(() => memory, { ...manifest, article: 'post-two' }).read(), 0);
  assert.equal(createProgressStore(() => memory, { ...manifest, audio: manifest.audio + '-new' }).read(), 0);
  assert.equal(createProgressStore(() => memory, { ...manifest, duration: 88 }).read(), 0);
  progress.save(87, true);
  assert.equal(progress.read(), 0);
  progress.save(20); progress.save(0);
  assert.equal(progress.read(), 0);
});

test('过期、损坏和越界进度忽略，禁用存储时仍可正常调用', () => {
  const memory = storage(), progress = createProgressStore(() => memory, manifest);
  const key = 'hexo-ai-reader:progress:v1:post-one';
  for (const value of ['bad-json', '{}', JSON.stringify({ ...manifest, time: -1, updatedAt: Date.now() }),
    JSON.stringify({ ...manifest, time: 20, updatedAt: Date.now() - 91 * 86400000 })]) {
    memory.setItem(key, value); assert.equal(progress.read(), 0);
  }
  progress.save(NaN); progress.save(-1);
  progress.save(86.5);
  assert.equal(progress.read(), 0);
  const blocked = createProgressStore(() => { throw new Error('SecurityError'); }, manifest);
  assert.equal(blocked.read(), 0);
  assert.doesNotThrow(() => blocked.save(10));
});

test('加载失败不自动循环请求，再次调用可恢复；JSON 错误也可重试', async () => {
  const life = new AbortController();
  let calls = 0;
  const fetcher = async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json(manifest);
  await assert.rejects(loadManifest('https://example.com/manifest.json', life.signal, { fetcher }), /加载失败/);
  assert.equal(calls, 1);
  assert.deepEqual(await loadManifest('https://example.com/manifest.json', life.signal, { fetcher }), manifest);
  await assert.rejects(loadManifest('https://example.com/manifest.json', life.signal, {
    fetcher: async () => new Response('broken-json')
  }), SyntaxError);
});

test('慢请求超时终止，离页取消在途请求，已离页实例不继续请求', async () => {
  const fetcher = (url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const life = new AbortController();
  await assert.rejects(loadManifest('https://example.com/manifest.json', life.signal, { fetcher, timeout: 10 }), /超时/);
  const pending = loadManifest('https://example.com/manifest.json', life.signal, { fetcher });
  life.abort(new Error('离开文章'));
  await assert.rejects(pending, /离开文章/);
  await assert.rejects(loadManifest('https://example.com/manifest.json', life.signal, {
    fetcher: () => assert.fail('离页后不应发起请求')
  }), /离开文章/);
});
