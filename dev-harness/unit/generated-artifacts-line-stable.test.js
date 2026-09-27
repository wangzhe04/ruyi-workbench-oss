#!/usr/bin/env node
// 架构还债批 2:生成物不随源码行号漂移。
//
// 以前 docs/architecture/module-dependency-graph.json 给每条跨模块引用记 `lines:[...]`、route-inventory.json
// 给每个判定点记 `line:`,于是在 app/src 里加一行注释就要重算、提交几万行生成物(CLAUDE.md 甚至劝人「注释写在
// 已有行尾」)。现在两个生成器都只以稳定锚(模块/符号/路由/所在顶层函数名)记事。本件把这条性质钉死:
//   把 app/src 拷到临时目录,在文件顶部和每个顶层 function 前各插一行注释/空行(纯行号平移,不改任何符号、
//   路由、依赖),再对副本跑两个生成器 —— 三份依赖图产物(契约 / 机读图 / 人读图)与路由清册(JSON + MD)
//   必须与未平移的输出逐字节相同。
// 反向对照:同样的副本里真加一个顶层函数和一个判定点,输出必须变 —— 证明上面的「相同」不是比了个寂寞。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const graphGen = require('../module-dependency-graph');
const routeGen = require('../route-inventory');

const SRC = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'src');
const STAMP = '2000-01-01T00:00:00.000Z';

function copySrc(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(SRC, dir, { recursive: true });
  return dir;
}

// 纯行号平移:顶部(越过 shebang)插一行注释;每个行首 `function`/`async function` 前插一行注释和一个空行。
// 保留文件原有换行风格(Windows 检出可能是 CRLF)。返回插入的行数,供断言「确实平移了」。
function shiftLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const out = [];
  let inserted = 0;
  lines.forEach((line, index) => {
    if (index === 0 && !line.startsWith('#!')) { out.push('// line-shift probe (top)'); inserted++; }
    if (/^(async\s+)?function\s/.test(line)) { out.push('// line-shift probe', ''); inserted += 2; }
    out.push(line);
    if (index === 0 && line.startsWith('#!')) { out.push('// line-shift probe (top)'); inserted++; }
  });
  fs.writeFileSync(file, out.join(eol));
  return inserted;
}

function moduleFiles(srcDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  return manifest.modules.map(item => (typeof item === 'string' ? item : item.file));
}

function renderAll(srcDir) {
  const graph = graphGen.renderArtifacts(graphGen.buildGraph(srcDir ? { srcDir } : {}));
  const inv = { ...routeGen.computeInventory(srcDir ? { srcDir } : {}), generatedAt: STAMP };
  return {
    'module-contracts.json': graph.contract,
    'module-dependency-graph.json': graph.graph,
    'module-dependency-graph.md': graph.markdown,
    'route-inventory.json': JSON.stringify(inv, null, 2) + '\n',
    'route-inventory.md': routeGen.renderMarkdown(inv),
  };
}

describe('generated architecture artifacts are line-number free', () => {
  const temps = [];
  let baseline;
  before(() => { baseline = renderAll(null); });
  after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true }); });

  it('a pure line shift across every src module leaves all five artifacts byte-identical', () => {
    const dir = copySrc('ruyi-line-shift-');
    temps.push(dir);
    const inserted = {};
    for (const file of moduleFiles(dir)) inserted[file] = shiftLines(path.join(dir, file));
    // 点名的三个文件与全部路由文件必须真被平移过(否则本件静默失效)。
    for (const file of ['00-boot.js', '02-session-store.js', '13-http-router.js', '13d-core-domain-routes.js', '13g-steward.js', '01b-route-auth.js']) {
      assert.ok(inserted[file] > 0, `${file} 应被插入行(实得 ${inserted[file]})`);
    }
    assert.ok(inserted['13-http-router.js'] > 2, '13-http-router.js 在顶层函数前也插了行(判定点之间的相对距离也变了)');
    const shifted = renderAll(dir);
    for (const name of Object.keys(baseline)) {
      assert.ok(baseline[name].length > 0, `${name} 非空`);
      assert.equal(shifted[name], baseline[name], `${name} 在纯行号平移后必须逐字节不变`);
    }
  });

  it('control: a real new top-level function and route decision point DO change the artifacts', () => {
    const dir = copySrc('ruyi-line-shift-ctl-');
    temps.push(dir);
    const router = path.join(dir, '13-http-router.js');
    const text = fs.readFileSync(router, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(router, text + [
      '', 'function lineShiftProbeRoute(pathname) {',
      "  if (pathname === '/health-line-shift-probe') return true;",
      '  return false;', '}', '',
    ].join(eol));
    const changed = renderAll(dir);
    assert.notEqual(changed['module-contracts.json'], baseline['module-contracts.json'], '新增顶层函数 → 契约 provides 变化');
    assert.notEqual(changed['module-dependency-graph.json'], baseline['module-dependency-graph.json'], '新增顶层函数 → 依赖图变化');
    assert.notEqual(changed['route-inventory.json'], baseline['route-inventory.json'], '新增判定点 → 路由清册变化');
    assert.ok(changed['route-inventory.md'].includes('lineShiftProbeRoute'), '人读表以 handler 函数名为锚列出新判定点');
  });

  it('committed JSON artifacts carry no line/lines fields', () => {
    for (const name of ['module-contracts.json', 'module-dependency-graph.json', 'route-inventory.json']) {
      assert.equal((baseline[name].match(/"lines?"\s*:/g) || []).length, 0, `${name} 不含行号字段`);
    }
  });
});
