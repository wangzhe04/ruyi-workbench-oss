'use strict';
// 如意 Ruyi — SVG 线性图标集(UI v3 §2.15)。零依赖原生 ES module,无构建步。
//
// icon(name, size=16) → SVGElement,用 createElementNS + setAttribute 构建(不碰 innerHTML → XSS 安全)。
// 风格基准:24×24 viewBox,stroke=currentColor(随文字色/引擎色继承),圆角线帽/连接,
// 与如意云头曲线的圆角线条呼应;青花蓝单色由使用处 color 决定,hover 由外层类切换。
//
// 121-K8(34 号文 §2.10.1):描边【只有两档】—— 基线 1.75,五态药丸内的小字形 3。
//   两档各只有一处字面量(下面两个常量),粗线那一档【只从 missionStateIcon 这一个取件口发出去】,
//   因为药丸是唯一在 10–12px 尺寸上印字形的地方(1.75 在那个尺寸下糊成一团)。别处一律走基线。
// 实心形【只有三处】(§2.10.1):线程「停止」的方块、「暂停」的双竖条、来源「如意开的」的环心点
//   (lensSteward,与 avatar 同一个最简形)。另有两枚形状本身就没有轮廓可言的字形沿用实心:
//   more 的三颗点(r=1.4 的点画成描边就是一团墨)与 theme 的半圆(昼夜各半是它的语义)。
const NS = 'http://www.w3.org/2000/svg';
const F = { fill: 'currentColor', stroke: 'none' }; // 实心形复用
const STROKE_BASE = '1.75';  // 基线:24 网格单线
const STROKE_PILL = '3';     // 五态药丸内的 10–12px 小字形

