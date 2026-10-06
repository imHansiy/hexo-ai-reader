'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { resolveConfig } = require('../lib/config');
const { createAudioPublisher } = require('../lib/storage');
const { buildArticle } = require('../lib/build');
const { digest, guideHash, audioCacheHash } = require('../lib/source');
const { toneWave, validateGuide } = require('../lib/providers');

const rawStorage = { provider: 'b2', b2: { key_id: 'test-id', key: 'test-secret', bucket: 'test-bucket',
  bucket_id: 'test-bucket-id', region: 'us-east-005', public_base: 'https://cdn.example.com/assets', prefix: 'voice/中文' } };

async function fixture(t, { cleanup = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-storage-'));
  if (cleanup) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const audio = toneWave(2);
  const result = { audio, audioHash: digest(audio), extension: 'wav' };
  const config = resolveConfig({ storage: rawStorage });
  const files = new Map(), calls = [], state = { uploaded: 0, publicFailure: false, infoFailure: false, publicHeaderFailure: false, publicAudio: audio };
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('b2_authorize_account')) return Response.json({ authorizationToken: 'account-token', apiInfo: {
      storageApi: { apiUrl: 'https://api001.backblazeb2.com', allowed: {
        capabilities: ['readFiles', 'writeFiles', 'listFiles'], buckets: [{ id: 'test-bucket-id', name: 'test-bucket' }], namePrefix: null
      } }
    } });
    const body = options.body && !Buffer.isBuffer(options.body) ? JSON.parse(options.body) : null;
    if (url.endsWith('b2_list_file_names')) return Response.json({ files: [...files.values()].filter(file => file.fileName === body.prefix) });
    if (url.endsWith('b2_get_upload_url')) return Response.json({ bucketId: 'test-bucket-id', uploadUrl: 'https://pod001.backblaze.com/upload', authorizationToken: 'upload-token' });
    if (url.endsWith('/upload')) {
      state.publicAudio = options.body;
      assert.equal(options.headers['X-Bz-Content-Sha1'], createHash('sha1').update(options.body).digest('hex'));
      assert.equal(Number(options.headers['Content-Length']), options.body.length);
      assert.equal(options.headers['X-Bz-Info-b2-cache-control'], 'public%2C%20max-age%3D31536000%2C%20immutable');
      const file = { fileName: decodeURIComponent(options.headers['X-Bz-File-Name']), contentLength: options.body.length,
        contentSha1: options.headers['X-Bz-Content-Sha1'], action: 'upload', bucketId: 'test-bucket-id', fileId: 'file-' + ++state.uploaded };
      files.set(file.fileName, file);
      return Response.json(file);
    }
    if (url.endsWith('b2_get_file_info')) {
      const file = [...files.values()].find(file => file.fileId === body.fileId);
      return Response.json(state.infoFailure ? { ...file, contentSha1: 'wrong' } : file);
    }
    assert.equal(options.headers.Authorization, undefined);
    if (state.publicFailure) return new Response('unavailable', { status: 503 });
    return new Response(state.publicAudio.subarray(0, 64), { status: 206, headers: { 'Content-Range': `bytes 0-63/${state.publicHeaderFailure ? state.publicAudio.length + 1 : state.publicAudio.length}` } });
  };
  const publisher = createAudioPublisher(config.storage, { fetcher });
  return { directory, result, config, files, calls, state, fetcher, publisher };
}

test('默认本地不访问存储，切换存储、域名和密钥不使文稿及语音缓存失效', async t => {
  const { result, config, directory } = await fixture(t);
  const defaults = resolveConfig();
  assert.equal(defaults.storage.provider, 'local');
  assert.equal(await createAudioPublisher(defaults.storage, { fetcher: () => assert.fail('本地不能访问 B2') }).publish(result, directory), result);
  const post = { title: '文章' }, sources = [{ id: 'one', text: '正文' }], guide = { text: '导读' };
  assert.equal(guideHash(post, sources, config), guideHash(post, sources, defaults));
  assert.equal(audioCacheHash(guide, config), audioCacheHash(guide, defaults));
  assert.throws(() => createAudioPublisher({ provider: 'unknown' }), /只支持 local 或 b2/);
});

