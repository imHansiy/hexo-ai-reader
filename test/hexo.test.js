'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Hexo = require('hexo');
const register = require('../lib/plugin');

test('真实 Hexo 构建：自动生成、缓存跳过、强制生成、离线开关和关闭', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexo-reader-integration-'));
  const hexo = new Hexo(directory, { safe: true, silent: true });
  try {
    await fs.mkdir(path.join(directory, 'source/_posts'), { recursive: true });
    await fs.mkdir(path.join(directory, 'themes/test/layout'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'reader-test', hexo: { version: '8.1.2' } }));
    await fs.writeFile(path.join(directory, '_config.yml'), 'theme: test\nurl: https://example.com/blog\nroot: /blog/\npermalink: :title/\nai_reader:\n  enabled: true\n  mode: mock\n  mock_voice: __no_installed_voice__\n');
    await fs.writeFile(path.join(directory, 'themes/test/_config.yml'), '');
    await fs.writeFile(path.join(directory, 'themes/test/layout/post.ejs'), '<html><head></head><body><article><%- page.content %></article></body></html>');
    await fs.writeFile(path.join(directory, 'source/_posts/test.md'), '---\ntitle: test\ndate: 2026-09-30 12:00:00\nai_reader: true\n---\n## 第一节\n\n这篇文章用于验证真正的 Hexo 构建和正文高亮。\n\n## 第二节\n\n接下来需要确认模板里可以读到完整的播放器和段落映射。');
    await hexo.init();
    await hexo.loadPlugin(require.resolve('hexo-renderer-marked'));
    await hexo.loadPlugin(require.resolve('hexo-renderer-ejs'));
    hexo.config.ai_reader.narration = { persona: 'private-persona-setting', system_prompt: 'private-system-instruction' };
    register(hexo);
    // 模拟 hide-posts 提前缓存 Warehouse query；插件不能只改另一份文档副本。
    hexo.extend.filter.register('before_generate', () => hexo.locals.set('posts', hexo.model('Post').find({ published: true })), 20);
    await hexo.call('generate', {});
    const readPage = () => fs.readFile(path.join(directory, 'public/test/index.html'), 'utf8');
    assert.match(await readPage(), /data-ai-reader-manifest/);
    await assert.rejects(hexo.call('ai-reader', { prepare: true, post: '_posts/missing.md' }), /没有匹配/);
    await assert.rejects(hexo.call('ai-reader', { prepare: true, clear: '_posts/test.md' }), /不能同时/);
    await hexo.call('ai-reader', { prepare: true, post: '_posts/test.md' });
    const html = await readPage();
    assert.equal((html.match(/data-ai-reader-manifest/g) || []).length, 1);
    assert.match(html, /data-ai-source/);
    assert.match(html, /\/blog\/ai-reader\/reader.js/);
    const key = (await fs.readdir(path.join(directory, '.cache/hexo-ai-reader')))[0];
    const manifestPath = path.join(directory, 'public/ai-reader', key, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(manifest.mode, 'mock');
    assert.equal((html.match(/data-ai-segment=/g) || []).length, manifest.segments.length);
    assert.match(html, /data-ai-minimize/);
    assert.match(html, /data-ai-completion/);
    assert.match(html, /\/blog\/ai-reader\/avatar.webp/);
    await fs.access(path.join(directory, 'public/ai-reader/avatar.webp'));
    await assert.rejects(fs.access(path.join(directory, 'public/ai-reader/design/reader-reference.png')));
    assert.ok(manifest.captions.length >= manifest.segments.length);
    assert.equal(manifest.captions[0].start, 0);
    assert.equal(manifest.captions.at(-1).end, manifest.duration);
    assert.doesNotMatch(html, /data-ai-captions-toggle/);
    assert.equal(manifest.player.captions, undefined);
    assert.ok(manifest.audio.startsWith('/blog/ai-reader/'));
    assert.doesNotMatch(JSON.stringify(manifest), /api_key|workspace_id|voice-test|Bearer/);
    assert.doesNotMatch(JSON.stringify(manifest) + html, /private-persona-setting|private-system-instruction|systemPrompt/);
    const ready = JSON.parse(await fs.readFile(path.join(directory, '.cache/hexo-ai-reader', key, 'ready-mock.json'), 'utf8'));
    const cachedAudio = path.join(directory, '.cache/hexo-ai-reader', key, 'audio', ready.audioKey, 'narration.wav');
    const before = (await fs.stat(cachedAudio)).mtimeMs;
    await hexo.call('generate', {});
    assert.equal((await fs.stat(cachedAudio)).mtimeMs, before);
    assert.equal(((await readPage()).match(/data-ai-reader-manifest/g) || []).length, 1);
    for (const [avatar, expected] of [
      ['/images/reader-avatar.webp', '/blog/images/reader-avatar.webp'],
      ['https://images.example.com/avatar.webp', 'https://images.example.com/avatar.webp'],
      ['javascript:alert(1)', '/blog/ai-reader/avatar.webp'],
      ['', '/blog/ai-reader/avatar.webp']
    ]) {
      hexo.config.ai_reader.player = { avatar, name: '小读<伙伴>', title: '小读 & 陪你读' };
      await hexo.call('generate', {});
      assert.ok((await readPage()).includes(`src="${expected}"`));
      assert.match(await readPage(), /data-ai-greeting>小读 &amp; 陪你读/);
      assert.match(await readPage(), /aria-label="小读&lt;伙伴&gt; AI 语音导读"/);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, '.cache/hexo-ai-reader', key, 'ready-mock.json'), 'utf8')), ready);
      assert.equal((await fs.stat(cachedAudio)).mtimeMs, before);
    }
    await hexo.call('ai-reader', { prepare: true, post: 'test' });
    assert.equal((await fs.stat(cachedAudio)).mtimeMs, before);
    await hexo.call('ai-reader', { force: true, post: 'test' });
    const forced = JSON.parse(await fs.readFile(path.join(directory, '.cache/hexo-ai-reader', key, 'ready-mock.json'), 'utf8'));
    assert.notEqual(forced.guideKey, ready.guideKey);
    assert.notEqual(forced.audioKey, ready.audioKey);
    const forcedAudio = path.join(directory, '.cache/hexo-ai-reader', key, 'audio', forced.audioKey, 'narration.wav');
    const forcedTime = (await fs.stat(forcedAudio)).mtimeMs;
    await hexo.call('generate', {});
    assert.equal((await fs.stat(forcedAudio)).mtimeMs, forcedTime);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, '.cache/hexo-ai-reader', key, 'ready-mock.json'), 'utf8')).audioKey, forced.audioKey);
    await hexo.call('ai-reader', { clear: '_posts/test.md' });
    hexo.config.ai_reader.auto_generate = false;
    await hexo.call('generate', {});
    assert.doesNotMatch(await readPage(), /data-ai-reader-manifest/);
    hexo.config.ai_reader.auto_generate = true;
    await hexo.call('generate', {});
    assert.match(await readPage(), /data-ai-reader-manifest/);
    // 准备阶段校验失败必须返回失败状态，而普通生成仍可完成。
    hexo.config.ai_reader.mode = 'invalid';
    await assert.rejects(hexo.call('ai-reader', { prepare: true }), /准备失败/);
    hexo.config.ai_reader.mode = 'mock';
    hexo.config.ai_reader.enabled = false;
    await hexo.call('generate', {});
    assert.doesNotMatch(await readPage(), /data-ai-reader-manifest|data-ai-source/);
    assert.match(await readPage(), /真正的 Hexo/);
    const sibling = path.join(directory, '.cache/hexo-ai-reader/another-article');
    await fs.mkdir(sibling);
    await hexo.call('ai-reader', { clear: '_posts/test.md' });
    await assert.rejects(fs.access(cachedAudio));
    await fs.access(sibling);
  } finally {
    await hexo.exit();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
