'use strict';
// git_* 工具的 cwd 解析与结果形状(审计 NE-6 / NE-7)。真跑本机 git;没有 git 的机器整件跳过。
//   [G1] 不传 cwd → 用对话工作目录(与 powershell_run/script_run/shell_start 同一套解析),不是家目录
//   [G2] 显式 cwd 不存在 → 报「目录不存在」,不再悄悄换成家目录
//   [G3] git_diff 只有未跟踪文件 → 列出 untracked,不说「没有改动」
//   [G4] 中文路径原样显示(core.quotepath=false),不是 "\346\226\260..." 八进制
//   [G5] 大 diff:序列化后远低于 60K,truncated 在 diff 之前,附 --stat 文件清单
//   [G6] 超过 maxBuffer 的巨型 diff:优雅截断,不是「Git 命令执行失败」
//   [G7] git_commit:addAll 默认 false(代码与 schema 文字一致),没有暂存时提示 addAll/paths
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const haveGit = (() => { try { return cp.spawnSync('git', ['--version']).status === 0; } catch { return false; } })();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-git-shape-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = path.join(root, 'data');
process.env.RUYI_HOME = path.join(root, 'data');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const git = (cwd, ...args) => cp.execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' });
function mkRepo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@example.com');
  return dir;
}
const ctxFor = cwd => ({ config: { permissionMode: 'default' }, session: { id: 's', cwd } });
const opts = { skip: haveGit ? false : '本机没有 git' };

test('[G1] git_status 不传 cwd:落在对话工作目录', opts, async () => {
  const repo = mkRepo('g1');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const r = await srv.toolCall('git_status', {}, ctxFor(repo));
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(path.resolve(r.cwd), path.resolve(repo));
  assert.equal(r.untracked, 1);
  const log = await srv.toolCall('git_log', {}, ctxFor(repo));
  assert.notEqual(log.error, '这个文件夹还不是 Git 仓库', 'git_log 也用对话工作目录');
});

test('[G2] 显式 cwd 不存在:报错并点名路径,不换成家目录', opts, async () => {
  const repo = mkRepo('g2');
  // 写错的目录放在线程工作目录【里面】:读类 git 先过工作区围栏(2026-10 工具走查,与 file_read 同一道),
  // 区外的路径先报 not-allowed,不替区外探测「这个目录在不在」。
  const bad = path.join(repo, 'typo-dir');
  for (const tool of ['git_status', 'git_diff', 'git_log']) {
    const r = await srv.toolCall(tool, { cwd: bad }, ctxFor(repo));
    assert.equal(r.ok, false, tool);
    assert.match(String(r.error), /目录不存在/, tool + JSON.stringify(r).slice(0, 200));
    assert.ok(String(r.error).includes(bad), tool);
  }
  const c = await srv.toolCall('git_commit', { cwd: bad, message: 'x', addAll: true }, ctxFor(repo));
  assert.equal(c.ok, false);
  assert.match(String(c.error), /目录不存在/);
});

test('[G3] git_diff 只有未跟踪文件:列出 untracked,不是「没有改动」', opts, async () => {
  const repo = mkRepo('g3');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'brand-new.txt'), 'hello\n');
  const r = await srv.toolCall('git_diff', {}, ctxFor(repo));
  assert.equal(r.ok, true);
  assert.equal(r.diff, '');
  assert.deepEqual(r.untracked, ['brand-new.txt']);
  assert.equal(r.empty, false, '有未跟踪文件时不能报 empty:true');
  assert.match(String(r.hint), /未跟踪/);
  // 真的干净则仍是 empty:true
  fs.unlinkSync(path.join(repo, 'brand-new.txt'));
  const clean = await srv.toolCall('git_diff', {}, ctxFor(repo));
  assert.equal(clean.empty, true);
  assert.equal(clean.untracked, undefined);
});

test('[G4] 中文路径在 status / diff 里原样显示', opts, async () => {
  const repo = mkRepo('g4');
  fs.writeFileSync(path.join(repo, '中文.txt'), 'one\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, '中文.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, '新文件-报告.md'), 'n\n');
  const st = await srv.toolCall('git_status', {}, ctxFor(repo));
  assert.ok(st.status.includes('新文件-报告.md'), st.status);
  assert.ok(!/\\\d{3}/.test(st.status), '不带八进制转义: ' + st.status);
  const d = await srv.toolCall('git_diff', {}, ctxFor(repo));
  assert.ok(d.diff.includes('中文.txt'), d.diff.slice(0, 200));
  assert.ok(!/\\3\d\d/.test(d.diff.split('\n')[0]), d.diff.split('\n')[0]);
});

test('[G5] 大 diff:序列化远低于 60K,truncated 在 diff 之前,附 stat 文件清单', opts, async () => {
  const repo = mkRepo('g5');
  fs.writeFileSync(path.join(repo, 'big-file.txt'), 'seed\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'seed\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'big-file.txt'), Array.from({ length: 8000 }, (_, i) => 'changed line number ' + i).join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'changed\n');
  const r = await srv.toolCall('git_diff', {}, ctxFor(repo));
  assert.equal(r.ok, true);
  const json = JSON.stringify(r);
  assert.ok(json.length < 55000, 'json ' + json.length);
  assert.equal(r.truncated, true);
  assert.ok(Object.keys(r).indexOf('truncated') < Object.keys(r).indexOf('diff'));
  assert.match(r.diff, /已截断/);
  assert.match(r.stat, /big-file\.txt/);
  assert.match(r.stat, /other\.txt/, 'stat 列出被截掉的那个文件');
  // 用 path 只看一个小文件:不截断
  const one = await srv.toolCall('git_diff', { path: 'other.txt' }, ctxFor(repo));
  assert.equal(one.truncated, false);
  assert.match(one.diff, /\+changed/);
});

