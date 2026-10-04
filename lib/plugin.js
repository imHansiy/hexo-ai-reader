'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveConfig } = require('./config');
const { annotate, stripReader, articleKey, digest } = require('./source');
const { buildArticle } = require('./build');
const { withPreparationLock } = require('./lock');
const { loadEnvironment } = require('./environment');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rootUrl = (root, route) => `${String(root || '/').replace(/\/?$/, '/')}${route}`;

function eligible(post, config, hexoConfig) {
  const tags = post.tags?.toArray ? post.tags.toArray().map(tag => tag.name) : (post.tags || []);
  const protectedTag = (hexoConfig.encrypt?.tags || []).some(tag => tag.password && tags.includes(tag.name));
  if (post.layout !== 'post' || post.published === false || post.password || post.encrypt || protectedTag || /id=["']hexo-blog-encrypt/.test(post.content || '')) return false;
  if (!config.enabled || post.ai_reader === false) return false;
  if (post.ai_reader === true || (post.ai_reader && typeof post.ai_reader === 'object')) return true;
  return config.defaultEnabled || config.include.includes(post.source) || config.include.includes(post.slug);
}

function playerHtml(url, manifest, config, root) {
  const svg = (content, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
  const avatar = config.player.avatar;
  const avatarUrl = /^https?:\/\//i.test(avatar) ? avatar : (/^\/(?!\/)/.test(avatar) ? rootUrl(root, avatar.slice(1)) : '');
  const portrait = `<img src="${escape(avatarUrl || rootUrl(root, 'ai-reader/avatar.webp'))}" alt="" width="80" height="80" loading="eager" decoding="async">`;
  const waves = '<span class="ai-reader__waves" aria-hidden="true">' + '<i></i>'.repeat(9) + '</span>';
  const directory = manifest.segments.map((segment, index) => {
    const seconds = Math.floor(segment.start);
    const stamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    return `<li><button type="button" data-ai-segment="${index}" aria-label="从 ${stamp} 播放：${escape(segment.text)}" title="${escape(segment.text)}" disabled><span class="ai-reader__directory-icon" aria-hidden="true">${svg('<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>')}</span><time>${stamp}</time><span class="ai-reader__directory-text">${escape(segment.text)}</span></button></li>`;
  }).join('');
  return `<section class="ai-reader" data-ai-reader-manifest="${escape(url)}" aria-label="海灵 AI 语音导读">
  <button type="button" class="ai-reader__portrait" data-ai-avatar aria-label="展开导读目录" title="展开导读目录"><span class="ai-reader__portrait-crop">${portrait}</span><span class="ai-reader__avatar-badge">${waves}</span></button>
  <div class="ai-reader__bubble" data-ai-bubble>
    <div class="ai-reader__actions">
      <button type="button" data-ai-toggle aria-label="展开导读目录" aria-expanded="false" title="展开导读目录">${svg('<path d="M14 3h7v7M21 3l-9 9M10 5H5v14h14v-5"/>')}</button>
      <button type="button" data-ai-minimize aria-label="最小化导读播放器" title="最小化，继续播放">${svg('<path d="M6 12h12"/>')}</button>
      <button type="button" data-ai-close aria-label="关闭导读播放器" title="暂停并收起">${svg('<path d="m6 6 12 12M6 18 18 6"/>')}</button>
    </div>
    <div class="ai-reader__summary">
      <div class="ai-reader__greeting"><span data-ai-greeting>海灵陪你读</span><span class="ai-reader__sparkle" aria-hidden="true">✦</span><span class="ai-reader__voice">${waves}</span></div>
      <button type="button" class="ai-reader__text" data-ai-text title="点击定位到对应正文">点击播放，跟着导读看正文</button>
      <div class="ai-reader__completion" hidden data-ai-completion><strong>导读已播放完成</strong><span>感谢你的聆听 <b>♥</b></span></div>
      <div class="ai-reader__playback">
        <div class="ai-reader__timeline"><input data-ai-progress type="range" min="0" max="${manifest.duration}" step="0.1" value="0" aria-label="导读播放进度" disabled><span data-ai-time>00:00 / 00:00</span></div>
        <select data-ai-rate aria-label="导读播放速度" disabled><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
        <button type="button" class="ai-reader__play" data-ai-play data-play-state="play" aria-label="播放 AI 语音导读" title="播放 AI 语音导读" disabled>${svg('<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>', 'ai-reader__icon-play')}${svg('<path d="M8 6v12M16 6v12" stroke-width="3.5"/>', 'ai-reader__icon-pause')}${svg('<path d="M3 11a9 9 0 1 1 3 8M3 5v6h6"/>', 'ai-reader__icon-replay')}</button>
      </div>
      <span class="ai-reader__subtitle" data-ai-subtitle role="status">听一听这篇文章</span>
    </div>
    <div class="ai-reader__details" data-ai-details hidden>
      <div class="ai-reader__directory-heading"><strong>导读目录 <span data-ai-count>(${manifest.segments.length})</span></strong><span data-ai-chapter>01 / ${String(manifest.segments.length).padStart(2, '0')}</span><button type="button" data-ai-settings-toggle aria-expanded="false">设置</button></div>
      <ol class="ai-reader__directory" data-ai-directory aria-label="导读目录">${directory}</ol>
      <div data-ai-settings hidden><div class="ai-reader__options"><button type="button" data-ai-skip="-10" aria-label="后退 10 秒" disabled>↶ 10 秒</button><button type="button" data-ai-skip="10" aria-label="前进 10 秒" disabled>10 秒 ↷</button><button type="button" data-ai-captions-toggle aria-pressed="${config.player.captions}" aria-label="${config.player.captions ? '关闭' : '开启'}导读字幕">字幕</button><label><input data-ai-follow type="checkbox" ${config.player.auto_scroll ? 'checked' : ''}><span class="ai-reader__switch" aria-hidden="true"></span>正文跟随</label></div>
      <div class="ai-reader__footer"><span data-ai-status>正在加载…</span><span class="ai-reader__badge">${manifest.mode === 'mock' ? '演示语音' : 'AI 语音'}</span></div></div>
    </div>
  </div>
  <audio preload="none"></audio><noscript>启用 JavaScript 后可使用同步高亮；<a href="${escape(manifest.audio)}">下载导读音频</a>。</noscript>
</section>`;
}

async function readerConfig(hexo, prepare = false) {
  // 参数只来自 Hexo 已加载的配置，多文件合并交给 Hexo 的 --config。
  const raw = hexo.config.ai_reader || {};
  const provider = raw.tts?.provider || 'qwen3';
  const required = [raw.llm?.base_url, raw.llm?.api_key, raw.llm?.model];
  if (provider === 'dashscope') required.push(raw.tts?.api_key, raw.tts?.voice);
  const needsEnvironment = /\$\{[A-Z0-9_]+\}/.test(JSON.stringify(raw)) ||
    required.some(value => !value);
  if (raw.enabled && (raw.auto_generate !== false || prepare) &&
      (raw.mode || process.env.AI_READER_MODE || 'live') !== 'mock' && needsEnvironment) {
    // 可选的本地密钥来源；完整 YAML 配置无需此文件。
    loadEnvironment(path.join(hexo.base_dir, '.env.ai-reader'));
  }
  return resolveConfig(raw, hexo.base_dir);
}

module.exports = function register(hexo) {
  if (hexo.__aiReaderRegistered) return;
  hexo.__aiReaderRegistered = true;
  let routes = [];
  let renderedPosts = new Map();
  const assetVersions = {};
  let preparation = null;
  // 在 Hexo 自身 render_post 之后运行；每次生成都检查缓存，兼容 db.json 命中。
  hexo.extend.filter.register('before_generate', async function () {
    routes = [];
    renderedPosts = new Map();
    const config = await readerConfig(hexo, !!preparation);
    const posts = hexo.model('Post').toArray();
    const started = Date.now();
    const stats = { selected: 0, ready: 0, guides: 0, audio: 0, missing: 0, failed: 0, fallback: 0 };
    if (preparation) preparation.stats = stats;
    const processPosts = async () => {
      for (const post of posts) {
        if (!post.content) continue;
        const originalContent = post.content;
        post.content = stripReader(post.content);
        if (post.content !== originalContent) await post.save();
        renderedPosts.set(post.source, post.content);
        if (!eligible(post, config, hexo.config)) continue;
        const generate = preparation ? (!preparation.post || [post.source, post.slug].includes(preparation.post)) : config.autoGenerate;
        if (generate) stats.selected++;
        let failureCounted = false;
        try {
          if (!['live', 'mock'].includes(config.mode)) throw new Error('mode 只能为 live 或 mock');
          const { html, sources } = annotate(post.content);
          if (!sources.length) throw new Error('正文没有可导读段落');
          const key = articleKey(post);
          const fixture = config.mode === 'mock' ? hexo.locals.get('data')?.ai_reader_mock?.[post.source] : undefined;
          const directory = path.resolve(hexo.base_dir, config.cacheDir, key);
          const options = { post, sources, config, fixture, directory };
          let result;
          try { result = await buildArticle({ ...options, generate, force: generate && preparation?.force === true }); }
          catch (error) {
            if (!generate) throw error;
            stats.failed++;
            failureCounted = true;
            let message = String(error.message || '未知错误');
            for (const secret of [config.llm.apiKey, config.tts.apiKey]) if (secret) message = message.split(secret).join('[已隐藏]');
            hexo.log.warn(`[hexo-ai-reader] 准备失败 ${post.title}：${message}`);
            result = await buildArticle(options);
            stats.fallback++;
          }
          stats.ready++;
          if (!result.guideCached) stats.guides++;
          if (!result.audioCached) stats.audio++;
          const base = `ai-reader/${key}`;
          const audioPath = `${base}/narration.${result.extension}`;
          const manifestPath = `${base}/manifest.json`;
          const manifest = {
            version: 1, article: key, title: result.guide.title, mode: config.mode,
            audio: `${rootUrl(hexo.config.root, audioPath)}?v=${result.audioHash.slice(0, 16)}`,
            duration: result.duration, alignment: result.alignment, mockAudio: result.mockAudio,
            segments: result.segments, captions: result.captions, captionAlignment: result.captionAlignment, player: config.player
          };
          const manifestJson = JSON.stringify(manifest);
          const manifestUrl = `${rootUrl(hexo.config.root, manifestPath)}?v=${digest(manifestJson).slice(0, 16)}`;
          renderedPosts.set(post.source, `${playerHtml(manifestUrl, manifest, config, hexo.config.root)}<div data-ai-reader-body>${html}</div>`);
          routes.push({ path: audioPath, data: result.audio }, { path: manifestPath, data: manifestJson });
          hexo.log.info(`[hexo-ai-reader] ${post.title}：${result.migrated ? '旧缓存已迁移' : result.cached ? '命中缓存' : '准备完成'}，${Math.round(result.duration)} 秒，${result.alignment.method}`);
          if (result.mockAudio === 'test-tone') hexo.log.warn('[hexo-ai-reader] 本机无可用系统语音，Mock 使用提示音；真实模式不受影响');
        } catch (error) {
          if (error.code === 'AI_READER_CACHE_MISS') stats.missing++;
          if (!failureCounted && (generate || error.code !== 'AI_READER_CACHE_MISS')) stats.failed++;
          // 仅报告已知的诊断文本；删除任何已配置凭据，避免底层错误意外回显。
          let message = String(error.message || '未知错误');
          for (const secret of [config.llm.apiKey, config.tts.apiKey]) if (secret) message = message.split(secret).join('[已隐藏]');
          hexo.log.warn(`[hexo-ai-reader] 跳过 ${post.title}：${message}`);
        }
      }
      if (config.enabled) {
        for (const file of ['reader.js', 'reader.css', 'avatar.webp']) {
          const data = await fs.readFile(path.join(__dirname, '..', 'assets', file));
          assetVersions[file] = digest(data).slice(0, 12);
          routes.push({ path: `ai-reader/${file}`, data });
        }
        hexo.log.info(`[hexo-ai-reader] ${preparation?.force ? '强制生成' : preparation ? '准备' : config.autoGenerate ? '自动生成' : '离线构建'}完成：可用 ${stats.ready} 篇，生成文稿 ${stats.guides} 篇、音频 ${stats.audio} 篇，缺缓存 ${stats.missing} 篇，失败 ${stats.failed} 篇${stats.fallback ? `，保留旧版 ${stats.fallback} 篇` : ''}，耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
      }
    };
    if (config.enabled && config.autoGenerate && !preparation) {
      await withPreparationLock(path.resolve(hexo.base_dir, config.cacheDir), processPosts);
    } else await processPosts();
  }, 100);

  hexo.extend.generator.register('ai-reader', () => routes);
  // 在最终模板上下文中替换正文，兼容 hexo-hide-posts 等提前快照 locals 的插件。
  // 只装饰文章页，避免播放器污染首页摘要、搜索索引和 RSS。
  hexo.extend.filter.register('template_locals', locals => {
    if (renderedPosts.has(locals.page?.source)) locals.page.content = renderedPosts.get(locals.page.source);
    return locals;
  }, 100);
  // 所有页面都有轻量初始化脚本，因此从首页 PJAX 进入文章也可以正常启动。
  hexo.extend.filter.register('after_render:html', html => {
    if (!resolveConfig(hexo.config.ai_reader).enabled || html.includes('data-ai-reader-runtime')) return html;
    const css = escape(rootUrl(hexo.config.root, 'ai-reader/reader.css'));
    const js = escape(rootUrl(hexo.config.root, 'ai-reader/reader.js'));
    return html.replace('</head>', `<link rel="stylesheet" href="${css}?v=${assetVersions['reader.css'] || '1'}" data-ai-reader-runtime></head>`)
      .replace('</body>', `<script src="${js}?v=${assetVersions['reader.js'] || '1'}" defer data-ai-reader-runtime></script></body>`);
  }, 30);

  hexo.extend.console.register('ai-reader', '生成导读或清除单篇缓存', {
    usage: 'ai-reader (--prepare | --force) [--post <source 或 slug>] | --clear <source 或缓存目录名>',
    options: [{ name: '--prepare', desc: '允许生成导读，并生成站点' },
      { name: '--force', desc: '重新生成文稿和语音，成功后切换版本' },
      { name: '--post', desc: '仅生成指定文章，例如 _posts/example.md' },
      { name: '--clear', desc: '清除文章的所有缓存版本' }]
  }, async args => {
    if ((args.prepare || args.force) && args.clear) throw new Error('--prepare/--force 和 --clear 不能同时使用');
    if (args.prepare || args.force) {
      if (preparation) throw new Error('同一进程不能同时准备两份导读');
      if (args.post !== undefined && (typeof args.post !== 'string' || !args.post)) throw new Error('--post 需要文章 source 或 slug');
      const run = { post: args.post, force: args.force === true };
      preparation = run;
      try {
        const config = await readerConfig(hexo, true);
        await withPreparationLock(path.resolve(hexo.base_dir, config.cacheDir), async () => {
          await hexo.call('generate', {});
          if (!run.stats?.selected) throw new Error('没有匹配且已开启导读的公开文章');
          if (run.stats.failed) throw new Error(`${run.stats.failed} 篇导读准备失败；详情见前面的日志`);
        });
      } finally { preparation = null; }
      return;
    }
    if (typeof args.clear !== 'string' || !args.clear) throw new Error('用法：hexo ai-reader --prepare、--force 或 --clear _posts/example.md');
    const directory = path.resolve(hexo.base_dir, (await readerConfig(hexo)).cacheDir);
    await withPreparationLock(directory, async () => {
      const sourceSuffix = `-${require('./source').digest(args.clear).slice(0, 10)}`;
      const entries = await fs.readdir(directory);
      const matches = entries.filter(name => !name.startsWith('.') && (name === args.clear || name.endsWith(sourceSuffix)));
      for (const name of matches) await fs.rm(path.join(directory, name), { recursive: true, force: true });
      hexo.log.info(`[hexo-ai-reader] 已清除 ${matches.length} 篇文章的缓存；下次自动编译或 --prepare 重新生成`);
    });
  });
};

module.exports.eligible = eligible;
