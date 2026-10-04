'use strict';
// 随包 Claude Code 插件(ruyi-workbench/resources/plugins/ruyi-offline)的形状锁。不依赖 claude CLI(CI 上没有),
// 按 Claude Code 2.1.x `claude plugin validate` 实测报错的同一批规则断。来路:2026-10 随包资产走查 —— plugin.json 里
// "skills":"skills" / "commands":"commands" / "agents":"agents" 让 `claude plugin install` 直接 invalid manifest、
// 插件整体装不上,安装脚本只打一行 warning,一直没人发现。
//   [A] plugin.json:路径字段要么不写(skills/commands/agents 默认目录自动发现),要么 ./ 开头(agents 还须是 .md 文件);
//       license 与仓库 LICENSE 一致。
//   [B] marketplace.json:每个插件 source 是 ./ 相对路径、指向带 .claude-plugin/plugin.json 的目录,名字与版本对得上。
//   [C] agents/*.md:有 frontmatter,name = 文件名、description 非空(Claude Code 靠它决定何时委派);tools 若写,只许
//       Claude Code 内建工具名或工作台真实注册过的 mcp__ruyi__ 工具。
//   [D] skills/<id>/SKILL.md 有 name 与 description、目录名合法;commands/*.md 有 description。
//   [E] 插件目录里每个文件都进了覆盖包载荷(build-overlay PAYLOAD_FILES)—— 修前只登记了技能与命令,覆盖包用户重跑
//       安装脚本时装的还是那份坏清单。
//   [F] 前端点选命令:内置命令两种引擎都插展开后的模板(Claude Code 里只有 /offline-toolkit:<id>,裸 /<id> 解析不了);
//       用户命令在 Agent CLI 下仍插 /name。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-offline-plugin-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
process.env.RUYI_HOME = home;

const REPO = path.resolve(__dirname, '..', '..');
const WB = path.join(REPO, 'ruyi-workbench');
const MARKET = path.join(WB, 'resources', 'plugins', 'ruyi-offline');
const srv = require(path.join(WB, 'app', 'server.js'));
const overlay = require(path.join(WB, 'tools', 'build-overlay.js'));

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// 只认本插件用到的 YAML 子集:--- 包住的若干行,key: value 单行标量,或 key: 后跟缩进的 "- item" 列表。
function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  const out = {};
  let listKey = '';
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && listKey) { out[listKey].push(item[1].trim()); continue; }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = '';
    if (kv[2] === '') { out[kv[1]] = []; listKey = kv[1]; } else out[kv[1]] = kv[2].trim();
  }
  return out;
}
function walk(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(full)); else out.push(full);
  }
  return out;
}

const marketplace = readJson(path.join(MARKET, '.claude-plugin', 'marketplace.json'));
const plugins = marketplace.plugins.map(entry => ({ entry, dir: path.join(MARKET, entry.source) }));
// Claude Code 子代理 frontmatter 里 tools 可用的内建工具名(MCP 工具另按 mcp__<server>__<tool> 认)。
const CLAUDE_BUILTIN_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'Skill']);

test('[A] plugin.json 的路径字段合 Claude Code 清单规范,license 与仓库一致', () => {
  assert.ok(plugins.length >= 1, 'marketplace 里至少有一个插件');
  const repoLicense = fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
  for (const { entry, dir } of plugins) {
    const pj = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    assert.equal(pj.name, entry.name, 'plugin.json 的 name 与市场条目一致');
    for (const key of ['skills', 'commands', 'agents']) {
      if (!Object.prototype.hasOwnProperty.call(pj, key)) continue;
      for (const p of (Array.isArray(pj[key]) ? pj[key] : [pj[key]])) {
        assert.equal(typeof p, 'string', `${key} 只能写路径字符串`);
        assert.ok(p.startsWith('./'), `${key} 路径必须以 ./ 开头(实得 ${JSON.stringify(p)});默认目录不用写`);
        if (key === 'agents') assert.ok(p.endsWith('.md'), `agents 必须指向 .md 文件,不能是目录(实得 ${p})`);
      }
    }
    if (/Apache License\s+Version 2\.0/.test(repoLicense)) assert.equal(pj.license, 'Apache-2.0', 'license 与仓库 LICENSE(Apache-2.0)一致');
  }
});

