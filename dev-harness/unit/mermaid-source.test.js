'use strict';
// 109c(2026-10-04 五路走查):mermaid 源码两道预处理(public/js/mermaid-source.js)的纯函数锁。
//
// 判据:
//   [T] 图类型识别跳过 frontmatter / 空行 / %% 注释与指令,别名归一(graph→flowchart、xychart-beta→xychart …)。
//   [P] prepareMermaidSource 只改 mermaid 会【静默画错】的写法:<Generic> 转实体(真 HTML 与 <<interface>> 不动)、
//       甘特中文时长、甘特区段名太宽时补左边距指令(放在 frontmatter 之后,作者自己写了 leftPadding 就不动)、
//       时间线全角冒号与长串中文换行、状态图 / ER 的两处写法;别的图种原样返回。
//   [R] repairMermaidSource 只在渲染抛错后用:每条规则修一种今天必然解析失败的写法;改不动时返回 null;
//       桑基图把中文节点名换成 ASCII 代号并给出代号表(画完由 mermaid-postprocess.js 换回)。
// 真实渲染效果(修前回落成源码、修后画出来)由 mermaid-viewer.browser.e2e.js 的 B11 钉。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = path.resolve(__dirname, '../../ruyi-workbench/app/public/js/mermaid-source.js');
const load = () => import(pathToFileURL(FILE).href);

test('[T] 图类型识别:跳过 frontmatter、空行与 %% 行,别名归一', async () => {
  const { mermaidDiagramType: type } = await load();
  assert.equal(type('\n---\ntitle: x\n---\n%%{init: {}}%%\n%% 注释\n\nflowchart LR\n A-->B'), 'flowchart');
  assert.equal(type('graph TD\n A-->B'), 'flowchart');
  assert.equal(type('xychart-beta\n x-axis [a]'), 'xychart');
  assert.equal(type('stateDiagram-v2\n [*] --> A'), 'state');
  assert.equal(type('sankey-beta\n\na,b,1'), 'sankey');
  assert.equal(type('radar-beta\n axis a'), 'radar');
  assert.equal(type('quadrantChart'), 'quadrant');
  assert.equal(type('这不是图'), '');
  assert.equal(type(''), '');
  assert.equal(type(null), '');
});

test('[P] <Generic> 转实体;真 HTML、<<interface>>、箭头原样', async () => {
  const { prepareMermaidSource: prepare } = await load();
  assert.equal(prepare('flowchart LR\n A[List<String>] --> B[<b>粗</b>]\n C <--> D'),
    'flowchart LR\n A[List#lt;String#gt;] --> B[<b>粗</b>]\n C <--> D');
  assert.equal(prepare('classDiagram\n class Repo{\n  <<interface>>\n  +List<User> findAll()\n }\n Animal <|-- Duck'),
    'classDiagram\n class Repo{\n  <<interface>>\n  +List#lt;User#gt; findAll()\n }\n Animal <|-- Duck');
  // 时序图不在这一条的范围里(它自己处理尖括号);原样。
  const seq = 'sequenceDiagram\n A->>B: List<String>';
  assert.equal(prepare(seq), seq);
});

