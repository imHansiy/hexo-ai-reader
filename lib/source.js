'use strict';

const { load } = require('cheerio');
const { createHash } = require('node:crypto');
const digest = text => createHash('sha256').update(text).digest('hex');
const SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote';
const EXCLUDE = '.ai-summary-card,.ai-reader,script,style,noscript,svg,[data-ai-reader-ignore],.highlight';

function clean($) {
  $('.ai-reader').remove();
  $('[data-ai-reader-body]').each((_, el) => $(el).replaceWith($(el).contents()));
  $('[data-ai-source]').removeAttr('data-ai-source');
}

function stripReader(html) {
  if (!/data-ai-source|data-ai-reader-body|class="ai-reader"/.test(html)) return html;
  const $ = load(html, { decodeEntities: false }, false);
  clean($);
  return $.html();
}

function annotate(html) {
  const $ = load(html, { decodeEntities: false }, false);
  clean($);
  const sources = [], counts = new Map();
  $(SELECTOR).each((_, node) => {
    const el = $(node);
    if (el.is(EXCLUDE) || el.parents(EXCLUDE).length) return;
    // 一个 block 只对应一个 source，避免列表/表格/引用中的子节点重复高亮。
    if (el.parents('li,pre,table,blockquote').length) return;
    const copy = el.clone();
    copy.find('script,style,.headerlink').remove();
    const text = copy.text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const base = `p-${digest(node.tagName + '\n' + text).slice(0, 12)}`;
    const count = (counts.get(base) || 0) + 1;
    counts.set(base, count);
    const id = `${base}-${count}`;
    el.attr('data-ai-source', id);
    sources.push({ id, tag: node.tagName, text });
  });
  return { html: $.html(), sources };
}

function articleKey(post) {
  const source = String(post.source || post.slug || post.path);
  const name = String(post.slug || source).split('/').pop().replace(/\.md$/i, '')
    .normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 64) || 'article';
  return `${name}-${digest(source).slice(0, 10)}`;
}

function cacheHash(post, sources, config, fixture) {
  const { apiKey: _llmKey, ...llm } = config.llm;
  const { apiKey: _ttsKey, provider, qwen3, ...legacyTts } = config.tts;
  const tts = provider === 'qwen3' ? { ...legacyTts, provider, qwen3 } : legacyTts;
  return digest(JSON.stringify({ schema: 1, title: post.title, sources, mode: config.mode,
    llm, tts, narration: config.narration, mockVoice: config.mockVoice, fixture }));
}

function sourceHash(post, sources) {
  return digest(JSON.stringify({ title: post.title, sources }));
}

function guideHash(post, sources, config, fixture) {
  return digest(JSON.stringify({ schema: 2, source: sourceHash(post, sources), mode: config.mode,
    llm: config.mode === 'live' ? { baseUrl: config.llm.baseUrl, model: config.llm.model } : undefined,
    narration: config.narration, fixture: config.mode === 'mock' ? fixture : undefined }));
}

function audioCacheHash(guide, config) {
  const { model, voice, instruction, sampleRate, rate, timestamps, format } = config.tts;
  return digest(JSON.stringify({ schema: 2, text: guide.text, mode: config.mode,
    tts: config.mode === 'live' && config.tts.provider === 'qwen3' ? {
      provider: 'qwen3', ...require('./qwen3').soundSettings(config.tts.qwen3)
    } : config.mode === 'live' ? { model, voice, instruction, sampleRate, rate, timestamps, format,
      language: config.narration.language.split('-')[0] } : undefined,
    mockVoice: config.mode === 'mock' ? config.mockVoice : undefined }));
}

module.exports = { annotate, stripReader, articleKey, cacheHash, sourceHash, guideHash, audioCacheHash, digest };