test('B2 上传后回读文件信息并验证公开 URL，二次编译零请求，换域名只验证新地址', async t => {
  const { publisher, directory, result, calls, state, config, fetcher } = await fixture(t);
  const first = await publisher.publish(result, directory);
  assert.equal(first.audioUrl, `https://cdn.example.com/assets/voice/%E4%B8%AD%E6%96%87/${result.audioHash}.wav`);
  assert.equal(state.uploaded, 1);
  assert.ok(calls.some(call => call.url.endsWith('b2_get_file_info')));
  const count = calls.length;
  assert.equal((await publisher.publish(result, directory)).audioUrl, first.audioUrl);
  assert.equal(calls.length, count);
  const changed = { ...config.storage, b2: { ...config.storage.b2, keyId: '', key: '', publicBase: 'https://new.example.com' } };
  const remote = await createAudioPublisher(changed, { fetcher }).publish(result, directory);
  assert.match(remote.audioUrl, /^https:\/\/new.example.com\/voice\//);
  assert.equal(calls.length, count + 1);
  assert.equal(state.uploaded, 1);
  const receipt = JSON.stringify(await Promise.all((await fs.readdir(path.join(directory, 'storage'))).map(file => fs.readFile(path.join(directory, 'storage', file), 'utf8'))));
  assert.doesNotMatch(receipt, /test-secret|test-id|account-token|upload-token/);
});

test('清除上传记录后查重远程对象，不重复上传；离线模式不执行网络', async t => {
  const { publisher, directory, result, state, calls, config, fetcher } = await fixture(t);
  const first = await publisher.publish(result, directory);
  for (const file of await fs.readdir(path.join(directory, 'storage'))) await fs.unlink(path.join(directory, 'storage', file));
  const fresh = createAudioPublisher(config.storage, { fetcher });
  assert.equal((await fresh.publish(result, directory)).audioUrl, first.audioUrl);
  assert.equal(state.uploaded, 1);
  const count = calls.length;
  await fresh.publish(result, directory, { allowUpload: false });
  assert.equal(calls.length, count);
  for (const file of await fs.readdir(path.join(directory, 'storage'))) await fs.unlink(path.join(directory, 'storage', file));
  await assert.rejects(fresh.publish(result, directory, { allowUpload: false }), /缺少已验证/);
  assert.equal(calls.length, count);
});

test('公开地址失败保留上传记录，下次仅补验证；信息回读错误不宣称上传成功', async t => {
  const { publisher, directory, result, state, calls } = await fixture(t);
  state.publicFailure = true;
  await assert.rejects(publisher.publish(result, directory), /HTTP 503/);
  assert.equal(state.uploaded, 1);
  state.publicFailure = false;
  const count = calls.length;
  await publisher.publish(result, directory);
  assert.equal(state.uploaded, 1);
  assert.equal(calls.length, count + 1);
  const { publisher: broken, directory: other, result: otherResult, state: brokenState } = await fixture(t);
  brokenState.infoFailure = true;
  await assert.rejects(broken.publish(otherResult, other), /回读校验失败/);
  await assert.rejects(fs.access(path.join(other, 'storage')));
});

test('无效地址、权限及超时错误不泄露凭据，已发布地址不被上传器覆盖', async t => {
  const { directory, result, config, publisher, calls } = await fixture(t);
  const published = { published: true, audioUrl: 'https://existing.example.com/voice.wav' };
  assert.equal(await publisher.publish(published, directory), published);
  assert.equal(calls.length, 0);
  for (const publicBase of ['http://cdn.example.com', 'https://user:password@cdn.example.com', 'https://cdn.example.com?secret=1']) {
    const invalid = createAudioPublisher({ ...config.storage, b2: { ...config.storage.b2, publicBase } });
    await assert.rejects(invalid.publish(result, directory), /public_base/);
  }
  const failed = createAudioPublisher(config.storage, { fetcher: async () => { throw Error('test-secret account-token'); } });
  await assert.rejects(failed.publish(result, directory), error => error.code === 'AI_READER_STORAGE' && !/test-secret|account-token/.test(error.message));
  const denied = createAudioPublisher(config.storage, { fetcher: async () => Response.json({ authorizationToken: 'token', apiInfo: { storageApi: { apiUrl: 'https://api001.backblazeb2.com', allowed: { capabilities: ['writeFiles'], buckets: null } } } }) });
  await assert.rejects(denied.publish(result, directory), /权限/);
});

test('存储发布失败保留旧版指针，已生成文稿和音频下次只补上传', async t => {
  const { directory, config, state, publisher } = await fixture(t);
  const sources = [{ id: 'one', tag: 'p', text: '正文。' }];
  const guide = validateGuide({ title: '导读', segments: [{ id: 'g-one', text: '正文导读。', sourceIds: ['one'] }] }, sources, 800);
  const counters = { llm: 0, tts: 0 };
  const options = { directory, config, publisher, post: { title: '文章', source: '_posts/test.md' }, sources, generate: true,
    services: { generateGuide: async () => { counters.llm++; return guide; }, synthesize: async () => { counters.tts++; return { audio: toneWave(2), extension: 'wav', sentences: [] }; } } };
  state.publicFailure = true;
  await assert.rejects(buildArticle(options), /HTTP 503/);
  await assert.rejects(fs.access(path.join(directory, 'ready-live.json')));
  state.publicFailure = false;
  const first = await buildArticle(options);
  assert.equal(first.cached, true);
  assert.deepEqual(counters, { llm: 1, tts: 1 });
  assert.ok(first.audioUrl);
  const old = await fs.readFile(path.join(directory, 'ready-live.json'), 'utf8');
  options.services.synthesize = async () => ({ audio: toneWave(3), extension: 'wav', sentences: [] });
  const failingPublisher = { publish: async () => { throw Error('上传失败'); } };
  await assert.rejects(buildArticle({ ...options, force: true, publisher: failingPublisher }), /上传失败/);
  assert.equal(await fs.readFile(path.join(directory, 'ready-live.json'), 'utf8'), old);
  assert.equal((await buildArticle({ ...options, generate: false })).audioUrl, first.audioUrl);
});

test('真实 Hexo 默认输出本地音频，切换 B2 自动上传并只发布远程引用，切回本地和 clean 都复用缓存', async t => {
  const Hexo = require('hexo'), yaml = require('js-yaml'), register = require('../lib/plugin');
  const { directory, fetcher, state, calls } = await fixture(t, { cleanup: false });
  const hexo = new Hexo(directory, { safe: true, silent: true });
  const originalFetch = global.fetch;
  global.fetch = fetcher;
  t.after(async () => { global.fetch = originalFetch; try { await hexo.exit(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  await fs.mkdir(path.join(directory, 'source/_posts'), { recursive: true });
  await fs.mkdir(path.join(directory, 'themes/test/layout'), { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'storage-test', hexo: { version: '8.1.2' } }));
  await fs.writeFile(path.join(directory, '_config.yml'), yaml.dump({ theme: 'test', url: 'https://example.com/blog', root: '/blog/',
    permalink: ':title/', ai_reader: { enabled: true, mode: 'mock', mock_voice: '__no_installed_voice__' } }));
  await fs.writeFile(path.join(directory, 'themes/test/_config.yml'), '');
  await fs.writeFile(path.join(directory, 'themes/test/layout/post.ejs'), '<html><head></head><body><%- page.content %></body></html>');
  const markdown = '---\ntitle: test\ndate: 2026-10-05 12:00:00\nai_reader: true\n---\n这是公开文章的正文。';
  const postFile = path.join(directory, 'source/_posts/test.md');
  await fs.writeFile(postFile, markdown);
  await hexo.init();
  await hexo.loadPlugin(require.resolve('hexo-renderer-marked'));
  await hexo.loadPlugin(require.resolve('hexo-renderer-ejs'));
  register(hexo);
  await hexo.call('generate', {});
  const key = require('../lib/source').articleKey({ source: '_posts/test.md', slug: 'test' });
  const readManifest = async () => JSON.parse(await fs.readFile(path.join(directory, 'public/ai-reader', key, 'manifest.json')));
  const local = await readManifest();
  assert.match(local.audio, /^\/blog\/ai-reader\//);
  assert.equal(calls.length, 0);
  const audioPath = path.join(directory, 'public/ai-reader', key, 'narration.wav');
  const originalAudio = await fs.readFile(audioPath);
  hexo.config.ai_reader.storage = rawStorage;
  await hexo.call('generate', {});
  const remote = await readManifest();
  assert.match(remote.audio, /^https:\/\/cdn.example.com\/assets\//);
  assert.equal(state.uploaded, 1);
  await assert.rejects(fs.access(audioPath));
  const publicText = JSON.stringify(remote) + await fs.readFile(path.join(directory, 'public/test/index.html'), 'utf8');
  assert.doesNotMatch(publicText, /test-secret|test-id|account-token|upload-token|keyId|bucketId/);
  const count = calls.length;
  await hexo.call('generate', {});
  assert.equal(calls.length, count);
  hexo.config.ai_reader.storage = { provider: 'local' };
  await hexo.call('generate', {});
  assert.equal((await readManifest()).audio, local.audio);
  assert.deepEqual(await fs.readFile(audioPath), originalAudio);
  await hexo.call('clean', {});
  await hexo.call('generate', {});
  assert.deepEqual(await fs.readFile(audioPath), originalAudio);
  assert.equal(calls.length, count);
  assert.equal(await fs.readFile(postFile, 'utf8'), markdown);
});