test('[P] 甘特:中文时长换成 d/w,区段名太宽时补左边距(放在 frontmatter 之后;作者写了就不动)', async () => {
  const { prepareMermaidSource: prepare } = await load();
  const out = prepare('---\ntitle: 计划\n---\ngantt\n dateFormat YYYY-MM-DD\n section 需求分析与评审阶段\n 调研 :a1, 2026-10-05, 3天\n 评审 :a2, after a1, 2周');
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['---', 'title: 计划', '---']);
  assert.match(lines[3], /^%%\{init: \{"gantt":\{"leftPadding":\d+\}\}\}%%$/);
  assert.ok(Number(/leftPadding":(\d+)/.exec(lines[3])[1]) > 75, '9 个汉字的区段名需要比默认 75px 宽的左边距');
  assert.ok(out.includes('调研 :a1, 2026-10-05, 3d') && out.includes('评审 :a2, after a1, 2w'));
  // 短区段名:不加指令;作者自己写了 leftPadding:不动。
  assert.ok(!prepare('gantt\n section 盘点\n a :a1, 2026-10-05, 1d').includes('%%{init'));
  const own = '%%{init: {"gantt": {"leftPadding": 200}}}%%\ngantt\n section 需求分析与评审阶段\n a :a1, 2026-10-05, 1d';
  assert.equal(prepare(own), own);
});

test('[P] 时间线:全角冒号当分隔符,一长串中文每 8 个字换一行;英文与短句不动', async () => {
  const { prepareMermaidSource: prepare } = await load();
  const out = prepare('timeline\n title 历程\n 2020 : 这是一个非常非常长的事件描述文字用来测试 : 短事件\n 2021：上线\n 2022 : Release v2 with english words');
  assert.ok(out.includes(' 2020 : 这是一个非常非常<br>长的事件描述文字<br>用来测试 : 短事件'), out);
  assert.ok(out.includes(' 2021 : 上线'));
  assert.ok(out.includes(' 2022 : Release v2 with english words'));
  assert.ok(out.includes(' title 历程'));
});

test('[P] 别的图种、已经写对的写法原样返回', async () => {
  const { prepareMermaidSource: prepare } = await load();
  for (const src of ['pie title x\n "a" : 1', 'sequenceDiagram\n A->>B: hi', 'flowchart TD\n A["调用 f(x)"] --> B']) {
    assert.equal(prepare(src), src);
  }
});

test('[R] 流程图:括号/斜杠/@/竖线标签加引号、行尾注释、子图标题、end 当节点名', async () => {
  const { repairMermaidSource: repair } = await load();
  const fixed = repair('flowchart TD\n A[调用 f(x)] --> B[/api/users]\n B -->|成功 (200)| C[user@x.com]  %% 注释\n subgraph 前端 (React)\n C --> end\n end');
  assert.equal(fixed.source,
    'flowchart TD\n A["调用 f(x)"] --> B["/api/users"]\n B -->|"成功 (200)"| C["user@x.com"]\n subgraph "前端 (React)"\n C --> End\n end');
  assert.equal(fixed.labels, null);
  // 真形状 [/平行四边形/]、[(圆柱)]、((圆)) 不动;无可修时返回 null。
  assert.equal(repair('flowchart TD\n A[/输入/] --> B[(库)] --> C((圆))'), null);
  assert.equal(repair('flowchart TD\n A-->B'), null);
});

test('[R] xychart / 饼图 / 象限 / gitGraph / 时序 / 雷达 / 树图 / 甘特中文日期', async () => {
  const { repairMermaidSource: repair } = await load();
  assert.equal(repair('xychart-beta\n title 月度收入 (万元)\n x-axis [一月, 二月]\n y-axis 收入 0 --> 100\n bar [1, 2]').source,
    'xychart-beta\n title "月度收入 (万元)"\n x-axis [ "一月", "二月"]\n y-axis "收入" 0 --> 100\n bar [1, 2]');
  assert.equal(repair('pie title 占比\n 读文件：42%\n "写" : 18').source, 'pie title 占比\n    "读文件" : 42\n    "写" : 18');
  assert.equal(repair('quadrantChart\n x-axis 低 --> 高\n 需求A：[1.0, .5]').source, 'quadrantChart\n x-axis 低 --> 高\n    "需求A": [1, 0.5]');
  assert.equal(repair('gitGraph\n commit\n branch 用户登录\n checkout 用户登录\n merge 用户登录 tag: "v1"').source,
    'gitGraph\n commit\n branch "用户登录"\n checkout "用户登录"\n merge "用户登录" tag: "v1"');
  assert.equal(repair('sequenceDiagram\n A->>B：先查询; 再写入').source, 'sequenceDiagram\n A->>B: 先查询#59; 再写入');
  assert.equal(repair('radar-beta\n axis a[沟通], b[效率]').source, 'radar-beta\n axis a["沟通"], b["效率"]');
  assert.equal(repair('treemap-beta\n 根\n  子项: 10').source, 'treemap-beta\n "根"\n  "子项": 10');
  assert.equal(repair('gantt\n dateFormat YYYY年MM月DD日\n a :a1, 2026年10月5日, 1d').source,
    'gantt\n dateFormat YYYY-MM-DD\n a :a1, 2026-10-05, 1d');
});

test('[R] 桑基图:中文节点名换成不撞名的 ASCII 代号,给出代号表;纯 ASCII 不动', async () => {
  const { repairMermaidSource: repair } = await load();
  const fixed = repair('sankey-beta\n\n来源A,中间,50\n中间,"输出,一",50\nN1x,B,3');
  assert.equal(fixed.source, 'sankey-beta\n\nN2x,N3x,50\nN3x,N4x,50\nN1x,B,3');
  assert.deepEqual(fixed.labels, { N2x: '来源A', N3x: '中间', N4x: '输出,一' });
  assert.equal(repair('sankey-beta\n\nA,B,1'), null);
});
