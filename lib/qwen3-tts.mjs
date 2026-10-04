#!/usr/bin/env node
/**
 * qwen3-tts.mjs —— 声音生成工具脚本（纯 Node.js，零依赖，可直接发给别的 AI）
 *
 * 直接实现 HF Space `prithivMLmods/Qwen3-TTS-Daggr-UI` 的 daggr WebSocket 节点图协议，
 * **不依赖 Python、不依赖 npm 包**。Node ≥ 22 即可（用到全局 WebSocket + fetch，Node 24 实测通过）。
 *
 * 四种能力：
 *   voice   用「默认音色」（声音样本）说一段话        ← 最常用
 *   clone   给一段参考音频，克隆它的音色说一段话
 *   say     用内置预置音色（Serena / Ryan / ...）合成
 *   design  用自然语言描述一个全新音色（无需参考音频）
 *   asr     音频转文字
 *
 * ── 给调用方 AI 的 6 条铁律 ──────────────────────────────────────────
 * 1. 必须看 JSON 里的 `ok` 字段。业务失败不抛异常、也可能退出码 0，只是 ok:false + status 文本。
 *    例：{"ok":false,"status":"Error: Unsupported speakers: [xxx]"}
 * 2. stdout 恒为 JSON（默认单行，--pretty 才缩进）；进度走 stderr。只解析 stdout。
 * 3. 退出码：0 成功 / 1 失败 / 2 参数错。
 * 4. 不要重试推理。一次调用 = 一次完整 GPU 推理，重试是双倍耗时且不会更好。
 *    只有「推理成功但下载失败」才重下 → 用 download 子命令。
 * 5. 推理期间可能几十秒没输出，正常。真超时只有 error.type=="timeout"，那时调大 --timeout 再跑。
 * 6. 音频会上传到公开共享 Space，产物是公开可猜的链接。涉密音频不要用。
 * ──────────────────────────────────────────────────────────────────
 *
 * 环境变量（可选）：
 *   QWEN3_TTS_HOST        覆盖 Space 主机名
 *   QWEN3_TTS_VOICE_CFG   默认音色配置 json
 *   QWEN3_TTS_HF_TOKEN    可选 HF token（匿名即可用，一般不用设）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOST = 'prithivmlmods-qwen3-tts-daggr-ui.hf.space';
const DEFAULT_VOICE_CFG = ''; // voice 模式需显式提供音色配置。

const NODE_VOICE_DESIGN = 'Voice Design';
const NODE_CUSTOM_VOICE = 'Custom Voice';
const NODE_VOICE_CLONE = 'Voice Clone';
const NODE_QWEN3_ASR = 'Qwen3 ASR';

// 各算子的必填端口。服务端对漏传参数不报错（会回 Success + 默认值音频），只能本地拦截。
const REQUIRED_PORTS = {
  [NODE_CUSTOM_VOICE]: ['text'],
  [NODE_VOICE_DESIGN]: ['text', 'voice_description'],
  [NODE_VOICE_CLONE]: ['ref_audio', 'target_text'],
  [NODE_QWEN3_ASR]: ['audio_upload'],
};

// 产物音频端口（按顺序找第一个有效值）
const AUDIO_PORTS = ['cloned_audio', 'generated_audio', 'tts_audio', 'audio'];

const AUDIO_MIME = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'audio/webm',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};

class TtsError extends Error {
  constructor(type, message) {
    super(message);
    this.name = 'TtsError';
    this.type = type;
  }
}

function envOr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

// ---------------------------------------------------------------------------
// 协议层
// ---------------------------------------------------------------------------
function sessionId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return 'session_' + hex; // 形状对齐前端：session_ + 12 hex
}

function encodeAudio(filePath) {
  if (!fs.existsSync(filePath)) throw new TtsError('invalid_input', `音频文件不存在：${filePath}`);
  const data = fs.readFileSync(filePath);
  if (!data.length) throw new TtsError('invalid_input', `音频文件为空：${filePath}`);
  const mime = AUDIO_MIME[path.extname(filePath).toLowerCase()] || 'audio/wav';
  return `data:${mime};base64,${data.toString('base64')}`;
}

/** 按魔数白名单判断下载到的字节是不是音频（200 + SPA HTML 是最常见的假成功）。 */
function looksLikeAudio(buf) {
  const h = buf.subarray(0, 12);
  const s4 = h.subarray(0, 4).toString('latin1');
  if (s4 === 'RIFF' || s4 === 'fLaC' || s4 === 'OggS') return true;
  if (h.subarray(0, 3).toString('latin1') === 'ID3') return true;
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return true; // mp3 帧同步
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return true; // mkv/webm
  return h.subarray(4, 8).toString('latin1') === 'ftyp'; // mp4/m4a
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Boolean(v);
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'n', 'off', ''].includes(t)) return false;
  }
  return Boolean(v);
}

