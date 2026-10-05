'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Hexo = require('hexo');
const yaml = require('js-yaml');
const { buildArticle } = require('../lib/build');
const { resolveConfig } = require('../lib/config');
const { annotate, sourceHash, digest, articleKey } = require('../lib/source');
const { toneWave } = require('../lib/providers');
const register = require('../lib/plugin');

function fixture() {
  const sources = [{ id: 'p-one', tag: 'p', text: '公开正文。' }];
  const post = { title: '文章', source: '_posts/test.md' };
  const guide = { title: '导读', segments: [{ id: 'guide-1', text: '我陪你理解公开正文。', sourceIds: ['p-one'] }] };
  post.ai_reader = { generated: { version: 1, source_hash: sourceHash(post, sources), audio_key: 'a'.repeat(64),
    audio: { url: 'https://cdn.example.com/files/audio.wav', sha256: 'b'.repeat(64), duration: 2,
      text_hash: digest(guide.segments[0].text) }, guide } };
  return { post, sources, config: resolveConfig({ enabled: true }), guide };
}

test('已发布导读不需要缓存、凭据或克隆参考；不请求远程音频', async t => {
  const options = fixture();
  options.directory = path.join(os.tmpdir(), `reader-no-cache-${crypto.randomUUID()}`);
  const oldFetch = global.fetch;
  global.fetch = () => { throw new Error('禁止网络调用'); };
  t.after(() => { global.fetch = oldFetch; });
  const result = await buildArticle({ ...options, generate: true });
  assert.equal(result.published, true);
  assert.equal(result.audioUrl, options.post.ai_reader.generated.audio.url);
  assert.equal(result.audio, undefined);
  assert.equal(result.guide.text, options.guide.segments[0].text);
  assert.equal(result.captions.at(-1).end, 2);
  await assert.rejects(fs.access(options.directory));
});

test('正文或标题变化不能使用已发布旧稿；损坏数据不能触发隐式网络调用', async t => {
  const options = fixture();
  options.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-published-invalid-'));
  t.after(() => fs.rm(options.directory, { recursive: true, force: true }));
  const original = structuredClone(options.post.ai_reader.generated);
  for (const mutate of [
    record => { record.version = 99; },
    record => { record.audio.duration = 0; },
    record => { record.audio.sha256 = 'invalid'; },
    record => { record.audio.url = 'javascript:alert(1)'; },
    record => { record.audio.url = 'https://secret@cdn.example.com/audio.wav'; },
    record => { record.audio.url += '?api_key=secret'; },
    record => { record.guide.segments[0].text += '未同步的修改'; },
    record => { record.guide.segments[0].sourceIds = ['missing']; }
  ]) {
    options.post.ai_reader.generated = structuredClone(original);
    mutate(options.post.ai_reader.generated);
    await assert.rejects(buildArticle({ ...options, generate: true }), { code: 'AI_READER_PUBLISHED_INVALID' });
  }
  options.post.ai_reader.generated = original;
  options.post.title += '修改';
  await assert.rejects(buildArticle(options), { code: 'AI_READER_CACHE_MISS' });
  options.post.title = '文章';
  options.sources.push({ id: 'p-new', tag: 'p', text: '新增正文。' });
  await assert.rejects(buildArticle(options), { code: 'AI_READER_CACHE_MISS' });
});

test('强制生成绕过已发布数据，失败保留远程旧版，成功后普通编译复用新本地版本', async t => {
  const options = fixture();
  options.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-published-force-'));
  t.after(() => fs.rm(options.directory, { recursive: true, force: true }));
  options.config = resolveConfig({ enabled: true, tts: { provider: 'dashscope' } });
  let guides = 0, speech = 0;
  options.services = {
    async generateGuide() { guides++; return { ...options.guide, segments: [{ ...options.guide.segments[0], text: '新的导读。' }] }; },
    async synthesize() { speech++; throw new Error('供应商失败'); }
  };
  await assert.rejects(buildArticle({ ...options, generate: true, force: true }), /供应商失败/);
  assert.equal((await buildArticle({ ...options, generate: true })).published, true);
  options.services.synthesize = async () => { speech++; return { audio: toneWave(2), extension: 'wav', sentences: [] }; };
  const forced = await buildArticle({ ...options, generate: true, force: true });
  const next = await buildArticle({ ...options, generate: true });
  assert.equal(next.hash, forced.hash);
  assert.equal(next.guide.text, '新的导读。');
  assert.deepEqual({ guides, speech }, { guides: 2, speech: 2 });
  await fs.rm(options.directory, { recursive: true, force: true });
  assert.equal((await buildArticle(options)).published, true);
});

test('全新 Hexo 编译读取文章内导读，保护文章仍排除，正文文件不被改写', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexo-published-reader-'));
  const hexo = new Hexo(directory, { safe: true, silent: true });
  const oldFetch = global.fetch;
  global.fetch = () => { throw new Error('禁止网络调用'); };
  try {
    await fs.mkdir(path.join(directory, 'source/_posts'), { recursive: true });
    await fs.mkdir(path.join(directory, 'themes/test/layout'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'published-reader-test', hexo: { version: '8.1.2' } }));
    await fs.writeFile(path.join(directory, '_config.yml'), 'theme: test\nurl: https://example.com/blog\nroot: /blog/\npermalink: :title/\nai_reader:\n  enabled: true\n');
    await fs.writeFile(path.join(directory, 'themes/test/_config.yml'), '');
    await fs.writeFile(path.join(directory, 'themes/test/layout/post.ejs'), '<html><head></head><body><%- page.content %></body></html>');
    await hexo.init();
    await hexo.loadPlugin(require.resolve('hexo-renderer-marked'));
    await hexo.loadPlugin(require.resolve('hexo-renderer-ejs'));
    const body = '公开正文。';
    const { sources } = annotate(await hexo.render.render({ text: body, engine: 'md' }));
    const { post } = fixture();
    post.title = 'test';
    post.ai_reader.generated.source_hash = sourceHash(post, sources);
    post.ai_reader.generated.guide.segments[0].sourceIds = [sources[0].id];
    const file = path.join(directory, 'source/_posts/test.md');
    const markdown = `---\n${yaml.dump({ title: post.title, date: '2026-10-05 12:00:00', ai_reader: post.ai_reader })}---\n${body}`;
    await fs.writeFile(file, markdown);
    await fs.writeFile(path.join(directory, 'source/_posts/protected.md'), markdown.replace('title: test', 'title: protected\npassword: secret'));
    register(hexo);
    await hexo.call('generate', {});
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'public/ai-reader', articleKey({ source: '_posts/test.md', slug: 'test' }), 'manifest.json')));
    assert.equal(manifest.audio, post.ai_reader.generated.audio.url);
    assert.equal(manifest.mode, 'live');
    assert.match(await fs.readFile(path.join(directory, 'public/test/index.html'), 'utf8'), /data-ai-reader-manifest/);
    assert.doesNotMatch(await fs.readFile(path.join(directory, 'public/protected/index.html'), 'utf8'), /data-ai-reader-manifest/);
    assert.equal(await fs.readFile(file, 'utf8'), markdown);
    await assert.rejects(fs.access(path.join(directory, 'public/ai-reader', articleKey({ source: '_posts/test.md', slug: 'test' }), 'narration.wav')));
    await hexo.call('generate', {});
    assert.equal(await fs.readFile(file, 'utf8'), markdown);
  } finally {
    global.fetch = oldFetch;
    await hexo.exit();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
