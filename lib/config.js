'use strict';

const path = require('node:path');

const DEFAULT_VOICE_STYLE = '使用自然亲切的中文聊天语气讲解文章，语速适中，有情感和自然停顿，不要新闻播音腔。';
const DEFAULT_GUIDE_STYLE = '使用自然、亲切、连续的中文讲解方式，像在给朋友介绍文章内容，不要逐段机械复述。';

function yamlValue(value, fallback = '') {
  const text = String(value ?? fallback);
  if (/\$\{[A-Z0-9_]+\}/.test(text)) throw new Error('请在 ai_reader 的 YAML 中填写实际值，不再支持环境变量占位符');
  return text;
}

function optionalPrompt(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field} 必须是文本，可使用 YAML 的 |- 写多行内容`);
  return yamlValue(value).trim();
}

function resolveConfig(raw = {}, baseDir = process.cwd()) {
  const llm = raw.llm || {}, tts = raw.tts || {}, narration = raw.narration || {};
  const persona = optionalPrompt(narration.persona, 'ai_reader.narration.persona');
  const systemPrompt = optionalPrompt(narration.system_prompt, 'ai_reader.narration.system_prompt');
  const playerName = typeof raw.player?.name === 'string' && raw.player.name.trim() ? raw.player.name.trim() : '海灵';
  const playerTitle = typeof raw.player?.title === 'string' && raw.player.title.trim() ? raw.player.title.trim() : `${playerName}陪你读`;
  const provider = yamlValue(tts.provider || 'qwen3');
  const storage = raw.storage || {}, b2 = storage.b2 || {};
  const qwen = tts.qwen3 || {};
  const localPath = value => value ? path.resolve(baseDir, yamlValue(value)) : '';
  const workspaceId = yamlValue(tts.workspace_id);
  const endpoint = yamlValue(tts.endpoint) ||
    `https://${workspaceId ? `${workspaceId}.cn-beijing.maas` : 'dashscope'}.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`;
  return {
    enabled: raw.enabled === true,
    autoGenerate: raw.auto_generate !== false,
    mode: yamlValue(raw.mode || 'live'),
    defaultEnabled: raw.default_enabled === true,
    include: Array.isArray(raw.include) ? raw.include : [],
    cacheDir: raw.cache_dir || '.cache/hexo-ai-reader',
    timeout: Number(raw.timeout_ms) || 240000,
    storage: {
      provider: yamlValue(storage.provider || 'local'),
      b2: {
        keyId: yamlValue(b2.key_id),
        key: yamlValue(b2.key),
        bucket: yamlValue(b2.bucket),
        bucketId: yamlValue(b2.bucket_id),
        region: yamlValue(b2.region),
        publicBase: yamlValue(b2.public_base),
        prefix: yamlValue(b2.prefix ?? 'ai-reader').replace(/^\/+|\/+$/g, ''),
        timeout: Number(b2.timeout_ms) || 90000
      }
    },
    llm: {
      baseUrl: yamlValue(llm.base_url).replace(/\/+$/, ''),
      apiKey: yamlValue(llm.api_key),
      model: yamlValue(llm.model),
      jsonMode: llm.json_mode === true,
      stream: llm.stream !== false,
      maxInputChars: Number(llm.max_input_chars) || 60000
    },
    tts: {
      endpoint,
      timeout: Number(tts.timeout_ms) || Number(raw.timeout_ms) || (provider === 'qwen3' ? 600000 : 90000),
      model: yamlValue(tts.model) || 'qwen-audio-3.1-tts-flash',
      apiKey: yamlValue(tts.api_key),
      workspaceId,
      voice: yamlValue(tts.voice) || '',
      instruction: yamlValue(tts.instruction || DEFAULT_VOICE_STYLE),
      sampleRate: Number(tts.sample_rate) || 24000,
      rate: Number(tts.rate) || 1,
      timestamps: tts.timestamps === true,
      format: provider === 'qwen3' ? 'wav' : 'mp3',
      provider,
      qwen3: {
        host: yamlValue(qwen.host),
        hfToken: yamlValue(qwen.hf_token),
        module: localPath(yamlValue(qwen.module)) || path.join(__dirname, 'qwen3-tts.mjs'),
        python: yamlValue(qwen.python),
        pythonScript: localPath(qwen.python_script),
        voiceConfig: localPath(yamlValue(qwen.voice_config)),
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
      style: yamlValue(narration.style || DEFAULT_GUIDE_STYLE),
      language: narration.language || 'zh-CN',
      maxChars: Number(narration.max_chars) || 800,
      promptVersion: 'guide-v1',
      // 留空时保持既有配置及文稿缓存版本，避免新增可选项触发生成。
      ...(persona ? { persona } : {}),
      ...(systemPrompt ? { systemPrompt } : {})
    },
    mockVoice: yamlValue(raw.mock_voice || 'Tingting'),
    player: {
      name: playerName,
      title: playerTitle,
      avatar: typeof raw.player?.avatar === 'string' ? raw.player.avatar : '',
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