test('[G6] 超过 maxBuffer 的巨型 diff:优雅截断而非「Git 命令执行失败」', opts, async () => {
  const repo = mkRepo('g6');
  fs.writeFileSync(path.join(repo, 'huge.txt'), 'seed\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const line = 'y'.repeat(99) + '\n';
  fs.writeFileSync(path.join(repo, 'huge.txt'), line.repeat(100000)); // ~10MB,超过 8MB 上限
  const r = await srv.toolCall('git_diff', {}, ctxFor(repo));
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.truncated, true);
  assert.ok(JSON.stringify(r).length < 55000);
  assert.match(r.stat || '', /huge\.txt/);
});

test('[G7] git_commit:addAll 默认 false;schema 文字与代码一致;没暂存时提示 addAll/paths', opts, async () => {
  const repo = mkRepo('g7');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const r = await srv.toolCall('git_commit', { message: 'try' }, ctxFor(repo));
  assert.equal(r.ok, false);
  assert.match(String(r.hint), /addAll/);
  const ok = await srv.toolCall('git_commit', { message: 'all', addAll: true }, ctxFor(repo));
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 300));
  assert.equal(path.resolve(ok.cwd), path.resolve(repo), 'git_commit 也用对话工作目录');
  const schema = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13f-native-tool-schemas.js'), 'utf8');
  const addAllLine = schema.split('\n').find(l => /addAll:\s*\{/.test(l));
  assert.ok(addAllLine && /default false/.test(addAllLine) && !/default true/.test(addAllLine), addAllLine);
});

// 走查 W1·F6:git_commit 超时的人话与收尸。修前 30s 超时被报成「提交被 pre-commit 钩子拒绝 hookRejected:true detail:''」,
// 钩子起的子进程成了孤儿(还攥着管道)。钩子是 sh 脚本(Git for Windows 自带 sh,Windows 上同样会跑)。
function writeHook(repo, name, body) {
  const file = path.join(repo, '.git', 'hooks', name);
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n');
  fs.chmodSync(file, 0o755);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('[G8] git_commit 超时:说「被终止」+ timedOut,不是 hookRejected;暂存区状态照实报', opts, async () => {
  const repo = mkRepo('g8');
  writeHook(repo, 'pre-commit', 'sleep 30');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const t0 = Date.now();
  const r = await srv.toolCall('git_commit', { message: 'slow', addAll: true, timeoutMs: 1500 }, ctxFor(repo));
  const took = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true, JSON.stringify(r).slice(0, 400));
  assert.notEqual(r.hookRejected, true, '超时不是钩子拒绝');
  assert.match(String(r.error), /超过 \d+ 秒仍未结束,已被终止/);
  assert.match(String(r.hint), /git_status/);
  assert.match(String(r.hint), /pre-commit/, '仓库有 pre-commit 钩子:点一句多半是钩子慢');
  assert.match(String(r.hint), /timeoutMs/);
  assert.equal(r.stagedCount, 1, '文件仍在暂存区,要如实说');
  assert.ok(took < 12000, `超时后应及时返回(耗时 ${took}ms)`);
});

test('[G8] 钩子起的整棵进程树随超时一并结束(不留孤儿)', { skip: !haveGit ? '本机没有 git' : process.platform === 'win32' ? 'sh 子进程号不是 Windows 进程号' : false }, async () => {
  const repo = mkRepo('g8b');
  const pidFile = path.join(repo, 'hook-sleep.pid');
  // 孙进程:后台 sleep(它的 stdout/stderr 仍连着 git 的管道),脚本 wait 它
  writeHook(repo, 'pre-commit', `sleep 60 &\necho $! > "${pidFile}"\nwait`);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const r = await srv.toolCall('git_commit', { message: 'slow', addAll: true, timeoutMs: 1500 }, ctxFor(repo));
  assert.equal(r.timedOut, true, JSON.stringify(r).slice(0, 300));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchild > 0);
  let gone = !alive(grandchild);
  for (let i = 0; i < 30 && !gone; i++) { await new Promise(res => setTimeout(res, 100)); gone = !alive(grandchild); }
  if (!gone) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* ignore */ } }
  assert.ok(gone, '钩子的孙进程(sleep 60)应随超时被杀掉');
});

test('[G8] 钩子真的拒绝(快速非零退出)仍报 hookRejected,不被误当超时', opts, async () => {
  const repo = mkRepo('g8c');
  writeHook(repo, 'pre-commit', 'echo "lint failed: no console.log"\nexit 1');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const r = await srv.toolCall('git_commit', { message: 'x', addAll: true }, ctxFor(repo));
  assert.equal(r.ok, false);
  assert.equal(r.hookRejected, true, JSON.stringify(r).slice(0, 300));
  assert.notEqual(r.timedOut, true);
  assert.match(String(r.detail), /lint failed/);
});

test('[G8] git_commit 的 schema 暴露 timeoutMs、默认超时说清', opts, () => {
  const t = srv.buildOpenAiTools({ ...srv.defaultConfig(), toolLoadingMode: 'full' }, null, { skillsEnabled: true }).find(x => x.function.name === 'git_commit');
  assert.ok(t && t.function.parameters.properties.timeoutMs, 'timeoutMs 在 schema 里');
  assert.match(t.function.description, /90s/);
});