test('[B] marketplace.json 的 source 是 ./ 相对路径且指向插件目录,版本与 plugin.json 一致', () => {
  for (const { entry, dir } of plugins) {
    assert.ok(typeof entry.source === 'string' && entry.source.startsWith('./'), `source 必须是 ./ 相对路径(实得 ${entry.source})`);
    assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')), `${entry.source} 下有 .claude-plugin/plugin.json`);
    const pj = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    assert.equal(entry.version, pj.version, '市场条目版本与 plugin.json 一致(Claude Code 按版本分缓存目录)');
  }
});

test('[C] 每个 agent 都有 frontmatter:name = 文件名、description 非空、tools 只用真实工具名', () => {
  const nativeTools = new Set(Object.keys(srv.TOOL_HANDLERS || {}));
  assert.ok(nativeTools.size > 20, '能从 server.js 拿到工作台工具注册表');
  for (const { dir } of plugins) {
    const agentsDir = path.join(dir, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    assert.ok(files.length > 0);
    for (const f of files) {
      const fm = frontmatter(path.join(agentsDir, f));
      assert.ok(fm, `${f} 缺 frontmatter(--- 块):Claude Code 只给它一句通用描述,模型不会委派`);
      assert.equal(fm.name, path.basename(f, '.md'), `${f} 的 name 与文件名一致`);
      assert.ok(typeof fm.description === 'string' && fm.description.length >= 20, `${f} 的 description 写清何时用它`);
      if (fm.tools === undefined) continue;
      const tools = Array.isArray(fm.tools) ? fm.tools : fm.tools.split(',').map(s => s.trim()).filter(Boolean);
      for (const tool of tools) {
        const mcp = /^mcp__ruyi__([a-z0-9_]+)$/.exec(tool);
        if (mcp) assert.ok(nativeTools.has(mcp[1]), `${f}: ${tool} 不是工作台注册过的工具`);
        else assert.ok(CLAUDE_BUILTIN_TOOLS.has(tool), `${f}: ${tool} 不是 Claude Code 内建工具名`);
      }
    }
  }
});

test('[D] 技能与命令的 frontmatter 齐全', () => {
  for (const { dir } of plugins) {
    const skillsDir = path.join(dir, 'skills');
    for (const id of fs.readdirSync(skillsDir)) {
      assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, `技能目录名 ${id} 合法(工作台 SKILL_ID_RE / Claude Code 以目录名作标识)`);
      const fm = frontmatter(path.join(skillsDir, id, 'SKILL.md'));
      assert.ok(fm && fm.name && fm.description, `${id}/SKILL.md 有 name 与 description`);
    }
    for (const f of fs.readdirSync(path.join(dir, 'commands')).filter(x => x.endsWith('.md'))) {
      const fm = frontmatter(path.join(dir, 'commands', f));
      assert.ok(fm && fm.description, `commands/${f} 有 description`);
    }
  }
});

test('[E] 插件目录里的每个文件都在覆盖包载荷里', () => {
  const payload = new Set(overlay.PAYLOAD_FILES);
  const files = walk(MARKET).map(f => path.relative(WB, f).split(path.sep).join('/'));
  assert.ok(files.length >= 30, `插件目录可遍历(实得 ${files.length} 个文件)`);
  const missing = files.filter(f => !payload.has(f));
  assert.deepEqual(missing, [], '这些文件没登记进 build-overlay PAYLOAD_FILES,覆盖包会漏发');
});