function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return !v.trim();
  return false;
}

class Client {
  constructor(host, { hfToken, connectTimeout = 30, timeout: runTimeout = 600 } = {}) {
    this.host = (host || envOr('QWEN3_TTS_HOST', DEFAULT_HOST)).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const token = hfToken !== undefined ? hfToken : envOr('QWEN3_TTS_HF_TOKEN', '');
    this.hfToken = token || null;
    this.connectTimeout = connectTimeout * 1000;
    this.runTimeout = runTimeout * 1000;
    this._graph = null;
  }

  get baseUrl() { return `https://${this.host}`; }

  /** 建一条 WebSocket，带超时。 */
  async _connect() {
    const url = `wss://${this.host}/ws/${sessionId()}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      throw new TtsError('transport_error', `建立 WebSocket 失败：${err.message}`);
    }
    const timer = setTimeout(() => { try { ws.close(); } catch {} }, this.connectTimeout);
    try {
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new TtsError('transport_error', `连接 ${url} 失败`));
        ws.onclose = () => reject(new TtsError('transport_error', `连接 ${url} 被关闭`));
      });
    } finally {
      clearTimeout(timer);
    }
    return ws;
  }

  /** 收一条 JSON 消息；超时抛 timeout 哨兵（单个 recv 空窗 ≠ 整体超时）。 */
  _recv(ws, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('recv timeout'), { isRecvTimeout: true }));
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        ws.removeEventListener('error', onErr);
        ws.removeEventListener('close', onClose);
      };
      const onMsg = (ev) => {
        cleanup();
        try { resolve(JSON.parse(ev.data)); }
        catch { reject(new TtsError('transport_error', `服务端返回的不是合法 JSON：${String(ev.data).slice(0, 200)}`)); }
      };
      const onErr = () => { cleanup(); reject(new TtsError('transport_error', 'WebSocket 出错')); };
      const onClose = () => { cleanup(); reject(new TtsError('transport_error', 'WebSocket 被关闭')); };
      ws.addEventListener('message', onMsg);
      ws.addEventListener('error', onErr);
      ws.addEventListener('close', onClose);
    });
  }

  async graph({ refresh = false } = {}) {
    if (this._graph && !refresh) return this._graph;
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ws = await this._connect();
        try {
          ws.send(JSON.stringify({ action: 'get_graph', hf_token: this.hfToken }));
          const msg = await this._recv(ws, this.connectTimeout);
          if (msg.type !== 'graph') throw new TtsError('graph_error', `期望 graph 消息，收到 ${JSON.stringify(msg).slice(0, 200)}`);
          const data = msg.data || {};
          if (!data.nodes) throw new TtsError('graph_error', 'graph 消息缺少 nodes 字段');
          this._graph = data;
          return data;
        } finally { try { ws.close(); } catch {} }
      } catch (err) {
        last = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw new TtsError('graph_error', `获取节点图失败（3 次）：${last?.message}`);
  }

  /**
   * 解析节点图。关键：FN 算子的端口只有名字，类型信息必须靠 edges 从 INPUT 节点回填，
   * 否则音频端口拿不到 component="audio"，本地文件不会被编码成 data URL → 服务端报
   * "Could not process reference audio"。
   */
  async nodes({ refresh = false } = {}) {
    const data = await this.graph({ refresh });
    const rawNodes = data.nodes || [];

    const inputMeta = new Map();
    for (const raw of rawNodes) {
      const comps = raw.input_components || [];
      if (raw.type !== 'INPUT' || !comps.length) continue;
      const comp = comps[0];
      const props = comp.props || {};
      inputMeta.set(raw.id || raw.name || '', {
        component: comp.component || comp.type || '',
        label: props.label,
        value: comp.value,
        choices: extractChoices(comp),
      });
    }

    // (FN 节点 id, 端口名) → 上游 INPUT 节点 id
    const incoming = new Map();
    for (const e of data.edges || []) {
      if (e.from_node && e.to_node && e.to_port) incoming.set(`${e.to_node}|${e.to_port}`, e.from_node);
    }

    return rawNodes.map((raw) => {
      const nodeId = raw.id || raw.name || '';
      const comps = raw.input_components || [];
      let inputs;
      if (comps.length) {
        inputs = comps.map((c) => ({
          port_name: c.port_name || '',
          component: c.component || c.type || '',
          label: (c.props || {}).label,
          value: c.value,
          choices: extractChoices(c),
          node_id: nodeId,
        }));
      } else {
        inputs = (raw.inputs || []).map((spec) => {
          const portName = typeof spec === 'string' ? spec : spec.name || '';
          const meta = inputMeta.get(incoming.get(`${nodeId}|${portName}`) || '') || {};
          return {
            port_name: portName,
            component: meta.component || '',
            label: meta.label,
            value: meta.value,
            choices: meta.choices,
            node_id: nodeId,
          };
        });
      }
      const outComps = raw.output_components || [];
      const outputs = outComps.length
        ? outComps.map((c) => ({ port_name: c.port_name || '', component: c.component || c.type || '' }))
        : (raw.outputs || []).map((p) => ({ port_name: String(p), component: '' }));
      return {
        name: raw.name || '', node_id: nodeId, type: raw.type || '',
        runnable: raw.type === 'FN', inputs, outputs,
      };
    });
  }

  async node(name) {
    const all = await this.nodes();
    const hit = all.find((n) => n.name === name);
    if (hit) return hit;
    const avail = all.filter((n) => n.runnable).map((n) => n.name).join(', ');
    throw new TtsError('unknown_node', `节点不存在：${name}。可用算子：${avail}`);
  }

  _resolveInputs(node, inputs, require) {
    const ports = new Map(node.inputs.map((p) => [p.port_name, p]));
    const out = {};
    const unknown = [];
    for (const [key, value] of Object.entries(inputs || {})) {
      let portName = null;
      if (key.includes('__')) {
        const [prefix, port] = key.split('__');
        if (prefix !== node.node_id) portName = null;
        else portName = ports.has(port) ? port : null;
      } else {
        portName = ports.has(key) ? key : null;
      }
      if (portName === null) { unknown.push(key); continue; }
      const port = ports.get(portName);
      out[`${port.node_id}__${port.port_name}`] = { value: this._coerce(port, value) };
    }
    if (unknown.length) {
      throw new TtsError('invalid_input', `${node.name} 不认识这些输入：${unknown.join(', ')}。可用端口：${[...ports.keys()].sort().join(', ') || '(无)'}`);
    }
    const missing = (require || []).filter((n) => ports.has(n) && isBlank((out[`${ports.get(n).node_id}__${n}`] || {}).value));
    if (missing.length) {
      throw new TtsError('invalid_input', `${node.name} 缺少必填参数：${missing.join(', ')}`);
    }
    return out;
  }

  _coerce(port, value) {
    if (port.component === 'audio') {
      if (typeof value === 'string') {
        if (value.startsWith('data:') || /^https?:\/\//.test(value)) return value;
        if (value.startsWith('/file/')) {
          throw new TtsError('invalid_input', `音频端口 ${port.port_name} 不接受服务端路径，请先下载为本地文件`);
        }
        if (fs.existsSync(value)) return encodeAudio(value);
      }
    } else if (port.component === 'checkbox') {
      return asBool(value);
    } else if (port.component === 'dropdown' && port.choices && typeof value === 'string') {
      if (!port.choices.includes(value)) {
        throw new TtsError('invalid_input', `${port.port_name}=${value} 不在可选值内：${port.choices.join(', ')}`);
      }
    }
    return value;
  }

  async run(nodeName, inputs, { saveTo, onEvent, timeout, require } = {}) {
    const node = await this.node(nodeName);
    if (!node.runnable) throw new TtsError('unknown_node', `${nodeName} 是参数节点，不能直接执行`);
    const required = require === undefined ? (REQUIRED_PORTS[node.name] || []) : require;
    const resolved = this._resolveInputs(node, inputs, required);

    const rid = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const deadline = Date.now() + (timeout ? timeout * 1000 : this.runTimeout);

    const ws = await this._connect();
    let msg;
    try {
      ws.send(JSON.stringify({
        action: 'run', node_name: node.name, inputs: resolved,
        item_list_values: {}, selected_results: {}, run_id: rid,
        sheet_id: null, hf_token: this.hfToken, run_ancestors: true,
      }));
      // 循环收消息：单个窗口空等不等于超时（推理期间服务端不推进度）
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TtsError('timeout', `等待 ${node.name} 完成超时（run_id=${rid}）`);
        let m;
        try {
          m = await this._recv(ws, Math.min(remaining, 45000));
        } catch (err) {
          if (err.isRecvTimeout) continue;
          throw err;
        }
        if (onEvent) { try { onEvent(m); } catch {} }
        const t = m.type;
        if (t === 'node_complete' && m.completed_node === node.name) { msg = m; break; }
        if (t === 'error') {
          const failed = m.node || m.completed_node;
          if (failed === undefined || failed === null || failed === node.name) {
            throw new TtsError('run_failed', `${node.name} 执行出错：${m.error}`);
          }
        }
        if (t === 'cancelled') throw new TtsError('run_failed', `${node.name} 已被取消`);
      }
    } finally { try { ws.close(); } catch {} }

    const outputs = {};
    for (const raw of msg.nodes || []) {
      if (raw.name !== node.name) continue;
      for (const c of raw.output_components || []) outputs[c.port_name] = c.value;
    }
    if (!Object.keys(outputs).length) throw new TtsError('run_failed', `${node.name} 的完成事件里没有输出端口`);
    const status = String(outputs.status || '');
    const ok = status.trim().toLowerCase() === 'success';

    let audio = null;
    for (const p of AUDIO_PORTS) {
      const v = outputs[p];
      if (typeof v === 'string' && v.startsWith('/file/')) { audio = v; break; }
    }
    let text = null;
    for (const p of ['transcription', 'detected_lang']) {
      if (outputs[p]) { text = String(outputs[p]); break; }
    }

    const result = {
      ok, node: node.name, status, audio, text,
      execution_time_ms: msg.execution_time_ms, run_id: String(msg.run_id || rid),
      outputs, saved_to: null,
    };

    if (saveTo && audio) {
      try { result.saved_to = await this.download(audio, saveTo); }
      catch (err) { result.download_error = err.message; }
    }
    return result;
  }

  async download(serverPath, dest) {
    const url = /^https?:\/\//i.test(serverPath) ? serverPath : `${this.baseUrl}/${serverPath.replace(/^\/+/, '')}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new TtsError('transport_error', `下载失败 HTTP ${res.status}：${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new TtsError('transport_error', `下载到的内容为空：${url}`);
    if (!looksLikeAudio(buf)) {
      throw new TtsError('transport_error', `下载到的不是音频（Content-Type=${res.headers.get('content-type') || '未知'}）：${url}`);
    }
    const out = path.resolve(dest);
    const dir = path.dirname(out);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, buf);
    return out;
  }

  /** 查 Space 运行状态（host 子域名无法直接反推 repo id，用 HF search 反查）。 */
  async spaceStatus() {
    const slug = this.host.split('.')[0];
    const searchUrl = `https://huggingface.co/api/spaces?search=${encodeURIComponent(slug)}&limit=20`;
    let repo = null;
    try {
      const r = await fetch(searchUrl);
      const list = await r.json();
      for (const item of list || []) {
        if ((item.id || '').replace('/', '-').toLowerCase() === slug) { repo = item.id; break; }
      }
    } catch (err) {
      return { reachable: false, error: `搜索 Space 失败：${err.message}` };
    }
    if (!repo) return { reachable: false, error: `未找到与 ${slug} 对应的 Space` };
    try {
      const r = await fetch(`https://huggingface.co/api/spaces/${repo}`);
      if (!r.ok) return { reachable: false, error: `HTTP ${r.status}` };
      const info = await r.json();
      const rt = info.runtime || {};
      return { reachable: true, space_id: info.id, stage: rt.stage, hardware: (rt.hardware || {}).current, raw: rt };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }
}

function extractChoices(comp) {
  const raw = (comp.props || {}).choices;
  if (!raw) return null;
  return raw.map((item) => (Array.isArray(item) && item.length ? String(item[0]) : String(item)));
}

// ---------------------------------------------------------------------------
// 产物校验：读 wav 头，报时长 / 采样率 / 是否疑似静音
// ---------------------------------------------------------------------------
function inspectAudio(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    if (st.size < 44) return { path: file, bytes: st.size, valid: false, note: '文件过小，不像完整 wav' };
    const head = Buffer.alloc(Math.min(st.size, 4096));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);

    const isWav = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';
    if (!isWav) return { path: file, bytes: st.size, valid: true, format: head.toString('ascii', 0, 4).trim() || 'unknown' };

    let off = 12, channels = 0, sampleRate = 0, bits = 0;
    const scanEnd = Math.min(head.length - 8, 1024);
    while (off < scanEnd) {
      const id = head.toString('ascii', off, off + 4);
      const size = head.readUInt32LE(off + 4);
      if (id === 'fmt ' && size >= 16) {
        channels = head.readUInt16LE(off + 10);
        sampleRate = head.readUInt32LE(off + 12);
        bits = head.readUInt16LE(off + 22);
        break;
      }
      off += 8 + size;
    }
    const dataBytes = Math.max(0, st.size - 44);
    const bytesPerSec = sampleRate * channels * (bits / 8) || 48000;
    const durationSec = +(dataBytes / bytesPerSec).toFixed(2);

    let rms = null;
    if (bits === 16 && sampleRate > 0) {
      const want = Math.min(8192, Math.max(0, st.size - 44));
      if (want >= 4) {
        const dbuf = Buffer.alloc(want - (want % 2));
        const fd2 = fs.openSync(file, 'r');
        fs.readSync(fd2, dbuf, 0, dbuf.length, 44 + Math.floor((st.size - 44) / 2));
        fs.closeSync(fd2);
        let sum = 0;
        const n = dbuf.length / 2;
        for (let i = 0; i < n; i++) { const v = dbuf.readInt16LE(i * 2); sum += v * v; }
        rms = Math.round(Math.sqrt(sum / n));
      }
    }
    return {
      path: file, bytes: st.size, valid: true, format: 'wav',
      sampleRate, channels, bits, durationSec, rms,
      silent: rms !== null && rms < 50,
    };
  } catch (err) {
    return { path: file, valid: false, note: `校验失败: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// 高层 API（可被 import 当库用）
// ---------------------------------------------------------------------------
function makeClient(opts = {}) {
  return new Client(opts.host, {
    hfToken: opts.hfToken,
    connectTimeout: opts.connectTimeout ?? 30,
    timeout: opts.timeout ?? 600,
  });
}

/** 环境自检：Space 状态 + 四算子在线。任何任务前先跑一次最省事。 */
export async function doctor(opts = {}) {
  const c = makeClient(opts);
  const report = { ok: true, host: c.host, checks: {} };
  const st = await c.spaceStatus();
  report.checks.space = {
    ok: Boolean(st.reachable) && st.stage === 'RUNNING',
    stage: st.stage, hardware: st.hardware, error: st.error,
  };
  if (!report.checks.space.ok) report.ok = false;
  try {
    const all = await c.nodes();
    report.checks.graph = { ok: true, operators: all.filter((n) => n.runnable).map((n) => n.name) };
  } catch (err) {
    report.ok = false;
    report.checks.graph = { ok: false, error: err.message };
  }
  return report;
}

/** 列出可用算子与端口。 */
export async function nodes(opts = {}) {
  const c = makeClient(opts);
  const all = await c.nodes();
  return { host: c.host, nodes: all.map((n) => ({
    name: n.name, node_id: n.node_id, runnable: n.runnable,
    inputs: n.inputs.map((p) => ({ port: p.port_name, component: p.component, choices: p.choices })),
    outputs: n.outputs.map((p) => p.port_name),
  })) };
}

/** 查某个算子的参数契约（必填/枚举）。 */
export async function schema(nodeName, opts = {}) {
  const c = makeClient(opts);
  const n = await c.node(nodeName);
  return {
    node: n.name, node_id: n.node_id, runnable: n.runnable,
    required: REQUIRED_PORTS[n.name] || [],
    inputs: n.inputs.map((p) => ({
      port: p.port_name, key: `${p.node_id}__${p.port_name}`,
      component: p.component, label: p.label, default: p.value, choices: p.choices,
    })),
    outputs: n.outputs.map((p) => p.port_name),
  };
}

/** Space 运行状态。 */
export async function status(opts = {}) {
  return makeClient(opts).spaceStatus();
}

/** 声音克隆。参考音频务必压小（>500KB 会在上传阶段断连），建议 3~10s 的 mp3。 */
export function clone({ refAudio, text, output, refText, xvector = true, language = 'Auto', modelSize = '1.7B' } = {}, opts = {}) {
  if (!refAudio) throw new TtsError('invalid_input', 'clone 需要 refAudio（参考音频路径）');
  if (!text) throw new TtsError('invalid_input', 'clone 需要 text（要说的文本）');
  const inputs = { ref_audio: refAudio, target_text: text, language, model_size: modelSize };
  if (refText !== undefined && refText !== null) inputs.ref_text = refText;
  inputs.use_xvector_only = xvector;
  return makeClient(opts).run(NODE_VOICE_CLONE, inputs, { saveTo: output, onEvent: opts.onEvent, timeout: opts.timeout });
}

/** 预置音色合成。 */
export function say({ text, output, speaker = 'Ryan', instruct = 'Neutral', language = 'English', modelSize = '1.7B' } = {}, opts = {}) {
  if (!text) throw new TtsError('invalid_input', 'say 需要 text');
  return makeClient(opts).run(NODE_CUSTOM_VOICE, {
    text, language, speaker, instruct, model_size: modelSize,
  }, { saveTo: output, onEvent: opts.onEvent, timeout: opts.timeout });
}

/** 音色设计：用英文描述一个新音色，不需要参考音频（最快）。 */
export function design({ text, description, output, language = 'Auto' } = {}, opts = {}) {
  if (!text) throw new TtsError('invalid_input', 'design 需要 text');
  if (!description) throw new TtsError('invalid_input', 'design 需要 description（音色描述，英文更稳）');
  return makeClient(opts).run(NODE_VOICE_DESIGN, {
    text, voice_description: description, language,
  }, { saveTo: output, onEvent: opts.onEvent, timeout: opts.timeout });
}

/** 音频转写。 */
export function asr(audio, { language = 'Auto' } = {}, opts = {}) {
  if (!audio) throw new TtsError('invalid_input', 'asr 需要音频文件路径');
  return makeClient(opts).run(NODE_QWEN3_ASR, { audio_upload: audio, lang_disp: language }, { onEvent: opts.onEvent, timeout: opts.timeout });
}

/** 通用执行：直接给端口 JSON。 */
export function run(nodeName, inputs, { output } = {}, opts = {}) {
  if (!nodeName) throw new TtsError('invalid_input', 'run 需要算子名');
  return makeClient(opts).run(nodeName, inputs || {}, { saveTo: output, onEvent: opts.onEvent, timeout: opts.timeout, require: [] });
}

/** 单独下载产物（推理成功但下载失败时用，别重跑推理）。 */
export async function download(remotePath, output, opts = {}) {
  if (!remotePath || !output) throw new TtsError('invalid_input', 'download 需要路径与 -o');
  const p = await makeClient(opts).download(remotePath, output);
  return { ok: true, saved_to: p, bytes: fs.statSync(p).size };
}

/** 用默认音色说话（不需要提供参考音频）。mode: xvector（默认，快）| icl（保真度更高） */
export function voice({ text, output, mode } = {}, opts = {}) {
  if (!text) throw new TtsError('invalid_input', 'voice 需要 text');
  const cfgPath = envOr('QWEN3_TTS_VOICE_CFG', DEFAULT_VOICE_CFG);
  if (!fs.existsSync(cfgPath)) {
    throw new TtsError('invalid_input', `找不到默认音色配置：${cfgPath}（可用 QWEN3_TTS_VOICE_CFG 覆盖）`);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const useIcl = (mode || cfg.default_mode || 'xvector') === 'icl';
  const refAudio = useIcl ? cfg.ref_audio_full : cfg.ref_audio_short;
  const refText = useIcl ? cfg.ref_text_full : cfg.ref_text_short;
  if (!refAudio || !fs.existsSync(refAudio)) throw new TtsError('invalid_input', `默认参考音频缺失：${refAudio}`);
  return clone({ refAudio, text, output, refText, xvector: !useIcl, language: 'Auto' }, opts);
}

export { inspectAudio, Client };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const USAGE = `qwen3-tts.mjs —— 声音生成工具脚本（纯 Node.js，零依赖）

  node qwen3-tts.mjs <command> [options]

命令：
  voice   "文本" [-o out.wav] [--mode xvector|icl]    用默认音色说话 ★最常用
  clone   <参考音频> -t "文本" [-o out.wav] [--ref-text "逐字稿"] [--xvector true|false]
  say     -t "文本" [--speaker Serena] [--instruct Neutral] [-o out.wav]
  design  -t "文本" -d "warm young female voice" [-o out.wav]
  asr     <音频文件> [--language Auto]
  doctor                                  环境自检（先跑这个）
  nodes / schema "Voice Clone" / status   查询算子与状态
  download <路径或URL> -o out.wav         重下产物（推理成功但下载失败时）

通用选项：
  -o, --output <文件>     产物保存路径
  --timeout <秒>          等待上限，默认 600；长文本调大（约 0.5s/字 + 10s）
  --pretty                缩进输出 JSON（默认单行）
  -q, --quiet             不打印进度
  --help                  看这段说明

输出：stdout 恒为 JSON。成功形如
  {"ok":true,"status":"Success","saved_to":"/abs/out.wav","audio_check":{...}}
失败形如
  {"ok":false,"error":{"type":"...","message":"..."}} 或 {"ok":false,"status":"Error: ..."}
退出码：0 成功 / 1 失败 / 2 参数错。

耗时提示：推理约 8~12s（短句），端到端还要加建连与下载；长文本按 0.5s/字估。
          期间可能几十秒无输出，属正常，请勿中断或重试。`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > -1) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) { flags[body] = argv[i + 1]; i++; }
      else flags[body] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      const body = a.slice(1);
      const eq = body.indexOf('=');
      if (eq > -1) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) { flags[body] = argv[i + 1]; i++; }
      else flags[body] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function baseOpts(flags) {
  return {
    timeout: Number(flags.timeout) > 0 ? Number(flags.timeout) : 600,
    onEvent: (flags.q || flags.quiet) ? undefined : (m) => {
      if (m.type === 'node_started') process.stderr.write(`[tts] 开始执行\n`);
      else if (m.type === 'node_complete') {
        const s = m.execution_time_ms ? `，耗时 ${(m.execution_time_ms / 1000).toFixed(1)}s` : '';
        process.stderr.write(`[tts] 完成 ${m.completed_node || ''}${s}\n`);
      }
    },
  };
}

function emit(payload, pretty) {
  process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const cmd = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  const pretty = Boolean(flags.pretty);
  const opts = baseOpts(flags);

  let result;
  try {
    switch (cmd) {
      case 'doctor': result = await doctor(opts); break;
      case 'nodes': result = await nodes(opts); break;
      case 'status': result = await status(opts); break;
      case 'schema':
        if (!positional[0]) { process.stderr.write('缺少算子名，例：schema "Voice Clone"\n'); return 2; }
        result = await schema(positional[0], opts); break;
      case 'voice': {
        const text = positional[0] ?? flags.t ?? flags.text;
        if (!text) { process.stderr.write('voice 需要一段文本：voice "要说的文本" -o out.wav\n'); return 2; }
        result = await voice({ text, output: flags.o || flags.output, mode: flags.mode }, opts);
        break;
      }
      case 'clone': {
        const refAudio = positional[0];
        const text = flags.t || flags.text;
        if (!refAudio || !text) { process.stderr.write('用法：clone <参考音频> -t "文本" [-o out.wav]\n'); return 2; }
        result = await clone({ refAudio, text, output: flags.o || flags.output, refText: flags['ref-text'],
          xvector: flags.xvector === undefined ? true : asBool(flags.xvector),
          language: flags.language ?? 'Auto', modelSize: flags['model-size'] ?? '1.7B' }, opts);
        break;
      }
      case 'say': {
        const text = flags.t || flags.text;
        if (!text) { process.stderr.write('用法：say -t "文本" [--speaker Serena] [-o out.wav]\n'); return 2; }
        result = await say({ text, output: flags.o || flags.output, speaker: flags.speaker ?? 'Ryan',
          instruct: flags.instruct ?? 'Neutral', language: flags.language ?? 'English',
          modelSize: flags['model-size'] ?? '1.7B' }, opts);
        break;
      }
      case 'design': {
        const text = flags.t || flags.text;
        const description = flags.d || flags.description;
        if (!text || !description) { process.stderr.write('用法：design -t "文本" -d "音色描述（英文更稳）"\n'); return 2; }
        result = await design({ text, description, output: flags.o || flags.output, language: flags.language ?? 'Auto' }, opts);
        break;
      }
      case 'asr': {
        if (!positional[0]) { process.stderr.write('用法：asr <音频文件>\n'); return 2; }
        result = await asr(positional[0], { language: flags.language ?? 'Auto' }, opts);
        break;
      }
      case 'run': {
        if (!positional[0]) { process.stderr.write('用法：run "算子名" --inputs \'{"text":"..."}\'\n'); return 2; }
        let inputs = {};
        try { inputs = JSON.parse(flags.inputs || '{}'); } catch { process.stderr.write('--inputs 不是合法 JSON\n'); return 2; }
        result = await run(positional[0], inputs, { output: flags.o || flags.output }, opts);
        break;
      }
      case 'download': {
        const out = flags.o || flags.output;
        if (!positional[0] || !out) { process.stderr.write('用法：download <路径或URL> -o out.wav\n'); return 2; }
        result = await download(positional[0], out, opts);
        break;
      }
      default:
        process.stderr.write(`未知命令：${cmd}\n\n${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    emit({ ok: false, error: { type: err?.type || 'error', message: err?.message || String(err) } }, pretty);
    return 1;
  }

  const savedTo = result.saved_to || result.savedTo;
  if (savedTo) {
    const info = inspectAudio(savedTo);
    if (info) result.audio_check = info;
  }
  emit(result, pretty);
  return result.ok === false ? 1 : 0;
}

const isDirectRun = (() => {
  try {
    const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return self === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isDirectRun) {
  main().then((code) => process.exit(code))
    .catch((err) => {
      emit({ ok: false, error: { type: err?.type || 'error', message: err?.message || String(err) } }, false);
      process.exit(1);
    });
}

export default {
  doctor, nodes, schema, status, clone, say, design, asr, run, download, voice, inspectAudio, Client,
};
