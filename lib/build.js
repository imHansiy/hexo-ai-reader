'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { generateGuide, synthesize, mockGuide, mockSpeech, validateGuide } = require('./providers');
const { createTimeline } = require('./timeline');
const { digest, cacheHash, sourceHash, guideHash, audioCacheHash } = require('./source');
const { readPublished } = require('./published');
const servicesDefault = { generateGuide, synthesize, mockGuide, mockSpeech };
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2));
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

async function audioDuration(audio, extension) {
  const { parseBuffer } = await import('music-metadata');
  const metadata = await parseBuffer(audio, { mimeType: extension === 'mp3' ? 'audio/mpeg' : 'audio/wav', size: audio.length }, { duration: true });
  const duration = metadata.format.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取完整音频时长');
  return duration;
}

async function readGuide(directory, key, fingerprint, sources, maxChars) {
  if (!validHash(key)) throw new Error('文稿缓存标识无效');
  const record = await readJson(path.join(directory, 'guides', key, 'guide.json'));
  if (record.version !== 2 || record.key !== key || record.sourceHash !== fingerprint) throw new Error('文稿与正文不匹配');
  return validateGuide(record.guide, sources, maxChars);
}

async function readAudio(directory, key, guide) {
  if (!validHash(key)) throw new Error('音频缓存标识无效');
  const audioDir = path.join(directory, 'audio', key);
  const record = await readJson(path.join(audioDir, 'result.json'));
  if (record.version !== 2 || record.key !== key || record.textHash !== digest(guide.text) ||
      !['mp3', 'wav'].includes(record.extension) || !Number.isFinite(record.duration) || record.duration <= 0) {
    throw new Error('音频与文稿不匹配');
  }
  const audio = await fs.readFile(path.join(audioDir, `narration.${record.extension}`));
  if (digest(audio) !== record.audioHash) throw new Error('缓存音频损坏');
  return { ...record, audio };
}

