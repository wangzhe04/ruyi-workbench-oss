'use strict';
// 152 L1/L2: send-time memory recall is bounded, and header vectors are shared across sessions.
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { functionBlock, constBlock } = require('../lib/source-slice');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');

test('L3 a memory header without coresummary carries its description once', () => {
  const build = vm.runInNewContext(constBlock(source('06d-memory-domain.js'), 'CORE_MEMORY_SUMMARY_CAP') + ';' + functionBlock(source('06d-memory-domain.js'), 'memorySemanticHeaderText') + ';memorySemanticHeaderText');
  const description = '部署前先冻结写入并核对备份校验和';
  // Pre-fix: [id, name, description, coresummary || description, type] repeated the description.
  const plain = build('deploy-freeze', { name: '发布冻结', description }, 'project');
  a.equal(plain.split(description).length - 1, 1);
  a.equal(plain, 'deploy-freeze 发布冻结 ' + description + ' project');
  a.equal(build('x', { name: 'n', description: 'd', coresummary: 'd' }, 'user'), 'x n d user');
  a.equal(build('x', { name: 'n', description: 'd', coresummary: 's' }, 'user'), 'x n d s user');
  a.equal(build('x', {}, 'user'), 'x x user');
});