// 每个键 = 一枚图标,值 = 形状列表 [tag, attrs]。KEY 行以「  name: [」起头(供静态测试正则计数)。
const ICONS = {
  folder: [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]],
  shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
  toolbox: [
    ['rect', { x: '2.5', y: '8.5', width: '19', height: '11', rx: '1.8' }],
    ['path', { d: 'M8 8.5V6.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['path', { d: 'M2.5 13h19' }],
    ['path', { d: 'M10 13v2.5h4V13' }],
  ],
  paperclip: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
  // 121-K8:原来是两枚实心星。§2.10.1 把实心收到只剩三处,这里改回单线(与原型 v3 的 spark 同形)。
  sparkles: [
    ['path', { d: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z' }],
    ['path', { d: 'M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z' }],
  ],
  trace: [['path', { d: 'M3 12h4l2.2-4.2 4.1 8.4 2.3-4.2H21' }]],
  agents: [
    ['circle', { cx: '9', cy: '8', r: '3' }],
    ['path', { d: 'M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20' }],
    ['circle', { cx: '17.5', cy: '9.5', r: '2.5' }],
    ['path', { d: 'M15.5 15.2h1.7a3.8 3.8 0 0 1 3.8 3.8v1' }],
  ],
  send: [
    ['path', { d: 'M22 2 11 13' }],
    ['path', { d: 'M22 2 15 22 11 13 2 9 22 2Z' }],
  ],
  stop: [['rect', { x: '6', y: '6', width: '12', height: '12', rx: '2.5', ...F }]],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }],
  ],
  stethoscope: [
    ['path', { d: 'M4 4v5a5 5 0 0 0 10 0V4' }],
    ['circle', { cx: '4', cy: '3', r: '1' }],
    ['circle', { cx: '14', cy: '3', r: '1' }],
    ['path', { d: 'M9 14v2.5a4.5 4.5 0 0 0 9 0V15' }],
    ['circle', { cx: '18', cy: '13', r: '2' }],
  ],
  help: [
    ['circle', { cx: '12', cy: '12', r: '9.5' }],
    ['path', { d: 'M9.2 9.2a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4' }],
    ['path', { d: 'M12 17.5h.01' }],
  ],
  menu: [['path', { d: 'M3.5 6h17M3.5 12h17M3.5 18h17' }]],
  more: [
    ['circle', { cx: '5.5', cy: '12', r: '1.4', ...F }],
    ['circle', { cx: '12', cy: '12', r: '1.4', ...F }],
    ['circle', { cx: '18.5', cy: '12', r: '1.4', ...F }],
  ],
  collapse: [['path', { d: 'M11 18l-6-6 6-6M19 18l-6-6 6-6' }]],
  compress: [['path', { d: 'M8 3v5H3M21 8h-5V3M3 16h5v5M16 21v-5h5' }]],
  theme: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12 3a9 9 0 0 0 0 18Z', ...F }],
  ],
  wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['path', { d: 'M21 21l-4.35-4.35' }],
  ],
  refresh: [
    ['path', { d: 'M23 4v6h-6' }],
    ['path', { d: 'M1 20v-6h6' }],
    ['path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10' }],
    ['path', { d: 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }],
  ],
  // F5b 收尾:「换一条」用的是【换一个目标】,不是【重试】—— refresh 那圈循环箭头读作后者。
  // 两条反向平行箭头是这件事的通用字形(与 refresh 的闭环刻意区分开)。
  swap: [
    ['path', { d: 'M4 8.5h13' }],
    ['path', { d: 'M13.5 5 17 8.5 13.5 12' }],
    ['path', { d: 'M20 15.5H7' }],
    ['path', { d: 'M10.5 12 7 15.5 10.5 19' }],
  ],
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['path', { d: 'M10 11v6M14 11v6' }],
  ],
  pin: [['path', { d: 'M9 3.5h6M10.5 3.5l-.5 6-2 2v1.5h8V11l-2-2-.5-6M12 15v5.5' }]],
  edit: [['path', { d: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }]],
  close: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
  monitor: [
    ['rect', { x: '2.5', y: '4', width: '19', height: '12', rx: '1.5' }],
    ['path', { d: 'M8.5 20h7M12 16v4' }],
  ],
  // 第89波(Pretender/Escapade 图标统一):全部对齐 trace 思考标识的线条语言 —— 24×24、单线描边、
  // currentColor、圆角线帽。文本字形/emoji 一律退场。
  // 121-K8(§2.10.1「删除交办台专用字形」):dispatch／sheet／takeover／dockArchive／dockPin／
  //   ticket／narrative 七枚随交办台(K1)退役。前五枚删除前已 git grep 过零消费者;
  //   sheet 的两处(右栏开合钮、「看全文」)与 ticket 的一处(自主性授权书条)换成了说得清是什么的
  //   新字形(panelRight／file／shield),不是把占位挪个地方。
  resume: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M10.2 8.8 15.4 12l-5.2 3.2z' }],
  ],
  // 121-K8:暂停 = 双竖条实心(§2.10.1 三处实心之一)。原来那枚「圆圈里两道线」在 13px 行内
  // 与 stop 的方块读起来是同一团,分不出停的是谁。
  pause: [
    ['rect', { x: '6', y: '5', width: '4', height: '14', rx: '1.2', ...F }],
    ['rect', { x: '14', y: '5', width: '4', height: '14', rx: '1.2', ...F }],
  ],
  playbook: [
    ['path', { d: 'M12 6.4C10.4 5 8 4.4 5.4 4.4v13.6c2.6 0 5 .6 6.6 2 1.6-1.4 4-2 6.6-2V4.4C16 4.4 13.6 5 12 6.4z' }],
    ['path', { d: 'M12 6.4V20' }],
  ],
  archive: [
    ['path', { d: 'M4 7.5h16l-1 11.4a2 2 0 0 1-2 1.8H7a2 2 0 0 1-2-1.8z' }],
    ['path', { d: 'M4 7.5V5.2A1.7 1.7 0 0 1 5.7 3.5h12.6A1.7 1.7 0 0 1 20 5.2v2.3' }],
    ['path', { d: 'M9.8 11.5h4.4' }],
  ],
  needs: [
    ['circle', { cx: '9', cy: '8', r: '3' }],
    ['path', { d: 'M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20' }],
    ['path', { d: 'M17.8 10v5.2M17.8 18.9h.01' }],
  ],
  ledger: [
    ['path', { d: 'M5 4.8A1.8 1.8 0 0 1 6.8 3h11a1.7 1.7 0 0 1 1.7 1.7v14.6a1.7 1.7 0 0 1-1.7 1.7h-11A1.8 1.8 0 0 1 5 19.2z' }],
    ['path', { d: 'M8.5 8h7M8.5 11.5h7M8.5 15h4.5' }],
  ],
  raw: [
    ['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '2' }],
    ['path', { d: 'M7 9l3 3-3 3' }],
    ['path', { d: 'M12.5 15h4.5' }],
  ],
  done: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M8.2 12.2l2.6 2.6 5-5.4' }],
  ],
  back: [
    ['path', { d: 'M19 12H5.5' }],
    ['path', { d: 'M10.5 6.5 5 12l5.5 5.5' }],
  ],
  go: [
    ['path', { d: 'M5 12h13.5' }],
    ['path', { d: 'M13.5 6.5 19 12l-5.5 5.5' }],
  ],
  open: [
    ['path', { d: 'M7 17 17 7' }],
    ['path', { d: 'M9.5 7H17v7.5' }],
  ],
  bell: [
    ['path', { d: 'M18 9a6 6 0 0 0-12 0c0 4.3-1.2 6.2-2.4 7.2h16.8C19.2 15.2 18 13.3 18 9z' }],
    ['path', { d: 'M10.2 19.4a2 2 0 0 0 3.6 0' }],
  ],
  quickask: [['path', { d: 'M13 3 5.8 13h4.7L9 21l7.2-10h-4.7z' }]],
  mail: [
    ['rect', { x: '3', y: '5.5', width: '18', height: '13', rx: '2' }],
    ['path', { d: 'M4 7.5l8 5.8 8-5.8' }],
  ],
  cloud: [['path', { d: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z' }]],
  // 121-K8:三环靶心 target 删除 —— 它当过「管家视角」「如意开的」两件不相干事情的占位,
  // 而两件事真正要的都是 avatar 的最简形(lensSteward,见下面 §2.10.1 那一组)。
  down: [
    ['path', { d: 'M12 4.5V19' }],
    ['path', { d: 'M6 13l6 6 6-6' }],
  ],
  minus: [['path', { d: 'M5 12h14' }]],
  // 第117波 F5a(27 号文 §11.13.1「F 追加」/ 32 号文 §2.2 F5):管家壳图标集。
  // 全部沿用本表的单线语言(24×24、currentColor、圆角线帽,描边由 icon() 统一给 1.5)。
  //
  // ① 停机 ≠ 停止。power/powerOff 只给【管家本人】的停机与唤醒(已停机 = 同一枚加一道斜杠);
  //    线程的「停止」仍是上面那枚实心方块 stop。F5a 之前这两件事都画成「圆里一个方块」
  //    (steward-settings.js 里那份孤本 ICON_STOP),读者没法从字形分辨停的是谁。
  power: [
    ['path', { d: 'M18.36 6.64a9 9 0 1 1-12.73 0' }],
    ['path', { d: 'M12 3v9' }],
  ],
  powerOff: [
    ['path', { d: 'M18.36 6.64a9 9 0 1 1-12.73 0' }],
    ['path', { d: 'M12 3v9' }],
    ['path', { d: 'M4.5 19.5 19.5 4.5' }],
  ],
  // ② 权限四档画在【同一个盾牌轮廓】里(家族标不变,里面的字形说是哪一档):
  //    问号 = 每步都问 / 铅笔 = 改文件不问 / 清单线 = 只做计划 / 闪电 = 全自动。
  //    名字由档位名派生(见下面的 permissionIconName),所以本文件【没有】第二份四档表 ——
  //    四档的唯一判据仍然是 steward-chips.js 的 STEWARD_PERMISSION_MODES。
  shieldDefault: [
    ['path', { d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' }],
    ['path', { d: 'M10.4 9.6a1.75 1.75 0 0 1 3.35.6c0 1.2-1.75 1.5-1.75 2.5' }],
    ['path', { d: 'M12 15.4h.01' }],
  ],
  shieldAcceptEdits: [
    ['path', { d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' }],
    ['path', { d: 'M14.4 7.9a1.45 1.45 0 0 1 2.05 2.05l-5.15 5.15-2.7.65.65-2.7z' }],
  ],
  shieldPlan: [
    ['path', { d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' }],
    ['path', { d: 'M9.2 9.6h5.6M9.2 12.2h5.6M9.2 14.8h3.4' }],
  ],
  shieldAuto: [
    ['path', { d: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z' }],
    ['path', { d: 'M13.1 7.4 9.5 12.4h2.7l-1.3 4.2 3.6-5h-2.7z' }],
  ],
  // ③ 头部胶囊右边那枚「还有别的档可选」的角标。
  caret: [['path', { d: 'M7 10l5 5 5-5' }]],
  // ④ 五态药丸的字形。名字同样【从五态值派生】(见下面的 missionStateIconName),
  //    本表因此不是第二份五态枚举 —— 谁处在哪一态永远只由 mission-state.js 判。
  //    done 与 quick_ask 的字形表里早就有,别名指向【同一个形状数组】,不抄第二份路径(见文件末)。
  stateRunning: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M7.4 12h2l1.4-2.9 2.4 5.4 1.3-2.5h2.1' }],
  ],
  stateNeedsYou: [
    ['path', { d: 'M20.5 12.2c0 3.87-3.8 7-8.5 7-1 0-1.97-.14-2.86-.4L4.5 20.5l1.6-4.05A6.6 6.6 0 0 1 3.5 12.2c0-3.87 3.8-7 8.5-7s8.5 3.13 8.5 7z' }],
    ['path', { d: 'M9.9 10.2a2.2 2.2 0 0 1 4.2.8c0 1.5-2.2 1.8-2.2 3' }],
    ['path', { d: 'M12 16.5h.01' }],
  ],
  stateStopped: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M8.2 12h7.6' }],
  ],
  stateDispatching: [
    ['path', { d: 'M12 3.5v8.7' }],
    ['path', { d: 'M8.4 8.8 12 12.4l3.6-3.6' }],
    ['path', { d: 'M4.5 15v3.2a2.3 2.3 0 0 0 2.3 2.3h10.4a2.3 2.3 0 0 0 2.3-2.3V15' }],
  ],
  // ⑤ 抽屉与看板的动作(其余动作复用表里已有的 send/pause/resume/stop/monitor/sheet/open/plus)。
  rewind: [
    ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
    ['path', { d: 'M3 3v5h5' }],
  ],
  handBack: [
    ['circle', { cx: '18.2', cy: '6.6', r: '2.6' }],
    ['path', { d: 'M20.5 18.5v-1.2a4.6 4.6 0 0 0-4.6-4.6H7.4' }],
    ['path', { d: 'M10.8 9.4 6.4 12.7l4.4 3.3' }],
  ],
  diff: [
    ['path', { d: 'M12 4.5v9' }],
    ['path', { d: 'M7.5 9h9' }],
    ['path', { d: 'M6 19h12' }],
  ],
  up: [
    ['path', { d: 'M12 20V7.5' }],
    ['path', { d: 'M6.8 12.7 12 7.5l5.2 5.2' }],
    ['path', { d: 'M5.5 4h13' }],
  ],
  // ═══ 第121波 K8(34 号文 §2.10.1;形状逐条照 docs/mockups/one-workbench-two-views.html 的原型 v3)═══
  // ① 两视角。分段钮左右各一枚,是这套界面里最常被看的两个字形,所以【不与任何别的意思共用】:
  //    管家 = avatar 的最简形(环＋心点),工作台 = 三栏面板。
  lensSteward: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['circle', { cx: '12', cy: '12', r: '3.5', ...F }],
  ],
  lensWork: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2.5' }],
    ['path', { d: 'M9 4v16M15 4v16' }],
  ],
  // ② 线程来源三值(§4.1)。「如意开的」复用上面的 lensSteward —— 同一个意思只画一次,见文件末的别名。
  originUser: [
    ['circle', { cx: '12', cy: '8', r: '4' }],
    ['path', { d: 'M4 21a8 8 0 0 1 16 0' }],
  ],
  originSchedule: [
    ['circle', { cx: '12', cy: '12', r: '8' }],
    ['path', { d: 'M12 8v4l3 2' }],
  ],
  // ③ 任务(mission)本身。左栏与任务栏说的都是「一件事」,不是「一个会话」。
  task: [
    ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '3' }],
    ['path', { d: 'M8 12.2l2.7 2.7L16.5 9' }],
  ],
  // ④ 在跑的脉冲(§2.10.1「live」)。与 trace 的思考轨迹刻意不同形:那枚说「它在想」,这枚说「它在动」。
  live: [['path', { d: 'M3 12h4l2-6 4 12 2-6h6' }]],
  // ⑤ 工作台工具卡:folder 表里早就有(见文件头),补一枚 file。
  file: [
    ['path', { d: 'M7 3h7l5 5v13H7z' }],
    ['path', { d: 'M14 3v5h5' }],
  ],
  check: [['path', { d: 'M5 12l5 5 9-10' }]],
  play: [['path', { d: 'M7 5l12 7-12 7z' }]],
  // ⑥ 右栏开合(≤1240 收成抽屉时那枚)与左栏看板密度。这两处 K4 借了 sheet／ledger 当占位,
  //    §13.7 ⑥ 记着要换真字形:右栏 = 面板右侧那一栏亮着,看板密度 = 一栏拉宽成两栏。
  panelRight: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2.5' }],
    ['path', { d: 'M15 4v16' }],
  ],
  columns: [
    ['rect', { x: '3', y: '4.5', width: '18', height: '15', rx: '2.5' }],
    ['path', { d: 'M9 4.5v15' }],
    ['path', { d: 'M12.5 9.5h5.5M12.5 14h3.5' }],
  ],
  // ⑦ 「记得的关于你」(口袋四枚之一,K7 消费;另外三枚用表里已有的 originSchedule／ledger／stethoscope)。
  memory: [
    ['path', { d: 'M12 4.5a6.5 6.5 0 0 0-6.5 6.5v2L3.8 16.5H8' }],
    ['path', { d: 'M12 4.5a6.5 6.5 0 0 1 6.5 6.5v2l1.7 3.5H16' }],
    ['path', { d: 'M9 20.5h6' }],
  ],
};

// F5a:五态里有两态的字形本表早就有(done 的对勾圈、quick_ask 的闪电)。别名指向【同一个形状
// 数组】—— 派生名字拿得到,却没有第二份路径字面量(「一套词汇,不留孤本」的同一条纪律)。
ICONS.stateDone = ICONS.done;
ICONS.stateQuickAsk = ICONS.quickask;
// 121-K8:来源「如意开的」与「管家视角」是同一个最简形(环＋心点)。同一条纪律 —— 别名,不抄第二份路径。
ICONS.originSteward = ICONS.lensSteward;

// 档位名 → 盾牌字形名(default → shieldDefault)。纯派生,不是查表:本文件不认识任何一个档位名,
// 加一档只要在 ICONS 里补一枚同名盾牌即可。表里没有对应字形时退回家族标 shield(不 warn)。
export function permissionIconName(mode) {
  const key = String(mode || '');
  const name = key ? 'shield' + key.charAt(0).toUpperCase() + key.slice(1) : '';
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? name : 'shield';
}

// 五态值 → 字形名(needs_you → stateNeedsYou)。同样是纯派生:本文件没有五态清单,
// 「谁处在哪一态」永远只由 mission-state.js 判。表里没有对应字形时返回空串(调用方不画图标)。
export function missionStateIconName(state) {
  const camel = String(state || '').replace(/_([a-z0-9])/g, (whole, letter) => letter.toUpperCase());
  const name = camel ? 'state' + camel.charAt(0).toUpperCase() + camel.slice(1) : '';
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? name : '';
}

// 五态字形的取件口:名字派生不出来就【什么都不画】,不猜、也不落到某个默认态。
// 121-K8(§2.10.1):粗线那一档【只在这里】发出去 —— 药丸是全仓唯一在 10–12px 上印字形的地方,
// 基线 1.75 到那个尺寸就糊了。别处调 icon() 一律拿基线,所以本文件的描边只有两个字面量。
export function missionStateIcon(state, size = 12) {
  const name = missionStateIconName(state);
  if (!name) return null;
  const svg = icon(name, size);
  if (svg) svg.setAttribute('stroke-width', STROKE_PILL);
  return svg;
}

// name → SVGElement(未知名返回 null + warn)。
export function icon(name, size = 16) {
  const shapes = ICONS[name];
  if (!shapes) { console.warn('[icons] unknown icon:', name); return null; }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', STROKE_BASE);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ic');
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    svg.appendChild(node);
  }
  return svg;
}

export function iconNames() { return Object.keys(ICONS); }

// 启动时把带 [data-icon] 的静态元素填充为 SVG(prepend 到首子节点前;幂等,已填充跳过)。
// 可选 data-icon-size 覆盖尺寸。用于 index.html 里不随 JS 改文案的静态 chrome 按钮/徽标。
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(elm => {
    if (elm.dataset.iconized === '1') return;
    const svg = icon(elm.getAttribute('data-icon'), parseInt(elm.getAttribute('data-icon-size') || '16', 10));
    if (!svg) return;
    elm.insertBefore(svg, elm.firstChild);
    elm.dataset.iconized = '1';
  });
}
