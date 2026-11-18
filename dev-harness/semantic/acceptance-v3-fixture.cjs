'use strict';
// Independent root-authored evaluation. Never use these rows to choose model or thresholds.
// Freeze this file's hash before the first evaluation of the next selected strategy.
const rows = [
  ['locker','zh','员工储物柜钥匙遗失后须先通知前台停用旧锁芯，再凭工牌领取临时柜；不得自行撬锁。','储物柜钥匙不见了该找谁，旧锁如何处理？','What should an employee do after losing a locker key?','员工工牌使用蓝色挂绳。'],
  ['backup','en','The camera memory card may be erased only after two independent backup copies have been opened and checked.','相机存储卡什么时候才可以清空？','What verification is required before erasing the camera card?','The camera batteries charge in the equipment room.'],
  ['nursery','zh','苗圃育苗盘出现积水时先疏通底部排水孔，暂停浇水，禁止把整盘苗移到烈日下暴晒。','育苗盘水排不出去时怎么救苗？','How should standing water in seedling trays be handled?','苗圃在围栏旁摆放空花盆。'],
  ['laundry','en','Guest laundry bags are collected from the reception desk before nine in the morning and returned the following evening.','住客送洗衣服最晚几点交，什么时候取？','Where and when should guests leave laundry for collection?','Guests can borrow umbrellas from reception.'],
  ['archive','zh','档案室扫描脆弱纸张时用平板扫描仪，不能送入自动进纸器；订书钉由档案员先拆除。','易碎的老档案应该用什么设备扫描？','How should fragile archive papers be scanned?','档案室借阅单按日期装订。'],
  ['antenna','en','Before moving the portable radio, collapse its telescopic antenna fully and disconnect the external power cable.','搬动便携收音机前要处理哪些部件？','How should the portable radio be prepared before moving it?','The radio schedule is pinned beside the entrance.'],
  ['reservations','zh','会议室预订超过开始时间十五分钟无人签到即自动释放；需要延迟开始必须提前在系统中修改。','订了会议室却迟到多久会被取消？','When is an unused meeting room reservation automatically released?','会议室配备可移动白板。'],
  ['freezer','en','Frozen reference samples are packed with dry ice in vented containers; airtight glass vessels must never be used.','冷冻参考样品用干冰运输时容器能完全密封吗？','What container is required when shipping frozen reference samples with dry ice?','Reference samples carry printed batch labels.'],
  ['payroll','zh','差旅报销单必须附车票和主管签字，缺任一项退回补齐，不得拆分成多个小额申请规避审核。','差旅报销少了主管签名能直接提交通过吗？','Which supporting items are mandatory for travel expense claims?','报销单模板放在共享文件夹。'],
  ['bicycle','en','Rental bicycles must be returned to a marked rack and locked through the frame; a photograph of the locked bicycle completes the return.','租来的自行车怎样操作才算归还完成？','How is the return of a rental bicycle confirmed?','Rental helmets are available in three sizes.'],
  ['shelter','zh','临时避雨棚遇强风预警必须收起侧帘并停止使用，人员转移到旁边的砖房等候通知。','大风预警时还能待在临时雨棚里吗？','Where should people move when strong winds make the temporary shelter unsafe?','雨棚旁边设有饮水点。'],
  ['certificates','en','A replacement course certificate uses the original completion date and includes a duplicate mark; it does not extend the certificate validity.','补发课程证书会重新计算有效期吗？','Does a replacement course certificate change the original validity period?','Course attendance is recorded on a paper register.'],
  ['warehouse','zh','货架 BQ-619 存放退货待检件，未通过复检不得移入可销售库存；BQ-620 为已验收区。','BQ-619 的东西能直接重新上架出售吗？','Can items from rack BQ-619 be sold before inspection?','仓库晚班在九点交接。'],
  ['translationdesk','en','Requests marked urgent must include a target language and a delivery time; the translation desk returns incomplete requests to the sender.','加急翻译申请缺少交付时间会怎样？','What information must accompany an urgent translation request?','The translation desk uses a shared calendar.'],
  ['schedule','zh','新版通知将泳池设备检修从周二改为周四，周二照常开放；旧通知作废。','泳池现在是哪天检修停用？','Which day is the swimming pool closed under the revised maintenance notice?','旧通知：泳池原计划周二检修。'],
  ['packing','en','Pack the microscope upright with its lowest-power objective selected, and secure the stage before placing padding around the instrument.','装箱显微镜前物镜和载物台该如何设置？','How should the microscope be configured before packing?','Microscope accessories are stored in labeled drawers.'],
  ['labels','zh','正式交付采用标签模板 CN-R8，R7 已撤销；二维码必须保持黑白，不能跟随品牌色变成浅黄色。','现在交付用哪个标签模板，二维码能改成黄色吗？','Which label template is approved and may its QR code be pale yellow?','旧版模板 CN-R7 曾使用橙色边框。'],
  ['kitchen','en','After cleaning the shared coffee grinder, let all removable parts dry completely before reassembling them; the motor housing is wiped only with a damp cloth.','清洁磨豆机后能把湿零件直接装回去吗？','How should the coffee grinder be reassembled after cleaning?','The shared kitchen buys whole coffee beans monthly.'],
  ['repair','zh','旧自行车刹车线修好后，先在无行人的平地低速试刹，两侧制动都正常才能交还骑手。','换完刹车线之后怎样确认自行车可以交付？','What test is required after repairing a bicycle brake cable?','维修登记册记录车架颜色。'],
  ['display','en','The touchscreen kiosk enters cleaning mode from the settings menu, disabling touch input until the physical side button is pressed.','擦触摸屏时如何防止误触，清洁后怎样退出？','How is touchscreen input disabled and restored for cleaning the kiosk?','The kiosk displays opening hours on its home page.'],
];
const documents = rows.flatMap(([id,language,text,zh,en,distractor]) => [{id,language,text},{id:id+'-distractor',text:distractor}]);
const queries = rows.flatMap(([id,language,text,zh,en]) => [{id:id+'-zh',text:zh,relevant:[id],group:'zh-'+language},{id:id+'-en',text:en,relevant:[id],group:'en-'+language}]);
const noAnswer = [
 '怎样计算圆锥的体积？','奥运会五环分别是什么颜色？','为什么金星比水星更热？','成年大象一天吃多少食物？','如何给网页的按钮设置圆角？','什么是概率中的条件独立？','雨滴为什么不是泪滴形状？','如何用吉他演奏大横按？','为什么海水有咸味？','素数有无穷多个如何证明？',
 '怎样辨别二氧化碳和氧气？','蜜蜂的蜂王能活多久？','如何把二进制数转换成十进制？','古埃及的象形文字怎样被破译？','火山喷发会形成什么岩石？','为什么红移可以用于估算宇宙膨胀？','围棋中的打劫是什么意思？','地球内部有哪几层结构？','英语过去完成时如何使用？','植物叶片为什么通常呈绿色？',
 'What causes the phases of the Moon?','How do penguins stay warm?','What is the difference between RAM and an SSD?','How does a violin produce sound?','Why does bread dough rise?','What is the area of a regular hexagon?','How do mangroves survive in salt water?','What is an eigenvector?','Why are sunsets red?','What determines the boiling point of a liquid?',
 'How do historians date ancient pottery?','What is the purpose of an HTTP status code?','How are coral reefs formed?','What causes an eclipse?','How does a steam turbine work?','What is the difference between a simile and a metaphor?','Why do migrating birds fly in a V formation?','How is a chess pawn promoted?','What is the role of fungi in a forest?','How is a musical time signature read?',
];
const unsupported = [
 '员工储物柜换锁收费多少？','苗圃去年种了多少棵苗？','档案扫描仪的购买价格是多少？','会议室预订管理员的姓名是什么？','BQ-619 的货架有多高？','泳池设备检修工人的电话是多少？',
 'What brand is the camera memory card?','How much does the guest laundry service cost?','Who supplies the dry ice for sample shipments?','What is the replacement course certificate fee?','What is the microscope serial number?','How many coffee grinders are in the kitchen?',
];
module.exports = {name:'independent-root-acceptance-v3',documents,queries,noAnswer,unsupported};
