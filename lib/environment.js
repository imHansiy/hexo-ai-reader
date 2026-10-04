'use strict';

const fs = require('node:fs');

// 只解析赋值，不执行 shell；已有环境变量（如 CI 提供的凭据）优先。
function loadEnvironment(file, target = process.env) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || target[match[1]] !== undefined) continue;
    let value = match[2].trim();
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
    if (quoted) value = quoted[2];
    else if (/^['"]/.test(value)) throw new Error(`私有环境文件中 ${match[1]} 的引号格式无效`);
    else value = value.replace(/\s+#.*$/, '').trim();
    target[match[1]] = value;
  }
}

module.exports = { loadEnvironment };
