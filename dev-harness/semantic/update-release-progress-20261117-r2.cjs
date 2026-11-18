'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const base = 'docs/optimization-plan/';
const evidence = base + 'evidence/semantic-retrieval-20261116/';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function pin(path, expected) {
  const bytes = fs.readFileSync(path);
  if (sha(bytes) !== expected) throw Error('Changed reviewed evidence: ' + path);
  return {path, sha256: expected};
}
const archive = pin(evidence + 's3c-candidate-directory-and-hard-death-reviewed-r1/manifest.json', 'd7510f32f284b6b5ddf62fec06f7694712b3112933519be46e8c3befa60d70b5');
const candidate = pin('output/semantic-owned-candidate-native-primitive-v6/root-review.json', '8ba2086a03ad183149a246d8dd20d8fdb0ee7fc9b0abc676d3ddb38ee304673d');
const parent = pin('output/semantic-resident-proxy-parent-death-v2/root-review.json', '57d555f615ba8d5be3de8f85c81944951007d5c9ef0dbf5b6b0d6921dce18d4d');
const helper = pin('output/semantic-resident-proxy-helper-death-v2/root-review.json', 'e4dbd9fa401eb63871d07953606fe8fdbec820e2f59e634d0daa5a7212e74f63');
const media = pin('output/m4-notice-delivery-coverage-20261117-r1/root-review.json', '6dffe7fb8edb29d3fb882b83deef32182c1165b70173f93ae220399c6893ddee');
const gatePath = evidence + 'release-gates.json';
const gates = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
if (gates.status !== 'pending' || gates.gates.length !== 8 || gates.gates.some(g => g.status !== 'pending')) throw Error('Unexpected formal gate status');
const work = gates.currentWork;
work.realCommonJsBootstrap.nextControlledSourceExperiment = {
  status: 'ROOT_CANDIDATE_DIRECTORY_PRIMITIVE_SCOPED_PASS_ORDINARY_VERTICAL_PENDING',
  review: candidate, archive,
  scope: 'Actual atomic directory creation, held identities, DELETE-sharing, deep-first flush, first-item replacement and existing-name collision. Synthetic directory capability, not full production enable.',
  productEnableQualified: false,
  nextDesign: 'Separate the exact privately authorized new candidate output from the legacy original-source census, retain parent namespace and identity checks, and independently verify the complete target with fixed pre-publication proof. Do not broadly exclude .work-data or relax original-source metadata checks.',
  remaining: ['Root review and actual ordinary production enable vertical, including individually recorded helper cleanup.', 'Special raw-tree ADS and portableCapture boundary integration; complete restore/disable/recovery matrix.', 'Fresh source-root Access rejection remains independently open.']
};
work.runtimeLifecycleRequirement.actualHardDeathPrimitives = {
  status: 'ROOT_REAL_SYNTHETIC_PARENT_AND_HELPER_HARD_DEATH_SCOPED_PASS', parent, helper, archive,
  parentCase: 'Native held-handle termination of actual parent; independent observer saw parent/helper/busy synthetic worker absent before external cleanup.',
  helperCase: 'Native held-handle termination of actual helper; worker absent, actual parent still alive. Parent retains unknown and rejects replacement.',
  outerTerminationRequested: false,
  productRuntimeWired: false,
  fullApplicationQualified: false,
  remaining: ['OS canonical UTF-8 bootstrap, input backpressure, concurrent profiles, bootstrap-parent exit and nested-Job failures.', 'Production provider integration, genuine model lifecycle, all consumers and total application resource measurements.']
};
work.fullLocalSourceMaterials20261117.historicalPackageNoticeCoverage = {
  status: 'ROOT_HISTORICAL_FULL_LOCAL_NOTICE_AND_FONT_BYTES_SCOPED_PASS', review: media, archive,
  runtimeArtifacts: 4987, noticePaths: 69, locations: 4, darkGardenSourceFiles: 7,
  newPackageQualified: false, redistributionAdmitted: false
};
work.releaseReadiness20261117R2 = {
  status: 'PRE_RC_IMPLEMENTATION_AND_INTEGRATION_ACCEPTANCE',
  batches: [
    'Close M3 complete encryption enable/restore/disable and resident runtime production lifecycle.',
    'Qualify real-model search, compaction recovery and memory consumers; frozen independent quality and complete 1000-fragment performance.',
    'Close M4 distribution/source obligations and M5 platform and workflow qualification.',
    'Freeze final source and assets; build new offline packages; complete authorized regression, installation, upgrade, recovery and rollback.'
  ],
  externalDependencies: ['Real platform credentials, callback environment and explicit controlled-message authorization when real M5 tests are ready.', 'Supported clean Windows and required cross-machine/account verification; applicable upstream distribution evidence.'],
  percentageClaimed: false, releaseDateCommitted: false,
  version: '3.0.1', defaultModelChanged: false, publicReleaseAuthorized: false
};
const auditPath = evidence + '3.1-remaining-requirements-audit-20261117.json';
const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
audit.progressUpdatedAt = new Date().toISOString();
audit.progressMethod = 'Root-reviewed execution records and archived immutable inputs, kept separate from the initial inventory method; no blind corpus opened.';
const byId = Object.fromEntries(audit.requirements.map(r => [r.id, r]));
byId['M3-enable-restore'].evidence = 'Actual production-derived full flow crossed backup, restore rehearsal and independent cold verification, then failed prepare on Access metadata of the current private candidate output root. Atomic directory primitive passed real NTFS cases; full enable remains failed.';
byId['M3-enable-restore'].gap = 'Complete ordinary and special production enable/restore/disable are unqualified. Exact source/output domain separation is under review; the independent fresh-source Access issue remains open.';
byId['M3-enable-restore'].next = 'Root-review frozen private candidate boundary and complete target proof, record observed helper cleanup, then execute ordinary vertical and special ADS/portableCapture recovery matrix. Preserve source guards and original failures.';
byId['SR6-resident-hard-exit'].evidence = 'Real synthetic Win32 echo, large tail drain, stalled-output unknown fence and parent/helper hard-kill primitives passed root execution. Hard-kill absence was independently observed before external cleanup; helper death retains parent unknown. Genuine model residency is separately component-qualified.';
byId['SR6-resident-hard-exit'].gap = 'Primitives are not the integrated product. OS canonical bootstrap, startup races, input backpressure, concurrency, nested Job failure, provider integration and final genuine-model lifecycle remain open.';
byId['SR6-resident-hard-exit'].next = 'Execute remaining reviewed frozen native batches; integrate and independently accept actual startup resident provider, configuration/disable/shutdown/unknown paths and full parent/helper/worker costs.';
byId['M4-public-distribution'].progress = 'Root verified 21 source archives and notice byte copies, plus historical Full-local 4987 artifacts, 69 notices across four locations and seven DarkGarden source files. These checks do not qualify new packages or close component-specific distribution obligations.';
fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
work.complete31RequirementsAudit.audit = {path: auditPath, sha256: sha(fs.readFileSync(auditPath))};
gates.updatedAt = new Date().toISOString();
gates.currentStatus = 'HARD_DEATH_PRIMITIVES_PASS_M3_AND_PRODUCT_INTEGRATION_PENDING_PRE_RC';
fs.writeFileSync(gatePath, JSON.stringify(gates, null, 2) + '\n');
const title = '### 10.31 发布距离复核与强杀原语通过';
const section = `${title}

当前仍处于候选发布之前的实现与集成验收，不能称为只差打包。SR1–SR8全部pending并非零实现进度，而是组件PASS尚不足以关闭完整发布要求；不据用例数量推算完成百分比或承诺发布日期。版本3.0.1、原默认模型不变，未commit/push/发布。

Root已真实执行候选目录v6：原子创建、原DELETE-share兼容、child/nested→child→root刷新、首项替换拒绝且不追加flush、已存在名称碰撞拒绝均通过，helper正常退出并独立观察原创建身份缺席，外层Job正常active0且无需兜底强杀。它仅是合成候选目录原语，不证明生产授权、文件内容或完整启用。后续方案改为精确的源／输出域分离：只有私有manifest／owner／intent授权、原子新建ID与父链绑定的新候选不递归进入旧source census，父namespace仍校验；独立完整native target proof与固定发布前后对照必须保留。真实原source四时间、attrs、streams、双census不放宽，不整体排除.work-data。普通vertical候选尚待root审验，特殊ADS／portableCapture及fresh-source Access另列待办。

父／helper强杀v2现已各自通过真实限定验收：原生同一held HANDLE验证身份后强杀；父强杀时独立观察parent/helper/忙碌合成worker均缺席，helper强杀时观察worker缺席且原parent仍存活。后者保持unknown并拒补启动，不能因OS缺席升级为正常observed。两次都在外层清理之前完成独立观察，外层正常active0、无Terminate。首版父强杀见证失败仍保留。所有结果仍是研究代理原语；生产provider接线、启动竞态、并发、输入背压、nested Job与跨Windows信任尚未验收，真实模型完整生命周期及总应用内存仍待。

Root另独跑历史Full-local交付检查：4987个运行时文件、69个notice在wheel／runtime／历史ZIP两位置共四处字节一致；DarkGarden七份源码／许可材料与历史包对应。该结果只证明历史材料覆盖，不关闭新包、FFmpeg对应或最终分发义务。以上原件、首红、快照和复核见[目录原语与强杀复核归档](evidence/semantic-retrieval-20261116/s3c-candidate-directory-and-hard-death-reviewed-r1/manifest.json)，manifest SHA d7510f32f284b6b5ddf62fec06f7694712b3112933519be46e8c3befa60d70b5。

发布前仍按四批串联：先完整M3与常驻生产接线；再真实模型搜索／压缩恢复／记忆全入口、独立质量及完整千片段性能；然后关闭M4发行与M5平台／工作流；最后冻结最终树、构建新离线包并做获授权的全量回归、安装升级恢复回滚。部分工作可并行，但真实平台、干净Windows／跨机验证和发行来源存在外部依赖，尚无可靠剩余天数。已明确延期、取消或禁止的测试继续按原范围处理。
`;
const planPath = base + '147-3.1-semantic-retrieval-and-recovery.md';
const prior = fs.readFileSync(planPath, 'utf8');
if (prior.includes(title)) throw Error('Progress section already exists; do not rewrite historical updates');
fs.writeFileSync(planPath, prior.trimEnd() + '\n\n' + section);
const top = '> **2026-11-17 本批接续：** 当前尚未进入候选发布阶段。目录原子创建及父／helper真实强杀原语已由root执行通过，helper被杀后保留unknown并拒补启动；完整加密启用、常驻生产接线、真实模型全消费者／独立质量／千片段性能仍待。历史Full-local notice／字体源字节覆盖通过，新包与M4发行、M5真实平台、最终树验收未关闭。详见[147 §10.31](147-3.1-semantic-retrieval-and-recovery.md#1031-发布距离复核与强杀原语通过)。SR1–SR8全pending，版本3.0.1，未commit/push/发布。';
for (const name of ['README.md', '86-3.1-completion-and-privacy-roadmap.md', '92-3.1-implementation-handoff.md']) {
  const p = base + name, text = fs.readFileSync(p, 'utf8');
  if (!/^> \*\*2026-11-17 本批接续：\*\*.*$/m.test(text)) throw Error('Missing current status: ' + p);
  fs.writeFileSync(p, text.replace(/^> \*\*2026-11-17 本批接续：\*\*.*$/m, top));
}
console.log(JSON.stringify({status: gates.currentStatus, formalGates: gates.gates.map(g => [g.id, g.status]), archive}));
