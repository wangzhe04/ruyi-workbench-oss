// 第36波(v1.7)评审修复批 · 静态源锁 + 单元矩阵(纯静态,无端口,秒级快通道)。
//
// 锁对象(每条对应一处已修缺陷,防回潮):
//   S1 serveStatic 前缀子串 bug      —— 改 pathWithinRoot 段比较(与作者自己在 pathWithinRoot 注释里
//                                        批评的 classic prefix bug 同款,public-evil/ 兄弟目录可越界)。
//   S2 syncClaudeCliSettings 越权     —— 工作台无 model 时不再无条件 delete settings.model;
//                                        权属 sidecar(claude-settings-sync.json)追踪,只删自己写过的。
//   S3 freeStalePort 误杀            —— node.exe 镜像名不再是充分证据,必须命令行取证
//                                        (processCommandLine → image:node+cmdline)。
//   S4 desktop_screenshot 越界写      —— 模型给定的 outputPath 过 guardFileToolPath 写闸。
//   S5 uiMode 回退漂移               —— 非法值回退与 defaultConfig 对齐 'simple'(不再 'pro')。
//   S6 orchestrate maxItems 漂移     —— schema 与实现(slice 0,64)/clamp(1..64)三方对齐 64。
//   S7 D6 主动检索指引名存实亡        —— 自适应装载下按「目录可用」(toolRequirementsMet)判定,
//                                        不再按「首批 schema 已 offer」。
//   S8 ACC 护栏/审计/布局            —— capture/desktop_extra 输出路径 protected 护栏、audit 值脱敏、
//                                        update.bat 双布局、read_file 真字节预算、launch wait_timeout。
//   S9 run-all 端口审计 + capabilities 毕业 —— portAudit/stripJsComments 在;KNOWN_FAILURE 不再含 capabilities。
'use strict';
const { readServerSource } = require('./src-reader');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const RUNALL = path.join(ROOT, 'dev-harness', 'run-all.js');
const ACC = path.join(ROOT, 'mcp', 'ai-computer-control');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const server = readServerSource();
const runall = fs.readFileSync(RUNALL, 'utf8');

// ── S1: serveStatic 用段比较,startsWith 前缀判定绝迹 ─────────────────────────
const serveStaticBody = server.slice(server.indexOf('async function serveStatic'), server.indexOf('async function serveStatic') + 900);
ok(/pathWithinRoot\(full,/.test(serveStaticBody), 'S1: serveStatic 用 pathWithinRoot 段比较');
ok(!/full\.startsWith\(path\.normalize\(base\)\)/.test(serveStaticBody), 'S1: startsWith 前缀判定已移除');

// ── S2: settings.model 权属 sidecar;无条件 delete 绝迹 ──────────────────────
ok(server.includes('claude-settings-sync.json'), 'S2: 权属 sidecar 文件存在');
ok(/prevSyncedModel/.test(server), 'S2: 上次同步值追踪(prevSyncedModel)');
ok(!/else delete settings\.model;/.test(server), 'S2: 无条件 else delete settings.model 绝迹');
ok(/else if \(prevSyncedModel && settings\.model === prevSyncedModel\) delete settings\.model;/.test(server), 'S2: 仅权属可证时才删除');

// ── S3: freeStalePort 命令行取证 ────────────────────────────────────────────
ok(/function processCommandLine\(pid\)/.test(server), 'S3: processCommandLine 取证助手存在');
ok(server.includes("why = 'image:node+cmdline'"), 'S3: node.exe 需命令行佐证(image:node+cmdline)');
ok(!/why = 'image:node';/.test(server), 'S3: 裸 image:node 处死分支绝迹');

// ── S4: desktop_screenshot 输出路径写闸 ─────────────────────────────────────
ok(/guardFileToolPath\(outPathRaw, ctx, \{ tool: 'desktop_screenshot', write: true \}\)/.test(server), 'S4: 模型给定 outputPath 过 guardFileToolPath 写闸');

// ── S5: uiMode 回退 'simple' ────────────────────────────────────────────────
ok(/config\.uiMode : 'simple'/.test(server), "S5: uiMode 非法值回退 'simple'");
ok(!/config\.uiMode : 'pro'/.test(server), "S5: 回退 'pro' 绝迹");

// ── S6: orchestrate maxItems 三方对齐 64 ────────────────────────────────────
ok(/type: 'array', minItems: 1, maxItems: 64,/.test(server), 'S6: orchestrate_agents schema maxItems=64');
ok(!/maxItems: 32/.test(server), 'S6: schema maxItems:32 绝迹');

// ── S7: D6 目录可用口径 ─────────────────────────────────────────────────────
ok(/toolRequirementsMet\('web_search', caps, false, config\)/.test(server), 'S7: D6 按 TOOL_REQUIRES 目录可用判定');

// ── S8: ACC 侧修复(静态)─────────────────────────────────────────────────────
const accCapture = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'capture.py'), 'utf8');
const accClip = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'desktop_extra.py'), 'utf8');
const accAudit = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'audit.py'), 'utf8');
const accFs = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'filesystem.py'), 'utf8');
const accApp = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'application.py'), 'utf8');
const accOcr = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'ocr.py'), 'utf8');
const updateBat = fs.readFileSync(path.join(ACC, 'installer', 'update.bat'), 'utf8');
ok(/protected_path_reason\(output_path\)/.test(accCapture), 'S8: window_screenshot 输出路径 protected 护栏');
ok(/protected_path_reason\(save_path\)/.test(accClip), 'S8: get_clipboard_image 保存路径 protected 护栏');
ok(/_SECRET_VALUE_PATTERNS/.test(accAudit) && /_scrub_value/.test(accAudit), 'S8: audit 值级脱敏在');
ok(/open\(path, "rb"\)/.test(accFs), 'S8: read_file 二进制读(真字节预算)');
ok(!/f\.read\(max_bytes\)/.test(accFs), 'S8: read_file 字符读旧实现绝迹');
ok(/wait_timeout: float = 120\.0/.test(accApp), 'S8: launch_application 独立 wait_timeout');
ok(!/"ok": True, "found": True, "error"/.test(accOcr), 'S8: ocr_click nth 越界自矛盾包络绝迹');
ok(updateBat.includes('runtime\\python\\python.exe') && updateBat.includes('venv\\Scripts\\python.exe'), 'S8: update.bat 双布局探测');

// ── S9: 端口审计在 + capabilities 毕业 ──────────────────────────────────────
ok(/function portAudit\(\)/.test(runall) && /function stripJsComments\(/.test(runall), 'S9: run-all 端口唯一性审计在');
ok(!/capabilities\.e2e\.js/.test(runall), 'S9: capabilities 已从 KNOWN_FAILURE 毕业');

// ── 单元矩阵: pathWithinRoot(prefix bug 的核心判定,导出直测)─────────────────
const mod = require(SERVER);
const root = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const evil = process.platform === 'win32' ? 'C:\\ws-evil\\x.txt' : '/ws-evil/x.txt';
const inner = path.join(root, 'sub', 'x.txt');
ok(mod.pathWithinRoot(inner, root) === true, 'U: 根内子路径 → true');
ok(mod.pathWithinRoot(root, root) === true, 'U: 根自身 → true');
ok(mod.pathWithinRoot(evil, root) === false, 'U: 兄弟前缀目录(public-evil 形) → false(prefix bug 核心)');
ok(mod.pathWithinRoot(path.join(root, '..', 'escape.txt'), root) === false, 'U: .. 逃逸 → false');

console.log('\nV17-REVIEW-FIXES STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
