#!/usr/bin/env node
// 发 GitHub Release（可重入）：建／复用 tag 对应的 Release，上传缺的资产，最后逐个核大小。
// Publish a GitHub Release (re-runnable): create or reuse the release for a tag, upload missing assets, verify sizes.
//
// 凭据：走本机 git 的凭据助手（`git credential fill`，与 `git push` 用的是同一份）——不读环境变量、不落盘、不打印。
// Credential: taken from git's credential helper (the same one `git push` uses); never printed or written anywhere.
//
// 用法 / usage（在仓库根目录）：
//   node dev-harness/publish-github-release.js --tag v3.0.0-preview.1 --title "…" \
//     --notes docs/release-notes/v3.0.0-preview.1.md --prerelease \
//     --asset ruyi-workbench/dist/Ruyi-v3.0.0-preview.1-slim.zip --asset … [--dry-run]
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const a = { assets: [], prerelease: false, dryRun: false, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error('missing value for ' + k); return x; };
    if (k === '--tag') a.tag = v();
    else if (k === '--title') a.title = v();
    else if (k === '--notes') a.notes = v();
    else if (k === '--asset') a.assets.push(v());
    else if (k === '--repo') a.repo = v();
    else if (k === '--prerelease') a.prerelease = true;
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error('unknown argument: ' + k);
  }
  if (!a.tag || !a.title || !a.notes) throw new Error('--tag, --title and --notes are required');
  return a;
}

function git(args, opts = {}) { return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim(); }

function repoFromOrigin() {
  const url = git(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error('origin is not a GitHub remote: ' + url);
  return m[1] + '/' + m[2];
}

function credential() {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 120000 });
  const m = {};
  for (const line of out.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) m[line.slice(0, i)] = line.slice(i + 1); }
  if (!m.password) throw new Error('git credential helper returned no GitHub credential');
  return m.password;
}

function request(token, { method = 'GET', host = 'api.github.com', urlPath, body, headers = {}, stream, length }) {
  return new Promise((resolve, reject) => {
    const h = { 'user-agent': 'ruyi-release-publisher', accept: 'application/vnd.github+json', authorization: 'token ' + token, ...headers };
    let payload = null;
    if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); h['content-type'] = 'application/json'; h['content-length'] = payload.length; }
    if (stream) h['content-length'] = length;
    const req = https.request({ method, host, path: urlPath, headers: h }, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (stream) {
      let sent = 0, lastPct = -1;
      stream.on('data', d => { sent += d.length; const pct = Math.floor(sent * 100 / length); if (pct >= lastPct + 5) { lastPct = pct; process.stdout.write(`\r    ${pct}%`); } });
      stream.on('end', () => process.stdout.write('\n'));
      stream.pipe(req);
    } else { if (payload) req.write(payload); req.end(); }
  });
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const repo = a.repo || repoFromOrigin();
  const notes = fs.readFileSync(a.notes, 'utf8');
  const assets = a.assets.map(p => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }));

  // 标签必须已经在远端 —— 不让 API 在服务器上替我们凭空建一个指向默认分支的标签。
  const remoteTag = git(['ls-remote', 'origin', 'refs/tags/' + a.tag]);
  if (!remoteTag) throw new Error(`tag ${a.tag} is not on origin; push it first (git push origin ${a.tag})`);
  console.log(`repo ${repo} · tag ${a.tag} (remote ${remoteTag.split(/\s+/)[0].slice(0, 12)}) · prerelease=${a.prerelease}`);
  for (const x of assets) console.log(`  asset ${x.name}  ${(x.size / 1048576).toFixed(2)} MB`);
  if (a.dryRun) { console.log('dry run: nothing sent'); return; }

  const token = credential();
  let rel = await request(token, { urlPath: `/repos/${repo}/releases/tags/${encodeURIComponent(a.tag)}` });
  if (rel.status === 404) {
    rel = await request(token, { method: 'POST', urlPath: `/repos/${repo}/releases`,
      body: { tag_name: a.tag, name: a.title, body: notes, prerelease: a.prerelease, draft: false } });
    if (rel.status !== 201) throw new Error(`create release failed: HTTP ${rel.status} ${rel.text.slice(0, 300)}`);
    console.log('created release ' + rel.json.html_url);
  } else if (rel.status === 200) {
    const upd = await request(token, { method: 'PATCH', urlPath: `/repos/${repo}/releases/${rel.json.id}`,
      body: { name: a.title, body: notes, prerelease: a.prerelease } });
    if (upd.status !== 200) throw new Error(`update release failed: HTTP ${upd.status} ${upd.text.slice(0, 300)}`);
    rel = upd;
    console.log('reusing release ' + rel.json.html_url);
  } else throw new Error(`lookup release failed: HTTP ${rel.status} ${rel.text.slice(0, 300)}`);

  const id = rel.json.id;
  const existing = new Map((rel.json.assets || []).map(x => [x.name, x]));
  for (const x of assets) {
    const have = existing.get(x.name);
    if (have && have.size === x.size && have.state === 'uploaded') { console.log(`  skip ${x.name} (already uploaded, same size)`); continue; }
    if (have) {
      const del = await request(token, { method: 'DELETE', urlPath: `/repos/${repo}/releases/assets/${have.id}` });
      if (del.status !== 204) throw new Error(`delete stale asset ${x.name} failed: HTTP ${del.status}`);
    }
    console.log(`  uploading ${x.name} …`);
    const up = await request(token, { method: 'POST', host: 'uploads.github.com',
      urlPath: `/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(x.name)}`,
      headers: { 'content-type': x.name.endsWith('.zip') ? 'application/zip' : 'text/plain' },
      stream: fs.createReadStream(x.path), length: x.size });
    if (up.status !== 201) throw new Error(`upload ${x.name} failed: HTTP ${up.status} ${up.text.slice(0, 300)}`);
  }

  // 收尾核对：远端每个资产都在、大小逐字节对得上。
  const fin = await request(token, { urlPath: `/repos/${repo}/releases/${id}` });
  const remote = new Map((fin.json.assets || []).map(x => [x.name, x]));
  let bad = 0;
  for (const x of assets) {
    const r = remote.get(x.name);
    const ok = r && r.size === x.size && r.state === 'uploaded';
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK ' : 'BAD'} ${x.name} local=${x.size} remote=${r ? r.size + '/' + r.state : 'missing'}`);
  }
  console.log(`${bad ? 'INCOMPLETE' : 'DONE'}: ${fin.json.html_url}  prerelease=${fin.json.prerelease}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('ERROR: ' + (e && e.message || e)); process.exit(1); });
