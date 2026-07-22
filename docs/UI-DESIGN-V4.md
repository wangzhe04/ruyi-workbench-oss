# UI-DESIGN-V4 · 现代毛玻璃质感(定稿)

> 状态:**定稿**(2026-07-22,第50波)。本文是如意工作台第四代视觉语言的设计基线,token 值与
> `ruyi-workbench/app/public/styles.css` 一致(设计稿生命周期见 docs/README.md)。
> 原型:`docs/mockups/v4-glass-home.html` / `v4-glass-workbench.html`(双主题,经所有者两轮质感评审:
> 第 2 轮"深色要更高级"迭代值已回写 styles.css)。

## 1. 总体语言:从"纯色平铺"到"分层磨砂"

三层材质体系——**底层有景、中层磨砂、上层点睛**:

- **底层(Scene)**:应用背景不再是单一平色。暗主题"墨夜深空"微渐变(藏蓝墨 → 深空灰对角缓变
  + 5% 微噪点压塑料感);亮主题"月白晨雾"微渐变。**底层有内容,毛玻璃的模糊才有意义**。
- **中层(Glass)**:侧栏、顶栏、composer 容器、右栏面板、浮层(modal/popover/toast/命令面板)
  统一半透明磨砂:`backdrop-filter` + 半透明底色 + 1px 半透明描边 + 顶部 1px 内高光。
- **上层(Accent)**:青花蓝从"大片铺底"收敛为**点色**(主按钮、激活态、焦点环、关键数据);
  黛紫 `--accent-2` 为其渐变搭档(只作装饰面:品牌标/头像/发光,不作文字底色);鎏金(香槟)
  仅保留授权/信任语义。

**克制原则**:玻璃是"框与浮"的材质,正文阅读区/代码块/diff 区一律实色;玻璃过头变"花哨"
与简洁目标冲突,设计评审以"长时间使用不疲劳"为准绳。

## 2. 玻璃材质 token 族(双主题对称,theme.e2e 点名锁)

| token | 用途 | 暗主题(提亮路数) | 亮主题(留白+柔影) |
|-------|------|-----------------|------------------|
| `--scene-bg` | 底层微渐变 | 蓝紫双 radial + `#090d16→#0e1526` 对角 + `--noise` 噪点 | 青花/黛色轻染 + `#f6f8fc→#e9eef8` |
| `--glass-bg-1` | 框架族底色 | `rgba(146,166,214,.065)` | `rgba(255,255,255,.58)` |
| `--glass-bg-2` | 浮层族底色 | `rgba(158,178,224,.085)` | `rgba(255,255,255,.72)` |
| `--glass-bg-3` | 卡片族底色 | `rgba(140,160,208,.05)` | `rgba(255,255,255,.46)` |
| `--glass-border` / `-strong` | 玻璃描边 | 白 9% / 15%(偏蓝) | 墨 9% / 14% |
| `--glass-highlight` | 顶部内高光(inset) | 白 8%(偏蓝) | 白 75% |
| `--glass-shadow` / `-soft` | 浮起投影 | 黑 55% / 35%(深而远) | 墨 15% / 9% |
| `--glass-blur-1/2/3` | 模糊三档(非颜色,:root) | `blur(8/16/24px) saturate(1.2/1.3/1.4)` | 同左 |
| `--accent-2` | 黛紫渐变搭档(装饰面) | `#9a72f0` | `#7a5fd0` |

**关键裁决(WCAG 红线优先于 mockup)**:mockup 第 2 轮的暗主题 accent `#6e86f2` 对 accent-ink
白字对比仅 3.3,不过 theme.e2e 的 4.5 红线——**`--accent` 保留 `#4a6cd9`**,蓝紫高级感经
`--accent-2` 渐变与 glow 表达,不经文字底色。亮主题 accent 采纳 mockup `#2050c8`(对比 6.9 ✓)。

纪律:玻璃材质**只能写在 token 与组件类上**,禁散写 `backdrop-filter` 字面量(token 静态锁约束)。

## 3. 材质分档:哪里用玻璃,哪里不用

| 档 | 表面 | 材质 |
|----|------|------|
| 玻璃一档(blur 大) | 浮层族:modal、popover、命令面板、toast、右键菜单 | `--glass-bg-2` + blur-3 + `--glass-shadow` |
| 玻璃二档(blur 中) | 框架族:顶栏、侧栏、右栏、composer 容器 | `--glass-bg-1` + blur-2,贴边侧无圆角 |
| 玻璃三档(blur 小) | 卡片族:消息卡、tool 卡、工作台节点卡、设置卡 | `--glass-bg-3` + blur-1;列表内大量出现时降级半透明纯色(容器 `data-glass="off"`) |
| 非玻璃 | 正文阅读区、代码块、diff 区 | 实色(阅读舒适与对比度稳定) |

## 4. 性能与降级(头号工程约束)

- **模糊预算**:同屏 `backdrop-filter` 表面 ≤ 6 个(框架族 3-4 + 浮层 1-2);卡片族在消息流/列表
  场景**自动降级**为半透明纯色(`data-glass="off"` 统一切换,静态锁机械约束)。
- **合成层纪律**:玻璃元素禁滥用 `will-change`;浮层动画只动 transform/opacity;blur 封顶 24px。
- **降级路径**:`@supports not (backdrop-filter)` → token 级实色回退(布局零变化);
  `prefers-reduced-transparency` → 关模糊(均已落 styles.css)。
- **对比度兜底**:阅读区不磨砂;框架/浮层文字底色是 panel 系实色,玻璃只在其上叠一层薄纱,
  theme.e2e 的 WCAG 红线(ink/bg≥7、muted/panel≥4.5、accent-ink/accent≥4.5、link/bg≥4.5)持续生效。

## 5. 主题三态

明 / 暗 / **跟随系统**(`prefers-color-scheme` 监听),持久化 `wcw.theme`,预绘脚本防闪沿用。
双主题玻璃差异化:暗主题玻璃靠"提亮"(白 4%~8% + 亮描边),亮主题靠"留白 + 柔影"
(白 46%~72% + `--glass-shadow`)——**禁止一套值双边复用**。

## 6. 图标与细节

- 图标沿用 `js/icons.js` currentColor 线性集(描边 1.5px @16 网格);新增走同一规范。
- emoji 清零目标:界面控件零 emoji(分批,本波处理高频控件;playbook/toast 保留区后续评估)。
- 圆角 `--r` 阶梯;hover 微交互统一(translateY(-1px) + 阴影加深 + 底色微提亮,`--dur` 三档);
  焦点环青花外发光(`--ring`/`--glow-accent`)。
- `.num` 仪表数字推广到用量/指标。

## 7. 本轮清障(第50波)

- 删除零引用令牌:`--density-scale`、`--gold-soft`(两主题)、`--sp-7`(`--sp-8` 有 1 处活引用,保留)。
- 4 处硬编码 `#fff` token 化(×3 → `--accent-ink`;iframe 预览底 → `--panel`)。
- 鎏金:暗 `#f2c14e` → 香槟 `#dcba75`;亮 `#a97b1e` → `#a8822f`(mockup 第 2 轮值)。
- 亮主题 `--accent`/`--link` `#2350a8` → `#2050c8`。

## 8. 守护(第50波 Step 3 落地)

- theme.e2e:令牌键集对称 + WCAG 红线 + 玻璃令牌族点名锁(本稿 §2 表即断言源)。
- 视觉回归门:headless `--screenshot` 双主题截图对比(dom-screenshot.e2e)。
- "新组件两主题对称"写入贡献指南。
