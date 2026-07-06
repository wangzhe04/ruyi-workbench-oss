'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-agent-worktree-'));
process.env.RUYI_HOME = path.join(root, 'data');
const { createAgentWorktree, finalizeAgentWorktree, applyAgentWorktree } = require('../ruyi-workbench/app/server.js');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
function git(args, cwd = repo) { return cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
let failures = 0;
function ok(condition, label) { if (condition) console.log('PASS ' + label); else { failures += 1; console.error('FAIL ' + label); } }

(async () => {
  git(['init']); git(['config', 'user.name', 'Ruyi Test']); git(['config', 'user.email', 'test@ruyi.local']);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'main\n');
  git(['add', '-A']); git(['commit', '-m', 'initial']);

  fs.writeFileSync(path.join(repo, 'preexisting-dirty.txt'), 'dirty\n');
  let dirtyCreateError = '';
  try { await createAgentWorktree(repo, 'run_dirty1234', 'writer', 1); } catch (e) { dirtyCreateError = String(e && e.message || e); }
  ok(/未提交改动/.test(dirtyCreateError), 'isolation refuses an inconsistent dirty source snapshot');
  fs.unlinkSync(path.join(repo, 'preexisting-dirty.txt'));
  const isolation = await createAgentWorktree(repo, 'run_1234abcd', 'writer', 1);
  ok(isolation.path && fs.existsSync(isolation.path), 'isolated worktree is created outside the repository');
  ok(!path.resolve(isolation.path).startsWith(path.resolve(repo) + path.sep), 'worktree storage does not pollute the source repository');
  fs.writeFileSync(path.join(isolation.path, 'value.txt'), 'isolated\n');
  fs.writeFileSync(path.join(isolation.path, 'new.txt'), 'new\n');
  await finalizeAgentWorktree(isolation, 'run_1234abcd', 'writer');
  ok(isolation.status === 'ready' && /^[a-f0-9]{40}$/i.test(isolation.commit || ''), 'isolated changes become a pending commit');
  ok(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8') === 'main\n' && !fs.existsSync(path.join(repo, 'new.txt')), 'main workspace remains untouched before explicit apply');

  const run = { id: 'run_1234abcd', sessionId: 'session_1234abcd', nodes: [{ id: 'writer', isolation }] };
  fs.writeFileSync(path.join(repo, 'user-dirty.txt'), 'user work\n');
  const refused = await applyAgentWorktree(run, 'writer');
  ok(refused.ok === false && /未提交改动/.test(refused.error || '') && fs.existsSync(path.join(repo, 'user-dirty.txt')), 'apply refuses a dirty workspace without touching user changes');
  fs.unlinkSync(path.join(repo, 'user-dirty.txt'));
  const applied = await applyAgentWorktree(run, 'writer');
  ok(applied.ok === true && isolation.status === 'applied', 'explicit apply cherry-picks the isolated commit');
  ok(fs.readFileSync(path.join(repo, 'value.txt'), 'utf8').trim() === 'isolated' && fs.readFileSync(path.join(repo, 'new.txt'), 'utf8').trim() === 'new', 'applied commit contains modified and untracked files');
  ok(!isolation.path, 'worktree is cleaned after successful apply');

  if (failures) { console.error(`AGENT WORKTREE E2E: ${failures} FAIL`); process.exitCode = 1; }
  else console.log('AGENT WORKTREE E2E: ALL PASS');
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; }).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
