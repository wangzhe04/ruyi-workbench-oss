'use strict';
// Root-authored sealed evaluation. Implementers must not inspect or tune against it.
// Freeze the file hash before calibration results or implementation are evaluated.
const rows = [
  ['observatory','zh','天文台每周三关闭公众参观，工作人员利用这天清洁主镜；预约只能改到其他开放日。','游客周三为什么不能进天文台？','Why are public visits unavailable on Wednesdays at the observatory?','天文台礼品店销售星图和明信片。'],
  ['kiln','en','Newly glazed pottery must cool inside the closed kiln overnight before anyone opens the lid.','陶器烧好后能立刻揭开窑盖吗？','When is it safe to open the kiln after glazing pottery?','The pottery studio accepts bookings for weekend workshops.'],
  ['choir','zh','合唱团本月排练改在社区礼堂，旧教室正在隔音施工；演出地点仍为市民剧院。','这个月合唱练习搬去哪里了？','Where is the choir rehearsing while its old classroom is renovated?','合唱团演出海报使用蓝色背景。'],
  ['ferry','en','Passengers with bicycles board the island ferry after pedestrians and secure their bikes on the lower deck.','带自行车坐渡轮要在什么时候登船？','In what order do cyclists board the island ferry?','The island ferry sells bottled water at its snack counter.'],
  ['seedbank','zh','种子样本入库前必须测定含水率，超过百分之八的批次需要重新干燥后复测。','种子太潮湿时可以直接存进库房吗？','What happens to seed batches with moisture above eight percent?','种子库的参观走廊设有植物图片。'],
  ['braille','en','Braille labels are attached to the right edge of each display case, at the same height as its handle.','展柜的盲文说明贴在哪个位置？','Where can visitors find the Braille labels on display cases?','The exhibition catalog contains a map of the building.'],
  ['residency','zh','艺术家驻留申请须提交三件近期作品及一封推荐信，不接受仅附个人简历的材料。','申请驻留除了简历还必须交什么？','Which supporting materials are required for the artist residency?','驻留工作室配有共享厨房。'],
  ['aquarium','en','During tank cleaning, aquarium staff transfer the fish into a covered holding basin filled with water from the original tank.','清洗鱼缸时鱼应该暂时放在哪里？','Where are the fish kept while their aquarium is cleaned?','The aquarium entrance has a touchscreen information desk.'],
  ['trail','zh','山脊步道因落石封闭，徒步者须改走湖畔路线；封闭期间不得翻越警戒栏。','山路有落石时应该绕行哪条路线？','Which route replaces the closed ridge trail?','湖畔游客中心出售登山地图。'],
  ['translation','en','The translator must preserve product codes exactly and translate only the surrounding prose in the maintenance manual.','翻译维修手册时产品代码要跟着翻译吗？','Should product identifiers be translated in the maintenance manual?','The maintenance manual uses numbered sections.'],
  ['instrument','zh','借出的弦乐器归还时必须松弓并擦净松香，琴弦保持原有张力，不要自行拆卸。','还小提琴之前需要怎样处理弓和琴弦？','How should a borrowed string instrument be prepared for return?','乐器借用柜台在午间休息。'],
  ['accessibility','en','Visitors who cannot climb stairs should enter the auditorium through the courtyard ramp; the front entrance has six steps.','不能走楼梯的观众从哪里进入礼堂？','Which auditorium entrance is suitable for a wheelchair user?','The auditorium seating plan is printed on the tickets.'],
  ['voucher','zh','纸质体验券只适用于陶艺课程，不能兑换现金，也不能抵扣绘画课程的费用。','陶艺体验券可以拿去付绘画课的钱吗？','Can the pottery voucher be used to pay for a painting class?','绘画教室的画架可以调节高度。'],
  ['brewery','en','Reusable brewing bottles are inspected against a light; any bottle with a chipped rim is discarded rather than refilled.','可重复使用的酿造瓶口有缺损该怎么办？','What should be done with a brewing bottle whose rim is chipped?','The brewery visitor tour ends at the tasting room.'],
  ['lostproperty','zh','失物柜中的普通衣物保管三十天，证件则当天移交服务台单独登记，不和衣物一起存放。','捡到身份证后会和衣服放在一起保管吗？','Are lost identity documents stored together with lost clothing?','服务台的失物登记本使用绿色封面。'],
  ['telescope','en','Before transporting the telescope, remove its eyepiece and lock both adjustment axes to prevent movement inside the case.','搬运望远镜之前要取下什么并锁住哪里？','How must the telescope be secured before transport?','The telescope club publishes a monthly observing newsletter.'],
  ['exhibit','zh','展品编号 KT-826 的表面损伤来自旧胶带残留；修复方案是先小面积测试清洁剂，不能直接刮除。','KT-826 的损伤原因和处理方法是什么？','What caused the surface damage on exhibit KT-826?','展品 KT-827 的木框松动，已经重新固定。'],
  ['costume','en','Stage costumes made of silk are steamed on the reverse side at low heat and must never be pressed directly with a hot iron.','丝绸戏服能不能直接用高温熨斗压烫？','How should silk stage costumes be smoothed safely?','Stage costume measurements are recorded in centimeters.'],
  ['rehearsal','zh','新通知将舞蹈彩排从周五晚改到周日下午，周五只保留灯光调试；以这次通知为准。','舞蹈演员现在应该什么时候来彩排？','When should the dancers attend the rescheduled rehearsal?','过期通知：舞蹈彩排原定周五晚上举行。'],
  ['bookbinding','en','Torn book pages are repaired with archival tissue and reversible paste, never with ordinary transparent adhesive tape.','书页破了可以用普通透明胶粘好吗？','What materials should be used to repair a torn book page?','The bookbinding workshop has twelve seats.'],
  ['ceremony','zh','典礼结束后接驳车从南门发车，末班为二十一点十五分；北门仅供步行离场。','活动散场想坐最后一班接驳车该去哪，几点发车？','Where and when does the final shuttle leave after the ceremony?','典礼签到台摆放在东侧门厅。'],
  ['soundcheck','en','For the sound check, mute the loudspeakers before connecting microphones, then raise the gain gradually to avoid feedback.','接麦克风之前应该先做什么以防啸叫？','How should microphones be connected safely during the sound check?','The concert recording will be edited next week.'],
  ['mapprint','zh','最终印刷文件为湖区导览-R6.pdf，共两千份；旧版 R5 已取消，不能继续交给印厂。','哪一版导览图可以付印，印多少份？','Which lake guide file is approved for printing and how many copies?','旧版湖区导览-R5.pdf 曾计划印一千五百份。'],
  ['clay','en','Unused clay is stored in airtight tubs with a damp cloth on top; dried scraps are kept separately for reclaiming.','没用完的陶泥怎么保存才不会干？','How is unused clay kept moist between pottery sessions?','The clay workshop floor is swept after each class.'],
];
const documents=rows.flatMap(([id,language,text,zh,en,negative])=>[{id,language,text},{id:id+'-distractor',text:negative}]);
const queries=rows.flatMap(([id,language,text,zh,en])=>[{id:id+'-zh',text:zh,relevant:[id],group:'zh-'+language},{id:id+'-en',text:en,relevant:[id],group:'en-'+language}]);
// No document is relevant to these topics. This is a retrieval rejection gate.
const noAnswer=[
 '酵母细胞通过什么方式繁殖？','如何求矩阵的特征值？','月球表面为什么有陨石坑？','长颈鹿通常睡多久？','碳酸氢钠的化学式是什么？','什么是债券的久期？','无线电波如何在电离层传播？','二叉搜索树删除节点有哪些情况？','如何判断岩石是玄武岩还是花岗岩？','为什么肥皂能去油？',
 '马拉松世界纪录是多少？','北极熊的皮肤是什么颜色？','哈希表如何解决键冲突？','咖啡因在体内如何代谢？','什么是二次剩余？','企鹅为什么不会飞？','大气压随海拔怎样变化？','希腊语属于哪个语系？','硬盘扇区损坏如何检测？','螺旋星系的旋臂怎样形成？',
 'How does a diesel engine ignite fuel?','What is the derivative of a logarithm?','Why do onions make people cry?','How do bees communicate distance?','Explain the difference between a compiler and an interpreter.','What causes ocean tides?','How is inflation measured?','What is the lifecycle of a butterfly?','How does a solar cell generate electricity?','What distinguishes a comet from an asteroid?',
 'How do sharks detect electric fields?','What is a prime factorization?','Why does iron rust?','How do glaciers shape valleys?','What is the purpose of a database transaction?','How is silk produced by silkworms?','Why do leaves change color in autumn?','What is the central limit theorem?','How do bats navigate at night?','What makes a rainbow appear?'
];
// Related evidence may legitimately be returned, but does not answer these.
// Report separately; search matches must not be called verified answers.
const unsupported=[
 '天文台门票多少钱？','合唱团指挥的姓名是什么？','种子库可以容纳多少吨种子？','艺术家驻留的报名截止日期是哪天？','琴弦原来的张力是多少牛顿？','KT-826 最初是哪一年制作的？','典礼接驳车车牌号是什么？','湖区导览图印刷厂的联系电话是多少？',
 'How much does the island ferry ticket cost?','What is the aquarium holding basin capacity?','Who translated the maintenance manual?','How many wheelchairs fit inside the auditorium?','What brand of paste is used for book repairs?','What is the kiln temperature in degrees?','Who owns the telescope?','What is the exact gain setting in decibels for the sound check?'
];
module.exports={name:'ruyi-semantic-acceptance-v2',releaseHoldout:true,documents,queries,noAnswer,unsupported};
