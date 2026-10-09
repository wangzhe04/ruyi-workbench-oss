# 媒体制作任务的原生工具验收

工具可通过 `tool_search` 查找，再用 `tool_load` 装载。无需先启动 computer use 来读取本地图片或分析音频。

| 需求 | 原生入口 | 范围与限制 |
| --- | --- | --- |
| 看图 | `file_read({path, as:"image"})` | 图片直接进入已开启视觉的服务商消息通道；`auto` 自动识别，`text` 排除图像。PDF 可按页读取，现代 Office/ODF 可读取内嵌媒体。旧版二进制 Office 不支持。 |
| 查能力开关 | `workbench_self_status({section:"capabilities"})` | 返回 vision/audio/asr、各模态工具、后台任务可用性和检查点范围。`config` 还包含协议及服务商视觉配置。配置不等于远端模型实际支持已通过探测。CLI 的视觉能力返回未知，由 CLI 自身决定。 |
| 音频客观验收 | `audio_inspect({path, stream:0, startSeconds:0, durationSeconds:120})` | 本地 FFmpeg 解码；各声道峰值、RMS 包络、瞬时/短时/积分 LUFS、接近削波的时间窗。音轨通过零基 `stream` 分别检查。不会上传或播放音频。 |
| 后台长任务 | `tool_search({query:"background shell", view:"matrix"})` | 原生 provider 引擎使用 `shell_start`/`shell_poll`/`shell_kill`；CLI/MCP 单次子进程不能承载这一组持久状态，使用所选 CLI 自己的后台命令能力。 |
| 写盘前语法检查 | `file_edit` / `file_write` 的 `validateSyntax:true` | 对完整候选文本做解析，失败则不改文件、不记虚假检查点。支持 JS/MJS/CJS、Python、JSON，最多 1MB；JS/Python 分别需要 Node/Python。不是类型检查、LSP 或测试。 |
| 单独检查候选源码 | `code_check({path, content?})` | 不提供 content 时读取文件；提供时不写盘。只解析，不执行用户源码。文本超过 file_read 窗口时拒绝局部验证，要求提供完整候选。 |
| 目录及批量操作 | `file_copy` / `file_move` / `file_delete` | 目录显式 `recursive:true`；复制/移动可用 `items:[{from,to}]`，删除可用 `paths:[...]`。最多 100 个根路径、1000 个条目、32 层，不遍历符号链接。 |
| 产物清理 | `file_delete({path:"out",recursive:true})` | 只清理明确指定的路径；也可指定 `dist`。拒绝删除/移动工作区根及其祖先。默认不覆盖文件；目录复制/移动可合并到现有目录，文件冲突仍需 overwrite。 |
| 模态检索 | `tool_search({query:"view image",view:"matrix"})` | 返回匹配工具的模态、风险档位、工具包与后台引擎限制；`vision`/`看图`优先命中文件视觉输入。 |
| 依赖探测 | `media_probe({refresh:true})` | FFmpeg、ffprobe、Chrome/Edge、Python、Node 的位置、版本或缺失建议。识别 PATH、显式环境变量和 Python 的 imageio-ffmpeg wheel。不会自动安装依赖。Windows 浏览器只检查文件存在，避免版本探测启动可见窗口。 |
| 较大草稿 | `scratchpad_write` | 32 条、单条 2000 字符、合计 12000 字符；提示注入仍上限 5000，超出时保留每条 key 的摘要。`op:"list"` 返回全文。仅本会话主 provider 回合，不是长期记忆写入。 |
| 验收回执 | `acceptance_report({path,title,checks})` | 保存带类型和版本的 JSON 产物，最多 50 个闸门；状态 pass/fail/blocked/not_run，绑定本地证据文件的路径、大小、修改时间和结论，返回汇总。 |

## 音频数值与试听

音频测量采用 FFmpeg 的 [ebur128 / astats 滤镜](https://www.ffmpeg.org/ffmpeg-filters.html)。曲线窗口默认 1 秒，自动扩大以保持最多约 600 点；每窗保留最大采样峰值、最大分帧 RMS 及最后一个瞬时/短时 LUFS。静音的负无穷峰值用 `null` 表示。积分响度只针对请求片段，不代表未读取的全片；默认读取 120 秒，单次最多 1800 秒，解码上限 60 秒。用 `nextStartSeconds` 分段续读，不能直接把片段 LUFS 作算术平均当作全片 LUFS。

`nearClipWindows` 标记采样峰值达到 -0.1 dBFS 的窗口，是风险定位而非“已听见失真”的证据。声道不是独立乐器 stem；多轨请分别选择 stream。`listeningPerformed` 固定为 false：当前 harness 没有把原始音频送入聊天模型或提供试听工具。`audio_transcribe` 只负责语音识别，也不等于试听。主观听感应由实际播放并听过的人验收；未执行的试听闸门记为 `not_run`。

## 检查点与证据的边界

文件批量操作先做整批路径、类型及冲突检查，再逐文件调用原有权限检查、锁和检查点机制。它不是原子事务；中途 I/O 失败返回 `partial` 与已完成结果。每个文件仍受 5MB 旧内容快照上限约束，留意 `checkpointWarn`。检查点恢复文件内容，不恢复目录元数据或空目录。

脚本、FFmpeg、浏览器、画图程序等外部程序产生的文件和窗口副作用不由文件检查点保护。撤销只通过用户界面完成；清理明确指定的 out/dist 路径是新的文件操作，不代表撤销了外部程序执行。

验收回执检查证据文件在生成时存在，但不独立验证调用者填写的结论。证据文件之后可能变化，必要时保留版本化产物。回执示例：

```json
{
  "path": "dist/acceptance.json",
  "title": "影片交付验收",
  "checks": [
    {"label":"分镜视觉","status":"pass","evidence":["out/board.png"],"conclusion":"已通过 file_read 逐页查看"},
    {"label":"混音测量","status":"pass","evidence":["out/audio-analysis.json"],"conclusion":"已检查各轨峰值与响度"},
    {"label":"主观试听","status":"not_run","conclusion":"尚未播放试听，不能声称已听过"}
  ]
}
```
