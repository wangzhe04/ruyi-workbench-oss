'use strict';

// Public synthetic text only. Keep the reference set independent of relevance labels.
const anchors = [
  'A bookmark rests between two pages.', 'Clouds move slowly above the fields.', 'A small stone lies beside the path.',
  'The wall clock faces the hallway.', 'Several chairs stand by the window.', 'The napkin is folded into a square.',
  'A pencil leaves a mark on paper.', 'The curtains move in the breeze.', 'A spoon rests beside a bowl.',
  'An envelope arrived this morning.', 'The floor tiles form a pattern.', 'The road crosses a narrow stream.',
  'The shelf has three compartments.', 'The lake reflects the afternoon light.', 'A light coat hangs on the hook.',
  'The handle is made of wood.', '墙上的挂历翻到了新的一页。','桌上的玻璃瓶是透明的。','傍晚的天空渐渐变暗。',
  '地上铺着一层落叶。','屋角摆着一盏台灯。','纸盒用棉线扎紧。','墙边有一把旧雨伞。',
  '蓝色方块旁边有一个圆圈。','窗外能看到几棵树。','钟声响了两次。','水面倒映着白云。',
  '小路通往远处的山坡。','柜门上有一只黄铜把手。','一排白色盘子整齐摆放。','瓷杯的边缘很光滑。','一块布盖在木箱上。',
];

function memoryCorpus() {
  const documents = [], queries = [];
  const services = ['账单', '库存', '账户', '通知', '审计', '订单', '搜索', '物流'];
  const rules = [
    ['部署前核验', '上线前核对构件签名，把审核结果保存到变更单。', '服务发版前要核对什么？'],
    ['回滚条件', '灰度期间持续出现付款超时就撤回这次发布，恢复上一版本。', '系统何时应当退回老版本？'],
    ['灰度顺序', '先向内部账号开放，再按区域逐批放量。', '新版本应先给哪些人使用？'],
    ['发布后观测', '放量完成后连续观察队列积压和错误数，并记录到交接表。', '全部放量后要看什么指标？'],
    ['应急联系人', '紧急变更由项目值班人员联系当日负责发布的工程师。', '遇到紧急版本变更时谁联系发布人员？'],
  ];
  for (const [i, service] of services.entries()) {
    for (const [j, [name, description, question]] of rules.entries()) {
      const id = 'ops-' + i + '-' + j;
      documents.push({ id, text: [id, service + name, service + '服务约定：' + description, 'project'].join(' ') });
      queries.push({ group: 'memory-deployment', kind: 'positive', text: service + question, relevant: [id] });
    }
  }
  const subjects = ['食堂','阅览室','咨询台','展览厅','活动室','休息区','会议室','健身房','地下车库','苗圃','画室'];
  const facts = [
    ['预约', '提前一天在前台登记，取号后保留确认单。'],
    ['清洁', '闭馆前先移走桌面物品，擦干后再放回原位。'],
    ['通风', '每天开放之前先开窗十分钟。'],
    ['照明', '最后离开的人检查灯具开关。'],
    ['借用', '借出物品时记录编号和预计归还日期。'],
    ['标牌', '入口处摆放中英文指引，指引应保持清晰。'],
    ['失物', '遗失物品集中交给当日值班人员登记。'],
    ['检修', '发现设备故障后停用并提交维修申请。'],
  ];
  for (const [i, subject] of subjects.entries()) {
    for (const [j, [name, description]] of facts.entries()) {
      const id = 'place-' + i + '-' + j;
      documents.push({ id, text: [id, subject + name, subject + '的约定：' + description, 'project'].join(' ') });
    }
  }
  for (const text of ['你好','好的','继续','谢谢','收到','嗯','好吧','知道了','早上好','辛苦了','hello','okay','go on','thanks','got it','great']) {
    queries.push({ group: 'memory-small-talk', kind: 'ood', text, relevant: [] });
  }
  return { documents, queries };
}
module.exports = { anchors, memoryCorpus };
