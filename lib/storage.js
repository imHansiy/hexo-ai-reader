'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { digest } = require('./source');

function fail(message) {
  const error = new Error(message);
  error.code = 'AI_READER_STORAGE';
  return error;
}

function publicBase(config) {
  const value = config.publicBase || (config.bucket && config.region
    ? `https://s3.${config.region}.backblazeb2.com/${encodeURIComponent(config.bucket)}` : '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw fail('ai_reader.storage.b2.public_base 需为公开 HTTPS 基址，或提供 bucket 和 region'); }
}

async function atomicRecord(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(record));
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

function createAudioPublisher(storage = { provider: 'local' }, { fetcher = (...args) => fetch(...args) } = {}) {
  if (!['local', 'b2'].includes(storage.provider)) throw fail('ai_reader.storage.provider 只支持 local 或 b2');
  const config = storage.b2 || {};
  let authorization;
  async function request(url, options = {}, json = true) {
    try {
      const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(config.timeout || 90000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(`B2 请求失败（HTTP ${response.status}）`);
      }
      return json ? await response.json() : response;
    } catch (error) {
      if (error.code === 'AI_READER_STORAGE') throw error;
      // 底层异常和供应商响应可能包含凭据；不回显它们。
      throw fail('B2 请求失败或超时，请检查网络、权限和公开地址');
    }
  }
  function b2Url(value, upload = false) {
    const url = new URL(value);
    const validHost = url.hostname.endsWith('.backblazeb2.com') || (upload && url.hostname.endsWith('.backblaze.com'));
    if (url.protocol !== 'https:' || !validHost ||
        url.username || url.password || url.search || url.hash) throw fail('B2 返回的 API 地址无效');
    return url.href.replace(/\/$/, '');
  }
  async function authorize() {
    if (authorization) return authorization;
    if (!config.keyId || !config.key) throw fail('缺少 ai_reader.storage.b2.key_id / key');
    const response = await request('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
      headers: { Authorization: 'Basic ' + Buffer.from(`${config.keyId}:${config.key}`).toString('base64') }
    });
    const api = response.apiInfo?.storageApi;
    const allowed = api?.allowed;
    if (!response.authorizationToken || !api?.apiUrl ||
        !['readFiles', 'writeFiles', 'listFiles'].every(capability => allowed?.capabilities?.includes(capability)) ||
        (allowed.buckets && !allowed.buckets.some(bucket => bucket.id === config.bucketId && (!bucket.name || bucket.name === config.bucket)))) {
      throw fail('B2 Key 需具备目标桶的 readFiles、writeFiles、listFiles 权限');
    }
    authorization = { token: response.authorizationToken, apiUrl: b2Url(api.apiUrl), prefix: allowed.namePrefix || '' };
    return authorization;
  }
  async function call(name, body) {
    const auth = await authorize();
    return request(`${auth.apiUrl}/b2api/v4/${name}`, {
      method: 'POST', headers: { Authorization: auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  function matches(file, key, result, sha1) {
    return file?.action === 'upload' && file.bucketId === config.bucketId && file.fileName === key &&
      Number(file.contentLength) === result.audio.length && file.contentSha1 === sha1 && !!file.fileId;
  }
  async function verifyPublic(url, audio) {
    const end = Math.min(audio.length, 64) - 1;
    const response = await request(url, { headers: { Range: `bytes=0-${end}` } }, false);
    if (response.status !== 200 && response.status !== 206) throw fail('B2 公开音频未返回 200 或 206');
    const size = response.status === 206 ? response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
      : response.headers.get('content-length');
    if (Number(size) !== audio.length) { await response.body?.cancel(); throw fail('B2 公开音频大小不匹配'); }
    const reader = response.body?.getReader();
    if (!reader) throw fail('B2 公开音频没有响应正文');
    const chunks = []; let sizeRead = 0;
    try {
      while (sizeRead <= end) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(Buffer.from(chunk.value)); sizeRead += chunk.value.length;
      }
    } finally { await reader.cancel(); }
    if (!Buffer.concat(chunks).subarray(0, end + 1).equals(audio.subarray(0, end + 1))) {
      throw fail('B2 公开音频内容不匹配');
    }
  }
  return {
    async publish(result, directory, { allowUpload = true } = {}) {
      if (storage.provider === 'local' || result.published) return result;
      if (!config.bucketId || !config.bucket) throw fail('缺少 ai_reader.storage.b2.bucket / bucket_id');
      const prefix = config.prefix ?? 'ai-reader';
      if (prefix.split('/').some(part => ['.', '..'].includes(part)) || /[\\?#\x00-\x1f]/.test(prefix)) throw fail('B2 prefix 必须是有效对象目录');
      if (!result.audio || !['wav', 'mp3'].includes(result.extension) || digest(result.audio) !== result.audioHash) throw fail('上传前音频校验失败');
      const key = `${prefix ? prefix + '/' : ''}${result.audioHash}.${result.extension}`;
      const base = publicBase(config);
      const url = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const receiptPath = path.join(directory, 'storage', `${digest(JSON.stringify({ bucketId: config.bucketId, key }))}.json`);
      let record;
      try {
        record = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        if (record.version !== 1 || record.bucketId !== config.bucketId || record.key !== key ||
            record.audioHash !== result.audioHash || record.size !== result.audio.length || !record.fileId || !Array.isArray(record.verifiedBases)) record = null;
      } catch { record = null; }
      if (!record) {
        if (!allowUpload) throw fail('缺少已验证的 B2 上传记录；请执行 hexo generate 上传已有音频');
        const auth = await authorize();
        if (!key.startsWith(auth.prefix)) throw fail('B2 对象目录不符合 Key 的前缀限制');
        const sha1 = createHash('sha1').update(result.audio).digest('hex');
        const listed = await call('b2_list_file_names', { bucketId: config.bucketId, prefix: key, maxFileCount: 1 });
        let file = listed.files?.find(item => item.fileName === key);
        if (file && !matches(file, key, result, sha1)) throw fail('B2 同名对象校验失败，未覆盖远程文件');
        if (!file) {
          const upload = await call('b2_get_upload_url', { bucketId: config.bucketId });
          if (!upload.authorizationToken || upload.bucketId !== config.bucketId) throw fail('B2 上传授权无效');
          file = await request(b2Url(upload.uploadUrl, true), {
            method: 'POST', headers: { Authorization: upload.authorizationToken,
              'X-Bz-File-Name': encodeURIComponent(key), 'X-Bz-Content-Sha1': sha1,
              'Content-Type': result.extension === 'mp3' ? 'audio/mpeg' : 'audio/wav',
              'Content-Length': String(result.audio.length), 'X-Bz-Info-b2-cache-control': encodeURIComponent('public, max-age=31536000, immutable') }, body: result.audio
          });
          if (!file.fileId) throw fail('B2 上传未返回文件标识');
        }
        const verified = await call('b2_get_file_info', { fileId: file.fileId });
        if (!matches(verified, key, result, sha1)) throw fail('B2 上传后回读校验失败');
        record = { version: 1, bucketId: config.bucketId, key, audioHash: result.audioHash,
          size: result.audio.length, fileId: file.fileId, verifiedBases: [] };
        // 先保留已上传事实：CDN 暂时不可用时下次只补公开地址验证。
        await atomicRecord(receiptPath, record);
      }
      if (!record.verifiedBases.includes(base)) {
        if (!allowUpload) throw fail('B2 公开地址未验证；请执行 hexo generate 验证新域名');
        await verifyPublic(url, result.audio);
        record.verifiedBases.push(base);
        await atomicRecord(receiptPath, record);
      }
      return { ...result, audioUrl: url };
    }
  };
}

module.exports = { createAudioPublisher };
