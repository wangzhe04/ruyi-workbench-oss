"""One-shot additive progress publication. No SR gate is closed by this batch."""
from pathlib import Path
from datetime import datetime, timezone
import copy
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'docs/optimization-plan/evidence/semantic-retrieval-20261116'
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def load(file):
    return json.loads(file.read_text(encoding='utf-8'))


def save(file, value, exclusive=False):
    with file.open('x' if exclusive else 'w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def binding(file, expected=None):
    digest = sha(file.read_bytes())
    if expected:
        assert digest == expected, file
    return {'path': file.relative_to(ROOT).as_posix(), 'sha256': digest}


old = BASE / '3.1-progress-20261118-r2.json'
assert sha(old.read_bytes()) == '63512b983df98463dee24f85f64ec361a2b6c3d76bbb646c8ea661107f52c32b'
out = BASE / '3.1-progress-20261118-r3.json'
assert not out.exists()
now = datetime.now(timezone.utc).isoformat()
progress = copy.deepcopy(load(old))
progress.update(updatedAt=now, status='PRE_RC_EARLY_LEASE_PASS_ENCRYPTED_EXPORT_BLOCKED')
root = ROOT / 'output'
early = root / 'semantic-desktop-early-lease-actual-run-v2/root-review.json'
life = root / 'semantic-encrypted-lifecycle-v3/root-review.json'
cause = root / 'semantic-export-snapshot-cause-v1/root-review.json'
integrated = root / 'semantic-candidate-integrated-v1/root-preflight.json'
progress['rootEvidence'] += [
    binding(early, '449de4e3bcbb009592ec0f9b24b3ffda58669876551c85375137f3c9ccf69f63'),
    binding(life, 'dbe0830c6b417b850b204aace4fe157c98fb60a90af12a3830c132d33fd1a5bb'),
    binding(cause, 'e717dbcf348707b017a87137d10ee223b64172cd96b49ce39f63a9d116d42600'),
    binding(integrated),
    binding(root / 'semantic-export-snapshot-cause-v1/root-capsule-postwalk.json'),
]
capsule = BASE / 's3c-early-lease-and-encrypted-lifecycle-reviewed-20261118-r1/manifest.json'
progress['immutableSourceCapsules'].append(binding(
    capsule, '41976a37293d6411c2ab2da086cc491d673c9d6802d2e72d9e7034c29373c332'))
e = load(early)
progress['desktop'] = {
    'status': e['status'], 'bindings': 48, 'sourceAndCoordinatorUnitPass': 25,
    'actualProductHostCodeExecuted': True, 'entryPoint': 'console probe; no GUI entry point',
    'liveDesktopModified': False,
    'independentAbsenceMsAfterKillInvocationStart': e['independentAbsenceMsAfterKillInvocationStart'],
    'naturalPostEofHoldMs': e['naturalPostEofHoldMs'],
    'actorAndCoordinatorAliveAtAbsence': e['actorAndCoordinatorAliveAtAbsence'],
    'actualProductJobClosedObserved': e['actualProductJobClosedObserved'],
    'outerForcedReclaim': False,
    'productArchitecture': 'C# WinForms/WebView2 shell plus Node.',
    'scope': 'Same held HANDLE kill of early Node; actual fixed Desktop Host code reclaims preparation PowerShell while console host remains alive. No visible desktop execution.',
    'firstPreexecutionRejections': ['PS marker/flush outside protected try', 'Windows CRLF rejected by coordinator'],
    'open': ['actual desktop-owner death, handoff, nested Job, two-instance and normal-close matrix',
             'trusted resident-home/ACL/lease channel and readonly installation',
             'supported direct Node/legacy/fallback paths and clean supported Windows'],
}
progress['runtime']['open'] = [
    'Full desktop-owner death/handoff/nested/two-instance/normal-close integration; only early Node-death lease reclamation newly passed.',
    'Trusted resident home/ACL and v5 SystemDrive environment chain remain candidate-only, not native qualified.',
    'All supported legacy/direct Node/fallback paths, full product source/privacy/consumer/quality/performance and clean Windows qualification.',
]
progress['ordinaryEncryption']['open'] = [
    'Full export/disable/delete lifecycle remains failed at export; no restore/recovery qualification.',
    'Special ADS/uploads/portable and independent fresh-source Access remain open.',
]
progress['migrationIntegration'] = {
    'status': load(integrated)['status'], 'bindings': 654, 'unitPass': 75,
    'originalDependencyPolicyRetained': True,
    'scope': 'Private injected consumer and original WeakMap issuer; no new reverse dependency or policy-baseline expansion. Native-free qualification only.',
}
progress['encryptedLifecycle'] = {
    'status': 'FAIL_RETAIN_AND_FENCE_EXPORT_BEFORE_CAPTURE',
    'firstRunBindings': 675, 'firstRunRootPreflightPass': 81,
    'diagnosticRunBindings': 687, 'diagnosticRootPreflightPass': 10,
    'observedPrefix': ['enable-published', 'actual loopback turn committed', 'original three-field readback', 'two complete index coverage reports'],
    'displayMessages': 2, 'originalSourceFields': 3,
    'diagnostic': {'stage': 'before-capture', 'code': 'work_data_backup.metadata_changed',
                   'branch': 'held-basic', 'objectClass': 'directory', 'fields': ['time.access'],
                   'exactDirectoryOrActorIdentified': False},
    'wholeLifecycleQualified': False, 'exportQualified': False,
    'disableExecuted': False, 'deleteExecuted': False, 'semanticModelEnabled': False,
    'protocolUnknownRetained': True,
    'outerForcedReclaim': True, 'outerActiveAfterReclaim': 0,
    'failedRootsRetainedWithoutRetryOrRollback': True,
}
progress['m5'] = {
    'status': 'FIXED_HTTP_HARNESS_UNDER_ROOT_REVIEW_NOT_EXECUTED',
    'humanScope': 'Five types, nine actions, each fresh fixture and server; do not reduce to one global server.',
    'knownPreexecutionFindings': ['v4 global single-server rule invalid for full human suite', 'keeper compiled before environment cleanup', 'query rights and lifecycle identity pairing required review'],
    'prior79TestScopeUnchanged': True, 'realPlatformQualified': False,
    'groupContinuousRevisionProviderQualified': False,
}
progress['checks'] = {'allEightSemanticGates': 'pending',
                      'previousReleaseGuardReceipt': binding(root / 'release-guard-20261118-r2/receipt.json'),
                      'thisRecordClaimsNewFullRegression': False}
save(out, progress, exclusive=True)
review = binding(out)

audit_path = BASE / '3.1-remaining-requirements-audit-20261117.json'
audit = load(audit_path)
audit.update(progressUpdatedAt=now, latestProgressReview=review)
for requirement in audit['requirements']:
    if requirement['id'] == 'M3-enable-restore':
        requirement['evidence'] += ' New root-reviewed private consumer integration passed 75 native-free checks; failed full lifecycle observed actual encrypted turn, original readback and complete lexical index before export failure.'
        requirement['gap'] = 'Export still fails before capture at held-basic directory time.access; exact directory/actor unknown. Disable/delete not reached; restore/recovery, special ADS/uploads/portable and independent fresh-source Access remain unqualified.'
    elif requirement['id'] == 'M3-index-lifecycle':
        requirement['evidence'] += ' Failed encrypted lifecycle observed two messages, three original fields and two complete lexical index coverage reports; semantic model disabled.'
        requirement['gap'] = 'Only the successful prefix of a failed lifecycle is observed. Export/disable/delete/rebuild/recovery and final-source installed-build qualification remain open; missing sources cannot be treated as negatives.'
    elif requirement['id'] == 'SR6-resident-hard-exit':
        requirement['evidence'] += ' Actual same-HANDLE early Node death reclaims preparation PowerShell in about 709ms while the fixed product Host remains alive; outer Job drains naturally. Console entry only, no visible Desktop.'
        requirement['gap'] = 'Full Desktop-owner death/handoff/nested/two-instance/normal-close, trusted home ACL/lease channel, all legacy/direct Node/fallback paths, clean Windows matrix and total application resources remain unqualified. Unknown must fence every profile/config/fallback.'
    elif requirement['id'] == 'M5-platform':
        requirement['gap'] += ' Fixed HTTP harness remains unexecuted after root review found full nine-action identity scope and environment/query-rights gaps; native-free mocks do not close actual HTTP or platform qualification.'
save(audit_path, audit)

gates_path = BASE / 'release-gates.json'
gates = load(gates_path)
assert gates['status'] == 'pending' and len(gates['gates']) == 8
assert all(gate['status'] == 'pending' for gate in gates['gates'])
gates.update(updatedAt=now, currentStatus=progress['status'])
current = gates['currentWork']
current['latestProgressReview20261118R3'] = review
current['complete31RequirementsAudit']['audit'] = binding(audit_path)
current['earlyLeaseAndEncryptedLifecycle20261118R3'] = {
    'progress': review, 'archive': binding(capsule),
    'desktopEarlyNodeDeath': binding(early), 'encryptedLifecycleFail': binding(life),
    'exportDirectoryAccessDiagnosticFail': binding(cause),
    'wholeLifecycleQualified': False, 'allEightGatesRemainPending': True,
}
current['latestChanges'] = [
    'Actual early Node-death lease reclaim passed scoped root verification; full product lifecycle remains open.',
    'Private consumer integration passed 75 native-free checks under unchanged dependency policy.',
    'Actual encrypted turn/readback/full lexical index observed, but export fails held-basic directory time.access before capture. Preserve FAIL/unknown; disable/delete unexecuted.',
    'Fixed HTTP human fixture must retain all nine actions; latest harness remains under root review and not executed.',
    'All SR1-SR8 pending; full consumers, independent quality/performance, platforms, distribution, new packages and final-source qualification remain open.',
]
for gate in gates['gates']:
    if gate['id'] == 'SR6':
        gate['notes'] = 'Actual Gemma2 resident65 and early Node-death preparation lease reclamation passed scoped root execution. Complete encrypted lifecycle still fails at export directory Access. Full Desktop-owner lifecycle, trusted home/ACL, all supported legacy/direct Node/fallback paths, privacy/keys and clean Windows remain pending.'
save(gates_path, gates)

document = ROOT / 'docs/optimization-plan/147-3.1-semantic-retrieval-and-recovery.md'
text = document.read_text(encoding='utf-8')
assert '### 10.34 ' in text and '### 10.35 ' not in text
text += '''
### 10.35 早期 Node 退出回收实测通过；加密会话导出仍阻塞

Root 对创建时 JobList 和 held-HANDLE waiter 的实际产品 Host 代码做控制台入口实测，未进入 Program.Main／ShellForm／Application.Run，也未改 live Desktop。准备阶段 PowerShell 的 marker、Flush 和 ReadToEnd 均置于同一 try 中，EOF 后 finally 固定保持30秒；因此强杀 Node 后约709ms观察到 Node／PowerShell 均缺席，不能归因于自然EOF退出。宿主与控制器当时仍是同一活身份，实际产品 Job 报告 empty 与 job-closed；外层自然 active0，无兜底强杀。Root前后核48绑定、独跑25项fake并复核原始CRLF字节、同HANDLE身份／终止见证和终态OS身份。旧marker保护范围及CRLF解析候选在执行前被拒绝并保留。此限定PASS不覆盖桌面宿主死亡、handoff、嵌套Job、双实例、正常关闭、direct Node／legacy／fallback及跨Windows矩阵；可信常驻home／ACL／租约通道仍在实现。

M3私有consumer注入整合候选已由root核654绑定，独跑50＋7＋16＋2＝75项无原生执行回归，保留原WeakMap发行者与依赖策略，无反向依赖或债务基线扩张。随后完整加密生命周期候选核675绑定、81项预检后真实执行：启用发布成功，loopback合成provider实际提交一回合，回读两条消息的三个原字段，两次搜索的索引覆盖均为2／2、pending0。整轮随后在export的冷快照失败，disable及delete未执行；不能把成功前半段写成整轮通过，语义模型本轮也未启用。

下一诊断仅加入固定阶段和安全code／对象类别。Root核687绑定与10项预检后执行，定位before-capture、work_data_backup.metadata_changed、held-basic、directory、time.access。它尚未识别具体目录属于source、generation、index或control，也未证明触发者，因此不刷原source、不回写时间、不放松四Basic或namespace／身份检查。两轮均保留FAIL与协议unknown，外层兜底后active0不等于正常功能收口；原失败根不自动重试或回滚。下一批先细分固定目录类别，再验证真实captured-read owner路径。

M5固定HTTP测试尚未获实际运行资格：root发现默认human为五类九项action，各自新建并关闭fixture，不能全局限定一个server来缩小验证；另须在PowerShell创建时清洁环境，并复核进程查询权限和每个实际child生命周期的Job／创建身份配对。实现者正在修正，纯mock不代表完整HTTP或QQ／飞书平台通过；原网络首红和连续群成员revision能力缺口仍保留。系统盘环境链v5也仍是候选资格，不把先前v4实测转移到未测代码。

本批原件、预执行拒绝、实际源码、原始日志和root复核存[早期租约与加密生命周期归档](evidence/semantic-retrieval-20261116/s3c-early-lease-and-encrypted-lifecycle-reviewed-20261118-r1/manifest.json)：2153别名、237本地gzip、1618条旧固定内容引用，manifest SHA41976a37293d6411c2ab2da086cc491d673c9d6802d2e72d9e7034c29373c332。Root不导入builder另作逐项原件／引用manifest／gzip／解压字节postwalk通过，不含数据根、home、备份、密钥、权重、盲测、系统SDK正文或原生binary。最新状态见[进度记录r3](evidence/semantic-retrieval-20261116/3.1-progress-20261118-r3.json)。完整3.1范围及所有原排除保留；SR1–SR8全pending，版本3.0.1／原默认不变，未commit/push/发布。
'''
document.write_text(text, encoding='utf-8', newline='\n')
notice = '> 2026-11-18 最新进度：早期Node退出时的准备进程回收已通过root实际限定验收；加密真实会话写入／原文回读／完整索引已观察到，但整轮在导出目录Access校验失败，后续关闭加密／删除未执行。完整桌面生命周期、全消费者与新包仍待，未达到RC。详见 [147 §10.35](147-3.1-semantic-retrieval-and-recovery.md#1035-早期-node-退出回收实测通过加密会话导出仍阻塞)，全部发布门槛仍pending。'
for name in ('README.md', '86-3.1-completion-and-privacy-roadmap.md', '92-3.1-implementation-handoff.md'):
    file = ROOT / 'docs/optimization-plan' / name
    text = file.read_text(encoding='utf-8')
    lines = text.splitlines()
    found = [i for i, line in enumerate(lines) if line.startswith('> 2026-11-18 最新进度：')]
    assert len(found) == 1, name
    lines[found[0]] = notice
    file.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'progress': review, 'audit': binding(audit_path),
                  'gates': 'all eight pending', 'section': '10.35'}, ensure_ascii=False))
