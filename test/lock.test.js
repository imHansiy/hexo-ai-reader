'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { withPreparationLock } = require('../lib/lock');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('锁内只进入一次，正常完成或异常退出均释放自己的锁', async t => {
  const root = await directory(t);
  await withPreparationLock(root, async () => {
    await assert.rejects(withPreparationLock(root, () => assert.fail('不能重复进入')), { code: 'AI_READER_BUSY' });
  });
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(withPreparationLock(root, async () => { throw new Error('准备失败'); }), /准备失败/);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await withPreparationLock(root, () => '再次准备'), '再次准备');
});

test('真实子进程持锁阻止另一个进程，进程被终止后自动恢复', async t => {
  const root = await directory(t);
  const helper = path.join(root, 'holder.cjs');
  await fs.writeFile(helper, `const { withPreparationLock } = require(${JSON.stringify(require.resolve('../lib/lock'))});
withPreparationLock(process.argv[2], () => new Promise(resolve => {
  process.send('locked'); process.on('message', () => resolve());
})).then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });`);
  const child = fork(helper, [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const error = [];
  child.stderr.on('data', data => error.push(String(data)));
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(error.join('')); })]);
  assert.equal(message[0], 'locked');
  await assert.rejects(withPreparationLock(root, () => assert.fail('不能重复调用模型')), { code: 'AI_READER_BUSY' });
  const exited = once(child, 'exit'); child.kill(); await exited;
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.lock')).length, 1);
  assert.equal(await withPreparationLock(root, () => '已恢复'), '已恢复');
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.lock')).length, 0);
});

test('四个真实进程同时竞争时最多一个进入准备阶段', { timeout: 10000 }, async t => {
  const root = await directory(t);
  const helper = path.join(root, 'contender.cjs');
  await fs.writeFile(helper, `const { once } = require('node:events');
const { withPreparationLock } = require(${JSON.stringify(require.resolve('../lib/lock'))});
process.once('message', async () => {
  try { await withPreparationLock(process.argv[2], async () => {
    process.send('entered'); await once(process, 'message');
  }); } catch (error) {
    if (error.code !== 'AI_READER_BUSY') { process.exit(1); return; }
    process.send('busy');
  }
  process.exit(0);
});
process.send('ready');`);
  const children = Array.from({ length: 4 }, () => fork(helper, [root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map(child => once(child, 'message')));
  const results = children.map(child => once(child, 'message'));
  const exits = children.map(child => once(child, 'exit'));
  for (const child of children) child.send('start');
  const statuses = (await Promise.all(results)).map(([value]) => value);
  assert.ok(statuses.filter(value => value === 'entered').length <= 1);
  assert.ok(statuses.every(value => value === 'entered' || value === 'busy'));
  children.forEach((child, index) => { if (statuses[index] === 'entered') child.send('release'); });
  assert.ok((await Promise.all(exits)).every(([code]) => code === 0));
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.lock')).length, 0);
});
