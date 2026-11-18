"""Publish this batch's scoped evidence without granting release acceptance."""
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'docs/optimization-plan/evidence/semantic-retrieval-20261116'
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
def bind(path):
    return {'path': path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
gemma = ROOT/'output/semantic-gemma2-proxy-resident-smoke-v2/root-review.json'
cn = ROOT/'output/semantic-gemma2-proxy-cn-lease-smoke-v2/root-review.json'
enable = ROOT/'output/semantic-target-binding-captured-read-v1/root-review.json'
media = ROOT/'output/m4-source-preparation-root-20261118-r2/root-integration.json'
builder = ROOT/'output/m4-openh264-repro-root-20261118-r1/root-live-integration.json'
desktop = ROOT/'output/semantic-desktop-job-list-build-v1/root-review.json'
g, e = read(gemma), read(enable)
assert g['status']=='ROOT_ACTUAL_GEMMA2_RESIDENT65_SCOPED_PASS'
assert e['publishedVerificationAndSuccessorQualified'] and not e['outerForcedReclaim']
capsules = [BASE/name/'manifest.json' for name in [
    's3c-media-supplement-reviewed-20261118-r1',
    's3c-resident-and-publication-reviewed-20261118-r1',
    's3c-ordinary-enable-and-build-tools-reviewed-20261118-r1']]
report = {
    'schema': 1, 'updatedAt': now, 'status': 'PRE_RC_SCOPED_RUNTIME_AND_ORDINARY_ENABLE_PROGRESS',
    'rootEvidence': [bind(path) for path in [cn, gemma, enable, media, builder, desktop]],
    'immutableSourceCapsules': [bind(path) for path in capsules],
    'runtime': {'status': 'ACTUAL_V4_GEMMA2_RESIDENT65_SCOPED_PASS',
        'measurements': g['measurements'],
        'scope': 'Actual frozen core/provider and router host prefix with genuine pinned model, synthetic VM configuration/consumer labels. Not full HTTP/UI or incremental desktop footprint.',
        'cases': ['Chinese/space canonical lease/helper UTF8 echo and observed cleanup',
                  'nonblocking prewarm call and actual public inference before available',
                  '65009ms resident same helper/worker across two synthetic sessions',
                  'disable observed cleanup and empty homes',
                  'reenable new owned helper/worker with public warm',
                  'normal shutdown observed cleanup and naturally empty outer Job'],
        'open': ['early bootstrap parent hard exit and actual desktop JobList matrix',
                 'all supported legacy/direct Node/fallback paths',
                 'full product source/privacy/consumer/quality/performance and clean Windows qualification']},
    'ordinaryEncryption': {'status': 'ACTUAL_ENABLE_PUBLISHED_VERIFIED_SUCCESSOR_SCOPED_PASS',
        'rootPreflightPass': 73, 'bindings': 641, 'outerForcedReclaim': False,
        'rootCauseEvidence': 'Earlier first published target comparison kept tree SHA but changed native file time.access. Candidate routes selected binding reads through actual target capture owner grant; original Basic4, fixed proof, namespace, identity and hash checks retained.',
        'scope': 'One ordinary synthetic config/session enable, semantic disabled. New successor observed and deliberately closed by the declared inner test Job; outer drained naturally.',
        'open': ['integrated private consumer injection candidate must be independently reviewed and rerun',
                 'encrypted session/source/index/export/disable lifecycle',
                 'restore/recovery, special ADS/uploads/portable and independent fresh-source Access']},
    'media': {'status': 'SOURCE_PREPARATION_AND_OFFLINE_REPRO_BUILDER_INTEGRATED',
        'sourceSupplementBytes': 15592,
        'sourceSupplementSha256': '4b2544085f7b545997c77c411948fbed921107b6eedb6c7c83bec66be7cab7c3',
        'rootSourcePreparationPass': True, 'rootValidatorUnitPass': 8, 'rootReproBuilderUnitPass': 5,
        'legacySourceZipAndLockUnchanged': True,
        'firstFailuresRetained': ['PowerShell document dispatch without PATHEXT; original async Python identity not captured and historical closure not proven.',
                                  'Root wrapper test accidentally omitted SystemRoot; managed PowerShell failed before script execution; explicit SystemRoot correction passed without source change.'],
        'open': ['actual new package source delivery coverage', 'actual binary corresponding source/build/relink and applicable distribution obligations']},
    'desktop': {'status': 'BASELINE_WAITER_JOBLIST_COMPILE_ONLY_PASS',
        'targetLibrariesExecuted': False, 'liveDesktopModified': False,
        'productArchitecture': 'C# WinForms/WebView2 desktop shell plus Node; earlier Electron wording in experimental disclaimers is inaccurate.',
        'open': ['actual kernel creation/parent death/handoff/nested/two-instance/normal-close matrix',
                 'direct Node/fallback support', 'supported Windows/Server scope and clean machine verification']},
    'checks': {'releaseGateUnitPass': 4, 'offlineInstallerStaticPass': 52, 'allEightSemanticGates': 'pending'},
    'version': '3.0.1', 'defaultModelChanged': False, 'commitPushOrPublicRelease': False,
    'whole31Complete': False, 'blindFinalCorpusConsumed': False,
}
report_path = BASE/'3.1-progress-20261118-r2.json'
assert not report_path.exists()
write(report_path, report)
audit_path = BASE/'3.1-remaining-requirements-audit-20261117.json'
audit = read(audit_path)
items = {row['id']: row for row in audit['requirements']}
items['M3-enable-restore']['progress'] = 'Root actual ordinary enable now SCOPED PASS with641 postverified bindings and73 scoped regressions: target binding reads use actual captured owner grants, fixed target proof/Basic4/namespace/hash guards unchanged; published verification and successor reached, controller0 and outer naturally active0, no fallback. Earlier root/category/postpublication failures remain failed. Integrated private host consumer candidate, complete source/index/export/disable/restore/recovery and special paths remain unqualified.'
items['M3-enable-restore']['gap'] = 'Only ordinary config/session enable has new real qualification. Private consumer architecture integration, encrypted source/index/export/disable, restore/recovery, special ADS/uploads/portable and independent fresh-source Access require source-bound qualification.'
items['M3-enable-restore']['next'] = 'Root review integrated candidate under original dependency policy; freeze and execute real synthetic session/source/index/export/disable matrix, then independent restore/recovery and special matrices. Do not reuse retained unknown fixtures.'
items['SR6-resident-hard-exit']['progress'] = 'Root actual v4 strict provider/router-prefix Gemma2 public warm,65s idle same helper/worker across two synthetic sessions,disable/reenable/normal-shutdown all scoped PASS; normal outer0/no fallback. Idle helper+worker326.14MiB WS/313.84MiB private, Node/VM+helper+worker393.57MiB WS/392.96MiB private; not full Desktop footprint. Existing desktop owner waiter+JobList candidates compiled only and not executed; early hard exit, all supported legacy/direct/fallback paths and full privacy/consumer matrix remain open.'
items['M4-public-distribution']['progress'] = 'Root verified116 static bindings and byte-exact independent report replay; original32-byte empty OpenH264 header archive defect confirmed. Root independently ran source preparation before/after copying and8 validator tests, offline byte-exact15592-byte supplement reproduction and5 builder tests; reviewed build-tool integration now live. Known empty legacy inner archive remains explicit and original source ZIP/lock unchanged. New full-package coverage and actual corresponding source/build/relink remain open. First dispatch/environment failures preserved.'
audit['progressUpdatedAt'] = now
audit['latestProgressReview'] = bind(report_path)
write(audit_path, audit)
gates_path = BASE/'release-gates.json'
gates = read(gates_path)
assert all(row['status']=='pending' for row in gates['gates'])
gates['updatedAt'] = now
gates['currentStatus'] = 'PRE_RC_ORDINARY_ENABLE_AND_GEMMA2_RESIDENT65_SCOPED_PASS_FULL_QUALIFICATION_PENDING'
work = gates['currentWork']
work['latestProgressReview20261118R2'] = bind(report_path)
work['complete31RequirementsAudit']['audit'] = bind(audit_path)
work['runtimeLifecycleRequirement']['productionProxyCandidateReview'] = {
    'status': 'V4_ROOT51_AND_ACTUAL_GEMMA2_RESIDENT65_SCOPED_PASS', 'genuineReceipt': bind(gemma),
    'nativePathReceipt': bind(cn), 'desktopCompileOnly': bind(desktop), 'liveDefaultUnchanged': True,
    'wholeLifecycleQualified': False}
work['realCommonJsBootstrap']['nextControlledSourceExperiment'] = {
    'status': 'ORDINARY_ENABLE_PUBLISHED_VERIFIED_SUCCESSOR_SCOPED_PASS', 'receipt': bind(enable),
    'next': 'Review integrated private consumer and real source/index/export/disable matrix; restore/recovery and special paths remain separate.'}
work['mediaSourceSupplement20261118R2'] = {'status': 'PREPARATION_TOOLS_INTEGRATED_NOT_DISTRIBUTION_APPROVAL',
    'sourcePreparation': bind(media), 'offlineBuilder': bind(builder), 'sourceCustody': [bind(p) for p in capsules]}
for row in gates['gates']:
    relevant = capsules if row['id']=='SR6' else [capsules[0],capsules[2]] if row['id']=='SR7' else []
    for path in relevant:
        item = bind(path)
        if item not in row['evidence']:
            row['evidence'].append(item)
write(gates_path, gates)

section = '''
### 10.34 2026-11-18 真实常驻与普通加密启用通过；源码补充接入

Root 顺序执行中文／空格路径代理测试和真实 Gemma2 常驻测试，两者事前事后各核对 669 项绑定。中文 UTF8 120 字节回包逐字一致；helper/worker、内层 Job、lease、OS 身份及私有 home 均正常收口，外层自然 active0。真实模型测试通过后台调用返回、公开预热、65 秒闲置同进程、第二会话热复用、禁用释放、重启新进程及正常关闭；没有外层强杀兜底。模型、tokenizer、CPU runtime、C4 源字节和 modelFP 均未变。

本轮后台调用返回约 0.35ms，启动到公开预热约 4.697s，重新启用约 4.608s；两个公开合成查询为 57.83ms 和 91.23ms。闲置 65 秒时 worker 工作集 298.60MiB／private 293.84MiB，helper 27.54／20.00MiB；两者合计 326.14／313.84MiB。加 Node/VM 父进程合计 393.57／392.96MiB。研究 Job 的峰值 commit 648.96MiB 含测试与诊断进程，不能叫 RSS，也不能相加各进程峰值。这是固定组件实测：未清 OS 文件缓存、没有 p95 样本、没有完整 HTTP／隐私／检索链或桌面增量占用。产品桌面是 C#/WinForms/WebView2＋Node，旧实验免责声明中的 Electron 称呼不准确。

M3 两轮真实诊断先保留失败，再把首次 published target 拒绝细化为 tree 摘要未变、native 文件 time.access 改变。候选将指定 generation binding 的读取接到真实 target capture owner／readCapturedScope／borrowCapturedFile／WorkDataStore 私有 grant；没有改四 Basic、固定目标摘要、namespace、identity 或内容 hash 条件。Root 复跑 50＋7＋16＝73 项限定回归，核对 641 项输入，随后真实普通 config/session 加密启用通过：发布后验证、旧服务退场和新 successor 均到达，规定 inner test Job 关闭 successor 后，控制器 exit0，外层自然 active0，未 fallback 强杀。该结果不等于 Desktop 正常关闭，也不外推到特殊 ADS/uploads/portable、restore/disable/recovery、完整索引或真实模型消费者。原所有失败样本与 unknown 均保留，不自动重试。新私有 host consumer 整合候选已经准备，尚待 root 独立验收原依赖策略及真实矩阵。

M4 已独立核对 116 项静态来源／notice 绑定并在新目录逐字重放报告；确认旧头档为空。补充包四个官方头及 LICENSE 的锁定归档为 15,592B，SHA 4b2544085f7b545997c77c411948fbed921107b6eedb6c7c83bec66be7cab7c3。Root 实测 prepare 复制前后校验、8 项 validator 反例、5 项离线重建测试及无 PATHEXT 的显式 Python 启动入口。源码准备／Full-local 接线、校验器和离线生成器已纳入 tools，说明见 [源码补充构建说明](../../ruyi-workbench/tools/README-media-source-supplement.md)。旧 ZIP 与旧 source lock 不变；新包应同时交付原两档、独立补充与索引。首轮 PowerShell document dispatch 和 root 测试遗漏 SystemRoot 的失败均保留。补充材料不能证明历史 DLL 使用了这些头，实际 source/build/relink 和新发行 ZIP 覆盖仍待验收。

更早的 lease/bootstrap 硬退出改进复用现有桌面 Job：独立 held-HANDLE waiter 候选及创建时 JobList 候选，17 项模型／结构检查由 root 复跑；固定系统 csc 对基线、waiter、JobList 三版 library 均编译 exit0，未加载或执行目标 DLL，未改 live Desktop，未运行可见 GUI／Computer Use。真实父进程强杀、handoff、嵌套限制、双实例、正常关闭，以及直接 Node／fallback 支持仍 OPEN。编译不当作内核保证。

已建立并独立按源字节、gzip、SHA 和原 capsule 引用 postwalk 三份新证据：media supplement 184 aliases／155 local blobs；resident/publication 2013／268；ordinary enable/build tools 739／161。详见 [本批状态与证据绑定](evidence/semantic-retrieval-20261116/3.1-progress-20261118-r2.json)。发布门槛单测 4 项及离线安装静态 52 项通过，均为限定检查；SR1–SR8 全 pending，版本 3.0.1、原默认模型不变，未 commit/push/发布。完整 3.1 范围与外部环境依赖继续保留。
'''
plan = ROOT/'docs/optimization-plan/147-3.1-semantic-retrieval-and-recovery.md'
text = plan.read_text(encoding='utf-8')
assert '### 10.34 ' not in text
plan.write_text(text.rstrip()+'\n\n'+section.strip()+'\n', encoding='utf-8')
notice = '> 2026-11-18 最新进度：真实 Gemma2 常驻65秒／跨会话／禁用重启关闭，以及一个普通样本加密启用已通过 root 限定实测；源码补充工具已接入。完整功能、恢复、全入口性能和新包仍待验收，尚未达到 RC。详见 [147 §10.34](147-3.1-semantic-retrieval-and-recovery.md#1034-2026-11-18-真实常驻与普通加密启用通过源码补充接入)，全部发布门槛仍 pending。'
for name in ['README.md','86-3.1-completion-and-privacy-roadmap.md','92-3.1-implementation-handoff.md']:
    path = ROOT/'docs/optimization-plan'/name
    lines = path.read_text(encoding='utf-8').splitlines()
    indices = [i for i,line in enumerate(lines) if line.startswith('> 2026-11-18 最新进度：')]
    assert len(indices)==1
    lines[indices[0]] = notice
    path.write_text('\n'.join(lines)+'\n', encoding='utf-8')
print(json.dumps({'status': report['status'], 'report': bind(report_path), 'audit': bind(audit_path), 'allEightGates':'pending'}))
