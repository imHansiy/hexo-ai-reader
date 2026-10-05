(() => {
  'use strict';
  function createProgressStore(getStorage, manifest) {
    const key = `hexo-ai-reader:progress:v1:${manifest.article}`;
    return {
      read() {
        try {
          const record = JSON.parse(getStorage().getItem(key));
          return record?.audio === manifest.audio && record.duration === manifest.duration &&
            Number.isFinite(record.time) && record.time > 0 && record.time < manifest.duration - 1 &&
            Number.isFinite(record.updatedAt) && Date.now() - record.updatedAt < 90 * 86400000 ? record.time : 0;
        } catch { return 0; }
      },
      save(time, completed = false) {
        if (!Number.isFinite(time) || time < 0) return;
        try {
          const storage = getStorage();
          if (completed || time === 0 || time >= manifest.duration - 1) storage.removeItem(key);
          else storage.setItem(key, JSON.stringify({ audio: manifest.audio, duration: manifest.duration,
            time, updatedAt: Date.now() }));
        } catch { /* 存储不可用时正常播放。 */ }
      }
    };
  }

  async function loadManifest(url, signal, { timeout = 12000, fetcher = fetch } = {}) {
    if (signal.aborted) throw signal.reason || new Error('已离开文章');
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => request.abort(new Error('导读加载超时')), timeout);
    try {
      const response = await fetcher(url, { signal: request.signal, cache: 'no-cache' });
      if (!response.ok) throw new Error('导读加载失败');
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  function resolveStaticUrl(value, base, { allowExternalAudio = false } = {}) {
    const url = new URL(value, base);
    const sameOrigin = url.origin === new URL(base).origin;
    const publicAudio = allowExternalAudio && url.protocol === 'https:' && !url.search && !url.hash;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!sameOrigin && !publicAudio)) {
      throw new Error('静态资源地址无效');
    }
    return url.href;
  }

  // 同一份浏览器实现可通过 Node 测试存储失效与请求取消，无需运行模型。
  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { createProgressStore, loadManifest, resolveStaticUrl };
    return;
  }
  if (window.__hexoAIReader) { window.__hexoAIReader.scan(); return; }
  const controllers = new Map();
  let instanceId = 0;
  const preferenceKey = 'hexo-ai-reader:preferences:v1';
  const rates = [0.75, 1, 1.25, 1.5, 2];
  const readPreferences = () => {
    try {
      const value = JSON.parse(localStorage.getItem(preferenceKey)) || {};
      return { rate: rates.includes(value.rate) ? value.rate : 1,
        follow: typeof value.follow === 'boolean' ? value.follow : undefined };
    } catch { return { rate: 1 }; }
  };
  const savePreference = (key, value) => {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ ...readPreferences(), [key]: value })); } catch { /* 存储被禁用时仍可正常使用。 */ }
  };
  const formatTime = value => {
    const seconds = Math.max(0, Math.floor(value || 0));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  // 浏览器会把 currentTime 截到微秒；允许 1ms 误差，避免跳到章节边界后误选上一段。
  const containsTime = (item, time) => time + 0.001 >= item.start && time + 0.001 < item.end;
  const sameOrigin = value => resolveStaticUrl(value, location.href);

  function mount(source) {
    const body = source.nextElementSibling;
    if (!body?.hasAttribute('data-ai-reader-body')) return;
    // 保留文章内的原始节点供 PJAX 缓存；浮层挂到 body，避免主题容器裁切。
    const card = source.cloneNode(true);
    // 主题可能把头像改成懒加载占位图；浮层独立加载，不依赖主题扫描。
    const portrait = card.querySelector('.ai-reader__portrait img');
    if (portrait) {
      for (const attribute of ['src', 'srcset']) {
        const deferred = portrait.getAttribute(`data-${attribute}`);
        if (deferred) { portrait.setAttribute(attribute, deferred); portrait.removeAttribute(`data-${attribute}`); }
      }
      portrait.classList.remove('lazyload', 'lazyloading');
      portrait.loading = 'eager';
    }
    card.removeAttribute('data-ai-reader-manifest');
    card.setAttribute('data-ai-reader-floating', '');
    card.hidden = false;
    source.hidden = true;
    document.body.append(card);
    const life = new AbortController(), audio = card.querySelector('audio');
    const button = card.querySelector('[data-ai-play]'), range = card.querySelector('[data-ai-progress]');
    const rate = card.querySelector('[data-ai-rate]'), skips = [...card.querySelectorAll('[data-ai-skip]')];
    const preferences = readPreferences();
    const time = card.querySelector('[data-ai-time]'), text = card.querySelector('[data-ai-text]');
    const subtitle = card.querySelector('[data-ai-subtitle]'), chapter = card.querySelector('[data-ai-chapter]');
    const greeting = card.querySelector('[data-ai-greeting]'), completion = card.querySelector('[data-ai-completion]');
    const displayName = card.dataset.aiName || '海灵';
    const playerTitle = card.dataset.aiTitle || `${displayName}陪你读`;
    let sentenceKey = '';
    let sentenceAnimation;
    const status = card.querySelector('[data-ai-status]'), follow = card.querySelector('[data-ai-follow]');
    const toggle = card.querySelector('[data-ai-toggle]'), details = card.querySelector('[data-ai-details]');
    details.id = `ai-reader-details-${++instanceId}`;
    toggle.setAttribute('aria-controls', details.id);
    const directory = card.querySelector('[data-ai-directory]');
    const settingsToggle = card.querySelector('[data-ai-settings-toggle]'), settings = card.querySelector('[data-ai-settings]');
    settings.id = `ai-reader-settings-${instanceId}`;
    settingsToggle.setAttribute('aria-controls', settings.id);
    const chapterButtons = [...directory.querySelectorAll('[data-ai-segment]')];
    const sourceMap = new Map([...body.querySelectorAll('[data-ai-source]')].map(el => [el.dataset.aiSource, el]));
    let manifest, active = -1, activeElements = [], manualUntil = 0, ownScrollUntil = 0, needsFollow = false, engaged = false;
    let scrubbing = false, baseStatus = '', failed = false, buffering = false;
    let loading = false, progress, pendingResume = null, lastProgressSave = 0;
    const currentTime = () => pendingResume ?? (audio.currentTime || 0);
    const saveProgress = (force = false) => {
      if (!progress || (!engaged && !force) || (!force && Date.now() - lastProgressSave < 3000)) return;
      progress.save(currentTime(), audio.ended);
      lastProgressSave = Date.now();
    };
    let highlightFrame = 0;
    const listen = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal: life.signal });
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const avatar = card.querySelector('[data-ai-avatar]');
    const bubble = card.querySelector('[data-ai-bubble]');
    let view = 'compact';
    const setView = value => {
      view = value;
      card.classList.toggle('ai-reader--minimized', value === 'minimized');
      card.classList.toggle('ai-reader--expanded', value === 'expanded');
      document.documentElement.classList.toggle('ai-reader-panel-open', !!document.querySelector('[data-ai-reader-floating].ai-reader--expanded'));
      details.hidden = value !== 'expanded';
      bubble.hidden = value === 'minimized';
      toggle.setAttribute('aria-expanded', String(value === 'expanded'));
      toggle.setAttribute('aria-label', value === 'expanded' ? '收起导读目录' : '展开导读目录');
      toggle.title = toggle.getAttribute('aria-label');
      avatar.setAttribute('aria-label', value === 'minimized' ? '展开导读播放器' : value === 'expanded' ? '收起导读目录' : '展开导读目录');
      avatar.title = avatar.getAttribute('aria-label');
    };
    setView('compact');
    listen(settingsToggle, 'click', () => { settings.hidden = !settings.hidden; settingsToggle.setAttribute('aria-expanded', String(!settings.hidden)); });
    listen(toggle, 'click', () => setView(view === 'expanded' ? 'compact' : 'expanded'));
    listen(avatar, 'click', () => setView(view === 'minimized' ? 'compact' : view === 'expanded' ? 'compact' : 'expanded'));
    listen(card.querySelector('[data-ai-minimize]'), 'click', () => { setView('minimized'); avatar.focus(); });
    listen(card.querySelector('[data-ai-close]'), 'click', () => { audio.pause(); engaged = false; clearHighlight(); setView('minimized'); avatar.focus(); });
    listen(card, 'keydown', event => {
      if (event.key === 'Escape') { setView(view === 'expanded' ? 'compact' : 'minimized'); avatar.focus(); }
    });
    // 一次导读对应一个连续区域；列表、引用和代码按完整容器计算边界。
    // 使用正文背后的单一背景层，不包裹/移动正文节点，也不改变排版与点击行为。
    const drawHighlight = () => {
      highlightFrame = 0;
      if (!activeElements.length || !body.isConnected || life.signal.aborted) return;
      const blocks = activeElements.map(el => {
        const container = el.closest('ul,ol,blockquote,figure,pre,table');
        return container && body.contains(container) ? container : el;
      });
      // source 刻意不朗读语法高亮代码，但末段说明后的代码/图片仍属于整块范围。
      let last = blocks.reduce((end, el) => end.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING ? el : end);
      for (let next = last.nextElementSibling; next; next = next.nextElementSibling) {
        if (next.matches('[data-ai-source], [data-ai-reader-ignore], .ai-summary-card') ||
            next.querySelector('[data-ai-source], [data-ai-reader-ignore], .ai-summary-card')) break;
        if (next.matches('script,style,noscript')) continue;
        blocks.push(next);
      }
      const rects = blocks.map(el => el.getBoundingClientRect()).filter(rect => rect.height && rect.width);
      if (!rects.length) { body.classList.remove('ai-reader-has-highlight'); return; }
      const origin = body.getBoundingClientRect();
      const top = Math.min(...rects.map(rect => rect.top)) - origin.top + body.scrollTop;
      const bottom = Math.max(...rects.map(rect => rect.bottom)) - origin.top + body.scrollTop;
      body.style.setProperty('--air-highlight-top', `${top - 12}px`);
      body.style.setProperty('--air-highlight-height', `${bottom - top + 24}px`);
      body.classList.add('ai-reader-has-highlight');
    };
    const scheduleHighlight = () => {
      if (!highlightFrame && activeElements.length && !life.signal.aborted) highlightFrame = requestAnimationFrame(drawHighlight);
    };
    const clearHighlight = () => {
      cancelAnimationFrame(highlightFrame); highlightFrame = 0;
      body.classList.remove('ai-reader-has-highlight');
      body.style.removeProperty('--air-highlight-top'); body.style.removeProperty('--air-highlight-height');
      activeElements.forEach(el => el.classList.remove('ai-reader-active')); activeElements = [];
    };
    clearHighlight();
    // 图片懒加载、字体和响应式换行会改变整段高度，统一重新测量背景。
    const highlightObserver = new ResizeObserver(scheduleHighlight);
    highlightObserver.observe(body);
    listen(body, 'load', scheduleHighlight, { capture: true });
    listen(window, 'resize', scheduleHighlight, { passive: true });
    document.fonts?.ready.then(scheduleHighlight);
    const position = force => {
      if (!manifest || active < 0 || (!force && (!follow.checked || Date.now() < manualUntil))) return;
      const element = sourceMap.get(manifest.segments[active].sourceIds[0]);
      if (!element) return;
      const top = element.getBoundingClientRect().top;
      const target = window.innerHeight * 0.4;
      needsFollow = false;
      if (!force && Math.abs(top - target) < window.innerHeight * 0.1) return;
      ownScrollUntil = Date.now() + 1400;
      window.scrollTo({ top: Math.max(0, window.scrollY + top - target), behavior: reduced() ? 'instant' : 'smooth' });
    };
    const interrupt = event => {
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      if (card.contains(event.target)) return;
      if (event.type === 'scroll' && Date.now() < ownScrollUntil) return;
      manualUntil = Date.now() + (manifest?.player.pause_scroll_ms || 8000);
      needsFollow = true;
      if (event.type !== 'scroll' && Date.now() < ownScrollUntil) {
        ownScrollUntil = 0;
        window.scrollTo({ top: window.scrollY, behavior: 'instant' });
      }
    };
    const update = () => {
      if (!manifest || failed) return;
      const now = currentTime();
      time.textContent = `${formatTime(now)} / ${formatTime(manifest.duration)}`;
      if (!scrubbing) range.value = String(now);
      range.style.setProperty('--air-progress', `${Math.min(100, now / manifest.duration * 100)}%`);
      range.setAttribute('aria-valuetext', `${formatTime(now)}，共 ${formatTime(manifest.duration)}`);
      card.classList.toggle('ai-reader--ended', audio.ended);
      completion.hidden = !audio.ended;
      text.hidden = audio.ended;
      greeting.textContent = failed ? '导读暂不可用' : buffering && !audio.paused ? `${displayName}正在准备声音` : audio.paused ? playerTitle : `${displayName}正在为你解读`;
      const cue = manifest.captions?.find(item => containsTime(item, now));
      const currentSentence = cue?.text || manifest.segments[Math.max(0, active)]?.text || '';
      if (sentenceKey !== currentSentence) {
        sentenceKey = currentSentence;
        text.textContent = currentSentence;
        if (!reduced()) { sentenceAnimation?.cancel(); sentenceAnimation = text.animate([{ opacity: .3, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 300 }); }
      }
      subtitle.textContent = audio.ended ? '已听完 · 再听一次' : engaged
        ? `${audio.paused ? '已暂停' : buffering ? '缓冲中' : '正在导读'} · ${formatTime(now)} / ${formatTime(manifest.duration)}`
        : `AI 语音导读 · ${formatTime(manifest.duration)}`;
      const index = manifest.segments.findIndex(segment => containsTime(segment, now));
      const next = index < 0 && now >= manifest.duration ? manifest.segments.length - 1 : Math.max(0, index);
      if (next !== active) {
        clearHighlight(); active = next;
        if (!cue) text.textContent = manifest.segments[active].text;
        chapter.textContent = `${String(active + 1).padStart(2, '0')} / ${String(manifest.segments.length).padStart(2, '0')}`;
        chapterButtons.forEach((item, index) => {
          if (index === active) item.setAttribute('aria-current', 'true');
          else item.removeAttribute('aria-current');
        });
        if (view === 'expanded' && engaged) {
          const row = chapterButtons[active], rect = row.getBoundingClientRect(), listRect = directory.getBoundingClientRect();
          if (rect.top < listRect.top || rect.bottom > listRect.bottom) directory.scrollTo({ top: directory.scrollTop + rect.top - listRect.top, behavior: reduced() ? 'instant' : 'smooth' });
        }
        needsFollow = true;
      }
      if (engaged && manifest.player.highlight && !activeElements.length && !audio.ended) {
        activeElements = manifest.segments[active].sourceIds.map(id => sourceMap.get(id)).filter(Boolean);
        activeElements.forEach(el => el.classList.add('ai-reader-active'));
        drawHighlight();
      }
      if (!audio.paused && needsFollow) position(false);
      card.classList.toggle('ai-reader--buffering', buffering && !audio.paused);
      status.textContent = buffering && !audio.paused ? '正在加载音频…' : !audio.paused && follow.checked && Date.now() < manualUntil ? '已暂停跟随，可自由阅读' : baseStatus;
      if (!engaged && pendingResume > 0) subtitle.textContent = `上次听到 ${formatTime(pendingResume)} · 点击继续`;
    };
    const seek = value => {
      if (!manifest || failed) return;
      const target = Math.max(0, Math.min(manifest.duration - 0.01, value));
      pendingResume = audio.readyState === 0 ? target : null;
      audio.currentTime = target;
      if (button.dataset.playState === 'replay') playbackState('play', '继续 AI 语音导读');
      engaged = true; update(); saveProgress(true);
    };
    listen(button, 'click', async () => {
      if (!manifest) { if (!loading) await initialize(); return; }
      if (failed) { pendingResume = currentTime(); failed = false; sentenceKey = ''; audio.load(); range.disabled = false; skips.forEach(item => { item.disabled = false; }); chapterButtons.forEach(item => { item.disabled = false; }); }
      if (!audio.paused) { audio.pause(); return; }
      for (const controller of controllers.values()) if (controller.audio !== audio) controller.audio.pause();
      engaged = true;
      manualUntil = 0; needsFollow = true;
      if (audio.ended) seek(0);
      try { await audio.play(); }
      catch (error) {
        // 用户在加载完成前暂停/离页会主动中断 play()，属于正常操作。
        if (life.signal.aborted || (error.name === 'AbortError' && audio.paused)) return;
        status.textContent = '播放未能开始，请再次点击或检查音频文件'; subtitle.textContent = '未能播放，点击重试';
      }
    });
    const playbackState = (state, label, playing = false) => {
      button.dataset.playState = state; button.setAttribute('aria-label', label); button.title = label;
      card.classList.toggle('ai-reader--playing', playing);
    };
    listen(audio, 'play', () => { buffering = audio.readyState < 3; playbackState('pause', '暂停 AI 语音导读', true); update(); });
    listen(audio, 'pause', () => { buffering = false; saveProgress(true); playbackState('play', '继续 AI 语音导读'); update(); });
    listen(audio, 'ended', () => { buffering = false; pendingResume = null; progress?.save(0, true); update(); clearHighlight(); engaged = false; playbackState('replay', '再次播放 AI 语音导读'); status.textContent = '本次导读已结束'; subtitle.textContent = '已听完 · 再听一次'; });
    listen(audio, 'loadedmetadata', () => {
      if (pendingResume !== null) { audio.currentTime = pendingResume; pendingResume = null; }
      update();
    });
    listen(audio, 'timeupdate', () => saveProgress());
    listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') saveProgress(true); });
    listen(window, 'pagehide', () => saveProgress(true));
    listen(audio, 'error', () => { greeting.textContent = '声音加载失败'; text.textContent = '点击播放按钮，重新加载导读'; text.hidden = false; completion.hidden = true; card.classList.remove('ai-reader--ended'); chapterButtons.forEach(item => { item.disabled = true; }); failed = true; buffering = false; scrubbing = false; playbackState('replay', '重试加载导读音频'); button.disabled = false; skips.forEach(item => { item.disabled = true; }); range.disabled = true; clearHighlight(); card.classList.remove('ai-reader--playing', 'ai-reader--buffering'); subtitle.textContent = '加载失败 · 点击重试'; status.textContent = '音频加载失败，可点击播放按钮重试'; });
    listen(audio, 'waiting', () => { buffering = true; update(); });
    listen(audio, 'playing', () => { buffering = false; update(); });
    listen(audio, 'timeupdate', update);
    listen(audio, 'seeked', update);
    listen(range, 'pointerdown', () => { scrubbing = true; });
    listen(range, 'input', () => seek(Number(range.value)));
    listen(range, 'change', () => { scrubbing = false; seek(Number(range.value)); });
    for (const event of ['pointerup', 'pointercancel', 'blur']) listen(range, event, () => { scrubbing = false; update(); });
    listen(window, 'pointerup', () => { if (scrubbing) { scrubbing = false; update(); } });
    listen(rate, 'change', () => {
      const value = Number(rate.value);
      if (rates.includes(value)) { audio.defaultPlaybackRate = value; audio.playbackRate = value; savePreference('rate', value); }
    });
    skips.forEach(item => listen(item, 'click', () => seek(currentTime() + Number(item.dataset.aiSkip))));
    listen(directory, 'click', event => {
      const item = event.target.closest('[data-ai-segment]');
      if (!item || !manifest || failed) return;
      seek(manifest.segments[Number(item.dataset.aiSegment)].start);
      position(true);
      if (audio.paused) button.click();
    });
    listen(text, 'click', () => position(true));
    listen(follow, 'change', () => { savePreference('follow', follow.checked); if (follow.checked) { manualUntil = 0; position(true); } });
    listen(body, 'click', event => {
      if (!manifest?.player.click_to_seek || event.target.closest('a,button,input,textarea,select,pre,code') || window.getSelection()?.toString()) return;
      const element = event.target.closest('[data-ai-source]');
      if (!element || !body.contains(element)) return;
      const segment = manifest.segments.find(item => item.sourceIds.includes(element.dataset.aiSource));
      if (segment) { seek(segment.start); needsFollow = false; }
    });
    for (const event of ['wheel', 'touchmove', 'pointerdown', 'keydown']) listen(document, event, interrupt, { passive: true, capture: true });
    listen(window, 'scroll', interrupt, { passive: true });
    const controller = {
      audio, body, card,
      dispose() {
        saveProgress(true);
        sentenceAnimation?.cancel();
        highlightObserver.disconnect();
        life.abort(); audio.pause(); audio.removeAttribute('src'); audio.load(); clearHighlight();
        card.remove(); controllers.delete(source);
        document.documentElement.classList.toggle('ai-reader-panel-open', !!document.querySelector('[data-ai-reader-floating].ai-reader--expanded'));
      }
    };
    controllers.set(source, controller);
    async function initialize() {
      if (loading || life.signal.aborted) return;
      loading = true; failed = false;
      button.disabled = true;
      greeting.textContent = `${displayName}正在准备导读`;
      subtitle.textContent = '正在加载导读…';
      try {
        const loaded = await loadManifest(sameOrigin(source.dataset.aiReaderManifest), life.signal);
        if (life.signal.aborted) return;
        if (!Number.isFinite(loaded.duration) || loaded.duration <= 0 || !loaded.segments?.length || !loaded.player ||
            typeof loaded.article !== 'string' || !loaded.article || typeof loaded.audio !== 'string') throw new Error('manifest 格式错误');
        let end = 0;
        for (const segment of loaded.segments) {
          if (typeof segment.text !== 'string' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
              Math.abs(segment.start - end) > 0.01 || segment.end <= segment.start || !segment.sourceIds?.length ||
              segment.sourceIds.some(id => !sourceMap.has(id))) throw new Error('正文与时间轴不匹配');
          end = segment.end;
        }
        if (Math.abs(end - loaded.duration) > 0.1) throw new Error('时间轴时长不匹配');
        let captionEnd = 0;
        for (const cue of loaded.captions || []) {
          if (typeof cue.text !== 'string' || !cue.text.trim() || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
              Math.abs(cue.start - captionEnd) > 0.01 || cue.end <= cue.start || cue.end > loaded.duration + 0.01) throw new Error('字幕时间轴无效');
          captionEnd = cue.end;
        }
        if (loaded.captions?.length && Math.abs(captionEnd - loaded.duration) > 0.1) throw new Error('字幕时长不匹配');
        const audioUrl = resolveStaticUrl(loaded.audio, location.href, { allowExternalAudio: true });
        manifest = loaded;
        progress = createProgressStore(() => localStorage, manifest);
        pendingResume = progress.read() || null;
        follow.checked = preferences.follow ?? manifest.player.auto_scroll !== false;
        rate.value = String(preferences.rate); audio.defaultPlaybackRate = preferences.rate; audio.playbackRate = preferences.rate;
        audio.src = audioUrl;
        // PJAX 可能缓存已经交互过的 HTML；新实例不能继承旧的“暂停”按钮状态。
        playbackState('play', pendingResume ? '继续 AI 语音导读' : '播放 AI 语音导读');
        range.max = String(manifest.duration);
        const alignmentHint = manifest.mode === 'mock'
          ? (manifest.mockAudio === 'test-tone' ? 'Mock 提示音 · 估算时间轴' : 'Mock 系统语音 · 估算时间轴')
          : (manifest.alignment.precise ? '官方字级时间戳' : '估算时间轴');
        time.title = alignmentHint;
        baseStatus = '点击导读，定位正文';
        button.disabled = false; range.disabled = false; rate.disabled = false; skips.forEach(item => { item.disabled = false; }); chapterButtons.forEach(item => { item.disabled = false; }); update();
      } catch (error) {
        if (life.signal.aborted) return;
        manifest = undefined; progress = undefined; pendingResume = null;
        failed = true; status.textContent = '导读加载失败，点击播放按钮重试';
        subtitle.textContent = '加载失败 · 点击重试'; greeting.textContent = '导读暂不可用'; text.textContent = '点击播放按钮重试加载，正文可继续阅读。';
        playbackState('replay', '重试加载导读');
        button.disabled = false; range.disabled = true;
      } finally { loading = false; }
    }
    initialize();
  }

  function scan() {
    for (const [source, controller] of controllers) {
      if (!source.isConnected || !controller.body.isConnected || !controller.card.isConnected) controller.dispose();
    }
    document.querySelectorAll('[data-ai-reader-manifest]').forEach(card => { if (!controllers.has(card)) mount(card); });
  }
  window.__hexoAIReader = { scan };
  for (const event of ['DOMContentLoaded', 'pjax:complete', 'pjax:success']) document.addEventListener(event, scan);
  document.addEventListener('pjax:send', () => { for (const controller of controllers.values()) controller.audio.pause(); });
  window.addEventListener('pagehide', () => { for (const controller of controllers.values()) controller.audio.pause(); });
  window.addEventListener('pageshow', scan);
  // 兼容音乐墙等自定义站内导航，不依赖特定主题的 PJAX 事件。
  let scheduled = false;
  new MutationObserver(records => {
    if (!records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
      (node.matches?.('[data-ai-reader-manifest], [data-ai-reader-body], [data-ai-reader-floating]') ||
       node.querySelector?.('[data-ai-reader-manifest], [data-ai-reader-body], [data-ai-reader-floating]'))))) return;
    if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; scan(); }); }
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
