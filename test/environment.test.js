'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { loadEnvironment } = require('../lib/environment');

test('私有环境文件只读取赋值，支持注释，保留已有环境变量', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-env-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env.ai-reader');
  await fs.writeFile(file, "export KEY='file-value'\nEMPTY='' # comment\nRAW=plain # comment\nLITERAL='$(echo secret)'\n# ignored\n");
  const target = { KEY: 'existing-value' };
  loadEnvironment(file, target);
  assert.deepEqual(target, { KEY: 'existing-value', EMPTY: '', RAW: 'plain', LITERAL: '$(echo secret)' });
  assert.doesNotThrow(() => loadEnvironment(path.join(directory, 'missing'), {}));
  await fs.writeFile(file, "KEY='private-content-without-closing-quote\n");
  assert.throws(() => loadEnvironment(file, {}), error => /引号格式/.test(error.message) && !error.message.includes('private-content'));
});
