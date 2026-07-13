# 如意 Ruyi 多语言兼容方案

## 目标与边界

将产品从当前的中文优先界面演进为**中文、英文均完整可用**，并为后续语言保留稳定扩展点。第一阶段的目标语言是 `zh-CN` 与 `en-US`；语言标签遵循 BCP 47，后续可增加 `ja-JP`、`ko-KR` 等，而不改动业务逻辑。

这份方案刻意把“文案资源”和“代码接入”分离：本次提交只新增 `docs/i18n/` 下的文档及资源，不修改 `app/`、`config/`、测试或打包文件。这样可与正在进行的功能开发并行，后续实施者只需按键名接入。

## 当前基线（2026-07-13）

| 区域 | 中文命中 | 说明 | 迁移优先级 |
|---|---:|---|---|
| `ruyi-workbench/app/public/index.html` | 312 | 静态按钮、标题、表单标签、ARIA 文本；文件中还存在乱码文本，需要先统一为 UTF-8 | P0 |
| `ruyi-workbench/app/public/app.js` | 1,548 | Toast、确认框、动态卡片、设置页与工作流 UI；包含大量注释 | P0/P1 |
| `ruyi-workbench/app/public/js/*.js` | 41 | 少量模块化前端提示 | P1 |
| `ruyi-workbench/app/server.js` | 需按错误契约复核 | API 错误、日志、模型提示词不能简单逐字替换 | P1/P2 |

上表是 `rg -n --glob '*.{js,html}' '[\\p{Han}]' ruyi-workbench/app/public` 的初始审计结果，不代表可见字符串数。实施前必须先通过 AST/DOM 与人工走查，把注释、测试断言、模型提示词、用户/文件数据和真实 UI 文案区分开。

## 资源结构与键规范

```text
docs/i18n/
  README.md                    # 本方案和接入契约
  STRING-CATALOG.md            # 迁移范围、术语和审校清单
  locales/
    zh-CN.json                 # 中文基准文案
    en-US.json                 # 英文翻译，键集合必须与 zh-CN 相同
```

上线实现时可原样将 `locales/` 移到 `ruyi-workbench/app/public/locales/`。键名以界面语义而非当前 DOM、英文或中文原文命名：

```js
t('session.delete.confirm')
t('workspace.switch.success', { directory })
tCount('session.messageCount', count, { count })
```

- 使用小写点分键：`<feature>.<element>.<meaning>`，如 `settings.provider.apiKey`。
- 有插值时只允许命名占位符 `{{name}}`，禁止依赖中文/英文句子拼接。
- 复数使用 `.one`、`.other` 后缀，并以 `Intl.PluralRules(locale)` 选择；中文可让两个键取同一文案。
- 一个键只表达一个稳定含义；“保存”“保存成功”“保存失败”不可共用一个键。
- 枚举值、工具名、API 参数、文件路径和模型返回内容保持原样，不进入翻译资源。

## 最小运行时契约

前端应增加一个无框架、无第三方运行时依赖的 `i18n` 模块。推荐 API：

```js
const SUPPORTED_LOCALES = ['zh-CN', 'en-US'];

function setLocale(locale) { /* 规范化并持久化 */ }
function t(key, params = {}) { /* 当前语言 → zh-CN → [key] 回退；命名插值 */ }
function tCount(baseKey, count, params = {}) { /* Intl.PluralRules 选择 one/other */ }
function applyTranslations(root = document) { /* data-i18n 与属性翻译 */ }
```

语言选择应保存在应用配置的 `locale` 字段：`auto | zh-CN | en-US`。`auto` 仅在首次启动时用 `navigator.languages` 选择支持语言，之后保存解析结果，避免每次启动因浏览器设置变化而跳变。`<html lang>`、`dir`、日期、数字、货币均以当前 locale 的 `Intl.*` API 渲染。

静态 DOM 建议采用：

```html
<button data-i18n="session.new">新会话</button>
<input data-i18n-attr="placeholder:session.search" />
<button data-i18n-attr="title:navigation.settings;aria-label:navigation.settings"></button>
```

动态 DOM 不新增 `data-i18n`，直接在创建时调用 `t()`；不要翻译已经渲染的自由文本或模型输出。切换语言后，清理并以状态为准重渲染当前视图，避免“中文节点 + 英文节点”混存。

## 前后端边界

服务器不可再把面向用户的中文句子作为唯一错误契约。HTTP 响应应携带稳定、语言无关的机器码与参数，前端通过资源表显示：

```json
{
  "ok": false,
  "error": {
    "code": "workspace.path_not_absolute",
    "params": { "example": "C:\\Users\\me\\project" }
  }
}
```

兼容过渡期可保留现有 `error` 字段作为日志/回退文本，但新 UI 优先用 `error.code`。不得将用户输入、路径、命令、模型回复或敏感错误详情放进翻译键；它们只能作为经过转义的插值参数显示。日志仍可保留原始信息，日志语言不等于 UI 语言。

模型 system prompt、工作流角色 prompt 与工具参数会影响模型行为，属于独立的“模型内容本地化”工作流：需版本化、回归评测和安全审查，不能随着 UI 文案一并自动翻译。

## 分阶段实施

1. **编码与基线**：确认所有 `app/public` 源文件为 UTF-8（无 BOM）；修复静态 HTML 中的乱码后建立可见文案清单。此步骤不混入功能重构。
2. **运行时与设置**：实现 `t`、`tCount`、locale 持久化、资源加载和“语言”设置项；默认保持现有中文体验。
3. **静态页面 P0**：先迁移导航、首启、会话、输入区、常用弹窗、设置标题及全部 `title`/`aria-label`。本仓库提供的两份 JSON 已覆盖这些高频文案。
4. **动态页面 P1**：迁移 `app.js` 中的 toast、confirm、错误卡、变更/审计、权限、工作流、用量面板；一次 PR 按功能域迁移并保留截图测试。
5. **错误契约 P2**：服务器新增错误代码和参数，前端去除对中文错误句子的分支判断；随后迁移 CLI/ACC/MCP 反馈。
6. **质量门与发布**：补全余下键、审校英文、做伪本地化与键一致性检查；将 README、用户指南拆为中英版本后再发布海外文档。

## 质量门

- `zh-CN.json`、`en-US.json` 的键集合完全相同；CI 对缺键和多余键失败。
- `t()` 遇到缺键在开发环境抛错/记录，在生产环境回退到 `zh-CN`，最后显示 `[key]`，绝不静默为空。
- 任何带 `{{placeholder}}` 的键，所有语言的占位符集合一致；插值一律 `textContent`/属性安全赋值。
- 英文 UI 用伪本地化（例如 `［Šëţţïñğš~~~~］`）跑一次截图，验证截断、弹窗宽度、按钮自适应和 RTL 准备度。
- 新增 UI 字符串必须经 lint：除允许列表中的协议/日志/测试外，禁止在 `app/public` 直接写可见文本；评审必须同时提交两个语言资源。
- 关键用户路径（首启、建会话、选工作区、发送、拒绝/允许权限、设置模型、工作流启动）在两种语言下通过 e2e。

## 与并行开发协作

本次提交只触及 `docs/i18n/**`，不会与当前代码改动产生文本冲突。后续迁移应以功能域拆分小 PR，禁止把 `app.js` 全文件格式化或做全局字符串替换；每个 PR 只改其负责函数及对应 locale 键。合并顺序建议先落运行时和资源，再逐域迁移调用点。