test('[F] 点选命令:内置命令两种引擎都插模板,用户命令在 Agent CLI 下插 /name', async () => {
  if (!globalThis.window) globalThis.window = globalThis;
  const { commandInsertionText } = await import(pathToFileURL(path.join(WB, 'app', 'public', 'js', 'skills-memory.js')).href);
  const builtin = { kind: 'command', source: 'builtin', id: 'api-probe', insert: '/api-probe', prompt: 'Probe a local or intranet HTTP API.' };
  assert.equal(commandInsertionText(builtin, false), builtin.prompt, 'Agent CLI:内置命令插模板,不插解析不了的裸 /api-probe');
  assert.equal(commandInsertionText(builtin, true), builtin.prompt, 'Provider:插模板');
  const user = { kind: 'command', source: 'user', id: 'my-cmd', insert: '/my-cmd', prompt: 'my template' };
  assert.equal(commandInsertionText(user, false), '/my-cmd', 'Agent CLI:~/.claude/commands 的命令仍交给 CLI 展开');
  assert.equal(commandInsertionText(user, true), 'my template', 'Provider:插模板');
});

// [G] 安装脚本把 MCP 配置 JSON 原样交给 claude。修前 `& $ClaudePath mcp add-json ruyi $serverJson`:Windows PowerShell 5.1
// 不转义内嵌双引号、又按引号个数决定要不要给参数加引号,claude 收到的是 {command:C:\...},登记失败只剩一行 warning。
// 这里把脚本里那两个函数原样切出来,在真的 powershell.exe(5.1)里对 node 跑一遍,比对收到的 argv。
test('[G] 安装脚本经 Invoke-NativeExact 把 JSON 原样交给原生程序(Windows PowerShell 5.1)', { skip: process.platform !== 'win32' && '需要 Windows PowerShell' }, () => {
  const cp = require('child_process');
  const { bracedBlock } = require('../lib/source-slice.js');
  const ps1 = fs.readFileSync(path.join(WB, 'resources', 'scripts', 'install-workbench.ps1'), 'utf8');
  assert.ok(!/&\s*\$ClaudePath\s+mcp\s+add-json/.test(ps1), 'mcp add-json 不再经 & 直接传 JSON');
  assert.ok(ps1.includes("Invoke-NativeExact $ClaudePath @('mcp', 'add-json', 'ruyi', $serverJson, '-s', $Scope)"), 'mcp add-json 走 Invoke-NativeExact');
  const fns = ['function ConvertTo-CommandLineToken', 'function Invoke-NativeExact'].map(marker => {
    const block = bracedBlock(ps1, marker);
    assert.ok(block, `切得出 ${marker}`);
    return block;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-native-args-'));
  try {
    const value = { command: 'C:\\Program Files\\Ruyi\\runtime\\node\\node.exe', args: ['C:\\dir with space\\', 'say "hi"', ''], env: { A: 'b\\' } };
    const want = ['mcp', 'add-json', 'ruyi', JSON.stringify(value), '-s', 'user'];
    const q = s => "'" + String(s).replace(/'/g, "''") + "'";
    fs.writeFileSync(path.join(dir, 'value.json'), want[3]);
    fs.writeFileSync(path.join(dir, 'echo.js'), "require('fs').writeFileSync(process.env.RUYI_ARGV_OUT, JSON.stringify(process.argv.slice(2)))");
    fs.writeFileSync(path.join(dir, 'run.ps1'), [
      ...fns,
      `$json = Get-Content -Raw -LiteralPath ${q(path.join(dir, 'value.json'))}`,
      `exit (Invoke-NativeExact ${q(process.execPath)} @(${q(path.join(dir, 'echo.js'))}, 'mcp', 'add-json', 'ruyi', $json, '-s', 'user'))`,
    ].join('\r\n'));
    const out = path.join(dir, 'argv.json');
    const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'run.ps1')],
      { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, RUYI_ARGV_OUT: out } });
    assert.equal(r.status, 0, `powershell 退出码 0(stderr: ${r.stderr})`);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), want, '原生程序收到的 argv 与脚本给的逐项相同(含空格、引号、末尾反斜杠、空串)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 临时目录 */ } });
