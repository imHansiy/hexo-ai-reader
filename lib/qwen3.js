'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { assertTtsConfig } = require('./config');
const hash = data => createHash('sha256').update(data).digest('hex');

function soundSettings(qwen) {
  const settings = { command: qwen.command, signature: qwen.signature || '' };
  if (qwen.command === 'voice') settings.mode = qwen.mode;
  if (qwen.command === 'say') Object.assign(settings, {
    speaker: qwen.speaker, instruct: qwen.instruct, language: qwen.language, modelSize: qwen.modelSize
  });
  if (qwen.command === 'clone') Object.assign(settings, {
    refText: qwen.refText, xvector: qwen.xvector, language: qwen.language, modelSize: qwen.modelSize
  });
  if (qwen.command === 'design') Object.assign(settings, { description: qwen.description, language: qwen.language });
  return settings;
}

async function inputSignature(config) {
  assertTtsConfig(config);
  const qwen = config.tts.qwen3;
  const parts = [];
  async function read(file, field) {
    try { return await fs.readFile(file); }
    catch { throw new Error(`无法读取 ${field} 对应文件`); }
  }
  parts.push(hash(await read(qwen.module, 'tts.qwen3.module')));
  if (qwen.pythonScript) parts.push(hash(await read(qwen.pythonScript, 'tts.qwen3.python_script')));
  if (qwen.command === 'clone') parts.push(hash(await read(qwen.refAudio, 'tts.qwen3.ref_audio')));
  if (qwen.command === 'voice') {
    let voice;
    try { voice = JSON.parse(await read(qwen.voiceConfig, 'tts.qwen3.voice_config')); }
    catch { throw new Error('tts.qwen3.voice_config 必须是可读取的 JSON 文件'); }
    const icl = qwen.mode === 'icl';
    const audio = icl ? voice.ref_audio_full : voice.ref_audio_short;
    const text = icl ? voice.ref_text_full : voice.ref_text_short;
    if (typeof audio !== 'string' || !path.isAbsolute(audio)) throw new Error('默认音色配置中的参考音频必须是绝对路径');
    parts.push(hash(await read(audio, '音色配置的参考音频')), text || '');
  }
  return hash(JSON.stringify(parts));
}

// 独立 Node 进程导入用户模块，避免 Windows CLI 入口失效和全局环境污染。
function runWorker(request, { env = process.env, timeout = 750000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'qwen3-worker.cjs'), [], {
      env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      detached: process.platform !== 'win32'
    });
    let response, finished = false, timeoutError;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = timeoutError = new Error('Qwen3-TTS 本地执行超时，未自动重试');
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => finish(error));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        finish(error);
      }
    }, timeout);
    child.on('message', message => { response = message; });
    child.on('error', () => finish(new Error('无法启动 Qwen3-TTS Node 执行进程')));
    child.on('exit', code => {
      if (timeoutError) { finish(timeoutError); return; }
      if (code !== 0 || response?.ok !== true) {
        const kind = response?.kind;
        const message = kind === 'timeout' ? 'Qwen3-TTS 推理超时，未自动重试'
          : kind === 'invalid_audio' ? 'Qwen3-TTS 返回空音频、静音或损坏的 WAV'
          : kind === 'module' ? '无法加载 tts.qwen3.module 或其生成接口'
          : 'Qwen3-TTS 生成失败，请检查脚本运行环境、音色参数和服务状态';
        finish(new Error(message));
      } else finish(null, response);
    });
    child.send(request, error => { if (error) { child.kill(); finish(new Error('无法向 Qwen3-TTS 传递生成参数')); } });
  });
}

async function synthesizeQwen(text, config, tempDir) {
  assertTtsConfig(config);
  if (!tempDir) throw new Error('Qwen3-TTS 缺少生成临时目录');
  const qwen = config.tts.qwen3;
  const output = path.join(tempDir, 'narration.wav');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', MSYS_NO_PATHCONV: '1' };
  // 保留系统运行环境，但生成参数只能由 YAML 提供。
  for (const name of Object.keys(env)) if (name.startsWith('QWEN3_TTS_')) delete env[name];
  for (const [name, value] of Object.entries({ QWEN3_TTS_PY: qwen.python,
    QWEN3_TTS_SCRIPT: qwen.pythonScript, QWEN3_TTS_VOICE_CFG: qwen.voiceConfig })) if (value) env[name] = value;
  await runWorker({ module: qwen.module, command: qwen.command,
    params: { text, output, mode: qwen.mode, speaker: qwen.speaker, instruct: qwen.instruct,
      language: qwen.language, modelSize: qwen.modelSize, refAudio: qwen.refAudio,
      refText: qwen.refText, xvector: String(qwen.xvector), description: qwen.description },
    timeoutSec: Math.ceil(config.tts.timeout / 1000), output,
    transport: { ...(qwen.host ? { host: qwen.host } : {}), hfToken: qwen.hfToken || '' }
  }, { env, timeout: config.tts.timeout + 150000 });
  const stat = await fs.stat(output).catch(() => null);
  if (!stat?.isFile() || stat.size <= 44 || stat.size > 64 * 1024 * 1024) throw new Error('Qwen3-TTS WAV 文件缺失或大小无效');
  const audio = await fs.readFile(output);
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Qwen3-TTS 产物不是 WAV 音频');
  return { audio, extension: 'wav', sentences: [], mockAudio: null };
}

module.exports = { synthesizeQwen, inputSignature, soundSettings, runWorker };
