'use strict';
// 150 号文 U9：隐私保护开启后，文件树读目录(/api/tools/file_list，回合外的工具调用)被网关拒成
// privacy.engine_not_supported，修前文件树原样印通用文案「请为本线程选择原生 API 引擎」—— 而本线程本来就是
// API 引擎，用户照做也没用。现在按码说文件树自己的理由；被藏起来的如意数据目录也补一句理由。
// 码只经 privacy-failure.js 的 privacyFailure 只读取(不改隐私模块)。错误体照真服务的回包形状：
// 409 {"ok":false,"error":{"code":"api.internal_error","params":{},"message":"privacy.engine_not_supported"}}
// (4C 实现时起真 serve、enhanced 档实测得到)，net.js api() 把整段回包正文当 Error.message 抛出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { functionBlock } = require('../lib/source-slice');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/js/file-browser.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/locales/en-US.json'), 'utf8'));

const serverBody = code => JSON.stringify({ ok: false, error: { code: 'api.internal_error', params: {}, message: code } }, null, 2);
const httpError = (body, status = 409) => Object.assign(new Error(body), { status, path: '/api/tools/file_list' });

async function failureText() {
  const { privacyFailure } = await import(pathToFileURL(path.join(repo, 'ruyi-workbench/app/public/js/privacy-failure.js')).href);
  const fn = functionBlock(source, 'fileTreeFailureText').replace(/^export\s+/, '');
  const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
  return vm.runInNewContext(fn + '\n;fileTreeFailureText', { privacyFailure, t, fallbackApiErrText: e => 'raw:' + String(e && e.message).slice(0, 20) });
}

test('a privacy-blocked directory listing explains the file tree, not the engine', async () => {
  const text = await failureText();
  assert.equal(text(httpError(serverBody('privacy.engine_not_supported'))), 'file.tree.privacyLocked');
  assert.equal(text(httpError(serverBody('privacy.policy_unavailable'))), 'file.tree.privacyUnavailable');
  assert.doesNotMatch(zh['file.tree.privacyLocked'], /选择.*引擎/, 'must not tell the user to pick another engine');
  assert.match(zh['file.tree.privacyLocked'], /隐私保护/);
  assert.match(en['file.tree.privacyLocked'], /privacy protection/i);
});

test('other failures keep the generic read-failed sentence', async () => {
  const text = await failureText();
  assert.match(text(httpError('{"ok":false,"error":{"code":"tool.failed","message":"ENOENT"}}', 400)), /^file\.tree\.readFailed /);
  assert.match(text(new Error('目录不存在')), /^file\.tree\.readFailed /);
});

test('both tree failure sites use the file-tree reason and the hidden data root is announced', () => {
  assert.equal((source.match(/fileTreeFailureText\(error, apiErrText\)/g) || []).length, 2, 'root load and folder expand');
  assert.equal((source.match(/t\('file\.tree\.readFailed'/g) || []).length, 1, 'only the fallback inside fileTreeFailureText');
  const fetchLevel = functionBlock(source, 'fetchDirLevel');
  assert.ok(fetchLevel.includes('entries.hiddenDataRoot = result.files.length > entries.length'));
  assert.ok(functionBlock(source, 'appendTruncatedNote').includes("t('file.tree.hiddenDataRoot')"));
  for (const key of ['file.tree.privacyLocked', 'file.tree.privacyUnavailable', 'file.tree.hiddenDataRoot']) {
    assert.equal(typeof zh[key], 'string', key);
    assert.equal(typeof en[key], 'string', key);
  }
});

test('fetchDirLevel flags the hidden data root (behaviour, with stubbed api/state)', async () => {
  const fn = functionBlock(source, 'fetchDirLevel');
  const run = async files => {
    const ctx = {
      api: async () => ({ ok: true, result: { ok: true, files } }),
      state: { status: { dataRoot: 'C:\\Users\\me\\.ruyi-workbench', dataRootAliases: [] } },
      fileBasename: p => String(p).split(/[\\/]/).pop(), t: k => k, DIR_LIST_MAX_FILES: 5000, DIR_READ_FAILURE_KEYS: {},
    };
    return vm.runInNewContext(fn + '\n;fetchDirLevel', ctx)('C:\\Users\\me');
  };
  const hidden = await run([{ path: 'C:\\Users\\me\\.ruyi-workbench', type: 'directory' }, { path: 'C:\\Users\\me\\a.txt', type: 'file' }]);
  assert.equal(hidden.length, 1);
  assert.equal(hidden.hiddenDataRoot, true);
  const plain = await run([{ path: 'C:\\Users\\me\\a.txt', type: 'file' }]);
  assert.equal(plain.hiddenDataRoot, false);
});