async function saveAudio(directory, key, guide, result) {
  const audioDir = path.join(directory, 'audio', key);
  await fs.mkdir(audioDir, { recursive: true });
  const record = { version: 2, key, textHash: digest(guide.text), extension: result.extension,
    duration: result.duration, sentences: result.sentences, mockAudio: result.mockAudio, audioHash: digest(result.audio) };
  const temp = path.join(audioDir, `narration.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, result.audio);
    await fs.rename(temp, path.join(audioDir, `narration.${record.extension}`));
    await atomicJson(path.join(audioDir, 'result.json'), record);
  } finally { await fs.rm(temp, { force: true }); }
  return { ...record, audio: result.audio };
}

const finish = (guide, result, guideCached, audioCached) => ({ ...result, guide,
  hash: result.key, cached: guideCached && audioCached, guideCached, audioCached,
  ...createTimeline(guide.segments, result.duration, result.sentences) });

// 精确匹配旧版正文及配置哈希后迁移，避免为已有导读再次调用模型。
async function migrateLegacy({ post, sources, config, fixture, directory }, fingerprint, guideKey) {
  const legacyDir = path.join(directory, cacheHash(post, sources, config, fixture));
  const old = await readJson(path.join(legacyDir, 'result.json'));
  if (old.hash !== path.basename(legacyDir) || !['mp3', 'wav'].includes(old.extension) ||
      !Number.isFinite(old.duration) || old.duration <= 0) throw new Error('旧缓存无效');
  const guide = validateGuide(old.guide, sources, config.narration.maxChars);
  const audio = await fs.readFile(path.join(legacyDir, `narration.${old.extension}`));
  if (digest(audio) !== old.audioHash) throw new Error('旧缓存音频损坏');
  const audioKey = audioCacheHash(guide, config);
  await atomicJson(path.join(directory, 'guides', guideKey, 'guide.json'), {
    version: 2, key: guideKey, sourceHash: fingerprint, guide
  });
  const result = await saveAudio(directory, audioKey, guide, { ...old, audio });
  await atomicJson(path.join(directory, `ready-${config.mode}.json`), {
    version: 2, sourceHash: fingerprint, guideKey, audioKey
  });
  return { ...finish(guide, result, true, true), migrated: true };
}

async function buildArticle(options) {
  const { post, sources, config, fixture, directory, generate = false, force = false, services = servicesDefault } = options;
  if (force && !generate) throw new Error('强制生成必须允许生成导读');
  if (!['live', 'mock'].includes(config.mode)) throw new Error('mode 只能为 live 或 mock');
  const fingerprint = sourceHash(post, sources);
  const guideVersion = guideHash(post, sources, config, fixture);
  let guideKey = force ? digest(guideVersion + randomUUID()) : guideVersion;
  const readyPath = path.join(directory, `ready-${config.mode}.json`);

  if (!force && config.mode === 'live') {
    const published = readPublished(post, sources, fingerprint, config.narration.maxChars);
    if (published) {
      // A successful local --force remains visible until its new result is exported.
      // Otherwise a published record works without credentials, cache or voice files.
      try {
        const ready = await readJson(readyPath);
        if (ready.forced && ready.version === 2 && ready.sourceHash === fingerprint && ready.audioKey !== published.key) {
          const guide = await readGuide(directory, ready.guideKey, fingerprint, sources, config.narration.maxChars);
          return finish(guide, await readAudio(directory, ready.audioKey, guide), true, true);
        }
      } catch { /* Missing or damaged local cache must not hide the published result. */ }
      return published;
    }
  }

  if (!generate) {
    try {
      const ready = await readJson(readyPath);
      if (ready.version !== 2 || ready.sourceHash !== fingerprint) throw new Error('正文已变化');
      const guide = await readGuide(directory, ready.guideKey, fingerprint, sources, config.narration.maxChars);
      return finish(guide, await readAudio(directory, ready.audioKey, guide), true, true);
    } catch {
      try { return await migrateLegacy(options, fingerprint, guideKey); }
      catch {
        const error = new Error('缺少可用导读或正文已变化；请重新编译或执行 hexo ai-reader --prepare');
        error.code = 'AI_READER_CACHE_MISS';
        throw error;
      }
    }
  }

  let guide, ready, guideCached = true;
  if (!force) {
    try {
      const pointer = await readJson(readyPath);
      if (pointer.version !== 2 || pointer.sourceHash !== fingerprint ||
          (pointer.guideVersion || pointer.guideKey) !== guideVersion) throw new Error('文稿配置已变化');
      guide = await readGuide(directory, pointer.guideKey, fingerprint, sources, config.narration.maxChars);
      ready = pointer;
      guideKey = pointer.guideKey;
    } catch { /* 当前发布版本不可复用，检查独立文稿缓存。 */ }
  }
  try {
    if (force) throw new Error('强制重新生成文稿');
    if (!guide) guide = await readGuide(directory, guideKey, fingerprint, sources, config.narration.maxChars);
  }
  catch {
    if (!force) {
      try { return await migrateLegacy(options, fingerprint, guideKey); } catch { /* 旧缓存未命中，准备新版本。 */ }
    }
    guideCached = false;
    guide = config.mode === 'mock' ? services.mockGuide(post, sources, config, fixture) : await services.generateGuide(post, sources, config);
    guide = validateGuide(guide, sources, config.narration.maxChars);
    await atomicJson(path.join(directory, 'guides', guideKey, 'guide.json'), {
      version: 2, key: guideKey, sourceHash: fingerprint, guide
    });
  }
  const audioConfig = config.mode === 'live' && config.tts.provider === 'qwen3'
    ? { ...config, tts: { ...config.tts, qwen3: { ...config.tts.qwen3,
      signature: await require('./qwen3').inputSignature(config) } } } : config;
  const audioVersion = audioCacheHash(guide, audioConfig);
  const audioKey = force ? digest(audioVersion + randomUUID())
    : ready && (ready.audioVersion || ready.audioKey) === audioVersion ? ready.audioKey : audioVersion;
  let result, audioCached = true;
  try {
    if (force) throw new Error('强制重新生成语音');
    result = await readAudio(directory, audioKey, guide);
  }
  catch {
    audioCached = false;
    await fs.mkdir(directory, { recursive: true });
    const temp = await fs.mkdtemp(path.join(directory, '.audio-'));
    try {
      const speech = config.mode === 'mock' ? await services.mockSpeech(guide, config, temp) : await services.synthesize(guide.text, config, temp);
      const duration = await audioDuration(speech.audio, speech.extension);
      result = await saveAudio(directory, audioKey, guide, { ...speech, duration });
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  // 仅在两个阶段都成功后发布指针；失败保留上一份正文匹配的导读。
  await atomicJson(readyPath, { version: 2, sourceHash: fingerprint, guideKey, audioKey, guideVersion, audioVersion, forced: force });
  return finish(guide, result, guideCached, audioCached);
}

module.exports = { buildArticle, audioDuration };
