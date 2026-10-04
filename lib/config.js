'use strict';

const path = require('node:path');

const DEFAULT_VOICE_STYLE = '使用自然亲切的中文聊天语气讲解文章，语速适中，有情感和自然停顿，不要新闻播音腔。';
const DEFAULT_GUIDE_STYLE = '使用自然、亲切、连续的中文讲解方式，像在给朋友介绍文章内容，不要逐段机械复述。';

function env(value, fallback = '') {
  return String(value ?? fallback).replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] || '');
}

function resolveConfig(raw = {}, baseDir = process.cwd()) {
  const llm = raw.llm || {}, tts = raw.tts || {}, narration = raw.narration || {};
  const provider = env(tts.provider || 'qwen3');
  const qwen = tts.qwen3 || {};
  const localPath = value => value ? path.resolve(baseDir, env(value)) : '';
  const workspaceId = env(tts.workspace_id, '${DASHSCOPE_WORKSPACE_ID}');
  const endpoint = env(tts.endpoint, '${DASHSCOPE_TTS_ENDPOINT}') ||
    `https://${workspaceId ? `${workspaceId}.cn-beijing.maas` : 'dashscope'}.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`;
  return {
    enabled: raw.enabled === true,
    autoGenerate: raw.auto_generate !== false,
    mode: env(raw.mode || process.env.AI_READER_MODE || 'live'),
    defaultEnabled: raw.default_enabled === true,
    include: Array.isArray(raw.include) ? raw.include : [],
    cacheDir: raw.cache_dir || '.cache/hexo-ai-reader',
    timeout: Number(raw.timeout_ms) || 240000,
    llm: {
      baseUrl: env(llm.base_url, '${OPENAI_BASE_URL}').replace(/\/+$/, ''),
      apiKey: env(llm.api_key, '${OPENAI_API_KEY}'),
      model: env(llm.model, '${OPENAI_MODEL}'),
      jsonMode: llm.json_mode === true,
      stream: llm.stream !== false,
      maxInputChars: Number(llm.max_input_chars) || 60000
    },
    tts: {
      endpoint,
      timeout: Number(tts.timeout_ms) || Number(raw.timeout_ms) || (provider === 'qwen3' ? 600000 : 90000),
      model: env(tts.model, '${TTS_MODEL}') || 'qwen-audio-3.1-tts-flash',
      apiKey: env(tts.api_key, '${DASHSCOPE_API_KEY}'),
      workspaceId,
      voice: env(tts.voice, '${TTS_VOICE_ID}') || process.env.HAILING_VOICE_ID || '',
      instruction: env(tts.instruction || DEFAULT_VOICE_STYLE),
      sampleRate: Number(tts.sample_rate) || 24000,
      rate: Number(tts.rate) || 1,
      timestamps: tts.timestamps === true,
      format: provider === 'qwen3' ? 'wav' : 'mp3',
      provider,
      qwen3: {
        module: localPath(env(qwen.module, '${QWEN3_TTS_MODULE}')) || path.join(__dirname, 'qwen3-tts.mjs'),
        python: env(qwen.python),
        pythonScript: localPath(qwen.python_script),
        voiceConfig: localPath(env(qwen.voice_config, '${QWEN3_TTS_VOICE_CFG}')),
        command: qwen.command || 'say',
        mode: qwen.mode || 'xvector',
        speaker: qwen.speaker || 'Serena',
        instruct: qwen.instruct || 'Neutral',
        language: qwen.language || 'Chinese',
        modelSize: qwen.model_size || '1.7B',
        refAudio: localPath(qwen.ref_audio),
        refText: qwen.ref_text || '',
        xvector: qwen.xvector !== false,
        description: qwen.description || ''
      }
    },
    narration: {
      style: env(narration.style || DEFAULT_GUIDE_STYLE),
      language: narration.language || 'zh-CN',
      maxChars: Number(narration.max_chars) || 800,
      promptVersion: 'guide-v1'
    },
    mockVoice: env(raw.mock_voice || 'Tingting'),
    player: {
      avatar: typeof raw.player?.avatar === 'string' ? raw.player.avatar : '',
      captions: raw.player?.captions !== false,
      auto_scroll: raw.player?.auto_scroll !== false,
      highlight: raw.player?.highlight !== false,
      pause_scroll_ms: Number(raw.player?.pause_scroll_ms) || 8000,
      click_to_seek: raw.player?.click_to_seek !== false
    }
  };
}

function requireFields(required) {
  const missing = Object.keys(required).filter(key => !required[key]);
  if (missing.length) throw new Error(`缺少配置：${missing.join(', ')}；可设置 ai_reader.mode: mock 预览`);
}

function assertLlmConfig(config) {
  const required = {
    'ai_reader.llm.base_url': config.llm.baseUrl, 'ai_reader.llm.api_key': config.llm.apiKey,
    'ai_reader.llm.model': config.llm.model
  };
  requireFields(required);
  const url = new URL(config.llm.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('ai_reader.llm.base_url 必须是无认证信息、查询参数的 HTTP(S) API 基址');
  }
}

function assertTtsConfig(config) {
  if (config.tts.provider === 'qwen3') {
    const qwen = config.tts.qwen3;
    requireFields({ 'ai_reader.tts.qwen3.module': qwen.module });
    if (!['voice', 'say', 'clone', 'design'].includes(qwen.command)) throw new Error('tts.qwen3.command 只支持 voice、say、clone、design');
    if (!['xvector', 'icl'].includes(qwen.mode)) throw new Error('tts.qwen3.mode 只支持 xvector 或 icl');
    if (qwen.command === 'voice') requireFields({ 'ai_reader.tts.qwen3.voice_config': qwen.voiceConfig });
    if (qwen.command === 'clone') requireFields({ 'ai_reader.tts.qwen3.ref_audio': qwen.refAudio });
    if (qwen.command === 'design') requireFields({ 'ai_reader.tts.qwen3.description': qwen.description });
    return;
  }
  if (config.tts.provider !== 'dashscope') throw new Error('tts.provider 只支持 dashscope 或 qwen3');
  requireFields({ 'ai_reader.tts.api_key': config.tts.apiKey, 'ai_reader.tts.voice': config.tts.voice });
  if (config.tts.workspaceId && !/^[a-zA-Z0-9-]+$/.test(config.tts.workspaceId)) throw new Error('ai_reader.tts.workspace_id 格式无效');
  const endpoint = new URL(config.tts.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('TTS endpoint 必须是不含认证信息和查询参数的 HTTPS 地址');
  }
}

function assertLiveConfig(config) { assertLlmConfig(config); assertTtsConfig(config); }

module.exports = { resolveConfig, assertLiveConfig, assertLlmConfig, assertTtsConfig };
