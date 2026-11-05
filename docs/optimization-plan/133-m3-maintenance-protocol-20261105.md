# 133 · 启用流程：私有维护进程协议（2026-11-05）

上一片（132）确认「启用作业必须 spawn 私有维护进程」。本片把**协议形状**读实，作为下一片写测试夹具的规格。
无产品代码改动。

## 已核实的命令与约束

- `app/server.js work-data-maintenance`（冷）→ `14-main:154-168` → `WorkDataRuntimeHost.startColdMaintenance()`
  （`13au:673-684`）：校验 runtimeHooks 具备 `configure`/`runCold`，按 `coldBase(proc)` 建 cold host，
  只跑一次 configure，然后 `runCold()`。
- `app/server.js work-data-successor`（暖）→ `startSuccessorMaintenance({startServe})`；
  它是**两阶段**握手：`prepare` 严格 IPC 输入 +（恢复时）durable activation receipt，`complete` 复核后接管。
- serve 进程里 `worker:false` 是**装配契约**（`13au:651/654/804/821`），不是缺陷；`13ah:51/106` 因此 501。

## 暖进程输入（`13am:373-374`）

```
{ schema:1, id:<result id>, parentPid:<pid>, nonce:<32B hex>, base:<绝对路径>,
  serve:{port,host}, expectedAuthority:{generation,id,mode,sha256},
  ...(restore ? { activation:{kind:'separate-fresh-root', resultSha256} } : {}) }
```

- 通过 **stdin** 写入（`child.stdin.end(bytes)`，写完清零）；子进程用 IPC `message` 回 `serve-ready`。
- ready 消息键集**精确**为 `authority,host,id,kind,nonce,pid,port,schema`，`kind==='serve-ready'`，
  且 id/nonce/pid/port/host/authority 必须与输入一致（`13am:378-381`），否则拒绝。
- 暖进程启动时会要求 `DesktopLifetimeHooks`（若存在）签发 successor 租约并转移；桌面场景不能绕过。

## 冷进程

- 冷入口自己 `configure` 后 `runCold()`；`runCold(channel=processChannel(proc))`，失败/取消有明确 phase
  （`cancelled` 时直接返回）。
- 冷进程成功后会 `launchSuccessor(result)` 并 `exit(0)`；也就是说**冷进程不常驻**，作业状态由后继 serve 呈现。

## 下一片的夹具规格

1. 父进程 spawn `work-data-maintenance`（`stdio: ['pipe','inherit','inherit','ipc']`）；
2. 按上述 schema 写 stdin，监听 IPC 消息；
3. 断言 ready 消息键集/身份匹配，随后通过后继进程的 HTTP `/api/work-data/status` 观察作业状态；
4. 失败分支：错误 nonce / 错误 parentPid / 陈旧 authority / 非空 activation 均必须被拒且不落盘。
