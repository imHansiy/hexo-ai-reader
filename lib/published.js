'use strict';

const { validateGuide } = require('./providers');
const { digest } = require('./source');
const { createTimeline } = require('./timeline');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Published records contain public data only. Never download their audio during a build.
function readPublished(post, sources, fingerprint, maxChars) {
  const record = post.ai_reader?.generated;
  if (!record || record.source_hash !== fingerprint) return null;
  try {
    if (record.version !== 1 || !validHash(record.audio_key) || !validHash(record.audio?.sha256) ||
        !Number.isFinite(record.audio.duration) || record.audio.duration <= 0 ||
        typeof record.audio.url !== 'string') throw new Error();
    const url = new URL(record.audio.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    const guide = validateGuide(record.guide, sources, maxChars);
    if (record.audio.text_hash !== digest(guide.text)) throw new Error();
    return { guide, audioUrl: url.href, audioHash: record.audio.sha256, duration: record.audio.duration,
      key: record.audio_key, hash: record.audio_key, published: true, cached: true,
      guideCached: true, audioCached: true, mockAudio: null,
      ...createTimeline(guide.segments, record.audio.duration, []) };
  } catch {
    const error = new Error('文章中的已发布导读数据无效；请核对文稿、音频地址和校验值');
    error.code = 'AI_READER_PUBLISHED_INVALID';
    throw error;
  }
}

module.exports = { readPublished };
