'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

const host = createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
const pattern = /^\.prepare-([a-f0-9]{16})-(\d+)-([a-f0-9-]{36})\.lock$/;

// 每个候选者先创建独立文件，再检查其他候选者。若同时竞争，允许双方
// 都退出，但不能同时进入。死进程文件有唯一名字，清理不会误删新锁。
async function withPreparationLock(directory, action) {
  await fs.mkdir(directory, { recursive: true });
  const name = `.prepare-${host}-${process.pid}-${randomUUID()}.lock`;
  const file = path.join(directory, name);
  const handle = await fs.open(file, 'wx');
  await handle.close();
  try {
    for (const other of await fs.readdir(directory)) {
      const match = other.match(pattern);
      if (!match || other === name) continue;
      const pid = Number(match[2]);
      if (match[1] === host) {
        try { process.kill(pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') {
            await fs.rm(path.join(directory, other), { force: true });
            continue;
          }
          // 无权限查询时按仍在运行处理，避免重复计费。
        }
      }
      const error = new Error(`已有导读准备或清理进程（PID ${pid}）正在运行，请等待完成后重试`);
      error.code = 'AI_READER_BUSY';
      throw error;
    }
    return await action();
  } finally { await fs.rm(file, { force: true }); }
}

module.exports = { withPreparationLock };
