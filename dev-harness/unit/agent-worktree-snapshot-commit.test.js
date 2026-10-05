'use strict';
// Unit(走查 W1·F5):finalizeAgentWorktree 的内部快照提交不受用户仓库的钩子与签名配置牵连。
// 修前是裸 `git commit`:用户仓库里有 pre-commit(lint / 测试)、commit-msg、prepare-commit-msg 钩子,
// 或 commit.gpgsign=true 而本机没有可用的 gpg 时,快照提交失败 → finalize 抛错 → 整个隔离节点失败。
//   [W1] 四种钩子都「会失败 / 会留痕」+ gpgsign 指向不存在的 gpg:finalize 仍成功(status ready、有 40 位提交号),
//        钩子一个都没跑(留痕文件不存在),提交作者是 Ruyi Agent。
//   [W2] 干净的隔离树(没改动)路径不变:status clean、worktree 被清掉。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-worktree-commit-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
const git = (args, cwd = repo) => cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git(['init', '-b', 'main']); git(['config', 'user.name', 'Ruyi Test']); git(['config', 'user.email', 'test@ruyi.local']);
fs.writeFileSync(path.join(repo, 'value.txt'), 'main\n');
git(['add', '-A']); git(['commit', '-m', 'initial']);
// 钩子:全部「留痕 + 失败」(commit-msg / pre-commit / prepare-commit-msg 失败会中止提交;post-commit 只留痕)。
const TRACE = path.join(root, 'hook-trace.log');
const traceHook = name => `#!/bin/sh\necho ${name} >> "${TRACE.replace(/\\/g, '/')}"\nexit 1\n`;
for (const name of ['pre-commit', 'commit-msg', 'prepare-commit-msg', 'post-commit']) {
  const file = path.join(repo, '.git', 'hooks', name);
  fs.writeFileSync(file, traceHook(name));
  fs.chmodSync(file, 0o755);
}
// 要求签名,但 gpg 程序不存在:签名那一步必失败。
git(['config', 'commit.gpgsign', 'true']);
git(['config', 'gpg.program', path.join(root, 'no-such-gpg-binary')]);

test('[W1] 钩子会失败 + gpgsign 要签名而 gpg 不存在:finalizeAgentWorktree 仍成功,钩子一个没跑', async () => {
  // 前提自检:这套仓库配置下裸 git commit 确实会失败(否则这条测试什么也没证明)
  fs.writeFileSync(path.join(repo, 'probe.txt'), 'probe\n');
  git(['add', '-A']);
  assert.throws(() => git(['commit', '-m', 'probe']), '前提:裸 commit 在这套配置下失败');
  git(['reset', '--hard', 'HEAD']);
  try { fs.unlinkSync(TRACE); } catch { /* ignore */ }

  const iso = await srv.createAgentWorktree(repo, 'run_w1snap01', 'writer', 1);
  fs.writeFileSync(path.join(iso.path, 'value.txt'), 'isolated\n');
  fs.writeFileSync(path.join(iso.path, 'new.txt'), 'new\n');
  const out = await srv.finalizeAgentWorktree(iso, 'run_w1snap01', 'writer');
  assert.equal(out.status, 'ready', JSON.stringify(out));
  assert.match(out.commit || '', /^[a-f0-9]{40}$/i);
  assert.equal(fs.existsSync(TRACE), false, '用户的任何钩子都不该为内部快照提交运行' + (fs.existsSync(TRACE) ? ':' + fs.readFileSync(TRACE, 'utf8') : ''));
  assert.equal(git(['log', '-1', '--format=%an <%ae>', out.commit]), 'Ruyi Agent <agent@ruyi.local>');
  assert.equal(git(['show', out.commit + ':value.txt']), 'isolated');
  assert.equal(git(['show', out.commit + ':new.txt']), 'new');
  assert.equal(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8'), 'main\n', '主工作区没被动');
  try { git(['worktree', 'remove', '--force', iso.path]); } catch { /* ignore */ }
});

test('[W2] 没有改动的隔离树:clean,worktree 被清掉(路径不变)', async () => {
  const iso = await srv.createAgentWorktree(repo, 'run_w1snap02', 'writer', 1);
  const out = await srv.finalizeAgentWorktree(iso, 'run_w1snap02', 'writer');
  assert.equal(out.status, 'clean');
  assert.equal(out.path, '');
});
