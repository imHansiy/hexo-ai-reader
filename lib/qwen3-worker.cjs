'use strict';

const { pathToFileURL } = require('node:url');

process.once('message', async request => {
  let reply;
  let stage = 'module';
  try {
    const imported = await import(pathToFileURL(request.module).href);
    const api = imported.default || imported;
    if (!['voice', 'say', 'clone', 'design'].includes(request.command) || typeof api[request.command] !== 'function' ||
        typeof api.inspectAudio !== 'function' && typeof imported.inspectAudio !== 'function') throw new Error('invalid module');
    stage = 'generation';
    const result = await api[request.command](request.params, {
      ...request.transport, quiet: true, timeout: request.timeoutSec, timeoutSec: request.timeoutSec
    });
    // 纯 JS 模块直接返回业务结果；旧 Python 桥接模块返回 exitCode/data。
    const wrapped = result && Object.hasOwn(result, 'exitCode');
    const data = wrapped ? result.data : result;
    if ((wrapped && result.exitCode !== 0) || data?.ok !== true || data?.status !== 'Success') {
      const error = new Error('generation failed');
      error.type = data?.error?.type;
      throw error;
    }
    stage = 'invalid_audio';
    const inspect = api.inspectAudio || imported.inspectAudio;
    const info = inspect(request.output);
    if (!info || info.valid !== true || info.format !== 'wav' || info.silent !== false ||
        !Number.isFinite(info.durationSec) || info.durationSec <= 0) throw new Error('invalid audio');
    reply = { ok: true };
  } catch (error) {
    reply = { ok: false, kind: error.type === 'timeout' ? 'timeout' : stage };
  }
  process.exitCode = reply.ok ? 0 : 1;
  process.send(reply, () => process.disconnect());
});
