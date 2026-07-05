// E2E (v1.0-S8): 双手册离线静态守护。无端口、无 spawn —— 纯文件断言。
//
// 守护对象:
//   ruyi-workbench/docs/manuals/USER-GUIDE_CN.md   (用户手册)
//   ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md  (管理员手册)
//
// 断言:
//  (a) 两手册均存在且各 ≥ 4000 字节;
//  (b) USER-GUIDE 含关键词:如意 / 工作文件夹 / 每步都问 / 撤销 / 任务卡;
//      ADMIN-GUIDE 含关键词:overlay / SSRF / 掩码 / 审计 / e2e;
//  (c) 两手册均不含:
//      - 任何 sk-[a-zA-Z0-9]{20,} 形态密钥;
//      - 旧品牌名「Win Claude Workbench」(带空格)——按行判断,含存量兼容标识 `win-claude-workbench`
//        (数据目录 ~/.win-claude-workbench、env、MCP id;v1.0-S9 有意保留)的行豁免;
//      - "TODO" / "待补" 残留;
//  (d) ruyi-workbench/README.md 含两手册的相对链接,且两个目标文件存在。
//
// 判定行(harness 约定,回归 runner grep "E2E:"):精确 `MANUALS E2E: ALL PASS`。
'use strict';
const path = require('path'), fs = require('fs');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');                        // repo root
const WB = path.resolve(ROOT, 'ruyi-workbench');
const MANUALS_DIR = path.join(WB, 'docs', 'manuals');
const USER_PATH = path.join(MANUALS_DIR, 'USER-GUIDE_CN.md');
const ADMIN_PATH = path.join(MANUALS_DIR, 'ADMIN-GUIDE_CN.md');
const README_PATH = path.join(WB, 'README.md');

// The forbidden-token scan runs over both manuals. Kept as top-level constants so the intent is legible.
const SECRET_RE = /sk-[a-zA-Z0-9]{20,}/;                      // real-key shape
const OLD_BRAND = 'Win Claude Workbench';                     // spaced old product name (must be gone)
const PATH_TOKEN = 'win-claude-workbench';                    // 存量兼容标识(数据目录/env/MCP id,v1.0-S9 保留)— 携带此 token 的行豁免旧品牌扫描
const RESIDUE = ['TODO', '待补'];                             // editorial residue

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  const readIf = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const sizeIf = p => { try { return fs.statSync(p).size; } catch { return -1; } };

  // ============ (a) both manuals exist & each ≥ 4000 bytes ============
  const userSize = sizeIf(USER_PATH);
  const adminSize = sizeIf(ADMIN_PATH);
  ok(userSize >= 0, '(a) USER-GUIDE_CN.md exists');
  ok(adminSize >= 0, '(a) ADMIN-GUIDE_CN.md exists');
  ok(userSize >= 4000, '(a) USER-GUIDE_CN.md >= 4000 bytes (got ' + userSize + ')');
  ok(adminSize >= 4000, '(a) ADMIN-GUIDE_CN.md >= 4000 bytes (got ' + adminSize + ')');

  const userText = readIf(USER_PATH) || '';
  const adminText = readIf(ADMIN_PATH) || '';

  // ============ (b) required keywords ============
  const USER_KW = ['如意', '工作文件夹', '每步都问', '撤销', '任务卡'];
  const ADMIN_KW = ['overlay', 'SSRF', '掩码', '审计', 'e2e'];
  for (const kw of USER_KW) ok(userText.includes(kw), '(b) USER-GUIDE contains keyword: ' + kw);
  for (const kw of ADMIN_KW) ok(adminText.includes(kw), '(b) ADMIN-GUIDE contains keyword: ' + kw);

  // ============ (c) forbidden content (per-manual, per-line) ============
  // Returns array of "relpath:lineno[reason]" hits.
  function scanForbidden(relName, text) {
    const hits = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // secret shape
      if (SECRET_RE.test(ln)) hits.push(relName + ':' + (i + 1) + '[secret]');
      // old spaced brand — a line carrying the win-claude-workbench compat token (data dir/env/MCP id) is exempt.
      if (ln.includes(OLD_BRAND) && !ln.includes(PATH_TOKEN)) hits.push(relName + ':' + (i + 1) + '[old-brand]');
      // editorial residue
      for (const r of RESIDUE) if (ln.includes(r)) hits.push(relName + ':' + (i + 1) + '[' + r + ']');
    }
    return hits;
  }
  const userHits = scanForbidden('USER-GUIDE_CN.md', userText);
  const adminHits = scanForbidden('ADMIN-GUIDE_CN.md', adminText);
  ok(userHits.length === 0, '(c) USER-GUIDE has no forbidden content' + (userHits.length ? ' — HITS: ' + userHits.join(', ') : ''));
  ok(adminHits.length === 0, '(c) ADMIN-GUIDE has no forbidden content' + (adminHits.length ? ' — HITS: ' + adminHits.join(', ') : ''));

  // ============ (d) README links both manuals; targets exist ============
  const readme = readIf(README_PATH) || '';
  // Relative links from ruyi-workbench/README.md into docs/manuals/.
  const userLink = /docs\/manuals\/USER-GUIDE_CN\.md/.test(readme);
  const adminLink = /docs\/manuals\/ADMIN-GUIDE_CN\.md/.test(readme);
  ok(userLink, '(d) README.md links USER-GUIDE (docs/manuals/USER-GUIDE_CN.md)');
  ok(adminLink, '(d) README.md links ADMIN-GUIDE (docs/manuals/ADMIN-GUIDE_CN.md)');
  ok(fs.existsSync(USER_PATH), '(d) linked USER-GUIDE target file exists');
  ok(fs.existsSync(ADMIN_PATH), '(d) linked ADMIN-GUIDE target file exists');

  // Verdict line (harness convention): exact "MANUALS E2E: ALL PASS".
  console.log('\nMANUALS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
