# M5-B1 人工重试回复：私有最小候选 / 2026-10-26

本目录是作者候选，生产只读。未接HTTP/UI，未build/native/真实平台/完整回归，不自动晋升。必须根非作者审查后接线与验门。

## 身份和前置

- 原已审取消payload3：96e9bb602d8a9b99ab468b2fe76bb4738a5cf6d259370531e42ce05b2ad38a33，原字节在13w-original-payload3.js与13w-baseline.js。
- 取消容量修复单片：c82cef972e46ae42d58f74d775a6a6a09e52caeb7d3d368a71fcaa57074504c6。见cancel-physical-span.json及cancel-capacity-review.json；根已独审并落盘此片；人工重试本身仍未独审晋升。真实原Store的40MiB-1有效plain账本上，原取消会ACK后写出不可再读取的文件，且active sender被abort；首红与修后2用例保留。此窄修不改通用Store容量原语。
- 人工重试候选以以上窄修为基线，单独基线文件13w-retry-baseline.js。产品026d912512f8d36cd10678d801075f386d0527ac4aeea0bbac561b24eb0ff79a，6精确span位于spans.json，可完整逆回前置基线。不能直接覆盖生产。

## 支持的人工动作

请求只有准确id、expectedAttemptId和16–64字符retryRequestId。将来精确本机管理入口必须先经过现有token+origin门，再在原state串行链中传模块私有EXTERNAL_BOT_LOCAL_REPLY_RETRY对象给externalBotRetryReply；请求JSON不能构造这个对象。候选没有新增可调用HTTP路径、exports或UI权限。

只允许已有终态业务、failed回复、无active sender/未结算标记、原owner/连接/当前凭据仍合法，且错误严格为predispatch或7种已知token阶段失败的回复。此白名单表示尚未提交MESSAGE；不声称可撤销token认证请求。业务不再进入queued/running，不再次调用管家，不改变replyText/turnSeq/控制/接受/去重/归档事实。

unknown、sent、cancelled、pending、sending均拒绝；失败中rate_limited/rejected/aborted/source_limit等也保守拒绝。当前账本没有持久限流解除时间，不能把429重试写成完成；unknown人工核对仍待独立可信回执设计，点击不是已知未发证明。

## payload4与幂等

首个成功动作将整份业务payload升4；Store schema1/AAD/queue用途及原state-v1路径不变。所有item有replyHistory数组，每条保存完整前failed delivery、nextAttemptId、retryRequestId和requestedAt，当前delivery为主机新生成attempt的pending。链、唯一attempt/请求、准确字段及失败来源均校验；旧schema1/2/3不接受history，旧reader拒绝整个payload4账本，不能降version绕过。

相同item/request/expectedAttempt返回同一持久receipt，当前attempt后来sent/cancelled/unknown或又重试过也只回原记录、不排队、不写入。旧attempt换request冲突；同request换expectedAttempt也冲突。请求身份必须由前端在一次用户动作中稳定持有，丢ACK后先明确刷新核对；不要自动生成新身份重发。

取消共享state链，旧attempt取消不能取消新attempt；准确新attempt可在尚未提交窗口取消，schema4不降回3。原worker只取pending回复，原13w最终source/credential/policy与13x同步提交门全文不变。根接HTTP时仅在durable成功后唤醒原worker；本核心不提前唤醒。

历史最多128条显式工程上限，满则拒绝，不裁剪，不腾去重容量。原1000item/40MiBcompact业务上限仍在；retry额外保守预检projected pretty JSON不超过原40MiB物理plain读限，两模式一致，避免history增长ACK后令OFF账本不可读。它是本操作准入，不是通用Store既有缺口已全面修复的声明。

## 有限纯证据

- 最终retry.test.cjs：45/45通过，无skip；另plain-capacity.test.cjs：1/1通过。
- 实际原Store/Codecs/FullSnapshot源码与实际13x源码VM；平台HTTPS和保护器明确为模型，非DPAPI/native。
- 覆盖新attempt持久前零ACK/调度、同请求幂等/丢ACK后对账、取消两种串行次序、后继unknown不重排、1000item满箱、128历史与真实40MiB密文/明文边界、plain/sealed旧v1/v2/v3 reader整账拒绝0覆盖0run0send、加密缺钥/坏tag、密码包与codec保全部历史/源字节。
- 6当前移除负控全部非零拒绝：本机authority、history保存、幂等、expectedAttempt、history validator、pretty预检。
- 原39用例首轮2个测试错误（引用未初始化变量；把允许的token请求当MESSAGE）保留pure-first.log及首版测试；只修测试，产品不因这两个失败变化。
- 真实plain容量首红属于候选/基座容量错配，不归咎fixture；原红源码、首红日志与当前移除pretty门负控保留。测试临时证据未冒称实际原生完整旅程。

## 后续根工作

独审6spans、私有authority与history上限/兼容合同；再迁长期纯测（旧reader用精确逆片，避免TEMP或运行时Git依赖）。真实API需token/origin/严格body、幂等回执/丢ACK、实际newattempt只发送一次、默认不自动重试；UI要展示旧attempt历史与升级成本，给当前语言拒绝原因，复用原writeOwner/generation/物理pending并发围栏。再串行实际隔离HTTP/browser/相关e2e与必要全门；真QQ/飞书/限流/窗口/unknown核对仍单列，不借有限候选称B1完成。