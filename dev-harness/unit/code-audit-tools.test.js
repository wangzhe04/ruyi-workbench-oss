'use strict';
// 代码审计类工具的噪声与保真(审计 NE-14)。
//   [A1] code_review_scan:正则 .exec( / querySelector / 散文里的 update+拼接 不再当成 shell-exec / sql-concat;真风险照报
//   [A2] code_review_scan:counts 在 findings 之前,高危排前面
//   [A3] frontend_audit:给出首个命中的行号与片段;注释里的 CDN 链接不算
//   [A4] claude_md_audit:英文关键词带词界("latest" 不算写了 test 命令)
//   [A5] debug_hypothesis:test 之后 ledger 仍保留 mechanism / expectedEvidence / verification
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-code-audit-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
process.env.RUYI_HOME = path.join(root, 'data');
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
const mk = (name, files) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
};
const ctxFor = dir => ({ config: { permissionMode: 'default' }, session: { id: 's', cwd: dir } });

test('[A1] code_review_scan:正则 exec / querySelector / 散文拼接不再误报', async () => {
  const dir = mk('a1', {
    'quiet.js': [
      "const m = /^(\\d+)-(\\w+)$/.exec(line);",
      "const n = pattern.exec(text);",
      "document.querySelector('#x').classList.add('y');",
      "const title = 'Update ' + name + ' and Delete ' + other;",
      "map.delete(key); // Select the rows from the table",
      "// child_process.exec('rm ' + x) is what we avoid here",
    ].join('\n'),
    'risky.js': [
      "const { exec } = require('child_process');",
      "exec('ls ' + dir);",
      "require('child_process').execSync('dir ' + dir);",
      "db.query(\"SELECT * FROM users WHERE id=\" + id);",
      "db.query(`DELETE FROM orders WHERE id=${id}`);",
    ].join('\n'),
    'risky.py': "import os\nos.system('rm ' + p)\nsubprocess.run(cmd, shell=True)\n",
  });
  const r = await srv.toolCall('code_review_scan', { root: dir }, ctxFor(dir));
  assert.equal(r.ok, true);
  const quiet = r.findings.filter(f => f.relativePath === 'quiet.js');
  assert.deepEqual(quiet, [], 'quiet.js: ' + JSON.stringify(quiet));
  const hits = id => r.findings.filter(f => f.id === id).map(f => `${f.relativePath}:${f.line}`).sort();
  assert.deepEqual(hits('shell-exec'), ['risky.js:2', 'risky.js:3', 'risky.py:2', 'risky.py:3']);
  assert.deepEqual(hits('sql-concat'), ['risky.js:4', 'risky.js:5']);
});

test('[A2] code_review_scan:counts 在 findings 前,高危排前面', async () => {
  const dir = mk('a2', {
    'a-notes.js': '// TODO: later\n',
    'z-config.js': "const apiKey = 'abcdefghijklmnop123456';\n",
  });
  const r = await srv.toolCall('code_review_scan', { root: dir }, ctxFor(dir));
  const keys = Object.keys(r);
  assert.ok(keys.indexOf('counts') < keys.indexOf('findings'));
  assert.equal(r.findings[0].severity, 'high', JSON.stringify(r.findings.map(f => f.severity)));
  assert.equal(r.findings[r.findings.length - 1].severity, 'low');
  assert.equal(r.total, r.findings.length);
});

test('[A3] frontend_audit:首个命中的行号与片段;注释里的 CDN 不算', async () => {
  const dir = mk('a3', {
    'index.html': [
      '<!-- <script src="https://cdn.example.com/old.js"></script> -->',
      '<html><head><meta name="viewport" content="width=device-width"></head>',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=X">',
      '</html>',
    ].join('\n'),
    'app.css': 'a { color: red; }\n/* cdn: https://cdn.example.com/x */\nh1 { letter-spacing: -1px; }\n',
  });
  const r = await srv.toolCall('frontend_audit', { root: dir }, ctxFor(dir));
  const ext = r.issues.find(i => i.id === 'external-asset' && i.relativePath === 'index.html');
  assert.ok(ext, JSON.stringify(r.issues));
  assert.equal(ext.line, 3);
  assert.match(ext.text, /fonts\.googleapis\.com/);
  const ls = r.issues.find(i => i.id === 'negative-letter-spacing');
  assert.equal(ls.line, 3);
  assert.ok(!r.issues.some(i => i.id === 'external-asset' && i.relativePath === 'app.css'), '注释里的 CDN 不算');
});

test('[A4] claude_md_audit:词界 —— "latest" 不算写了 test 命令', async () => {
  const dir = mk('a4', { 'CLAUDE.md': 'latest thoughts, nothing else here\n' });
  const r = await srv.toolCall('claude_md_audit', { root: dir }, ctxFor(dir));
  assert.equal(r.found, 1);
  assert.ok(r.audits[0].missing.includes('commands'), JSON.stringify(r.audits[0].missing));
  const dir2 = mk('a4b', { 'CLAUDE.md': '# Overview\nRun the tests with `npm test`. Follow the style conventions. No secrets. Works offline.\n' });
  const r2 = await srv.toolCall('claude_md_audit', { root: dir2 }, ctxFor(dir2));
  assert.deepEqual(r2.audits[0].missing, []);
});

test('[A5] debug_hypothesis:test 之后 ledger 仍保留 mechanism/expectedEvidence/verification', async () => {
  const init = await srv.toolCall('debug_hypothesis', { action: 'init', hypotheses: [{ id: 'H1', description: 'cache stale', mechanism: 'TTL not reset', expectedEvidence: 'old value after write', verification: 'write then read twice' }] }, {});
  assert.equal(init.ok, true);
  const t = await srv.toolCall('debug_hypothesis', { action: 'test', ledger: init.ledger, hypothesisId: 'H1', result: 'supports', evidence: 'saw old value' }, {});
  assert.equal(t.ok, true, JSON.stringify(t));
  const h = t.ledger.hypotheses[0];
  assert.equal(h.mechanism, 'TTL not reset');
  assert.equal(h.expectedEvidence, 'old value after write');
  assert.equal(h.verification, 'write then read twice');
  const s = await srv.toolCall('debug_hypothesis', { action: 'status', ledger: t.ledger }, {});
  assert.equal(s.ledger.hypotheses[0].verification, 'write then read twice');
});
