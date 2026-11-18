'use strict';
// Synthetic development pilot, authored before model execution. Not the release holdout.
const rows = [
  ['backup', '备份保留三十天，每天凌晨两点复制到异地磁盘。', '数据丢了可以从哪里找回？', 'Where can I recover lost files?', '备份管理页面的按钮改为蓝色，图标使用圆角。'],
  ['invoice', 'Employees submit travel receipts to finance before Friday; reimbursement arrives next month.', '出差垫付的钱怎样报销？', 'How do I claim money spent on a business trip?', 'The customer invoice template uses a larger company logo.'],
  ['password', '忘记口令时使用已绑定邮箱的验证码重设登录密码。', '进不了账号，原来的密码想不起来了。', 'I cannot remember the credential for signing in.', '管理员不得把任何人的密码写进运行日志。'],
  ['offline', 'The workstation runs without internet; model weights and tokenizer are bundled on the installation disk.', '断开外网之后还能推理吗？', 'Can inference run on an air-gapped computer?', 'The download website displays the current version number.'],
  ['delete', '删除会话时同时移除衍生搜索索引，防止已删内容再次出现。', '清掉聊天后，搜索结果为什么也必须清理？', 'How are search remnants removed when a chat is erased?', '关闭侧栏只隐藏当前窗口，不删除历史会话。'],
  ['timeout', 'Requests stop after twenty seconds; an expired call releases its process and returns a timeout code.', '一直没有响应的调用多久会中止？', 'When does an unresponsive request get cancelled?', 'Queue length is limited to eight pending jobs.'],
  ['encrypt', '本地历史使用用户密钥加密，密钥失效时拒绝读取，不能跳过校验。', '密钥不对时能不能继续读本地对话？', 'What happens if the history decryption key is wrong?', '压缩包使用校验和检测下载损坏。'],
  ['restore', 'To restore a previous revision, select a checkpoint and verify its content hash before replacing files.', '改坏代码后怎样回到修改前？', 'How can I roll back a broken edit?', 'The latest revision adds a timestamp column to the interface.'],
  ['port', '启动报错 EADDRINUSE 说明监听端口已被占用，应换空闲端口或停止占用进程。', '服务监听地址冲突应该怎么解决？', 'What should I do when the listening socket is already taken?', '网络请求返回四零四表示路由不存在。'],
  ['meeting', 'The architecture review moved from Tuesday to Thursday at 15:00; the earlier invitation is superseded.', '架构评审改期后安排在什么时候？', 'What is the revised time for the design review?', 'The weekly sales meeting remains on Tuesday at 09:00.'],
  ['memory', '项目记忆只在同一项目内召回，过期和被否决的条目不应自动注入。', '失效的长期记录还会被带入提示词吗？', 'Are expired remembered facts inserted automatically?', '所有项目共用同一套浅色主题设置。'],
  ['cancel', 'A user cancellation prevents queued jobs from starting and terminates the running child process.', '点了取消以后，排队任务还应继续执行吗？', 'What should happen to pending work after cancellation?', 'Pausing the activity animation does not stop computation.'],
  ['source', '搜索命中后必须按来源坐标重新读取原文，不能把向量当作历史证据。', '语义找到了内容之后怎样核实真实出处？', 'How do we verify a retrieved historical claim?', 'The embedding dimension is shown on the diagnostics screen.'],
  ['attachment', 'PDF attachments are split by page; citations retain page number and character offsets.', '附件里的文字怎样保留可追溯位置？', 'How are document attachment citations located?', 'The upload button accepts JPEG and PNG avatar pictures.'],
  ['permission', '跨会话读取之前先验证授权范围，权限被撤回后禁止读取原文。', '另一个聊天没有给访问权还能读取吗？', 'May another conversation be read after access is revoked?', 'Read-only UI tabs do not allow modifying the page title.'],
  ['queue', 'Foreground queries take priority over document indexing jobs that have not started yet.', '后台建索引排队时，用户查询应该排在哪里？', 'Which work should be served before background indexing?', 'Completed indexing jobs are recorded with a duration counter.'],
  ['stock', '库存不足时先联系仓管调货，未经确认不能承诺次日发货。', '缺货时销售应该先找谁确认？', 'Who must confirm availability before promising shipment?', '发票抬头必须与合同中的企业名称一致。'],
  ['leave', 'Annual leave requests require the direct manager approval at least three working days in advance.', '休年假要提前几天提交审批？', 'How early should vacation approval be requested?', 'Sick leave requires a medical certificate after two days.'],
  ['compression', '会话压缩保留摘要和原始快照引用，缺失细节通过引用回读恢复。', '上下文缩短以后忘掉的细节怎么找回？', 'How can details removed during context compaction be recovered?', '模型加载时先解压权重文件再建立推理会话。'],
  ['expiry', 'Temporary download links expire after ten minutes and must be regenerated for later access.', '临时分享地址失效后怎么办？', 'How do I reopen a temporary link after it expires?', 'The permanent documentation address is printed on the help page.']
];
const documents = rows.flatMap((row, i) => [{ id: row[0], language: i % 2 ? 'en' : 'zh', text: row[1] }, { id: row[0] + '-negative', text: row[4] }]);
const queries = rows.flatMap((row, i) => [{ id: row[0] + '-zh', text: row[2], relevant: [row[0]], group: i % 2 ? 'zh-en' : 'zh-zh' }, { id: row[0] + '-en', text: row[3], relevant: [row[0]], group: i % 2 ? 'en-en' : 'en-zh' }]);
const noAnswer = ['如何治疗犬类耳部感染？', '木星的主要卫星有多少颗？', '怎样给小提琴换琴弦？', 'Where is the tallest mountain in Antarctica?', 'How do I bake sourdough bread?', '请推荐古希腊哲学的入门著作。'];
module.exports = { name: 'ruyi-semantic-development-pilot-v1', releaseHoldout: false, documents, queries, noAnswer };
