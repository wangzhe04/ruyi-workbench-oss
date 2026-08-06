#!/usr/bin/env node
'use strict';
// v2.5 临时冒烟测试:claude-code 技能源 + MCP 自动导入 + DELETE /api/skills。
// 跑完即弃;不进 dev-harness 正式套件。
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const http = require('http');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'ruyi-workbench', 'app', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-v25-'));
process.env.RUYI_HOME = TMP;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail || ''); }
}

(async () => {
  console.log('TMP dataRoot:', TMP);

  // ── Part A: 纯函数(不启动服务器) ──────────────────────────────────
  console.log('\n[A] pure function tests');
  const mod = require(SERVER);

  const dc = mod.defaultConfig();
  ok('defaultConfig.autoImportClaudeCodeMcp === true', dc.autoImportClaudeCodeMcp === true);
  ok('defaultConfig.dismissedMcpIds is []', Array.isArray(dc.dismissedMcpIds) && dc.dismissedMcpIds.length === 0);

  // normalizeConfig: 返回 {config, changed};混入脏值应被清洗
  const nr = mod.normalizeConfig({
    autoImportClaudeCodeMcp: false,
    dismissedMcpIds: ['a', 'a', 'b', 123, '', 'c'.repeat(200)],
  });
  const norm = nr.config;
  ok('normalize autoImport=false preserved', norm.autoImportClaudeCodeMcp === false);
  ok('normalize dismissedMcpIds dedup+trim+cap', JSON.stringify(norm.dismissedMcpIds) === JSON.stringify(['a', 'b', 'c'.repeat(64)]),
    'got ' + JSON.stringify(norm.dismissedMcpIds));
  ok('normalize dismissedMcpIds cap 64 chars', norm.dismissedMcpIds[2].length === 64);

  // 默认 true(未设字段)
  const nr2 = mod.normalizeConfig({});
  const norm2 = nr2.config;
  ok('normalize default autoImport=true', norm2.autoImportClaudeCodeMcp === true);
  ok('normalize default dismissed=[]', Array.isArray(norm2.dismissedMcpIds) && norm2.dismissedMcpIds.length === 0);

  // autoImportClaudeCodeMcp 开关关闭 -> 立即返回 {added:0}, 不读盘
  const r0 = await mod.autoImportClaudeCodeMcp({ autoImportClaudeCodeMcp: false, externalMcpServers: [], dismissedMcpIds: [] });
  ok('autoImport disabled -> added=0', r0.added === 0 && r0.config && r0.config.autoImportClaudeCodeMcp === false);

  // loadSkillRegistry 未导出 -> 跳过直接单测,改由 HTTP GET /api/skills 覆盖

  // ── Part B: HTTP 端到端(子进程) ──────────────────────────────────
  console.log('\n[B] HTTP end-to-end (DELETE /api/skills)');
  await fsp.mkdir(path.join(TMP, 'skills', 'test-user-skill'), { recursive: true });
  await fsp.writeFile(path.join(TMP, 'skills', 'test-user-skill', 'SKILL.md'),
    '---\nname: 测试用户技能\ndescription: 临时测试\n---\n# 测试\nbody\n', 'utf8');

  const port = 18765 + Math.floor(Math.random() * 1000);
  const child = cp.spawn(process.execPath, [SERVER, 'serve'], {
    env: { ...process.env, RUYI_HOME: TMP, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });

  // 等 runtime.json 出现(含 token)
  const runtimePath = path.join(TMP, 'runtime.json');
  let token = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = JSON.parse(await fsp.readFile(runtimePath, 'utf8'));
      if (r.token && r.port === port) { token = r.token; break; }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  ok('server booted + runtime.json token', !!token, token ? '' : 'no token (stderr: ' + stderr.slice(0, 200) + ')');
  if (!token) { child.kill(); console.log('\nRESULT:', pass, 'pass,', fail, 'fail'); process.exit(fail ? 1 : 0); }

  const req = (method, p, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: { 'x-wcw-token': token, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    if (data) r.write(data);
    r.end();
  });

  // B1: GET /api/skills 应见 test-user-skill
  let r = await req('GET', '/api/skills', null);
  let j = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
  const skills = j && Array.isArray(j.skills) ? j.skills : [];
  const found = skills.find(s => s.id === 'test-user-skill');
  ok('GET /api/skills lists user skill', !!found, 'skills=' + skills.map(s => s.id).join(','));
  ok('user skill source === user', found && found.source === 'user');

  // B2: DELETE 无 confirm -> 400
  r = await req('DELETE', '/api/skills', { id: 'test-user-skill' });
  ok('DELETE without confirm -> 400', r.status === 400, 'status=' + r.status);

  // B3: DELETE confirm 不匹配 -> 400
  r = await req('DELETE', '/api/skills', { id: 'test-user-skill', confirm: 'wrong' });
  ok('DELETE mismatched confirm -> 400', r.status === 400, 'status=' + r.status);

  // B4: DELETE 非法 id -> 400
  r = await req('DELETE', '/api/skills', { id: '../etc', confirm: '../etc' });
  ok('DELETE path-traversal id -> 400', r.status === 400, 'status=' + r.status);

  // B5: DELETE 正确 confirm -> 200
  r = await req('DELETE', '/api/skills', { id: 'test-user-skill', confirm: 'test-user-skill' });
  j = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
  ok('DELETE correct confirm -> 200 ok', r.status === 200 && j && j.ok === true, 'status=' + r.status + ' body=' + r.body.slice(0, 120));

  // B6: 再 GET -> 技能已消失
  r = await req('GET', '/api/skills', null);
  j = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
  const gone = !(j && Array.isArray(j.skills) && j.skills.some(s => s.id === 'test-user-skill'));
  ok('skill gone after delete', gone);

  // B7: 目录确实被删
  const dirExists = fs.existsSync(path.join(TMP, 'skills', 'test-user-skill'));
  ok('skill directory removed from disk', !dirExists);

  // B8: DELETE 不存在的 -> 404
  r = await req('DELETE', '/api/skills', { id: 'never-existed', confirm: 'never-existed' });
  ok('DELETE missing skill -> 404', r.status === 404, 'status=' + r.status);

  // ── Part C: claude-code 技能源(自动映射 ~/.claude/skills/)。服务器仍在运行 ──
  console.log('\n[C] claude-code skill source (auto-map ~/.claude/skills/)');
  const ccBase = path.join(os.homedir(), '.claude', 'skills');
  const ccId = 'v25-cc-test-skill';
  const ccDir = path.join(ccBase, ccId);
  let cleanupCc = false;
  try {
    await fsp.mkdir(ccDir, { recursive: true });
    await fsp.writeFile(path.join(ccDir, 'SKILL.md'),
      '---\nname: CC测试技能\ndescription: 来自 Claude Code 的映射技能\n---\n# CC body\n', 'utf8');
    cleanupCc = true;
    const r2 = await req('GET', '/api/skills', null);
    const j2 = (() => { try { return JSON.parse(r2.body); } catch { return null; } })();
    const cc = j2 && Array.isArray(j2.skills) ? j2.skills.find(s => s.id === ccId) : null;
    ok('claude-code skill auto-mapped into registry', !!cc, 'body=' + r2.body.slice(0, 150));
    ok('claude-code skill source === "claude-code"', cc && cc.source === 'claude-code', 'source=' + (cc && cc.source));
  } finally {
    if (cleanupCc) { try { await fsp.rm(ccDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  child.kill();
  await new Promise(r => setTimeout(r, 300));

  // ── Part D: autoImportClaudeCodeMcp 幂等性(直接调导出函数,无需服务器) ──
  console.log('\n[D] autoImportClaudeCodeMcp idempotence');
  const imp1 = await mod.autoImportClaudeCodeMcp({ autoImportClaudeCodeMcp: true, externalMcpServers: [], dismissedMcpIds: [] });
  ok('autoImport #1 returns added>=0 + config', typeof imp1.added === 'number' && imp1.config, 'added=' + imp1.added + ' err=' + (imp1.error || ''));
  ok('autoImport skips reserved ids (win-claude-workbench, ai-computer-control)',
    !(imp1.ids || []).some(id => id === 'win-claude-workbench' || id === 'ai-computer-control'),
    'ids=' + JSON.stringify(imp1.ids));
  // 第二次:externalMcpServers 已含第一次导入的 id -> 全 conflict -> added=0(幂等)
  const imp2 = await mod.autoImportClaudeCodeMcp(imp1.config);
  ok('autoImport #2 idempotent (added=0)', imp2.added === 0, 'added=' + imp2.added);
  // dismissed 跳过:把第一次导入的第一个 id 放进 dismissed,重置 externalMcpServers=[],应跳过该 id
  if (imp1.added > 0 && imp1.ids && imp1.ids.length) {
    const dismissId = imp1.ids[0];
    const imp3 = await mod.autoImportClaudeCodeMcp({ autoImportClaudeCodeMcp: true, externalMcpServers: [], dismissedMcpIds: [dismissId] });
    ok('autoImport skips dismissed id', !imp3.ids || !imp3.ids.includes(dismissId), 'ids=' + JSON.stringify(imp3.ids));
  } else {
    ok('autoImport dismissed-skip (skipped: no real CC mcp to import)', true);
  }

  console.log('\nRESULT:', pass, 'pass,', fail, 'fail');
  // 清理
  try { await fsp.rm(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e.stack || e); process.exit(2); });
