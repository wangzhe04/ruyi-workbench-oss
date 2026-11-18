'use strict';
// Independently authored before evaluation. Freeze this file's hash in every receipt.
// Development pilot and these facts differ; do not tune model/thresholds on this fixture.
const rows = [
  ['delivery', 'zh', '北区货运车辆检修期间，订单改由铁路运输，预计到货比原计划晚两天。', '北边的卡车停运以后用什么送货？', 'How will northern shipments travel while trucks are being repaired?', '北区采购订单的开票地址下个月变更。'],
  ['diet', 'en', 'The cafeteria serves plant-based lunches on Mondays; eggs and dairy remain available on other weekdays.', '食堂哪天提供不含动物成分的午饭？', 'Which weekday has a vegan lunch menu?', 'The cafeteria closes at six in the evening.'],
  ['lease', 'zh', '办公室租约于六月三十日到期，续租须提前六十天书面通知房东。', '想继续租办公场地需要多久前告知业主？', 'How much notice is required to renew the office tenancy?', '办公室空调每季度由物业检查一次。'],
  ['printer', 'en', 'If the printer feeds two sheets at once, clean the pickup rollers and replace damp paper.', '打印机一次吞两张纸要怎么处理？', 'What fixes multiple sheets entering the printer together?', 'Printer cartridges are ordered from the approved supplier.'],
  ['merge', 'zh', '这次没有合入补丁，因为合并会覆盖用户尚未提交的修改；应先在独立工作树验证。', '刚才为什么暂缓把那个修复合进去？', 'Why was the patch merge postponed?', '合并请求的标题需要包含问题编号。'],
  ['travel', 'en', 'International train tickets may be refunded until two hours before departure, with a fifteen percent cancellation fee.', '跨国火车票退票最晚什么时候，扣多少？', 'What is the cancellation deadline and charge for international rail tickets?', 'International flights require passport details at booking.'],
  ['seal', 'zh', '出库包装的防拆封条如有破损，收货人员应拍照留证并拒绝签收。', '收到的包裹封口被动过怎么办？', 'What should receiving staff do about a broken tamper seal?', '包装箱外侧应标注货物重量。'],
  ['cooling', 'en', 'Servers shut down automatically when inlet temperature exceeds thirty-eight degrees; check cooling airflow before restarting.', '机器因为太热停机，重新开之前要检查什么？', 'What should be checked before restarting overheated servers?', 'Server maintenance windows are scheduled on Sundays.'],
  ['quota', 'zh', '本轮最多回读四段原始记录，总计不超过六千字；到限后应使用已有证据回答。', '找回旧上下文的次数和总字数上限是多少？', 'How many original history excerpts may be recalled in this turn?', '聊天标题在侧栏最多显示二十四个字。'],
  ['garden', 'en', 'The greenhouse irrigation timer waters seedlings at dawn; suspend watering when the soil moisture sensor is above seventy percent.', '育苗棚土壤已经很湿时还要自动浇水吗？', 'When should automatic watering of seedlings be suspended?', 'The garden gate stays locked after sunset.'],
  ['migration', 'zh', '数据迁移先复制并校验新目录，确认完整后切换读取位置，原目录保留七天供回退。', '搬完数据后旧文件什么时候才能清掉？', 'How long is the old data directory retained after migration?', '迁移向导的欢迎页面支持深色主题。'],
  ['battery', 'en', 'The handheld scanner uses a replaceable battery; a flashing amber light indicates it must be charged before the next shift.', '手持扫码器黄灯闪烁意味着什么？', 'What does a blinking amber light on the handheld scanner mean?', 'The barcode font must be large enough for camera scanning.'],
  ['retry', 'zh', '支付接口返回结果未知时禁止自动重试扣款，应先用交易编号查询实际到账状态。', '付款请求断线后可以直接再付一次吗？', 'May an ambiguous payment failure be retried immediately?', '付款页面支持保存常用发票抬头。'],
  ['archive', 'en', 'Research recordings are kept for ninety days after the study ends, then permanently removed along with transcripts.', '研究结束多久后录音和文字稿会一起清除？', 'When are study recordings and transcripts permanently deleted?', 'The archive room has a separate visitor sign-in book.'],
  ['decision', 'zh', '最新决定取消自动上传，改为只在用户点击导出后生成本地文件；上周的云同步方案已作废。', '现在还是会自己把文件传到云端吗？', 'Is automatic cloud upload still the chosen behavior?', '旧决定：应用每晚自动同步文件到云端。（已被后续决定取代）'],
  ['calibration', 'en', 'Weighing scales must be calibrated using the two-kilogram reference weight every morning before processing any orders.', '每天处理订单前怎样校准电子秤？', 'How should the scales be checked before the first order?', 'The order processing dashboard shows yesterday’s totals.'],
  ['identity', 'zh', '故障记录对应工单 ZX-7194，真正原因是编码后的路径被再次编码，修复是在边界只转换一次。', 'ZX-7194 当时定位到的根因是什么？', 'What caused incident ZX-7194?', '工单 ZX-7195 是数据库连接耗尽，重启连接池后恢复。'],
  ['swimming', 'en', 'Children under twelve must be accompanied by an adult in the swimming pool, including during supervised lessons.', '十二岁以下孩子参加游泳课也需要家长陪同吗？', 'Does a supervised swimming lesson remove the adult accompaniment requirement?', 'Children’s library cards are free to renew.'],
  ['scope', 'zh', '红杉项目中的客户资料不允许进入白桦项目的聊天，即使问题内容完全相同也不能跨范围引用。', '另一个项目有相同问题的资料能直接拿来回答吗？', 'Can identical questions justify importing customer records from another project?', '红杉和白桦项目可以使用同一套窗口配色。'],
  ['ventilation', 'en', 'After painting, keep both workshop windows open for forty-eight hours and do not store food in the room.', '车间刷漆之后要通风多长时间？', 'How long should the workshop be aired after painting?', 'Workshop safety notices are printed in large letters.'],
  ['artifact', 'zh', '最终交付文件是报价单-终版.xlsx，含税总额为 18450 元；此前草稿金额 17600 元不再适用。', '客户最后应该收到哪个表格，总价是多少？', 'Which final quotation file and tax-inclusive amount should be delivered?', '早期估算：草稿报价单金额为 17600 元，尚未计算新增运输费。'],
  ['shipping-label', 'en', 'Fragile glassware travels upright in individual foam sleeves; place the handling label on two adjacent sides of each carton.', '易碎玻璃器皿应怎样摆放和贴运输标记？', 'How should cartons containing delicate glassware be labeled?', 'The shipping department sends a weekly staffing report.'],
  ['recovery', 'zh', '已经清理的原始快照无法从搜索向量还原；界面必须说明原文不可用，不能编造缺失数值。', '只剩向量，没有原始记录，还能找回确切数字吗？', 'Can exact numbers be reconstructed when only an embedding remains?', '快照列表按保存时间从新到旧展示。'],
  ['elevator', 'en', 'During a fire alarm everyone must use the stairwell; the freight elevator is reserved for emergency personnel.', '火警响起时能坐货梯下楼吗？', 'Can employees evacuate using the freight lift during a fire alarm?', 'The elevator inspection certificate expires next spring.'],
];
const documents = rows.flatMap(([id, language, text, zh, en, negative]) => [{ id, language, text }, { id: id + '-distractor', text: negative }]);
const queries = rows.flatMap(([id, language, text, zh, en]) => [
  { id: id + '-zh', text: zh, relevant: [id], group: 'zh-' + language },
  { id: id + '-en', text: en, relevant: [id], group: 'en-' + language },
]);
const noAnswer = ['哪位画家创作了星月夜？', '怎样证明费马大定理？', '上海明天最高气温多少？', '红烧茄子要用哪些配料？', '哪颗恒星离太阳最近？', '请介绍古罗马的货币制度。', '钢琴左手和弦怎么练习？', '如何计算三角形内切圆半径？', 'What is the population of Iceland?', 'Who won the latest tennis championship?', 'How do I knit a wool scarf?', 'What is the boiling point of mercury?', 'How are coral reefs formed?', 'Which languages belong to the Uralic family?', 'Explain quantum entanglement.', 'Where was the poet born?', '我要给猫取个名字。', '怎样区分三种常见云层？', 'Tell me a joke about penguins.', 'Describe the plot of Hamlet.'];
module.exports = { name: 'ruyi-semantic-acceptance-v1', releaseHoldout: true, documents, queries, noAnswer };
